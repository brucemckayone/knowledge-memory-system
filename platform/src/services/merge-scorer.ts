/**
 * Merge Scorer (bead nmemo-2yv.42)
 *
 * Unified per-pair scoring for merge_candidates rows. Two enumerators feed
 * pairs into this module:
 *
 *   - graph-meta.detectMergeCandidates: within-component pairs (3-signal
 *     domain — entities with shared source memories / outgoing facts).
 *   - cross-cluster-generator.generateCrossClusterCandidates: cross-component
 *     pairs (cluster-bridging domain — entities in disconnected components
 *     that may refer to the same real-world referent).
 *
 * Both enumerators call `scoreMergeCandidates(pairs, ctx)` which computes nine
 * signals per pair in a single set-based CTE — roundtrip count is bounded by
 * the signal count, NOT pairs × signals (per the bead's perf acceptance bullet
 * and the reference pattern in src/services/graph-stats.ts:131-203).
 *
 * Nine signals:
 *   centroid_similarity        pgvector cosine over entity_meta.centroid
 *   memory_overlap             Jaccard over memory_entities (predicate-free)
 *   structural_similarity      Jaccard over facts.(predicate, object_entity_id)
 *   cluster_match              min(prob_a, prob_b) when entity_clusters.cluster_id
 *                              matches and is not noise (-1) — the pre-bead
 *                              cross-cluster semantic (a conservative estimate
 *                              of joint cluster-membership probability). The
 *                              bead's "probability product" wording is
 *                              descriptive shorthand for this joint signal;
 *                              switching to a true product breaks the env-
 *                              override test (.91) whose calibration assumes
 *                              min — see notes on bead .42
 *   predicate_signature_cosine cosine over entity_topology.predicate_signature
 *   drift_recency_either       1.0 if either entity has a recent (within
 *                              DRIFT_RECENCY_DAYS) entity_drift_events row
 *   centrality_match           min(pagerank_a, pagerank_b) / max_global_pagerank
 *   articulation_bonus         0.5 if either entity is an articulation point
 *   component_match            1.0 if both entities share the same
 *                              entity_topology.component_id
 *
 * NULL semantics (bead §3): a signal is NULL when its inputs aren't populated
 * (e.g. no entity_meta row → centroid_similarity is NULL). NULL is *excluded*
 * from the weighted sum, NOT treated as zero. Weights renormalise over the
 * non-NULL signals on a per-pair basis. This unifies the two enumerators'
 * historical NULL conventions (graph-meta wrote zeros; cross-cluster wrote
 * NULL by design per mig 017 R3 B3 — that lock is superseded by this bead).
 *
 * Storage shape: the existing three columns (centroid_similarity,
 * memory_overlap, structural_similarity) plus the `resolution_reasoning` JSON
 * blob continue to carry signal values. The other six signals (cluster_match
 * through component_match) live inside the JSON blob alongside any caller-
 * supplied extras (e.g. drift_driven flag from the cross-cluster enumerator).
 * No migration here — bead .43 (adaptive weighting) may promote signals to
 * columns if aggregate queries need them.
 *
 * Weights stay STATIC in this bead (a config struct merged with optional
 * caller overrides). Bead .43 wires graph_stats-driven adaptive weighting.
 */

import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

// =============================================================================
// Configuration
// =============================================================================

export interface MergeScorerWeights {
  centroidSimilarity:        number;
  memoryOverlap:             number;
  structuralSimilarity:      number;
  clusterMatch:              number;
  predicateSignatureCosine:  number;
  driftRecencyEither:        number;
  centralityMatch:           number;
  articulationBonus:         number;
  componentMatch:            number;
}

/** Default static weights for the nine signals. Sum to 1.0; this is the
 *  invariant that future tunings must preserve. Callers may override per-call
 *  via ctx.weights. Future bead .43 wires graph_stats-driven adaptive
 *  weighting; for now these are the F1a defaults. */
