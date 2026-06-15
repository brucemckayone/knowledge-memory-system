/**
 * Promotion — the DB layer around the pure planner (doc 41 §5 f–g; bead
 * nmemo-vpz.3 / E3).
 *
 * `promote(epochId)` is the deterministic authority that turns one epoch's staged
 * proposals into canonical graph mutations:
 *
 *   load()           read staged rows + the SCOPED prior-canonical snapshot
 *   planPromotion()  pure plan of mutations (promotion-plan.ts; steps a–e)
 *   applyPromotion() embeddings up front, then ONE transaction: mint entities,
 *                    insert facts, expire superseded, corroborate, + audit rows
 *
 * Single-writer (doc 41 §12 #2/#8 — one promotion per source, no interleaving) so
 * the prior-canonical snapshot is stable across the call. The transaction makes a
 * failed promotion leave canonical untouched and a retry idempotent (doc 41 §12
 * #9): a re-run sees the entities/facts the first run wrote as prior canonical and
 * corroborates instead of duplicating.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { stagingProposedEntities, stagingProposedFacts, entities, facts } from '../db/schema.js';
import { ml } from './ml-client.js';
import { recordFactChange } from './audit.js';
import {
  planPromotion,
  type PriorCanonical,
  type PriorEntity,
  type PriorFact,
  type PromotionPlan,
  type ResolvedRef,
  type StagedEntity,
  type StagedFact,
} from './promotion-plan.js';

const PROMOTION_ACTOR = 'promotion' as const;

export interface PromotionResult {
  epochId: string;
  plan: PromotionPlan;
  /** clusterKey → freshly-minted (or reused-by-name) canonical entity id. */
  mintedEntityIds: Record<string, string>;
  insertedFactIds: string[];
  expiredFactIds: string[];
  corroboratedFactIds: string[];
}

// ============================================
// Load — staged rows + scoped prior canonical
// ============================================

function firstToken(norm: string): string {
  return norm.split(' ')[0] ?? norm;
}

// Mirror promotion-plan.normalizeName for the load-time scoping query (first
// token only — a word-prefix match always shares the first token, so scoping
// prior candidates by first token never drops a resolvable match).
function normForToken(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^(dr|mr|mrs|ms|prof)\.?\s+/, '');
}

/**
 * Read one epoch's staged proposals and the prior-canonical state promotion
 * needs. Prior entities are scoped to same-type rows sharing a first token with
 * some staged name (the word-prefix candidate set) plus every anchored id; prior
 * active facts are scoped to those candidate subject ids. This keeps promotion
 * bounded instead of loading the whole graph.
 */
export async function loadPromotionInputs(
  epochId: string,
): Promise<{ prior: PriorCanonical; staged: { entities: StagedEntity[]; facts: StagedFact[] } }> {
  const [stagedEntityRows, stagedFactRows] = await Promise.all([
    db.select().from(stagingProposedEntities).where(eq(stagingProposedEntities.epochId, epochId)),
    db.select().from(stagingProposedFacts).where(eq(stagingProposedFacts.epochId, epochId)),
  ]);

  const stagedEntities: StagedEntity[] = stagedEntityRows.map((r) => ({
    handle: r.handle,
    name: r.name,
    type: r.entityType,
    summary: r.summary,
    anchorCanonicalId: r.anchorCanonicalId,
  }));
  const stagedFacts: StagedFact[] = stagedFactRows.map((r) => ({
    stagedFactId: r.stagedFactId,
    subjectHandle: r.subjectHandle,
    predicate: r.predicate,
    objectHandle: r.objectHandle,
    objectValue: r.objectValue,
    validAt: r.validAt,
    undated: r.undated,
    chunkIndex: r.chunkIndex,
    confidence: r.confidence,
    reasoning: r.reasoning,
    exclusiveGroup: r.exclusiveGroup,
    supersedesFactId: r.supersedesFactId,
  }));

  const types = [...new Set(stagedEntities.map((e) => e.type))];
  const tokens = [...new Set(stagedEntities.map((e) => firstToken(normForToken(e.name))))];
  const anchorIds = [...new Set(stagedEntities.map((e) => e.anchorCanonicalId).filter((x): x is string => !!x))];

  // Prior canonical entities: same-type + shared first token (the prefix-candidate
  // set), unioned with anchored ids (whose token may differ post-normalisation).
  let priorEntityRows: Array<{ id: string; canonicalName: string; entityType: string }> = [];
  if (types.length > 0 && tokens.length > 0) {
    priorEntityRows = await db
      .select({ id: entities.id, canonicalName: entities.canonicalName, entityType: entities.entityType })
      .from(entities)
      .where(
        and(
          inArray(entities.entityType, types),
          // inArray over the first-token expression emits `IN ($1,$2,…)` with one
          // param per token — avoids the array-literal binding `= ANY($1)` needs.
          inArray(sql`split_part(lower(${entities.canonicalName}), ' ', 1)`, tokens),
        ),
      );
  }
  if (anchorIds.length > 0) {
    const anchorRows = await db
      .select({ id: entities.id, canonicalName: entities.canonicalName, entityType: entities.entityType })
      .from(entities)
      .where(inArray(entities.id, anchorIds));
    const seen = new Set(priorEntityRows.map((r) => r.id));
    for (const r of anchorRows) if (!seen.has(r.id)) priorEntityRows.push(r);
  }

  const priorEntities: PriorEntity[] = priorEntityRows.map((r) => ({
    id: r.id,
    name: r.canonicalName,
    type: r.entityType,
  }));

  // Prior active facts whose subject is a candidate canonical id (anchored or
  // prefix-matched). Superset of what's strictly needed — harmless: planPromotion
  // only touches groups that have a new proposal.
  const candidateSubjectIds = [...new Set([...anchorIds, ...priorEntities.map((e) => e.id)])];
  let priorActiveFacts: PriorFact[] = [];
  if (candidateSubjectIds.length > 0) {
    const factRows = await db
      .select({
        id: facts.id,
        subjectEntityId: facts.subjectEntityId,
        predicate: facts.predicate,
        objectEntityId: facts.objectEntityId,
        objectValue: facts.objectValue,
        validAt: facts.validAt,
        confidence: facts.confidence,
      })
      .from(facts)
      .where(and(inArray(facts.subjectEntityId, candidateSubjectIds), isNull(facts.expiredAt)));
    priorActiveFacts = factRows;
  }

  return {
    prior: { entities: priorEntities, activeFacts: priorActiveFacts },
    staged: { entities: stagedEntities, facts: stagedFacts },
  };
}

