/**
 * Per-step instrumentation (doc 39 section 2.B, nmemo-hm4.5).
 *
 * PURE, deterministic derivation over the rich graph dump ({@link RichGraph}) -
 * no LLM, no DB. {@link deriveInstrumentation} folds the snapshot into a compact
 * structured record the comparison harness stores per `<arm>.<order>` in
 * metrics.json: contradictions split detected-by-type vs resolved vs dismissed
 * vs left-active, fact supersession (expired vs active, by expire reason),
 * causal-edge active/expired counts, same_as merge signals, and the entity/fact
 * totals.
 *
 * This is the snapshot-derived half of doc 39 section 2.B. The runtime half
 * (per-phase timing, tool-call / retry / 503 counts) is captured separately by
 * the driver from the batch ingest RESPONSE BODY (the per-chunk `timing` already
 * on each {@link ExtractResult}); the two are merged under one `perStep` key.
 *
 * Allowed import: a TYPE-ONLY `RichGraph` (erased at runtime) - so this module
 * never transitively pulls in the DB pool and stays unit-testable under
 * vitest.unit.config.ts.
 */

import type { RichGraph } from './graph-canonical-query.js';

/** Contradiction tallies split by detection type and lifecycle status. */
export interface ContradictionInstrumentation {
  /** All contradiction rows. */
  total: number;
  /** Count keyed by `contradiction_type` (e.g. opposing_object, temporal_impossible). */
  byType: Record<string, number>;
  /** Rows with a non-null `resolved_at`. */
  resolved: number;
  /** Rows dismissed (non-null `dismissed_reason`) and not resolved. */
  dismissed: number;
  /** Detected but neither resolved nor dismissed - the doc 39 "detected-not-reflected" gap. */
  active: number;
}

/** Fact supersession signal: how many facts are expired vs still active, and why. */
export interface SupersessionInstrumentation {
  /** Facts with a non-null `expired_at` (the supersession audit trail). */
  expiredFacts: number;
  /** Facts still active (`expired_at` null). */
  activeFacts: number;
  /** Expired-fact count keyed by `expire_reason` (null reason folded under `unknown`). */
  byExpireReason: Record<string, number>;
}

/** Causal-edge active/expired split. */
export interface CausalEdgeInstrumentation {
  total: number;
  active: number;
  expired: number;
}

/** The full per-snapshot instrumentation record (doc 39 section 2.B, derived half). */
export interface SnapshotInstrumentation {
  contradictions: ContradictionInstrumentation;
  supersession: SupersessionInstrumentation;
  causalEdges: CausalEdgeInstrumentation;
  /** same_as merge-signal links. */
  sameAs: number;
  entities: number;
  facts: number;
}

/** Tally `items` by the string key `keyOf` returns, into a plain object. */
function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * Derive the per-snapshot instrumentation record from a rich graph dump. Pure -
 * reads only the snapshot; no side effects. Status precedence for a
 * contradiction: resolved (any `resolvedAt`) wins over dismissed wins over
 * active, so the three buckets partition `total` exactly.
 */
export function deriveInstrumentation(graph: RichGraph): SnapshotInstrumentation {
  const contras = graph.contradictions;
  let resolved = 0;
  let dismissed = 0;
  let active = 0;
  for (const c of contras) {
    if (c.resolvedAt != null) resolved += 1;
    else if (c.dismissedReason != null) dismissed += 1;
    else active += 1;
  }

  const expiredFacts = graph.facts.filter((f) => f.expiredAt != null);
  const expiredEdges = graph.edges.filter((e) => e.expiredAt != null).length;

  return {
    contradictions: {
      total: contras.length,
      byType: countBy(contras, (c) => c.contradictionType),
      resolved,
      dismissed,
      active,
    },
    supersession: {
      expiredFacts: expiredFacts.length,
      activeFacts: graph.facts.length - expiredFacts.length,
      byExpireReason: countBy(expiredFacts, (f) => f.expireReason ?? 'unknown'),
    },
    causalEdges: {
      total: graph.edges.length,
      active: graph.edges.length - expiredEdges,
      expired: expiredEdges,
    },
    sameAs: graph.sameAs.length,
    entities: graph.entities.length,
    facts: graph.facts.length,
  };
}

/** The doc 39 §2.B detected-vs-reflected contradiction gap (nmemo-hm4.5). */
export interface ContradictionGap {
  /** Total contradictions the pipeline DETECTED during ingest (summed per-chunk). */
  detectedDuringIngest: number;
  /** Contradictions REFLECTED in the final table (the snapshot total). */
  reflectedInFinalTable: number;
  /** detected − reflected: rows detected during ingest but absent from the final table. */
  gap: number;
}

/**
 * Compute the detected-vs-reflected contradiction gap (doc 39 §2.B). PURE — the
 * detected count is passed IN (the harness sums it from the runtime stats); this
 * helper never reads runtime/DB state. `reflectedInFinalTable` is the snapshot's
 * `contradictions.total`; `gap` is detected minus reflected (positive ⇒ detected
 * rows never landed in the final table, the documented 6-15-detected / empty-table
 * symptom).
 */
export function contradictionGap(
  detectedDuringIngest: number,
  snapshot: SnapshotInstrumentation,
): ContradictionGap {
  const reflectedInFinalTable = snapshot.contradictions.total;
  return {
    detectedDuringIngest,
    reflectedInFinalTable,
    gap: detectedDuringIngest - reflectedInFinalTable,
  };
}
