/**
 * Causal Service
 *
 * Write and read functions for Graph C (causal graph).
 * Every edge requires reasoning (TEXT NOT NULL) and source_references (JSONB NOT NULL).
 */

import { db, type Tx } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { causalEdges, causalEvents, edgeSourceRefs, type CausalEvent, type CausalEdge } from '../db/schema.js';
import { eq, and, gte, lte, sql, or, inArray, isNull } from 'drizzle-orm';
import {
  recordEdgeChange,
  syncEdgeSourceRefs,
  jsonbLiteral,
  unwrapRows,
  type Actor,
  type SourceReference,
} from './audit.js';
import type { SeveritySummary } from './impact.js';

export type { SourceReference };

export interface CreateCausalEdgeParams {
  causeEventId: string;
  effectEventId: string;
  strength: number;
  reasoning: string;
  sourceReferences: SourceReference[];
  extractionMethod?: string;
  temporalSpan?: string;
  sourceMemoryId?: string;
  sourceText?: string;
  patternId?: string;
  patternPosition?: number;

  // Phase 1 audit context — REQUIRED.
  actor: Actor;
  reasoningReportId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Corroboration strength bump per re-assertion (Phase 2 — doc 13).
 * Diminishing returns are enforced by the 1.0 cap, not by varying this delta.
 */
const CORROBORATION_STRENGTH_DELTA = 0.05;

function sourceRefKey(ref: SourceReference): string {
  return `${ref.type}:${ref.id}`;
}

/**
 * Merge two source-reference arrays, deduplicating by `${type}:${id}`. Returns
 * the merged array (existing first, then new unique refs in input order) plus
 * the diff — the refs from `added` that were not already present, used for the
 * `added_source_refs` column on the corroborated audit row.
 */
function mergeSourceReferences(
  existing: SourceReference[],
  added: SourceReference[],
): { merged: SourceReference[]; addedDiff: SourceReference[] } {
  const seen = new Set(existing.map(sourceRefKey));
  const merged: SourceReference[] = [...existing];
  const addedDiff: SourceReference[] = [];
  for (const ref of added) {
    const key = sourceRefKey(ref);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(ref);
      addedDiff.push(ref);
    }
  }
  return { merged, addedDiff };
}

/**
 * Apply the corroboration update + audit to an already-locked active edge.
 * Caller is responsible for selecting `existing` with `FOR UPDATE` inside the
 * same transaction so concurrent corroborations of the same target serialise
 * behind the row lock instead of racing.
 */
async function applyCorroboration(
  tx: typeof db,
  existing: { id: string; strength: number; source_references: unknown },
  params: CreateCausalEdgeParams,
): Promise<string> {
  const prevRefs = Array.isArray(existing.source_references)
    ? (existing.source_references as SourceReference[])
    : [];
  const { merged, addedDiff } = mergeSourceReferences(prevRefs, params.sourceReferences);
  const prevStrength = Number(existing.strength);
  const newStrength = Math.min(1.0, prevStrength + CORROBORATION_STRENGTH_DELTA);

  await tx.execute(sql`
    UPDATE public.causal_edges
    SET strength = ${newStrength},
        corroboration_count = corroboration_count + 1,
        last_corroborated = NOW(),
        source_references = ${jsonbLiteral(merged)}
    WHERE id = ${existing.id}::uuid
  `);

  await recordEdgeChange({
    edgeId: existing.id,
    eventType: 'corroborated',
    previousStrength: prevStrength,
    newStrength,
    addedSourceRefs: addedDiff,
    reasoning: params.reasoning,
    actor: params.actor,
    reasoningReportId: params.reasoningReportId ?? null,
    tx,
  });

  await syncEdgeSourceRefs(existing.id, addedDiff, tx);

  return existing.id;
}

/**
 * Create a causal edge between two causal events, or corroborate an existing
 * active edge that represents the same causal claim.
 *
 * Corroboration runs in two stages (doc 13 part A):
 *   1. **Exact match** on `(cause_event_id, effect_event_id)`.
 *   2. **Semantic match** — same `(subject_entity_id, predicate)` on cause AND
 *      effect via different events. Strongest active candidate wins,
 *      tiebreak by earliest `created_at`.
 *
 * On either match, the existing edge is updated:
 *   - strength += 0.05 capped at 1.0
 *   - corroboration_count += 1
 *   - last_corroborated = NOW()
 *   - source_references merged (dedup by type+id)
 *   - causal_edge_history row with event_type='corroborated'
 *
 * Validates reasoning, source references, and event existence on all paths.
 */
/** Graph S → Graph C transition vocabulary for a minted causal event. */
export type CausalTransitionType = 'created' | 'strengthened' | 'weakened' | 'expired' | 'invalidated';

export interface MintCausalEventParams {
  factId: string;
  transitionType: CausalTransitionType;
  subjectEntityId: string;
  predicate: string;
  deltaConfidence?: number | null;
  sourceMemoryId?: string | null;
  sourceText?: string | null;
}