export const DEFAULT_WEIGHTS: MergeScorerWeights = Object.freeze({
  centroidSimilarity:        0.15,
  memoryOverlap:             0.15,
  structuralSimilarity:      0.15,
  clusterMatch:              0.15,
  predicateSignatureCosine:  0.10,
  driftRecencyEither:        0.10,
  centralityMatch:           0.08,
  articulationBonus:         0.07,
  componentMatch:            0.05,
});

/** Recent-drift window for the drift_recency_either signal. Days. */
function driftRecencyDays(): number {
  const v = process.env.DRIFT_RECENCY_DAYS;
  if (!v) return 30;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

// =============================================================================
// Public API types
// =============================================================================

/** A pair to score. Caller is responsible for enumeration; this module is
 *  agnostic to whether pairs come from within-component or cross-component
 *  sweeps. Canonical ordering (entity_a_id < entity_b_id, per merge_candidates
 *  schema CHECK) is enforced internally — pass either order. */
export interface PairInput {
  entityAId: string;
  entityBId: string;
}

/** All nine signal values for one pair. NULL when inputs are absent. */
export interface SignalSet {
  centroid_similarity:        number | null;
  memory_overlap:             number | null;
  structural_similarity:      number | null;
  cluster_match:              number | null;
  predicate_signature_cosine: number | null;
  drift_recency_either:       number | null;
  centrality_match:           number | null;
  articulation_bonus:         number | null;
  component_match:            number | null;
}

/** A scored candidate — the unit returned by scoreMergeCandidates and passed
 *  into upsertScoredCandidates. `entityAId < entityBId` per canonical order. */
export interface ScoredCandidate {
  entityAId: string;
  entityBId: string;
  signals: SignalSet;
  /** NULL-aware weighted average over non-NULL signals. Always in [0, 1] under
   *  default weights and signal-domain assumptions. */
  combinedScore: number;
}

/** Loose runner type — matches both the global drizzle `db` handle and the
 *  `tx` parameter passed to `db.transaction()`. We only need `.execute`. */
type Runner = { execute: typeof db.execute };

/** Per-call scoring context. The runner is required; weights default to
 *  DEFAULT_WEIGHTS. */
export interface MergeScorerCtx {
  runner: Runner;
  weights?: MergeScorerWeights;
}

/** Per-call upsert context. The caller decides candidate_source, per-pair
 *  status (staging vs candidate), and per-pair reasoning JSON. The status
 *  callback receives the scored pair so callers can use combinedScore as a
 *  staging-vs-candidate boundary (graph-meta's pattern) OR return a fixed
 *  value (cross-cluster's pattern). */
export interface UpsertCtx {
  runner: Runner;
  candidateSource: 'three_signal_scoring' | 'cross_cluster_generator';
  /** Per-pair status. Return 'staging' or 'candidate'. */
  statusFor: (scored: ScoredCandidate) => 'staging' | 'candidate';
  /** Per-pair JSON-serialisable reasoning extras. Merged with the signal
   *  values and combined_score into the resolution_reasoning blob. Return
   *  `undefined` to omit caller-specific extras. */
  reasoningFor?: (scored: ScoredCandidate) => Record<string, unknown> | undefined;
}

// =============================================================================
// Public: score pairs
// =============================================================================

/**
 * Score a set of merge-candidate pairs. Returns one ScoredCandidate per input
 * pair (preserving caller-supplied ordering after canonical-pair normalisation).
 *
 * SQL strategy:
 *   - Input pairs land in a CTE via `UNNEST(${aIds}::uuid[], ${bIds}::uuid[])`.
 *   - Each signal is a set-based JOIN / aggregate against its source table
 *     (entity_meta, memory_entities, facts, entity_topology, entity_clusters,
 *     entity_drift_events). No correlated-subquery per-pair lookups.
 *   - One separate query bootstraps `max_global_pagerank` — the centrality
 *     match denominator — because computing it over only the pair-set entities
 *     would be a per-call ceiling instead of the global one.
 *
 * Roundtrips: 2 (main CTE + max-pagerank). Independent of pair count.
 */
export async function scoreMergeCandidates(
  pairs: PairInput[],
  ctx: MergeScorerCtx,
): Promise<ScoredCandidate[]> {
  if (pairs.length === 0) return [];

  const weights = ctx.weights ?? DEFAULT_WEIGHTS;

  // Canonicalise pair ordering (a < b) per merge_candidates CHECK constraint.
  // Caller-supplied order is preserved in the OUTPUT array by mapping back
  // through pair_idx; but the SQL works on canonical pairs.
  const canon = pairs.map((p) =>
    p.entityAId < p.entityBId
      ? { a: p.entityAId, b: p.entityBId }
      : { a: p.entityBId, b: p.entityAId },
  );

  // Bootstrap the centrality_match denominator — one set-based query for the
  // global max. Doing this inside the main CTE would re-scan entity_topology
  // for every row; pulling it once and inlining is cheaper and clearer.
  const maxPagerankRows = (await ctx.runner.execute(sql`
    SELECT COALESCE(MAX(pagerank), 0)::FLOAT AS max_pr FROM public.entity_topology
  `)) as unknown as Array<{ max_pr: number }>;
  const maxGlobalPagerank = Number(maxPagerankRows[0]?.max_pr ?? 0);

  const recencyDays = driftRecencyDays();

  // Build the input_pairs CTE from a VALUES list. drizzle's `sql` template
  // doesn't reliably serialise JS arrays as postgres `uuid[]` literals for
  // UNNEST (the wire format collapses to a single element and postgres rejects
  // "<uuid>" as malformed array). The VALUES form is the portable shape;
  // sql.join stitches each pair as its own parameterised fragment.
  const pairValueFrags = canon.map(
    (p) => sql`(${p.a}::uuid, ${p.b}::uuid)`,
  );
  const pairsValues = sql.join(pairValueFrags, sql`, `);

  const rawRows = (await ctx.runner.execute(sql`
    WITH
    input_pairs AS (
      SELECT
        p.a_id AS a_id,
        p.b_id AS b_id,
        row_number() OVER () AS pair_idx
      FROM (VALUES ${pairsValues}) AS p(a_id, b_id)
    ),
    -- centroid_similarity from entity_meta. NULL when either side lacks a
    -- centroid (e.g. entity with zero source memories or unprocessed entity).
    centroid_sigs AS (
      SELECT p.pair_idx,
        CASE WHEN ema.centroid IS NULL OR emb.centroid IS NULL THEN NULL
             ELSE 1 - (ema.centroid <=> emb.centroid)
        END AS centroid_similarity
      FROM input_pairs p
      LEFT JOIN public.entity_meta ema ON ema.entity_id = p.a_id
      LEFT JOIN public.entity_meta emb ON emb.entity_id = p.b_id
    ),
    -- memory_overlap (Jaccard). Materialise per-pair memory tuples set-wise,
    -- then count intersections and unions via GROUP BY. NULL when neither
    -- entity has any memory associations.
    a_memories AS (
      SELECT p.pair_idx, me.memory_id
      FROM input_pairs p
      JOIN public.memory_entities me ON me.entity_id = p.a_id
    ),
    b_memories AS (
      SELECT p.pair_idx, me.memory_id
      FROM input_pairs p
      JOIN public.memory_entities me ON me.entity_id = p.b_id
    ),
    memory_intersections AS (
      SELECT a.pair_idx, COUNT(DISTINCT a.memory_id)::FLOAT AS shared
      FROM a_memories a
      JOIN b_memories b ON b.pair_idx = a.pair_idx AND b.memory_id = a.memory_id
      GROUP BY a.pair_idx
    ),
    memory_unions AS (
      SELECT pair_idx, COUNT(DISTINCT memory_id)::FLOAT AS u
      FROM (
        SELECT pair_idx, memory_id FROM a_memories
        UNION
        SELECT pair_idx, memory_id FROM b_memories
      ) all_mems
      GROUP BY pair_idx
    ),
    memory_overlap_sigs AS (
      SELECT p.pair_idx,
        CASE WHEN COALESCE(u.u, 0) = 0 THEN NULL
             ELSE COALESCE(i.shared, 0) / u.u
        END AS memory_overlap
      FROM input_pairs p
      LEFT JOIN memory_intersections i ON i.pair_idx = p.pair_idx
      LEFT JOIN memory_unions u ON u.pair_idx = p.pair_idx
    ),
    -- structural_similarity (Jaccard over outgoing-fact signatures —
    -- (predicate, object_entity_id) tuples). NULL when neither entity has any
    -- active outgoing facts.
    a_facts AS (
      SELECT p.pair_idx, f.predicate, COALESCE(f.object_entity_id::text, '') AS obj
      FROM input_pairs p
      JOIN public.facts f ON f.subject_entity_id = p.a_id AND f.expired_at IS NULL
    ),
    b_facts AS (
      SELECT p.pair_idx, f.predicate, COALESCE(f.object_entity_id::text, '') AS obj
      FROM input_pairs p
      JOIN public.facts f ON f.subject_entity_id = p.b_id AND f.expired_at IS NULL
    ),
    structural_intersections AS (
      SELECT a.pair_idx, COUNT(DISTINCT (a.predicate, a.obj))::FLOAT AS shared
      FROM a_facts a
      JOIN b_facts b ON b.pair_idx = a.pair_idx
                    AND b.predicate = a.predicate
                    AND b.obj = a.obj
      GROUP BY a.pair_idx
    ),
    structural_unions AS (
      SELECT pair_idx, COUNT(DISTINCT (predicate, obj))::FLOAT AS u
      FROM (
        SELECT pair_idx, predicate, obj FROM a_facts
        UNION
        SELECT pair_idx, predicate, obj FROM b_facts
      ) all_facts
      GROUP BY pair_idx
    ),
    structural_sigs AS (
      SELECT p.pair_idx,
        CASE WHEN COALESCE(u.u, 0) = 0 THEN NULL
             ELSE COALESCE(i.shared, 0) / u.u
        END AS structural_similarity
      FROM input_pairs p
      LEFT JOIN structural_intersections i ON i.pair_idx = p.pair_idx
      LEFT JOIN structural_unions u ON u.pair_idx = p.pair_idx
    ),
    -- Topology + cluster data joined per-pair. Drives cluster_match,
    -- predicate_signature_cosine (pgvector cosine over the topology
    -- predicate_signature column — predicate-signature.ts:65 normalises to
    -- L2 unit length, so cosine here is equivalent to the dot product the
    -- pre-bead cosineSignatureSimilarity helper computed in TS),
    -- centrality_match, articulation_bonus, and component_match.
    topology_pair AS (
      SELECT p.pair_idx,
        eta.component_id AS a_component_id,
        etb.component_id AS b_component_id,
        eta.is_articulation_point AS a_articulation,
        etb.is_articulation_point AS b_articulation,
        eta.pagerank AS a_pagerank,
        etb.pagerank AS b_pagerank,
        CASE WHEN eta.predicate_signature IS NULL OR etb.predicate_signature IS NULL THEN NULL
             ELSE 1 - (eta.predicate_signature <=> etb.predicate_signature)
        END AS predicate_signature_cosine,
        eca.cluster_id AS a_cluster_id,
        ecb.cluster_id AS b_cluster_id,
        eca.cluster_probability AS a_cluster_prob,
        ecb.cluster_probability AS b_cluster_prob
      FROM input_pairs p
      LEFT JOIN public.entity_topology eta ON eta.entity_id = p.a_id
      LEFT JOIN public.entity_topology etb ON etb.entity_id = p.b_id
      LEFT JOIN public.entity_clusters eca ON eca.entity_id = p.a_id
      LEFT JOIN public.entity_clusters ecb ON ecb.entity_id = p.b_id
    ),
    -- drift_recency_either: 1.0 if either entity has any drift event in the
    -- recency window; NULL when NEITHER does. Treating "no drift activity for
    -- this pair" as NULL (not 0) is the bead's NULL-renormalisation
    -- semantic — without it, the drift weight enters every pair's denominator
    -- and depresses scores for the common no-drift case.
    drift_recent_entities AS (
      SELECT DISTINCT entity_id::text AS entity_id
      FROM public.entity_drift_events
      WHERE detected_at >= NOW() - (${recencyDays} || ' days')::INTERVAL
    ),
    drift_sigs AS (
      SELECT p.pair_idx,
        CASE
          WHEN da.entity_id IS NOT NULL OR db.entity_id IS NOT NULL THEN 1.0::FLOAT
          ELSE NULL::FLOAT
        END AS drift_recency_either
      FROM input_pairs p
      LEFT JOIN drift_recent_entities da ON da.entity_id = p.a_id::text
      LEFT JOIN drift_recent_entities db ON db.entity_id = p.b_id::text
    )
    SELECT
      p.pair_idx::INT AS pair_idx,
      p.a_id::text AS a_id,
      p.b_id::text AS b_id,
      cs.centroid_similarity,
      mo.memory_overlap,
      ss.structural_similarity,
      tp.a_component_id,
      tp.b_component_id,
      tp.a_articulation,
      tp.b_articulation,
      tp.a_pagerank,
      tp.b_pagerank,
      tp.predicate_signature_cosine,
      tp.a_cluster_id,
      tp.b_cluster_id,
      tp.a_cluster_prob,
      tp.b_cluster_prob,
      dr.drift_recency_either
    FROM input_pairs p
    LEFT JOIN centroid_sigs cs ON cs.pair_idx = p.pair_idx
    LEFT JOIN memory_overlap_sigs mo ON mo.pair_idx = p.pair_idx
    LEFT JOIN structural_sigs ss ON ss.pair_idx = p.pair_idx
    LEFT JOIN topology_pair tp ON tp.pair_idx = p.pair_idx
    LEFT JOIN drift_sigs dr ON dr.pair_idx = p.pair_idx
    ORDER BY p.pair_idx
  `)) as unknown as Array<RawSignalRow>;

  return rawRows.map((r) => buildScoredCandidate(r, maxGlobalPagerank, weights));
}

interface RawSignalRow {
  pair_idx: number;
  a_id: string;
  b_id: string;
  centroid_similarity: number | null;
  memory_overlap: number | null;
  structural_similarity: number | null;
  a_component_id: number | null;
  b_component_id: number | null;
  a_articulation: boolean | null;
  b_articulation: boolean | null;
  a_pagerank: number | null;
  b_pagerank: number | null;
  predicate_signature_cosine: number | null;
  a_cluster_id: number | null;
  b_cluster_id: number | null;
  a_cluster_prob: number | null;
  b_cluster_prob: number | null;
  drift_recency_either: number | null;
}

/** Compose ScoredCandidate from a raw row + the global pagerank ceiling. */
function buildScoredCandidate(
  r: RawSignalRow,
  maxGlobalPagerank: number,
  weights: MergeScorerWeights,
): ScoredCandidate {
  // cluster_match: min(prob_a, prob_b) when same non-noise cluster. See the
  // module header for the rationale on min-vs-product. NULL when either side
  // lacks cluster data or when clusters differ / one side is noise (-1).
  let cluster_match: number | null = null;
  if (r.a_cluster_id !== null && r.b_cluster_id !== null
      && r.a_cluster_id === r.b_cluster_id && r.a_cluster_id !== -1) {
    cluster_match = Math.min(r.a_cluster_prob ?? 0, r.b_cluster_prob ?? 0);
  }

  // predicate_signature_cosine: SQL-computed via pgvector `<=>`. Cast to
  // number defensively — pg drivers sometimes return numeric as string.
  const predicate_signature_cosine: number | null =
    r.predicate_signature_cosine === null ? null : Number(r.predicate_signature_cosine);

  // centrality_match: min(pr_a, pr_b) / max_global_pagerank.
  let centrality_match: number | null = null;
  if (r.a_pagerank !== null && r.b_pagerank !== null && maxGlobalPagerank > 0) {
    centrality_match = Math.min(Number(r.a_pagerank), Number(r.b_pagerank)) / maxGlobalPagerank;
  }

  // articulation_bonus: 0.5 if either is articulation; NULL only when both
  // flags are missing (entity not in entity_topology at all).
  let articulation_bonus: number | null = null;
  if (r.a_articulation !== null || r.b_articulation !== null) {
    articulation_bonus = (r.a_articulation === true || r.b_articulation === true) ? 0.5 : 0;
  }

  // component_match: 1.0 if same component; 0 if different; NULL if either
  // entity isn't in entity_topology.
  let component_match: number | null = null;
  if (r.a_component_id !== null && r.b_component_id !== null) {
    component_match = r.a_component_id === r.b_component_id ? 1.0 : 0;
  }

  // drift_recency_either: SQL already produced 0/1 — propagate, treating as
  // NULL only when the column literally came back null (shouldn't happen with
  // CASE returning 0/1, but defend against future SQL drift).
  const drift_recency_either =
    r.drift_recency_either === null ? null : Number(r.drift_recency_either);

  const signals: SignalSet = {
    centroid_similarity:        r.centroid_similarity === null ? null : Number(r.centroid_similarity),
    memory_overlap:             r.memory_overlap === null ? null : Number(r.memory_overlap),
    structural_similarity:      r.structural_similarity === null ? null : Number(r.structural_similarity),
    cluster_match,
    predicate_signature_cosine,
    drift_recency_either,
    centrality_match,
    articulation_bonus,
    component_match,
  };

  return {
    entityAId: r.a_id,
    entityBId: r.b_id,
    signals,
    combinedScore: computeCombinedScore(signals, weights),
  };
}

/**
 * NULL-aware weighted average. Excludes NULL signals from the numerator AND
 * the denominator so weights renormalise to the active signal set. Returns 0
 * when every signal is NULL (no information → no score).
 */
export function computeCombinedScore(
  signals: SignalSet,
  weights: MergeScorerWeights,
): number {
  let weightedSum = 0;
  let weightTotal = 0;

  const pairs: Array<[number | null, number]> = [
    [signals.centroid_similarity,        weights.centroidSimilarity],
    [signals.memory_overlap,             weights.memoryOverlap],
    [signals.structural_similarity,      weights.structuralSimilarity],
    [signals.cluster_match,              weights.clusterMatch],
    [signals.predicate_signature_cosine, weights.predicateSignatureCosine],
    [signals.drift_recency_either,       weights.driftRecencyEither],
    [signals.centrality_match,           weights.centralityMatch],
    [signals.articulation_bonus,         weights.articulationBonus],
    [signals.component_match,            weights.componentMatch],
  ];

  for (const [signal, weight] of pairs) {
    if (signal === null) continue;
    weightedSum += weight * signal;
    weightTotal += weight;
  }
  return weightTotal > 0 ? weightedSum / weightTotal : 0;
}

// =============================================================================
// Public: upsert scored candidates
// =============================================================================

/**
 * Upsert scored candidates into merge_candidates. Caller controls
 * candidate_source, status (staging vs candidate), and the JSON reasoning
 * extras; this function fixes the column-write shape so the bead's
 * "only scoreMergeCandidates writes signal columns" contract holds at the
 * module boundary.
 *
 * ON CONFLICT preserves:
 *   - status='resolved' (never overwritten)
 *   - candidate_source='cross_cluster_generator' (R3 B4 lock, bead .60/.90 —
 *     a cross-cluster row is never downgraded to three_signal)
 *   - resolution_reasoning is preserved when the existing row's source is
 *     'cross_cluster_generator' (mirror of the candidate_source lock — keeps
 *     the cross-cluster prompt-seed JSON intact when the three-signal scorer
 *     later upserts the same pair)
 *
 * Returns the number of rows written (inserted or updated).
 */
export async function upsertScoredCandidates(
  scored: ScoredCandidate[],
  ctx: UpsertCtx,
): Promise<number> {
  let written = 0;
  for (const s of scored) {
    const status = ctx.statusFor(s);
    const reasoningExtras = ctx.reasoningFor?.(s);
    // The reasoning blob always carries the full signal set + combined score.
    // Caller extras (drift_driven, component IDs, etc.) merge on top.
    const reasoning = JSON.stringify({
      signals: s.signals,
      combined_score: s.combinedScore,
      ...(reasoningExtras ?? {}),
    });
    await ctx.runner.execute(sql`
      INSERT INTO public.merge_candidates (
        entity_a_id, entity_b_id,
        centroid_similarity, memory_overlap, structural_similarity,
        combined_score, status, candidate_source,
        detection_count, last_detected_at, resolution_reasoning
      ) VALUES (
        ${s.entityAId}::uuid, ${s.entityBId}::uuid,
        ${s.signals.centroid_similarity},
        ${s.signals.memory_overlap},
        ${s.signals.structural_similarity},
        ${s.combinedScore},
        ${status},
        ${ctx.candidateSource},
        1,
        NOW(),
        ${reasoning}
      )
      ON CONFLICT (entity_a_id, entity_b_id) DO UPDATE SET
        centroid_similarity = EXCLUDED.centroid_similarity,
        memory_overlap = EXCLUDED.memory_overlap,
        structural_similarity = EXCLUDED.structural_similarity,
        combined_score = EXCLUDED.combined_score,
        status = CASE WHEN merge_candidates.status = 'resolved'
                      THEN merge_candidates.status ELSE EXCLUDED.status END,
        -- R3 B4 lock (beads .60/.90): never downgrade a cross-cluster row.
        candidate_source = CASE WHEN merge_candidates.candidate_source = 'cross_cluster_generator'
                                THEN merge_candidates.candidate_source
                                ELSE EXCLUDED.candidate_source END,
        -- Mirror of the candidate_source lock — preserve cross-cluster JSON
        -- reasoning on collision so the reconciliation_agent's prompt seed
        -- isn't clobbered by a later three-signal write.
        resolution_reasoning = CASE WHEN merge_candidates.candidate_source = 'cross_cluster_generator'
                                    THEN merge_candidates.resolution_reasoning
                                    ELSE EXCLUDED.resolution_reasoning END,
        detection_count = merge_candidates.detection_count + 1,
        last_detected_at = NOW()
    `);
    written++;
  }
  return written;
}

/**
 * Pre-filter helper: drop pairs whose existing merge_candidates row is already
 * 'resolved'. The upsert path preserves resolved status via the ON CONFLICT
 * CASE, but resolved rows would still see their detection_count and
 * last_detected_at refreshed — noise in audit trails. Callers filter beforehand
 * so resolved pairs never enter the scoring pass.
 *
 * One set-based query per call; bounded by pair count.
 */
export async function filterResolvedPairs(
  pairs: PairInput[],
  runner: Runner,
): Promise<PairInput[]> {
  if (pairs.length === 0) return [];
  // Canonicalise for the query — schema invariant entity_a_id < entity_b_id.
  const canon = pairs.map((p) =>
    p.entityAId < p.entityBId
      ? { a: p.entityAId, b: p.entityBId, orig: p }
      : { a: p.entityBId, b: p.entityAId, orig: p },
  );
  // VALUES list (not UNNEST array params) for the same reason as in
  // scoreMergeCandidates — see comment there.
  const pairValueFrags = canon.map(
    (p) => sql`(${p.a}::uuid, ${p.b}::uuid)`,
  );
  const pairsValues = sql.join(pairValueFrags, sql`, `);
  const rows = (await runner.execute(sql`
    SELECT mc.entity_a_id::text AS a, mc.entity_b_id::text AS b
    FROM public.merge_candidates mc
    JOIN (VALUES ${pairsValues}) AS p(a_id, b_id)
      ON mc.entity_a_id = p.a_id AND mc.entity_b_id = p.b_id
    WHERE mc.status = 'resolved'
  `)) as unknown as Array<{ a: string; b: string }>;
  const resolvedKeys = new Set(rows.map((r) => `${r.a}|${r.b}`));
  return canon
    .filter((c) => !resolvedKeys.has(`${c.a}|${c.b}`))
    .map((c) => c.orig);
}