// ============================================
// Apply — embeddings up front, one transaction
// ============================================

async function embed(text: string): Promise<number[]> {
  try {
    const data = await ml.embed(text);
    return data.vector ?? [];
  } catch {
    return [];
  }
}

const vectorLiteral = (v: number[]): string => `[${v.join(',')}]`;

/**
 * Apply a {@link PromotionPlan} to canonical in ONE transaction (doc 41 §5f).
 * Embeddings (the only network calls) are computed first so the transaction is
 * pure DB work. Every mutation emits a fact_history row stamped actor='promotion'
 * (mig 041 CHECK; doc 12 audit contract).
 */
export async function applyPromotion(
  epochId: string,
  plan: PromotionPlan,
): Promise<PromotionResult> {
  // 1. Entity embeddings up front (outside the tx). Facts carry no embedding
  // column (unlike entities) — fact similarity is served from Qdrant, not pgvector.
  const entityEmbeddings = new Map<string, number[]>();
  for (const e of plan.entitiesToMint) entityEmbeddings.set(e.clusterKey, await embed(e.name));

  const mintedEntityIds: Record<string, string> = {};
  const insertedFactIds: string[] = [];
  const expiredFactIds: string[] = [];
  const corroboratedFactIds: string[] = [];

  // 2. One transaction.
  await db.transaction(async (tx) => {
    // (a) Mint fresh entities — dedup-by-name within the tx so a re-run reuses the
    // id the prior run wrote (idempotency, doc 41 §12 #9) and we never create a
    // second row for an existing canonical name+type.
    for (const e of plan.entitiesToMint) {
      const existing = await tx
        .select({ id: entities.id })
        .from(entities)
        .where(and(sql`lower(${entities.canonicalName}) = ${e.name.toLowerCase()}`, eq(entities.entityType, e.type)))
        .limit(1);
      let id = existing[0]?.id;
      if (!id) {
        id = randomUUID();
        await tx.insert(entities).values({
          id,
          canonicalName: e.name,
          entityType: e.type,
          description: e.summary ?? undefined,
        });
        const vec = entityEmbeddings.get(e.clusterKey);
        if (vec && vec.length > 0) {
          await tx.execute(sql`UPDATE public.entities SET embedding = ${vectorLiteral(vec)}::vector WHERE id = ${id}::uuid`);
        }
      }
      mintedEntityIds[e.clusterKey] = id;
    }

    const resolveId = (ref: ResolvedRef): string =>
      ref.kind === 'canonical' ? ref.id : mintedEntityIds[ref.key]!;

    // (b) Insert facts. Each fact is minted with a fresh id; an inserted-inactive
    // fact (lost group supersession to a peer) lands already-expired and gets both
    // a 'created' and a 'superseded' audit row so history is truthful.
    for (const f of plan.factsToInsert) {
      const factId = randomUUID();
      const subjectId = resolveId(f.subjectRef);
      const objectId = f.objectRef ? resolveId(f.objectRef) : null;
      const expiredAt = f.active ? null : new Date();
      await tx.insert(facts).values({
        id: factId,
        subjectEntityId: subjectId,
        predicate: f.predicate,
        objectEntityId: objectId,
        objectValue: objectId ? null : f.objectValue,
        validAt: f.validAt,
        confidence: f.confidence,
        sourceText: f.reasoning,
        extractionMethod: 'llm',
        expiredAt,
        expireReason: f.expireReason,
      });
      await recordFactChange({
        factId,
        eventType: 'created',
        newConfidence: f.confidence,
        newValidAt: f.validAt,
        reasoning: f.reasoning ?? 'Promoted from staged proposal',
        actor: PROMOTION_ACTOR,
        tx,
      });
      if (!f.active) {
        await recordFactChange({
          factId,
          eventType: 'superseded',
          reasoning: f.expireReason ?? 'Superseded on arrival by a later-valid fact in its exclusive group',
          actor: PROMOTION_ACTOR,
          tx,
        });
      }
      insertedFactIds.push(factId);
    }

    // (c) Expire prior-canonical actives that lost group supersession.
    for (const ex of plan.factsToExpire) {
      await tx
        .update(facts)
        .set({ expiredAt: new Date(), expireReason: ex.reason })
        .where(and(eq(facts.id, ex.factId), isNull(facts.expiredAt)));
      await recordFactChange({
        factId: ex.factId,
        eventType: 'superseded',
        reasoning: ex.reason,
        actor: PROMOTION_ACTOR,
        tx,
      });
      expiredFactIds.push(ex.factId);
    }

    // (d) Corroborate prior actives matched by an identical staged triple — raise
    // confidence only if the epoch carried a higher one (matches createFact).
    for (const c of plan.corroborations) {
      const [row] = await tx
        .select({ confidence: facts.confidence })
        .from(facts)
        .where(eq(facts.id, c.priorFactId));
      const prev = row?.confidence ?? 0;
      if (c.confidence > prev) {
        await tx.update(facts).set({ confidence: c.confidence }).where(eq(facts.id, c.priorFactId));
        await recordFactChange({
          factId: c.priorFactId,
          eventType: 'confidence_raised',
          previousConfidence: prev,
          newConfidence: c.confidence,
          reasoning: 'Corroborated by an identical triple proposed this epoch',
          actor: PROMOTION_ACTOR,
          tx,
        });
        corroboratedFactIds.push(c.priorFactId);
      }
    }
  });

  return { epochId, plan, mintedEntityIds, insertedFactIds, expiredFactIds, corroboratedFactIds };
}

