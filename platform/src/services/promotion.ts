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
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { stagingProposedEntities, stagingProposedFacts, entities, facts, sameAsLinks } from '../db/schema.js';
import { ml } from './ml-client.js';
import { recordFactChange } from './audit.js';
import { mergeEntities } from './entities.js';
import { mintCausalEvent } from './causal.js';
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
import { resolveEscalations, type ArbiterInvoker } from './promotion-arbiter.js';
import { canonicalizeStagedPredicates } from './predicate-resolve.js';

/** Options for {@link promote}. `invokeArbiter` is injectable for tests (E5). */
export interface PromoteOptions {
  invokeArbiter?: ArbiterInvoker;
}

const PROMOTION_ACTOR = 'promotion' as const;

export interface PromotionResult {
  epochId: string;
  plan: PromotionPlan;
  /** clusterKey → freshly-minted (or reused-by-name) canonical entity id. */
  mintedEntityIds: Record<string, string>;
  insertedFactIds: string[];
  expiredFactIds: string[];
  corroboratedFactIds: string[];
  /** Source entity ids merged away by identity-verdict merges (E5). */
  mergedAwayEntityIds: string[];
  /** same_as link ids created by identity verdicts (E5). */
  sameAsLinkIds: string[];
  /**
   * Causal event ids minted from this promotion's settled fact mutations (doc 41
   * §12 #5; E6): 'created' per newly-active fact, 'expired' per prior fact expired
   * this run, 'strengthened' per corroboration that raised confidence — each keyed
   * to the stable fact id. The post-promotion causal pass scopes its delta from these.
   */
  mintedCausalEventIds: string[];
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
  const mergedAwayEntityIds: string[] = [];
  const sameAsLinkIds: string[] = [];
  const mintedCausalEventIds: string[] = [];

  // 2. One transaction.
  await db.transaction(async (tx) => {
    // (0) Identity-verdict execution (E5, doc 41 §8a.5): the arbiter decided, the
    // applier executes. Canonical↔canonical merges (execute_merge moved out of the
    // agent surface into promotion code) and same_as links (create_same_as_link,
    // likewise) run FIRST, so the survivor and its re-pointed facts are settled
    // before the plan's fact mutations land. Both stamp actor='promotion' (mig 041).
    // A bad verdict throws → the whole tx rolls back (atomicity), same contract as
    // every other promotion mutation.
    for (const m of plan.entityMerges) {
      await mergeEntities({
        sourceId: m.sourceId,
        targetId: m.targetId,
        reason: m.reason,
        method: 'llm_verified',
        actor: PROMOTION_ACTOR,
        tx,
      });
      mergedAwayEntityIds.push(m.sourceId);
    }
    for (const l of plan.sameAsLinks) {
      // Canonical ordering (a < b) — mirrors the retired create_same_as_link tool.
      const [aId, bId] =
        l.entityAId < l.entityBId ? [l.entityAId, l.entityBId] : [l.entityBId, l.entityAId];
      const inserted = await tx
        .insert(sameAsLinks)
        .values({
          entityAId: aId,
          entityBId: bId,
          reasoning: l.reason,
          sourceEvidence: [],
          confidence: 1,
          createdBy: PROMOTION_ACTOR,
        })
        .onConflictDoNothing()
        .returning({ id: sameAsLinks.id });
      if (inserted[0]) sameAsLinkIds.push(inserted[0].id);
    }

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

      // (b.1) Mint a settled causal event for the active fact (doc 41 §12 #5; E6).
      // One 'created' event per newly-active fact, keyed to its stable id, inside
      // this tx so the post-promotion causal pass sees only settled event ids.
      // Born-inactive facts (lost group supersession on arrival) never become
      // active, so they get no event; expiries mint 'expired' at (c) and
      // corroborations mint 'strengthened' at (d).
      if (f.active) {
        mintedCausalEventIds.push(
          await mintCausalEvent(tx, {
            factId,
            transitionType: 'created',
            subjectEntityId: subjectId,
            predicate: f.predicate,
            deltaConfidence: f.confidence,
            sourceText: f.reasoning ?? null,
          }),
        );
      }
    }

    // (c) Expire prior-canonical actives that lost group supersession.
    for (const ex of plan.factsToExpire) {
      const [expired] = await tx
        .update(facts)
        .set({ expiredAt: new Date(), expireReason: ex.reason })
        .where(and(eq(facts.id, ex.factId), isNull(facts.expiredAt)))
        .returning({ subjectEntityId: facts.subjectEntityId, predicate: facts.predicate });
      await recordFactChange({
        factId: ex.factId,
        eventType: 'superseded',
        reasoning: ex.reason,
        actor: PROMOTION_ACTOR,
        tx,
      });
      // (c.1) Mint an 'expired' event for the prior fact actually expired this run
      // (doc 41 §12 #5; E6). `returning` is empty on a no-op re-run (already
      // expired), so we never double-mint a transition that did not happen.
      if (expired?.subjectEntityId) {
        mintedCausalEventIds.push(
          await mintCausalEvent(tx, {
            factId: ex.factId,
            transitionType: 'expired',
            subjectEntityId: expired.subjectEntityId,
            predicate: expired.predicate ?? '',
            sourceText: ex.reason,
          }),
        );
      }
      expiredFactIds.push(ex.factId);
    }

    // (d) Corroborate prior actives matched by an identical staged triple — raise
    // confidence only if the epoch carried a higher one (matches createFact).
    for (const c of plan.corroborations) {
      const [row] = await tx
        .select({
          confidence: facts.confidence,
          subjectEntityId: facts.subjectEntityId,
          predicate: facts.predicate,
        })
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
        // (d.1) Mint a 'strengthened' event for the corroborated prior fact (doc 41
        // §12 #5; E6) — only when confidence actually rose, mirroring the audit row.
        if (row?.subjectEntityId) {
          mintedCausalEventIds.push(
            await mintCausalEvent(tx, {
              factId: c.priorFactId,
              transitionType: 'strengthened',
              subjectEntityId: row.subjectEntityId,
              predicate: row.predicate ?? '',
              deltaConfidence: c.confidence - prev,
              sourceText: 'Corroborated by an identical triple proposed this epoch',
            }),
          );
        }
      }
    }
  });

  return {
    epochId,
    plan,
    mintedEntityIds,
    insertedFactIds,
    expiredFactIds,
    corroboratedFactIds,
    mergedAwayEntityIds,
    sameAsLinkIds,
    mintedCausalEventIds,
  };
}

