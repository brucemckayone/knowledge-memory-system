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
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { stagingProposedEntities, stagingProposedFacts, entities, facts, sameAsLinks } from '../db/schema.js';
import { embedForWrite } from './embed.js';
import { recordFactChange } from './audit.js';
import { recordFactSource } from './facts.js';
import { windowPointId } from './point-ids.js';
import { mergeEntities } from './entities.js';
import { mintCausalEvent } from './causal.js';
import {
  planPromotion,
  type PriorCanonical,
  type PriorEntity,
  type PriorFact,
  type PlannedDescriptionFill,
  type PromotionPlan,
  type ResolvedRef,
  type StagedEntity,
  type StagedFact,
} from './promotion-plan.js';
import { resolveEscalations, type ArbiterInvoker } from './promotion-arbiter.js';
import { canonicalizeStagedPredicates } from './predicate-resolve.js';
import { getCorpusPolicy, type CorpusMode } from './corpus-policy.js';
import { config } from '../config.js';
import { entityEmbedTextFor, entityEmbedModeFromFlag, factEmbedTextFor } from './embed-text.js';

/** Options for {@link promote}. `invokeArbiter` is injectable for tests (E5). */
export interface PromoteOptions {
  invokeArbiter?: ArbiterInvoker;
  /**
   * Corpus this epoch's canonical output belongs to (doc 34 §6 step 1). Defaults to
   * 'default', so every existing caller is byte-identical. Supplying it makes the
   * whole promote path corpus-scoped: the prior-canonical load, the entity
   * reuse-by-name lookup, and the entity/fact inserts. Without it the reuse-by-name
   * lookup is a CROSS-CORPUS FUSION PATH — two corpora sharing an entity name would
   * silently collapse onto one node, which is exactly what the Phase A fusion guards
   * exist to prevent.
   */
  corpusId?: string;
  /**
   * Deliberate per-call opt-in to the predicate fold, for the suites whose whole
   * subject IS the fold. Defaults to `config.PREDICATE_FOLD_ENABLED`, which is
   * false by decision of record (doc 41 §7 — 3.7% reduction against a 60% bar at
   * 0.43 merge precision). Production callers should not set this.
   */
  foldPredicates?: boolean;
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
  corpusId = 'default',
): Promise<{
  prior: PriorCanonical;
  staged: { entities: StagedEntity[]; facts: StagedFact[] };
  /** Corpus policy mode (D5) — threaded as data into the pure planner. */
  mode: CorpusMode;
}> {
  const [stagedEntityRows, stagedFactRows, mode] = await Promise.all([
    db.select().from(stagingProposedEntities).where(eq(stagingProposedEntities.epochId, epochId)),
    db.select().from(stagingProposedFacts).where(eq(stagingProposedFacts.epochId, epochId)),
    // D5 (04-hardened-spec.md §2): read the corpus stance here (the DB touch stays
    // OUT of the pure planner) and thread it in as data.
    getCorpusPolicy(corpusId),
  ]);

  // FUSION GUARD #5: drop an anchor that points OUTSIDE the corpus being promoted.
  //
  // resolveEntities binds `anchorCanonicalId` straight from the staged row -
  // `byHandle.set(e.handle, { kind: 'canonical', id: e.anchorCanonicalId })` -
  // without consulting the DB, because the planner is pure. So a proposal that
  // anchors across corpora used to bind, and the fact written on that handle then
  // hit migration 052's composite FK:
  //
  //   insert or update on table "facts" violates foreign key constraint
  //   "facts_subject_corpus_fk"
  //   Key (subject_entity_id, corpus_id)=(c80a8965-..., dal-nlp) is not present
  //   in table "entities".
  //
  // That is the constraint working exactly as designed - it stopped a silent
  // cross-corpus fusion - but it killed the whole epoch. Observed on the
  // 2026-08-31 re-ingest: a proposer anchored a dal-nlp entity to
  // 'User (stream default)', the self entity, which lives in corpus 'default'.
  //
  // Scoping here rather than in the planner keeps the planner DB-free and the
  // order-independence litmus intact. An out-of-corpus anchor becomes null, so the
  // handle is simply treated as unanchored and clusters normally - correct
  // isolation instead of a hard failure. Mirrors fusion guard #2 on the
  // word-prefix candidate load below.
  const anchorIdsRaw = [...new Set(stagedEntityRows.map((r) => r.anchorCanonicalId).filter((v): v is string => !!v))];
  const inCorpusAnchors = new Set<string>();
  if (anchorIdsRaw.length > 0) {
    const rows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(inArray(entities.id, anchorIdsRaw), eq(entities.corpusId, corpusId)));
    for (const r of rows) inCorpusAnchors.add(r.id);
  }
  const droppedAnchors = anchorIdsRaw.filter((id) => !inCorpusAnchors.has(id));
  if (droppedAnchors.length > 0) {
    console.warn(
      `[promotion] epoch=${epochId.slice(0, 8)} dropped ${droppedAnchors.length} out-of-corpus ` +
      `anchor(s) for corpus '${corpusId}': ${droppedAnchors.join(', ')} ` +
      '(fusion guard #5 — the handle clusters as unanchored instead)',
    );
  }

  const stagedEntities: StagedEntity[] = stagedEntityRows.map((r) => ({
    handle: r.handle,
    name: r.name,
    type: r.entityType,
    summary: r.summary,
    anchorCanonicalId:
      r.anchorCanonicalId && inCorpusAnchors.has(r.anchorCanonicalId) ? r.anchorCanonicalId : null,
  }));
  const stagedFacts: StagedFact[] = stagedFactRows.map((r) => ({
    stagedFactId: r.stagedFactId,
    subjectHandle: r.subjectHandle,
    predicate: r.predicate,
    objectHandle: r.objectHandle,
    objectValue: r.objectValue,
    validAt: r.validAt,
    undated: r.undated,
    sourceId: r.sourceId,
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
          // Fusion guard #2 (D5): scope the word-prefix candidate set to the
          // corpus being promoted so cross-corpus names never enter the plan.
          eq(entities.corpusId, corpusId),
        ),
      );
  }
  if (anchorIds.length > 0) {
    // Corpus-scoped for the same reason as fusion guard #5 above: an anchor from
    // another corpus must not enter this corpus's prior-entity set.
    const anchorRows = await db
      .select({ id: entities.id, canonicalName: entities.canonicalName, entityType: entities.entityType })
      .from(entities)
      .where(and(inArray(entities.id, anchorIds), eq(entities.corpusId, corpusId)));
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
    mode,
  };
}