/**
 * Mint a causal event for a SETTLED Graph S fact transition, inside the caller's
 * transaction (doc 41 §12 #5; bead nmemo-vpz.6 / E6).
 *
 * Promotion calls this for every settled active-fact mutation it applies, keyed to
 * the stable fact id — so the post-promotion causal pass only ever sees settled
 * event ids and the repointing / `expired_but_cited` debt is designed out, not
 * patched. Unlike the fire-and-forget `createCausalEvent` in facts.ts (the legacy
 * lazy path), this runs ON the promotion tx and PROPAGATES failure: a bad mint
 * rolls the whole promotion back, because minting is part of the deterministic
 * backbone, not best-effort. (Consolidate facts.ts:createCausalEvent into this when
 * the legacy create_fact path retires — E7.)
 */
export async function mintCausalEvent(tx: Tx, params: MintCausalEventParams): Promise<string> {
  const result = await tx
    .insert(causalEvents)
    .values({
      factId: params.factId,
      transitionType: params.transitionType,
      subjectEntityId: params.subjectEntityId,
      predicate: params.predicate,
      deltaConfidence: params.deltaConfidence ?? null,
      sourceMemoryId: params.sourceMemoryId ?? null,
      sourceText: params.sourceText ?? null,
    })
    .returning({ id: causalEvents.id });
  const id = result[0]?.id;
  if (!id) throw new Error('mintCausalEvent: INSERT returned no row');
  return id;
}

export async function createCausalEdge(params: CreateCausalEdgeParams): Promise<string> {
  // --- Validation ---

  if (!params.reasoning || params.reasoning.trim().length === 0) {
    throw new Error('reasoning must be a non-empty string');
  }

  if (!Array.isArray(params.sourceReferences) || params.sourceReferences.length === 0) {
    throw new Error('sourceReferences must be a non-empty array');
  }

  for (const ref of params.sourceReferences) {
    if (!['memory', 'fact', 'entity'].includes(ref.type)) {
      throw new Error(`sourceReference type must be 'memory', 'fact', or 'entity', got '${ref.type}'`);
    }
    if (!ref.id || !UUID_RE.test(ref.id)) {
      throw new Error(`sourceReference id must be a valid UUID, got '${ref.id}'`);
    }
    if (!ref.relevance || ref.relevance.trim().length === 0) {
      throw new Error('sourceReference relevance must be a non-empty string');
    }
  }

  if (params.causeEventId === params.effectEventId) {
    throw new Error('causeEventId and effectEventId must be different (no self-loops)');
  }

  if (params.strength < 0 || params.strength > 1) {
    throw new Error('strength must be between 0.0 and 1.0');
  }

  const existingEvents = await db
    .select({ id: causalEvents.id })
    .from(causalEvents)
    .where(inArray(causalEvents.id, [params.causeEventId, params.effectEventId]));
  const existingIds = new Set(existingEvents.map((r) => r.id));
  if (!existingIds.has(params.causeEventId)) {
    throw new Error(`causeEventId '${params.causeEventId}' does not reference an existing causal event`);
  }
  if (!existingIds.has(params.effectEventId)) {
    throw new Error(`effectEventId '${params.effectEventId}' does not reference an existing causal event`);
  }

  // --- Corroborate-or-insert + audit (same transaction) ---
  // Drizzle 0.29 + postgres.js 3.4 stringify jsonb array values when passed
  // through `.values({ ... })` inside a tx callback (jsonb_typeof lands as
  // 'string' instead of 'array'). Outside a tx the same construction
  // serialises correctly. Workaround: perform the INSERT with a raw SQL
  // template (which postgres.js JSON-encodes once and casts server-side
  // with ::jsonb) inside the tx, then chain the audit write. See
  // docs/handoff/phase1-findings.md for the investigation notes.

  const edgeId = await db.transaction(async (tx) => {
    // Step 1: exact-match corroboration. SELECT … FOR UPDATE so two
    // concurrent corroborations of the same pair serialise behind the row
    // lock instead of racing into a duplicate edge.
    const exactResult = await tx.execute(sql`
      SELECT id, strength, source_references
      FROM public.causal_edges
      WHERE cause_event_id = ${params.causeEventId}::uuid
        AND effect_event_id = ${params.effectEventId}::uuid
        AND expired_at IS NULL
      LIMIT 1
      FOR UPDATE
    `);
    const exactMatch = unwrapRows<{ id: string; strength: number; source_references: unknown }>(
      exactResult,
    )[0];

    if (exactMatch) {
      return applyCorroboration(tx as unknown as typeof db, exactMatch, params);
    }

    // Step 2: semantic-match corroboration. Two distinct (cause, effect)
    // event pairs that share `(subject_entity_id, predicate)` on both ends
    // describe the same causal claim — corroborate instead of branching.
    // JOIN equality naturally excludes NULL metadata; the IS NOT NULL
    // guards make that explicit and avoid surprising matches if the join
    // semantics ever shift. ORDER BY strength DESC, created_at ASC so the
    // strongest, oldest candidate wins (stable across runs).
    const semanticResult = await tx.execute(sql`
      WITH new_cause AS (
        SELECT subject_entity_id, predicate
        FROM public.causal_events
        WHERE id = ${params.causeEventId}::uuid
      ),
      new_effect AS (
        SELECT subject_entity_id, predicate
        FROM public.causal_events
        WHERE id = ${params.effectEventId}::uuid
      )
      SELECT e.id, e.strength, e.source_references
      FROM public.causal_edges e
      JOIN public.causal_events ce ON ce.id = e.cause_event_id
      JOIN public.causal_events ee ON ee.id = e.effect_event_id
      JOIN new_cause nc
        ON ce.subject_entity_id = nc.subject_entity_id
       AND ce.predicate = nc.predicate
      JOIN new_effect ne
        ON ee.subject_entity_id = ne.subject_entity_id
       AND ee.predicate = ne.predicate
      WHERE e.expired_at IS NULL
        AND nc.subject_entity_id IS NOT NULL
        AND nc.predicate IS NOT NULL
        AND ne.subject_entity_id IS NOT NULL
        AND ne.predicate IS NOT NULL
      ORDER BY e.strength DESC, e.created_at ASC
      LIMIT 1
      FOR UPDATE OF e
    `);
    const semanticMatch = unwrapRows<{ id: string; strength: number; source_references: unknown }>(
      semanticResult,
    )[0];

    if (semanticMatch) {
      return applyCorroboration(tx as unknown as typeof db, semanticMatch, params);
    }

    // Step 3: no match — INSERT new edge.
    const inserted = await tx.execute(sql`
      INSERT INTO public.causal_edges (
        cause_event_id, effect_event_id, strength, reasoning,
        source_references, extraction_method, temporal_span, initial_strength,
        source_memory_id, source_text, pattern_id, pattern_position
      ) VALUES (
        ${params.causeEventId}::uuid,
        ${params.effectEventId}::uuid,
        ${params.strength},
        ${params.reasoning},
        ${jsonbLiteral(params.sourceReferences)},
        ${params.extractionMethod ?? 'llm'},
        ${params.temporalSpan ?? null},
        ${params.strength},
        ${params.sourceMemoryId ?? null}::uuid,
        ${params.sourceText ?? null},
        ${params.patternId ?? null}::uuid,
        ${params.patternPosition ?? null}
      ) RETURNING id
    `);

    const edgeId = unwrapRows<{ id: string }>(inserted)[0]?.id;
    if (!edgeId) throw new Error('createCausalEdge: INSERT returned no row');

    await recordEdgeChange({
      edgeId,
      eventType: 'created',
      newStrength: params.strength,
      newReasoning: params.reasoning,
      addedSourceRefs: params.sourceReferences,
      reasoning: params.reasoning,
      actor: params.actor,
      reasoningReportId: params.reasoningReportId ?? null,
      tx,
    });

    await syncEdgeSourceRefs(edgeId, params.sourceReferences, tx);

    return edgeId;
  });

  // Phase 6 (nmemo-d9v.8): fire-and-forget pattern matching. Wrapped in a
  // catch so any failure (DB hiccup, missing pattern data, edge already
  // linked) logs but never surfaces back into edge creation.
  void import('./causal-patterns.js')
    .then(({ matchEdgeToPattern }) => matchEdgeToPattern(edgeId))
    .catch((err) => {
      console.warn(
        '[matchEdgeToPattern] failed for edge',
        edgeId + ':',
        err instanceof Error ? err.message : err,
      );
    });

  return edgeId;
}