// ============================================
// promote — the public entry point
// ============================================

/**
 * Promote one epoch's staged proposals to canonical (doc 41 §5). Deterministic +
 * transactional: safe to retry after a failure (canonical untouched) and
 * idempotent on a double-fire (the second run corroborates rather than dupes).
 *
 * Escalations (doc 41 §5g) the deterministic backbone cannot settle are resolved by
 * the promotion-escalation arbiter (E5, doc 41 §8a.5): a first planning pass
 * surfaces them, `resolveEscalations` turns each into a verdict (replay-reuse or the
 * Haiku arbiter), and a SECOND verdict-aware pass produces the plan that is applied.
 * Any escalation left without a verdict keeps the planner's conservative default, so
 * promotion always completes deterministically.
 */
const STAGING_TTL_MS = Number.parseInt(process.env.STAGING_TTL_MS ?? `${60 * 60 * 1000}`, 10);

/**
 * Delete staging proposals older than `olderThanMs` — abandoned-epoch cleanup.
 * promote() consumes an epoch's staging into canonical but never deletes it, and
 * an epoch that fails before promote (e.g. a session-limit pause mid-propose in
 * the resumable driver) leaves its proposals behind entirely. Both accumulate
 * (1200+ orphan rows observed after the LOTR run) and clutter the staging viz.
 * This sweeps anything older than a generous TTL — far longer than any in-flight
 * epoch, so a concurrent epoch's fresh proposals are never touched. Best-effort:
 * callers log and continue. Facts are deleted before entities. Returns counts.
 */
export async function cleanupAbandonedStaging(
  olderThanMs: number = STAGING_TTL_MS,
): Promise<{ entities: number; facts: number }> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const deletedFacts = await db
    .delete(stagingProposedFacts)
    .where(lt(stagingProposedFacts.createdAt, cutoff))
    .returning({ id: stagingProposedFacts.stagedFactId });
  const deletedEntities = await db
    .delete(stagingProposedEntities)
    .where(lt(stagingProposedEntities.createdAt, cutoff))
    .returning({ id: stagingProposedEntities.handle });
  return { entities: deletedEntities.length, facts: deletedFacts.length };
}

export async function promote(epochId: string, opts: PromoteOptions = {}): Promise<PromotionResult> {
  const { prior, staged } = await loadPromotionInputs(epochId);

  // Canonicalize staged predicates against the registry BEFORE planning (doc 42
  // §7, PC4 — "the spine"). Mutates StagedFact.predicate to the canonical string,
  // so tripleKey, the prior-canonical index, exclusive-group supersession, and the
  // written facts.predicate all key on the canonical predicate. Deterministic and
  // ml-down safe (keeps raw predicates if resolve is unreachable).
  const predStats = await canonicalizeStagedPredicates(staged.facts, staged.entities);
  if (predStats.reused + predStats.minted + predStats.deferred > 0) {
    console.log(
      `[promotion] epoch=${epochId.slice(0, 8)} predicates: reused=${predStats.reused} ` +
        `minted=${predStats.minted} deferred=${predStats.deferred}`,
    );
  }

  // Pass 1: deterministic plan that SURFACES escalations (conservative defaults).
  const firstPass = planPromotion(prior, staged);

  // Resolve escalations to verdicts, then RE-PLAN with them so the applied plan
  // reflects the arbiter's dispositions (doc 41 §8a.5; "arbiter decides, promotion
  // executes"). No escalations → the first plan is applied unchanged.
  let plan = firstPass;
  if (firstPass.escalations.length > 0) {
    const verdicts = await resolveEscalations(epochId, prior, staged, firstPass.escalations, {
      invokeArbiter: opts.invokeArbiter,
    });
    if (verdicts.length > 0) {
      plan = planPromotion(prior, staged, verdicts);
      console.log(
        `[promotion] epoch=${epochId.slice(0, 8)} arbiter resolved ${verdicts.length}/${firstPass.escalations.length} ` +
          `escalation(s); ${plan.escalations.length} remain at conservative default`,
      );
    } else {
      console.log(
        `[promotion] epoch=${epochId.slice(0, 8)} ${firstPass.escalations.length} escalation(s) recorded; ` +
          `no arbiter verdict — conservative defaults kept`,
      );
    }
  }

  const result = await applyPromotion(epochId, plan);

  console.log(
    `[promotion] epoch=${epochId.slice(0, 8)} minted=${Object.keys(result.mintedEntityIds).length} ` +
      `inserted=${result.insertedFactIds.length} expired=${result.expiredFactIds.length} ` +
      `corroborated=${result.corroboratedFactIds.length} merged=${result.mergedAwayEntityIds.length} ` +
      `same_as=${result.sameAsLinkIds.length} dropped_self_loops=${plan.droppedSelfLoops.length} ` +
      `dropped_orphans=${plan.droppedOrphanEntities.length}`,
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