// ============================================
// Apply — embeddings up front, one transaction
// ============================================

// Write-path embedding: embedForWrite THROWS on an ML failure (nmemo-avd / PC8-1)
// rather than returning []. Embeddings are computed up front (below), before the
// promotion transaction opens, so a throw aborts the whole promotion before any row is
// written — no entity or fact is ever committed with a NULL embedding that pgvector
// recall would silently skip. The epoch backpressure/retry layer handles the throw.
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
  corpusId = 'default',
): Promise<PromotionResult> {
  // 1. Embeddings up front (outside the tx — the only network calls, kept out of
  // the transaction so it stays pure DB work). Entity vectors embed a name+
  // authored-description composite when EMBED_DESCRIPTIONS is on (cross-corpus
  // recall lever, nmemo-uhp.14); default (off) embeds the name only, unchanged.
  const embedMode = entityEmbedModeFromFlag(config.EMBED_DESCRIPTIONS);
  const entityEmbeddings = new Map<string, number[]>();
  for (const e of plan.entitiesToMint) {
    entityEmbeddings.set(e.clusterKey, await embedForWrite(entityEmbedTextFor(e.name, e.summary, embedMode)));
  }

  // Fact embeddings, keyed by a pre-minted fact id. UNCONDITIONAL (nmemo-vga):
  // this used to be gated on EMBED_DESCRIPTIONS, which defaults to false and was
  // set nowhere, so `facts.fact_embedding` was NULL on the epoch path — measured
  // 0 of 136 on the default corpus. That gate contradicted the serial path's own
  // stated contract: createFact (facts.ts:239-244) embeds unconditionally with
  // embedForWrite precisely so "a fact must not commit with a NULL
  // fact_embedding (silently invisible to vector recall)". A feature flag about
  // ENTITY description text was silently deciding whether FACT edges were
  // retrievable at all. The two paths now agree, and the flag means only what
  // its name says. Same text convention as createFact (factEmbedTextFor), so the
  // two cannot drift. Pre-minted ids let us embed outside the tx and still
  // UPDATE the right row inside it.
  const factIdByIndex: string[] = [];
  const factEmbeddings = new Map<string, number[]>();
  for (let i = 0; i < plan.factsToInsert.length; i++) {
    const f = plan.factsToInsert[i]!;
    const id = randomUUID();
    factIdByIndex[i] = id;
    factEmbeddings.set(id, await embedForWrite(factEmbedTextFor(f.reasoning, f.predicate, f.objectValue)));
  }

  // Description fills for handles that bound to an EXISTING canonical entity
  // (nmemo-86z). Two steps outside the tx:
  //  (1) read which targets actually have no description, so the ML calls in (2)
  //      are bounded by real fills rather than by every resolved handle — on a
  //      built graph most epochs resolve to canonicals that already have one;
  //  (2) embed only those, and only when the flag makes the vector depend on the
  //      description at all (off ⇒ the composite text is name-only, so the
  //      existing vector is already correct and re-embedding is pure waste).
  // The UPDATE inside the tx re-checks the null itself, so a concurrent writer
  // between (1) and the tx cannot cause an overwrite — worst case a computed
  // vector goes unused.
  const fillTargets: PlannedDescriptionFill[] = [];
  const fillEmbeddings = new Map<string, number[]>();
  if (plan.entityDescriptionFills.length > 0) {
    const ids = plan.entityDescriptionFills.map((f) => f.canonicalId);
    const needy = await db
      .select({ id: entities.id, name: entities.canonicalName })
      .from(entities)
      .where(and(
        inArray(entities.id, ids),
        or(isNull(entities.description), eq(sql`btrim(${entities.description})`, '')),
      ));
    const nameById = new Map(needy.map((r) => [r.id, r.name]));
    for (const f of plan.entityDescriptionFills) {
      if (!nameById.has(f.canonicalId)) continue;
      fillTargets.push(f);
      if (config.EMBED_DESCRIPTIONS) {
        fillEmbeddings.set(
          f.canonicalId,
          await embedForWrite(entityEmbedTextFor(nameById.get(f.canonicalId)!, f.summary, embedMode)),
        );
      }
    }
  }

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
        .select({ id: entities.id, description: entities.description })
        .from(entities)
        // corpus-scoped (doc 34 §6): without eq(corpusId) this reuse-by-name lookup is a
        // cross-corpus fusion path — two separately-ingested corpora sharing an entity name
        // would collapse onto one node. Default corpus behaviour is unchanged.
        //
        // nmemo-asf.5: reuse by (name, corpus) only — entity_type is a first-seen attribute,
        // NOT identity. Two staged clusters for one name under different types (the planner
        // still partitions clusters by (type, norm)) converge HERE onto a single canonical
        // row: mintedEntityIds is keyed by clusterKey, so both keys map to the same id and
        // every fact from either handle resolves to it. Kills the type-fragmentation ratchet
        // (nmemo-x4s) on the epoch arm without restructuring the pure planner. (Existing
        // fragments already on disk are collapsed by the separate backfill-merge bead.)
        .where(and(
          sql`lower(${entities.canonicalName}) = ${e.name.toLowerCase()}`,
          eq(entities.corpusId, corpusId),
        ))
        // Deterministic pick when several same-name rows exist (the pre-backfill fragments):
        // earliest-created wins, ties broken by id — so a promotion re-run reuses the SAME
        // canonical id every time (idempotency, doc 41 §12 #9). Before dropping the type
        // predicate the (name,type) match was effectively unique; now it may not be.
        .orderBy(entities.createdAt, entities.id)
        .limit(1);
      let id = existing[0]?.id;
      const vec = entityEmbeddings.get(e.clusterKey);
      if (!id) {
        id = randomUUID();
        await tx.insert(entities).values({
          id,
          canonicalName: e.name,
          entityType: e.type,
          description: e.summary ?? undefined,
          corpusId,
        });
        if (vec && vec.length > 0) {
          await tx.execute(sql`UPDATE public.entities SET embedding = ${vectorLiteral(vec)}::vector WHERE id = ${id}::uuid`);
        }
      } else if (e.summary && !existing[0]?.description?.trim()) {
        // Reuse-by-name, and the existing row has no description while this
        // epoch's proposals do (nmemo-86z's open decision, decided FILL-IF-NULL):
        //  - never overwrite a description that exists  → first-write-wins for
        //    content, so repeated epochs do not thrash the text or the vector;
        //  - fill one that is absent                    → an entity minted before
        //    this fix, or reused before any proposal carried a summary, is not
        //    permanently stuck with a bare-name vector.
        // Monotone and idempotent: once set, later epochs take neither branch.
        // The vector is already computed out-of-tx for every entitiesToMint row,
        // so the re-embed costs no extra ML call.
        await tx
          .update(entities)
          .set({ description: e.summary })
          .where(eq(entities.id, id));
        if (vec && vec.length > 0) {
          await tx.execute(sql`UPDATE public.entities SET embedding = ${vectorLiteral(vec)}::vector WHERE id = ${id}::uuid`);
        }
      }
      mintedEntityIds[e.clusterKey] = id;
    }

    // (a2) Fill descriptions on entities that already existed (nmemo-86z). The
    // `IS NULL` re-check lives in the UPDATE itself, so this is fill-if-null
    // atomically — never an overwrite, and idempotent on replay.
    for (const f of fillTargets) {
      const filled = await tx.execute(sql`
        UPDATE public.entities
           SET description = ${f.summary}
         WHERE id = ${f.canonicalId}::uuid
           AND (description IS NULL OR btrim(description) = '')
        RETURNING id
      `);
      // Re-embed ONLY when the UPDATE actually landed. RETURNING rather than the
      // driver's row count because the fallback direction matters: if the fill
      // did not land, the row's description is something else, and writing a
      // vector composed from OUR summary would decouple the vector from the text
      // it claims to represent. `fillEmbeddings` is empty unless the flag makes
      // the vector description-dependent, so this is a no-op when it is off.
      const landed = (filled as unknown as unknown[]).length > 0;
      const vec = fillEmbeddings.get(f.canonicalId);
      if (landed && vec && vec.length > 0) {
        await tx.execute(sql`UPDATE public.entities SET embedding = ${vectorLiteral(vec)}::vector WHERE id = ${f.canonicalId}::uuid`);
      }
    }

    const resolveId = (ref: ResolvedRef): string =>
      ref.kind === 'canonical' ? ref.id : mintedEntityIds[ref.key]!;

    // (b) Insert facts. Each fact is minted with a fresh id; an inserted-inactive
    // fact (lost group supersession to a peer) lands already-expired and gets both
    // a 'created' and a 'superseded' audit row so history is truthful.
    for (let i = 0; i < plan.factsToInsert.length; i++) {
      const f = plan.factsToInsert[i]!;
      // Use the pre-minted id so the out-of-tx embedding maps to the row we
      // insert. Every index is populated now that embedding is unconditional, so
      // there is deliberately no `?? randomUUID()` fallback: that fallback would
      // silently mint a fact with a NULL fact_embedding — the exact failure
      // nmemo-vga was about — instead of failing.
      const factId = factIdByIndex[i]!;
      const subjectId = resolveId(f.subjectRef);
      const objectId = f.objectRef ? resolveId(f.objectRef) : null;
      const expiredAt = f.active ? null : new Date();
      // doc 35 §2: reconstruct the fact's parent window id from the staged
      // (source_id, chunk_index) — pure windowPointId, no Qdrant read — so the
      // epoch path stamps source_memory_id + a fact_sources row like the serial
      // path did once its injection was fixed. null when the source boundary was
      // not staged (leaves source_memory_id NULL, exactly as before).
      const windowId =
        f.sourceId != null && f.chunkIndex != null ? windowPointId(f.sourceId, f.chunkIndex) : null;
      await tx.insert(facts).values({
        id: factId,
        subjectEntityId: subjectId,
        predicate: f.predicate,
        objectEntityId: objectId,
        objectValue: objectId ? null : f.objectValue,
        validAt: f.validAt,
        confidence: f.confidence,
        sourceText: f.reasoning,
        sourceMemoryId: windowId,
        extractionMethod: 'llm',
        expiredAt,
        expireReason: f.expireReason,
        // mig 052 composite FK pins a fact's endpoints into its own corpus, so this must
        // match the entities minted above or the insert is rejected (23503).
        corpusId,
      });
      // doc 35 §2: per-source evidentiary row (fact -> window). No-ops when
      // windowId is null. source_text is the proposer's reasoning here (the epoch
      // path emits no verbatim span), so unit-grained fact_units offset spans stay
      // a Phase-4 extraction change; fact_sources + source_memory_id are the
      // Phase-1 lineage this path gains.
      await recordFactSource(tx, factId, windowId, f.reasoning, f.confidence);
      // nmemo-uhp.14: populate fact_embedding on the epoch path too (aligns with
      // the serial createFact path). Guarded ⇒ NULL exactly as before when off.
      const factVec = factEmbeddings.get(factId);
      if (factVec && factVec.length > 0) {
        await tx.execute(sql`UPDATE public.facts SET fact_embedding = ${vectorLiteral(factVec)}::vector WHERE id = ${factId}::uuid`);
      }
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
            corpusId,
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
            corpusId,
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
              corpusId,
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
  const corpusId = opts.corpusId ?? 'default';
  const { prior, staged, mode } = await loadPromotionInputs(epochId, corpusId);

  // Canonicalize staged predicates against the registry BEFORE planning (doc 42
  // §7, PC4 — "the spine"). Mutates StagedFact.predicate to the canonical string,
  // so tripleKey, the prior-canonical index, exclusive-group supersession, and the
  // written facts.predicate all key on the canonical predicate. Deterministic and
  // ml-down safe (keeps raw predicates if resolve is unreachable).
  //
  // Gated OFF by default (doc 41 §7: 3.7% reduction vs a 60% bar, 0.43 merge
  // precision — net-harmful as calibrated). Until then the fold was called
  // unconditionally and only stayed harmless because the registry had no
  // embeddings; running the backfill silently armed it. The skip is logged, not
  // silent, so a reader of the epoch log can see the fold did not run.
  if (!(opts.foldPredicates ?? config.PREDICATE_FOLD_ENABLED)) {
    console.log(
      `[promotion] epoch=${epochId.slice(0, 8)} predicates: fold SKIPPED ` +
        `(PREDICATE_FOLD_ENABLED=false; doc 41 §7 — predicates kept raw)`,
    );
  } else {
    const predStats = await canonicalizeStagedPredicates(staged.facts, staged.entities);
    if (predStats.reused + predStats.minted + predStats.deferred > 0) {
      console.log(
        `[promotion] epoch=${epochId.slice(0, 8)} predicates: reused=${predStats.reused} ` +
          `minted=${predStats.minted} deferred=${predStats.deferred}`,
      );
    }
  }

  // Pass 1: deterministic plan that SURFACES escalations (conservative defaults).
  // `mode` (D5) is threaded in as data — a comparative corpus escalates the
  // word-prefix single-match instead of binding; default corpus is unchanged.
  const firstPass = planPromotion(prior, staged, [], mode);

  // Resolve escalations to verdicts, then RE-PLAN with them so the applied plan
  // reflects the arbiter's dispositions (doc 41 §8a.5; "arbiter decides, promotion
  // executes"). No escalations → the first plan is applied unchanged.
  let plan = firstPass;
  if (firstPass.escalations.length > 0) {
    const verdicts = await resolveEscalations(epochId, prior, staged, firstPass.escalations, {
      invokeArbiter: opts.invokeArbiter,
    });
    if (verdicts.length > 0) {
      plan = planPromotion(prior, staged, verdicts, mode);
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

  const result = await applyPromotion(epochId, plan, corpusId);

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