// ============================================
// Edge mutation helpers — Phase 1 lifecycle events
// ============================================

export interface ExpireCausalEdgeParams {
  edgeId: string;
  reasoning: string;
  actor: Actor;
  reasoningReportId?: string | null;
  /** Free-text reason persisted on causal_edges.expire_reason (defaults to `reasoning`). */
  expireReason?: string;
  /**
   * Optional outer transaction. When supplied, the UPDATE + edge_history
   * write run on this tx; when omitted, expireCausalEdge opens its own
   * transaction (existing behaviour). See bead nmemo-2yv.38.
   */
  tx?: Tx;
  /**
   * Pre-mutation blast-radius severitySummary captured at the policy
   * boundary (handleToolCall for agent-initiated edge expiry,
   * resolveContradiction for mutating edge resolutions). Persisted onto the
   * causal_edge_history row. NULL for cascade-internal callers. See bead
   * nmemo-2yv.102.
   */
  preExpireBlastRadius?: SeveritySummary | null;
}

/**
 * Expire a causal edge (soft-delete via expired_at). Writes a
 * causal_edge_history row with event_type='expired' in the same transaction.
 * No-op if the edge is already expired or doesn't exist.
 */
export async function expireCausalEdge(params: ExpireCausalEdgeParams): Promise<void> {
  const {
    edgeId,
    reasoning,
    actor,
    reasoningReportId = null,
    expireReason,
    tx: outerTx,
    preExpireBlastRadius = null,
  } = params;
  const reader = outerTx ?? db;

  const existing = await reader
    .select({ strength: causalEdges.strength, reasoning: causalEdges.reasoning })
    .from(causalEdges)
    .where(and(eq(causalEdges.id, edgeId), isNull(causalEdges.expiredAt)))
    .limit(1);

  if (!existing[0]) return;

  const runUpdate = async (tx: Tx): Promise<void> => {
    await tx
      .update(causalEdges)
      .set({ expiredAt: new Date(), expireReason: expireReason ?? reasoning })
      .where(and(eq(causalEdges.id, edgeId), isNull(causalEdges.expiredAt)));

    await recordEdgeChange({
      edgeId,
      eventType: 'expired',
      previousStrength: existing[0]!.strength ?? null,
      newStrength: existing[0]!.strength ?? null,
      previousReasoning: existing[0]!.reasoning ?? null,
      reasoning,
      actor,
      reasoningReportId,
      tx,
      preExpireBlastRadius,
    });
  };

  if (outerTx) {
    await runUpdate(outerTx);
  } else {
    await db.transaction(runUpdate);
  }
}