// ============================================
// promote — the public entry point
// ============================================

/**
 * Promote one epoch's staged proposals to canonical (doc 41 §5). Deterministic +
 * transactional: safe to retry after a failure (canonical untouched) and
 * idempotent on a double-fire (the second run corroborates rather than dupes).
 *
 * Escalations (doc 41 §5g) are returned on `result.plan.escalations`; in E3 the
 * arbiter is a stub, so they are logged for the E5 recast and the conservative
 * deterministic default has already been applied by the planner.
 */
export async function promote(epochId: string): Promise<PromotionResult> {
  const { prior, staged } = await loadPromotionInputs(epochId);
  const plan = planPromotion(prior, staged);
  const result = await applyPromotion(epochId, plan);

  if (plan.escalations.length > 0) {
    console.log(
      `[promotion] epoch=${epochId.slice(0, 8)} ${plan.escalations.length} escalation(s) recorded (arbiter stub — E5): ` +
        plan.escalations.map((e) => `${e.kind}:${e.reason}`).join(' | '),
    );
  }
  console.log(
    `[promotion] epoch=${epochId.slice(0, 8)} minted=${Object.keys(result.mintedEntityIds).length} ` +
      `inserted=${result.insertedFactIds.length} expired=${result.expiredFactIds.length} ` +
      `corroborated=${result.corroboratedFactIds.length} dropped_self_loops=${plan.droppedSelfLoops.length}`,
  );

  // VERIFY-phase supersession hints (doc 41 §4, §8a.3; E4). The deterministic
  // valid_at order already decided supersession; hints are advisory. Log the
  // ones that DISAGREED — a proposer believed a prior fact was superseded but
  // valid_at ordering left it active. A signal for the E5 arbiter, never a
  // correction here (ordering is LOCKED).
  if (plan.supersessionHints.length > 0) {
    const disagreed = plan.supersessionHints.filter((h) => !h.agreed);
    console.log(
      `[promotion] epoch=${epochId.slice(0, 8)} supersession_hints=${plan.supersessionHints.length} ` +
        `agreed=${plan.supersessionHints.length - disagreed.length} disagreed=${disagreed.length}`,
    );
    for (const h of disagreed) {
      console.warn(
        `[promotion]   hint disagreement: staged ${h.stagedFactId.slice(0, 8)} claimed to supersede ` +
          `prior ${h.supersedesFactId.slice(0, 8)}, but valid_at ordering left it active`,
      );
    }
  }
  return result;
}