export interface ReviseCausalEdgeParams {
  edgeId: string;
  /** Required narrative justification for the revision itself. */
  reasoning: string;
  actor: Actor;
  /** New strength value (optional — omit to keep current). */
  newStrength?: number;
  /** New on-edge reasoning text (optional — omit to keep current). */
  newReasoning?: string;
  /** Additional source references appended to the edge. */
  addedSourceRefs?: SourceReference[];
  reasoningReportId?: string | null;
  /** Optional outer transaction; see ExpireCausalEdgeParams.tx for rationale. */
  tx?: Tx;
}

/**
 * Revise a causal edge — update strength and/or on-edge reasoning, and
 * optionally append source references. Writes a causal_edge_history row with
 * event_type='revised' in the same transaction.
 *
 * @throws if the edge does not exist, is expired, or newStrength is out of range.
 */
export async function reviseCausalEdge(params: ReviseCausalEdgeParams): Promise<void> {
  const { edgeId, reasoning, actor, newStrength, newReasoning, addedSourceRefs, reasoningReportId = null, tx: outerTx } = params;
  const reader = outerTx ?? db;

  if (newStrength !== undefined && (newStrength < 0 || newStrength > 1)) {
    throw new Error('newStrength must be between 0 and 1');
  }

  const existing = await reader
    .select({
      strength: causalEdges.strength,
      reasoning: causalEdges.reasoning,
      sourceReferences: causalEdges.sourceReferences,
    })
    .from(causalEdges)
    .where(and(eq(causalEdges.id, edgeId), isNull(causalEdges.expiredAt)))
    .limit(1);

  if (!existing[0]) {
    throw new Error(`reviseCausalEdge: edge ${edgeId} not found or already expired`);
  }

  const prevStrength = existing[0].strength ?? 0;
  const prevReasoning = existing[0].reasoning;
  const prevRefs = Array.isArray(existing[0].sourceReferences) ? existing[0].sourceReferences : [];

  const mergedRefs: SourceReference[] = addedSourceRefs && addedSourceRefs.length > 0
    ? [...(prevRefs as SourceReference[]), ...addedSourceRefs]
    : (prevRefs as SourceReference[]);

  const runUpdate = async (tx: Tx): Promise<void> => {
    await tx.execute(sql`
      UPDATE public.causal_edges
      SET strength = ${newStrength ?? prevStrength},
          reasoning = ${newReasoning ?? prevReasoning},
          source_references = ${jsonbLiteral(mergedRefs)}
      WHERE id = ${edgeId}::uuid
    `);

    await recordEdgeChange({
      edgeId,
      eventType: 'revised',
      previousStrength: prevStrength,
      newStrength: newStrength ?? prevStrength,
      previousReasoning: prevReasoning,
      newReasoning: newReasoning ?? prevReasoning,
      addedSourceRefs: addedSourceRefs ?? null,
      reasoning,
      actor,
      reasoningReportId,
      tx,
    });

    if (addedSourceRefs && addedSourceRefs.length > 0) {
      await syncEdgeSourceRefs(edgeId, addedSourceRefs, tx);
    }
  };

  if (outerTx) {
    await runUpdate(outerTx);
  } else {
    await db.transaction(runUpdate);
  }
}

// ============================================
// Cascade — Phase 2 part C (doc 13)
// ============================================

/**
 * Cascade weaken-or-expire ratio. Edges with corroboration_count > 1 lose
 * 20% of their strength when an upstream fact dies; sole-source edges are
 * tombstoned outright.
 */
const CASCADE_WEAKEN_FACTOR = 0.8;
const CASCADE_STRENGTH_FLOOR = 0.1;

export interface CascadeResult {
  /** Edge ids whose strength was reduced because they had other corroboration. */
  weakened: string[];
  /** Edge ids that were expired because the dying fact was the sole source. */
  expired: string[];
}

/**
 * Cascade fact expiry/invalidation to causal edges that cited the fact as
 * evidence. Active edges only — already-expired edges are skipped (the
 * underlying findEdgesCitingReference filters by `expired_at IS NULL`).
 *
 *   - corroboration_count > 1: weaken by 20% (floor 0.1), audit `weakened`
 *   - corroboration_count = 1: expire with reason `upstream fact … expired`,
 *                              audit `expired`
 *
 * Each per-edge mutation runs in its own transaction so the UPDATE and
 * audit row commit atomically. Per-edge granularity (not whole cascade)
 * matches `applyConfidenceDecay` and avoids long write transactions on
 * fact expirations with many downstream edges. A failure mid-cascade
 * leaves earlier edges fully transitioned and later edges untouched —
 * acceptable for a best-effort cleanup; surface for the reasoning agent
 * to repair on next patrol.
 *
 * Audit rows always carry `actor='cascade'` (regardless of who triggered
 * the upstream fact change) to make cascade-driven mutations distinct
 * from direct edits.
 */
export async function cascadeFactExpiry(
  factId: string,
  options: { reasoningReportId?: string | null } = {},
): Promise<CascadeResult> {
  const reasoningReportId = options.reasoningReportId ?? null;
  const affected = await findEdgesCitingReference('fact', factId);

  const weakened: string[] = [];
  const expired: string[] = [];

  for (const edge of affected) {
    if (edge.corroborationCount > 1) {
      const newStrength = Math.max(CASCADE_STRENGTH_FLOOR, edge.strength * CASCADE_WEAKEN_FACTOR);
      await db.transaction(async (tx) => {
        await tx
          .update(causalEdges)
          .set({ strength: newStrength })
          .where(eq(causalEdges.id, edge.id));
        await recordEdgeChange({
          edgeId: edge.id,
          eventType: 'weakened',
          previousStrength: edge.strength,
          newStrength,
          reasoning: `Upstream fact ${factId} was expired/invalidated; edge has other corroboration so weakened by ${Math.round((1 - CASCADE_WEAKEN_FACTOR) * 100)}%`,
          actor: 'cascade',
          reasoningReportId,
          tx,
        });
      });
      weakened.push(edge.id);
    } else {
      await db.transaction(async (tx) => {
        await tx
          .update(causalEdges)
          .set({ expiredAt: new Date(), expireReason: `upstream fact ${factId} expired` })
          .where(eq(causalEdges.id, edge.id));
        await recordEdgeChange({
          edgeId: edge.id,
          eventType: 'expired',
          previousStrength: edge.strength,
          newStrength: edge.strength,
          reasoning: `Upstream fact ${factId} expired/invalidated; this was the sole source of evidence for this edge`,
          actor: 'cascade',
          reasoningReportId,
          tx,
        });
      });
      expired.push(edge.id);
    }
  }

  return { weakened, expired };
}

// ============================================
// Confidence decay — Phase 2 part B (doc 13)
// ============================================

const DEFAULT_DECAY_RATE = 0.95;
const DEFAULT_DECAY_FLOOR = 0.1;
const DEFAULT_DECAY_AGE_DAYS = 30;

export interface ApplyConfidenceDecayOptions {
  /** Multiplier applied per cycle. Must be in (0, 1). Default 0.95. */
  rate?: number;
  /** Strength threshold at which an edge is expired instead of decayed.
   *  Must be in (0, 1). Default 0.1. */
  floor?: number;
  /** Stale threshold in days since last_corroborated. Must be > 0. Default 30. */
  ageDays?: number;
  /** Audit actor on the resulting history rows. Default 'system_trigger'. */
  actor?: Actor;
}

export interface DecayResult {
  decayed: number;
  expired: number;
  decayedEdgeIds: string[];
  expiredEdgeIds: string[];
}

function readDecayEnv(name: string, fallback: number, valid: (n: number) => boolean): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !valid(parsed)) {
    console.warn(`[decay] ignoring invalid ${name}=${JSON.stringify(raw)}; using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

function resolveDecayConfig(options: ApplyConfidenceDecayOptions): {
  rate: number;
  floor: number;
  ageDays: number;
  actor: Actor;
} {
  const rate = options.rate ?? readDecayEnv('MNEMO_DECAY_RATE', DEFAULT_DECAY_RATE, (n) => n > 0 && n < 1);
  const floor = options.floor ?? readDecayEnv('MNEMO_DECAY_FLOOR', DEFAULT_DECAY_FLOOR, (n) => n > 0 && n < 1);
  const ageDays =
    options.ageDays ?? readDecayEnv('MNEMO_DECAY_AGE_DAYS', DEFAULT_DECAY_AGE_DAYS, (n) => n > 0);
  return { rate, floor, ageDays, actor: options.actor ?? 'system_trigger' };
}

/**
 * Fade uncorroborated, stale, LLM-asserted causal edges. Each qualifying
 * edge is decayed by `rate` (or expired if `strength * rate <= floor`). Every
 * transition writes a `causal_edge_history` row in the same per-edge
 * transaction as the strength update.
 *
 * Configuration resolution order: `options` arg → env var → default.
 *   - rate     ← MNEMO_DECAY_RATE     (default 0.95, must be in (0, 1))
 *   - floor    ← MNEMO_DECAY_FLOOR    (default 0.10, must be in (0, 1))
 *   - ageDays  ← MNEMO_DECAY_AGE_DAYS (default 30,   must be > 0)
 *
 * Qualifying filter (doc 13 part B):
 *   - expired_at IS NULL
 *   - corroboration_count <= 1     (never reinforced)
 *   - last_corroborated < NOW() - INTERVAL 'ageDays days'
 *   - strength > floor             (above floor; otherwise ready to expire)
 *   - extraction_method = 'llm'    (don't decay user-asserted edges)
 *
 * Concurrency: candidates are loaded read-only, then each row is locked
 * with `FOR UPDATE` inside its own transaction and the qualifying filter
 * is re-checked. If another worker corroborated/decayed the edge between
 * the candidate scan and the lock, the row is silently skipped.
 */
export async function applyConfidenceDecay(
  options: ApplyConfidenceDecayOptions = {},
): Promise<DecayResult> {
  const { rate, floor, ageDays, actor } = resolveDecayConfig(options);

  // Reasoning strings are precomputed because every audit row in this run
  // shares the same rate / floor / ageDays values.
  const decayedReasoning =
    `decayed by ${((1 - rate) * 100).toFixed(1)}% after ${ageDays}+ days without corroboration`;
  const expiredReasoning =
    `confidence decayed to floor (${floor}) without corroboration for ${ageDays}+ days`;

  // Single-statement decay cycle. The CTE chain is:
  //   1. `to_decay`  — snapshot eligible rows + computed new_strength + will_expire
  //   2. `updated`   — UPDATE causal_edges in one statement (row locks acquired
  //                    in a single sweep; UPDATE WHERE re-evaluates the
  //                    qualifier against the committed state, so any row a
  //                    concurrent corroboration moved out of scope is dropped)
  //   3. INSERT INTO causal_edge_history — one bulk audit insert
  // Returns (edge_id, event_type) for each row touched so the caller can
  // partition decayed vs expired.
  const result = await db.transaction(async (tx) => {
    return tx.execute(sql`
      WITH to_decay AS (
        SELECT
          id,
          strength AS prev_strength,
          GREATEST(${floor}, strength * ${rate}) AS new_strength,
          (GREATEST(${floor}, strength * ${rate}) <= ${floor}) AS will_expire
        FROM public.causal_edges
        WHERE expired_at IS NULL
          AND corroboration_count <= 1
          AND last_corroborated < NOW() - (${ageDays} * INTERVAL '1 day')
          AND strength > ${floor}
          AND extraction_method = 'llm'
      ),
      updated AS (
        UPDATE public.causal_edges e
        SET strength = t.new_strength,
            decay_applied = true,
            expired_at = CASE WHEN t.will_expire THEN NOW() ELSE e.expired_at END,
            expire_reason = CASE WHEN t.will_expire THEN 'confidence decay' ELSE e.expire_reason END
        FROM to_decay t
        WHERE e.id = t.id
        RETURNING e.id, t.prev_strength, t.new_strength, t.will_expire
      )
      INSERT INTO public.causal_edge_history (
        edge_id, event_type, previous_strength, new_strength, reasoning, actor
      )
      SELECT
        id,
        CASE WHEN will_expire THEN 'expired' ELSE 'decayed' END AS event_type,
        prev_strength,
        new_strength,
        CASE WHEN will_expire THEN ${expiredReasoning} ELSE ${decayedReasoning} END,
        ${actor}
      FROM updated
      RETURNING edge_id, event_type
    `);
  });

  const rows = unwrapRows<{ edge_id: string; event_type: string }>(result);
  const decayedEdgeIds: string[] = [];
  const expiredEdgeIds: string[] = [];
  for (const r of rows) {
    if (r.event_type === 'expired') expiredEdgeIds.push(r.edge_id);
    else decayedEdgeIds.push(r.edge_id);
  }

  return {
    decayed: decayedEdgeIds.length,
    expired: expiredEdgeIds.length,
    decayedEdgeIds,
    expiredEdgeIds,
  };
}

// ============================================
// Read / Query Functions
// ============================================

export interface CausalChainNode {
  event: CausalEvent;
  edge?: CausalEdge; // the edge that connects this node to the next in the chain
}

export interface TraceOptions {
  maxDepth?: number;
  minStrength?: number;
}

/**
 * Walk Graph C backwards from a fact's causal event to root causes.
 * Returns the chain from root cause → ... → starting event.
 *
 * Cycle protection: each chain row carries a `path uuid[]` accumulator of
 * visited event ids. The recursive step is guarded by
 * `NOT (parent.id = ANY(chain.path))`, which prevents the walk from
 * revisiting an event reached earlier on the same branch. Diamond topology
 * (one event reached via legitimately different ancestors) still produces
 * separate branches because each branch carries its own `path`. Defends
 * against the cycle case (A→B + B→A without temporal_span) confirmed by
 * Phase 5's `detectCyclicCausal`. Pattern matches Phase 4
 * `findTransitiveChains` (`src/services/impact.ts`).
 */
export async function traceCauses(
  factId: string,
  options: TraceOptions = {},
): Promise<CausalChainNode[]> {
  const { maxDepth = 10, minStrength = 0 } = options;

  const rows = await rawQuery<{
    eventId: string;
    factId: string | null;
    transitionType: string;
    subjectEntityId: string | null;
    predicate: string | null;
    deltaConfidence: number | null;
    occurredAt: Date;
    sourceMemoryId: string | null;
    sourceText: string | null;
    createdAt: Date;
    edgeId: string | null;
    causeEventId: string | null;
    effectEventId: string | null;
    strength: number | null;
    reasoning: string | null;
    sourceReferences: unknown;
    extractionMethod: string | null;
    depth: number;
  }>(sql`
    WITH RECURSIVE chain AS (
      -- Base: the event for this fact
      SELECT
        ce.id as event_id,
        ce.fact_id, ce.transition_type, ce.subject_entity_id,
        ce.predicate, ce.delta_confidence, ce.occurred_at,
        ce.source_memory_id, ce.source_text, ce.created_at,
        NULL::uuid as edge_id,
        NULL::uuid as cause_event_id,
        NULL::uuid as effect_event_id,
        NULL::float as strength,
        NULL::text as reasoning,
        NULL::jsonb as source_references,
        NULL::varchar as extraction_method,
        0 as depth,
        ARRAY[ce.id] AS path
      FROM causal_events ce
      WHERE ce.fact_id = ${factId}

      UNION ALL

      -- Recurse: follow edges backwards (effect → cause)
      SELECT
        parent.id as event_id,
        parent.fact_id, parent.transition_type, parent.subject_entity_id,
        parent.predicate, parent.delta_confidence, parent.occurred_at,
        parent.source_memory_id, parent.source_text, parent.created_at,
        edge.id as edge_id,
        edge.cause_event_id,
        edge.effect_event_id,
        edge.strength,
        edge.reasoning,
        edge.source_references,
        edge.extraction_method,
        chain.depth + 1 as depth,
        chain.path || parent.id
      FROM chain
      JOIN causal_edges edge ON edge.effect_event_id = chain.event_id
        AND edge.expired_at IS NULL
        AND edge.strength >= ${minStrength}
      JOIN causal_events parent ON parent.id = edge.cause_event_id
      WHERE chain.depth < ${maxDepth}
        AND NOT (parent.id = ANY(chain.path))
    )
    SELECT
      event_id, fact_id, transition_type, subject_entity_id, predicate,
      delta_confidence, occurred_at, source_memory_id, source_text, created_at,
      edge_id, cause_event_id, effect_event_id, strength, reasoning,
      source_references, extraction_method, depth
    FROM chain ORDER BY depth DESC
  `);

  return rows.map(row => ({
    event: {
      id: row.eventId,
      factId: row.factId,
      transitionType: row.transitionType,
      subjectEntityId: row.subjectEntityId,
      predicate: row.predicate,
      deltaConfidence: row.deltaConfidence,
      occurredAt: row.occurredAt,
      sourceMemoryId: row.sourceMemoryId,
      sourceText: row.sourceText,
      createdAt: row.createdAt,
    } as CausalEvent,
    edge: row.edgeId ? {
      id: row.edgeId,
      causeEventId: row.causeEventId!,
      effectEventId: row.effectEventId!,
      strength: row.strength!,
      reasoning: row.reasoning!,
      sourceReferences: row.sourceReferences,
      extractionMethod: row.extractionMethod!,
    } as unknown as CausalEdge : undefined,
  }));
}

/**
 * Walk Graph C forward from a fact's causal event to downstream effects.
 * Returns the chain from starting event → ... → leaf effects.
 *
 * Cycle protection: same `path uuid[]` accumulator as `traceCauses`. Each
 * branch tracks visited event ids; the recursive step is guarded by
 * `NOT (child.id = ANY(chain.path))` to prevent re-entering an event already
 * on the branch. Diamond fan-out is preserved (independent branches see
 * independent paths). Pattern matches Phase 4 `findTransitiveChains`.
 */
export async function projectTrajectory(
  factId: string,
  options: TraceOptions = {},
): Promise<CausalChainNode[]> {
  const { maxDepth = 10, minStrength = 0 } = options;

  const rows = await rawQuery<{
    eventId: string;
    factId: string | null;
    transitionType: string;
    subjectEntityId: string | null;
    predicate: string | null;
    deltaConfidence: number | null;
    occurredAt: Date;
    sourceMemoryId: string | null;
    sourceText: string | null;
    createdAt: Date;
    edgeId: string | null;
    causeEventId: string | null;
    effectEventId: string | null;
    strength: number | null;
    reasoning: string | null;
    sourceReferences: unknown;
    extractionMethod: string | null;
    depth: number;
  }>(sql`
    WITH RECURSIVE chain AS (
      -- Base: the event for this fact
      SELECT
        ce.id as event_id,
        ce.fact_id, ce.transition_type, ce.subject_entity_id,
        ce.predicate, ce.delta_confidence, ce.occurred_at,
        ce.source_memory_id, ce.source_text, ce.created_at,
        NULL::uuid as edge_id,
        NULL::uuid as cause_event_id,
        NULL::uuid as effect_event_id,
        NULL::float as strength,
        NULL::text as reasoning,
        NULL::jsonb as source_references,
        NULL::varchar as extraction_method,
        0 as depth,
        ARRAY[ce.id] AS path
      FROM causal_events ce
      WHERE ce.fact_id = ${factId}

      UNION ALL

      -- Recurse: follow edges forward (cause → effect)
      SELECT
        child.id as event_id,
        child.fact_id, child.transition_type, child.subject_entity_id,
        child.predicate, child.delta_confidence, child.occurred_at,
        child.source_memory_id, child.source_text, child.created_at,
        edge.id as edge_id,
        edge.cause_event_id,
        edge.effect_event_id,
        edge.strength,
        edge.reasoning,
        edge.source_references,
        edge.extraction_method,
        chain.depth + 1 as depth,
        chain.path || child.id
      FROM chain
      JOIN causal_edges edge ON edge.cause_event_id = chain.event_id
        AND edge.expired_at IS NULL
        AND edge.strength >= ${minStrength}
      JOIN causal_events child ON child.id = edge.effect_event_id
      WHERE chain.depth < ${maxDepth}
        AND NOT (child.id = ANY(chain.path))
    )
    SELECT
      event_id, fact_id, transition_type, subject_entity_id, predicate,
      delta_confidence, occurred_at, source_memory_id, source_text, created_at,
      edge_id, cause_event_id, effect_event_id, strength, reasoning,
      source_references, extraction_method, depth
    FROM chain ORDER BY depth ASC
  `);

  return rows.map(row => ({
    event: {
      id: row.eventId,
      factId: row.factId,
      transitionType: row.transitionType,
      subjectEntityId: row.subjectEntityId,
      predicate: row.predicate,
      deltaConfidence: row.deltaConfidence,
      occurredAt: row.occurredAt,
      sourceMemoryId: row.sourceMemoryId,
      sourceText: row.sourceText,
      createdAt: row.createdAt,
    } as CausalEvent,
    edge: row.edgeId ? {
      id: row.edgeId,
      causeEventId: row.causeEventId!,
      effectEventId: row.effectEventId!,
      strength: row.strength!,
      reasoning: row.reasoning!,
      sourceReferences: row.sourceReferences,
      extractionMethod: row.extractionMethod!,
    } as unknown as CausalEdge : undefined,
  }));
}

/**
 * Get all causal events and edges involving an entity.
 */
export async function getEntityCausalHistory(entityId: string): Promise<{
  events: CausalEvent[];
  edges: CausalEdge[];
}> {
  const events = await db
    .select()
    .from(causalEvents)
    .where(eq(causalEvents.subjectEntityId, entityId))
    .orderBy(causalEvents.occurredAt);

  if (events.length === 0) {
    return { events: [], edges: [] };
  }

  const eventIds = events.map(e => e.id);

  // Find all active edges where cause or effect is one of this entity's events
  const edges = await db
    .select()
    .from(causalEdges)
    .where(and(
      isNull(causalEdges.expiredAt),
      or(
        inArray(causalEdges.causeEventId, eventIds),
        inArray(causalEdges.effectEventId, eventIds),
      ),
    ))
    .orderBy(causalEdges.createdAt);

  return { events, edges };
}

/**
 * Get causal events and edges created within a time window.
 */
export async function getCausalDelta(
  from: Date,
  to: Date,
  options: { entityId?: string } = {},
): Promise<{
  events: CausalEvent[];
  edges: CausalEdge[];
}> {
  const eventConditions = [
    gte(causalEvents.createdAt, from),
    lte(causalEvents.createdAt, to),
  ];
  if (options.entityId) {
    eventConditions.push(eq(causalEvents.subjectEntityId, options.entityId));
  }

  const events = await db
    .select()
    .from(causalEvents)
    .where(and(...eventConditions))
    .orderBy(causalEvents.createdAt);

  const edges = await db
    .select()
    .from(causalEdges)
    .where(and(
      gte(causalEdges.createdAt, from),
      lte(causalEdges.createdAt, to),
    ))
    .orderBy(causalEdges.createdAt);

  return { events, edges };
}

/**
 * Reverse lookup over `edge_source_refs` — returns every causal edge that
 * cites the given reference (memory / fact / entity uuid). Used by:
 *   - cascade invalidation (Phase 2): fact F expired → find edges citing F
 *   - blast radius (Phase 4): "what edges depend on this fact?"
 *   - contradiction detection (Phase 5): expired-but-cited
 *   - gardener: "this memory is going away — what loses evidence?"
 *
 * Active edges only by default; pass `includeExpired: true` to include
 * tombstoned edges. Discriminates by `refType`, so a fact UUID and a memory
 * UUID that happen to collide return disjoint result sets.
 */
export async function findEdgesCitingReference(
  refType: 'memory' | 'fact' | 'entity',
  refId: string,
  options: { includeExpired?: boolean } = {},
): Promise<CausalEdge[]> {
  const conditions = [
    eq(edgeSourceRefs.refType, refType),
    eq(edgeSourceRefs.refId, refId),
  ];
  if (!options.includeExpired) {
    conditions.push(isNull(causalEdges.expiredAt));
  }
  const rows = await db
    .select({ edge: causalEdges })
    .from(edgeSourceRefs)
    .innerJoin(causalEdges, eq(edgeSourceRefs.edgeId, causalEdges.id))
    .where(and(...conditions))
    .orderBy(causalEdges.createdAt);
  return rows.map((r) => r.edge);
}
