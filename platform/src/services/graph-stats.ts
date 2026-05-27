/**
 * Graph Stats Service
 *
 * Maintains the singleton `public.graph_stats` row that summarises the graph
 * at the aggregate level (scale, health, centroid distribution, cluster
 * statistics). Implements docs/architecture/truth-graph/22-graph-stats-foundation.md
 * §3.2 — see that doc for the design contract; this module is the executable
 * side of it.
 *
 * Cluster columns (embedding_cluster_count, mean_intra_cluster_distance,
 * mean_inter_cluster_distance, cluster_columns_version) are owned by Phase 3
 * (HDBSCAN backfill) and are deliberately *not* touched by computeGraphStats —
 * the upsert preserves whatever Phase 3 last wrote.
 *
 * After each compute, an aggregate-level reasoning_reports row is written so
 * the test-harden skill (doc 18) can consume graph_stats outcomes as an
 * agent-readable signal alongside patrol/query reports. The actor identity
 * lives in actions_taken JSONB (the table schema has no actor column); see
 * doc 22 §7.5 follow-up + bead nmemo-2yv.49 for the rationale.
 */
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { jsonbLiteral } from './audit.js';

const COMPUTATION_VERSION = 1;
const CENTROID_SAMPLE_LIMIT = 100; // ~10k pairs after CROSS JOIN
const CENTROID_RANDOM_SEED = 0.42; // fixed for idempotent recomputation (§4.2 idempotency test)

// ============================================
// Anomaly thresholds for the reasoning_reports row (bead nmemo-2yv.49)
// ============================================
// Absolute delta (not ratio) — orphan_rate is already bounded [0, 1], so 0.3
// is a meaningful magnitude jump (e.g. ingest of a memory whose entities all
// orphan because relationship extraction failed).
const ANOMALY_ORPHAN_RATE_DELTA = 0.3;
// Relative deltas — cluster count and predicate diversity grow/shrink with
// scale; a fixed absolute would mis-fire on small graphs.
const ANOMALY_RATIO_DELTA = 0.5;

type AnomalyTag = 'normal' | 'anomaly';

interface AnomalySignal {
  signal: string;
  prior: number | null;
  current: number | null;
  delta: number;
  threshold: number;
}

interface AnomalyClassification {
  tag: AnomalyTag;
  signals: AnomalySignal[]; // empty when tag='normal'
  reason: 'no_prior_compute' | 'all_within_threshold' | 'threshold_exceeded';
}

/**
 * Classify whether the current compute represents a structural anomaly vs
 * the prior row. Pure function so the test suite can pin it directly.
 * `prior` is null on first-ever compute (graph_stats row exists but
 * `computed_duration_ms` is NULL on the seed) — that case is always 'normal'.
 */
export function classifyAnomaly(prior: GraphStats | null, current: GraphStats): AnomalyClassification {
  if (prior === null || prior.computedDurationMs === null) {
    return { tag: 'normal', signals: [], reason: 'no_prior_compute' };
  }
  const signals: AnomalySignal[] = [];

  if (prior.orphanRate !== null && current.orphanRate !== null) {
    const delta = Math.abs(current.orphanRate - prior.orphanRate);
    if (delta > ANOMALY_ORPHAN_RATE_DELTA) {
      signals.push({
        signal: 'orphan_rate',
        prior: prior.orphanRate,
        current: current.orphanRate,
        delta,
        threshold: ANOMALY_ORPHAN_RATE_DELTA,
      });
    }
  }

  // Embedding cluster count: Phase 3 owns this, but if it's populated and
  // collapses/spikes between computes, the data-evolver wants to see it.
  if (
    prior.embeddingClusterCount !== null &&
    prior.embeddingClusterCount > 0 &&
    current.embeddingClusterCount !== null
  ) {
    const ratio = Math.abs(current.embeddingClusterCount - prior.embeddingClusterCount) / prior.embeddingClusterCount;
    if (ratio > ANOMALY_RATIO_DELTA) {
      signals.push({
        signal: 'embedding_cluster_count',
        prior: prior.embeddingClusterCount,
        current: current.embeddingClusterCount,
        delta: ratio,
        threshold: ANOMALY_RATIO_DELTA,
      });
    }
  }

  if (
    prior.predicateDiversity !== null &&
    prior.predicateDiversity > 0 &&
    current.predicateDiversity !== null
  ) {
    const ratio = Math.abs(current.predicateDiversity - prior.predicateDiversity) / prior.predicateDiversity;
    if (ratio > ANOMALY_RATIO_DELTA) {
      signals.push({
        signal: 'predicate_diversity',
        prior: prior.predicateDiversity,
        current: current.predicateDiversity,
        delta: ratio,
        threshold: ANOMALY_RATIO_DELTA,
      });
    }
  }

  return signals.length === 0
    ? { tag: 'normal', signals: [], reason: 'all_within_threshold' }
    : { tag: 'anomaly', signals, reason: 'threshold_exceeded' };
}

export interface GraphStats {
  id: number;
  totalEntities: number;
  totalFacts: number;
  totalActiveFacts: number;
  totalMemories: number;
  embeddingClusterCount: number | null;
  meanIntraClusterDistance: number | null;
  meanInterClusterDistance: number | null;
  centroidSimMean: number | null;
  centroidSimMedian: number | null;
  centroidSimP10: number | null;
  centroidSimP90: number | null;
  centroidSampleSize: number | null;
  factDensity: number | null;
  orphanRate: number | null;
  predicateDiversity: number | null;
  mergeCandidatesPending: number;
  computedAt: Date;
  computedDurationMs: number | null;
  computationVersion: number;
  clusterColumnsVersion: number | null;
}

interface RawRow {
  id: number;
  total_entities: number;
  total_facts: number;
  total_active_facts: number;
  total_memories: number;
  embedding_cluster_count: number | null;
  mean_intra_cluster_distance: number | null;
  mean_inter_cluster_distance: number | null;
  centroid_sim_mean: number | null;
  centroid_sim_median: number | null;
  centroid_sim_p10: number | null;
  centroid_sim_p90: number | null;
  centroid_sample_size: number | null;
  fact_density: number | null;
  orphan_rate: number | null;
  predicate_diversity: number | null;
  merge_candidates_pending: number;
  computed_at: Date;
  computed_duration_ms: number | null;
  computation_version: number;
  cluster_columns_version: number | null;
}

function rowToGraphStats(r: RawRow): GraphStats {
  return {
    id: Number(r.id),
    totalEntities: Number(r.total_entities),
    totalFacts: Number(r.total_facts),
    totalActiveFacts: Number(r.total_active_facts),
    totalMemories: Number(r.total_memories),
    embeddingClusterCount: r.embedding_cluster_count == null ? null : Number(r.embedding_cluster_count),
    meanIntraClusterDistance: r.mean_intra_cluster_distance == null ? null : Number(r.mean_intra_cluster_distance),
    meanInterClusterDistance: r.mean_inter_cluster_distance == null ? null : Number(r.mean_inter_cluster_distance),
    centroidSimMean: r.centroid_sim_mean == null ? null : Number(r.centroid_sim_mean),
    centroidSimMedian: r.centroid_sim_median == null ? null : Number(r.centroid_sim_median),
    centroidSimP10: r.centroid_sim_p10 == null ? null : Number(r.centroid_sim_p10),
    centroidSimP90: r.centroid_sim_p90 == null ? null : Number(r.centroid_sim_p90),
    centroidSampleSize: r.centroid_sample_size == null ? null : Number(r.centroid_sample_size),
    factDensity: r.fact_density == null ? null : Number(r.fact_density),
    orphanRate: r.orphan_rate == null ? null : Number(r.orphan_rate),
    predicateDiversity: r.predicate_diversity == null ? null : Number(r.predicate_diversity),
    mergeCandidatesPending: Number(r.merge_candidates_pending),
    computedAt: r.computed_at instanceof Date ? r.computed_at : new Date(r.computed_at),
    computedDurationMs: r.computed_duration_ms == null ? null : Number(r.computed_duration_ms),
    computationVersion: Number(r.computation_version),
    clusterColumnsVersion: r.cluster_columns_version == null ? null : Number(r.cluster_columns_version),
  };
}

/**
 * Read the current singleton row. Returns null if the row has been deleted
 * (e.g. by `deleteFromTables` during testing); callers MUST handle null per
 * doc 22 §6 edge case "Singleton row deleted".
 */
export async function getGraphStats(): Promise<GraphStats | null> {
  const rows = (await db.execute(sql`
    SELECT * FROM public.graph_stats WHERE id = 1
  `)) as unknown as RawRow[];
  return rows[0] ? rowToGraphStats(rows[0]) : null;
}

/**
 * Recompute the singleton from current DB state and upsert. Returns the new row.
 *
 * SQL strategy (doc 22 §3.2):
 *   - Scale: COUNT(*) over entities/facts/active-facts/distinct memories.
 *   - Centroid distribution: seeded random subsample of 100×100 entity_meta
 *     centroids, CROSS JOIN, percentile aggregates over the cosine pairs. The
 *     setseed call makes recomputation idempotent. Pairs where a.entity_id =
 *     b.entity_id are filtered (self-similarity is always 1.0 and would skew).
 *   - Health: fact_density (active/total, zero-safe), orphan_rate (entities
 *     with zero active facts in either role, per `06-graph-meta-layer.md:172`),
 *     predicate_diversity, merge_candidates_pending.
 *
 * All sub-queries run in a single `db.transaction` so the seed for `random()`
 * applies to the same connection that runs the big INSERT, and the reads
 * observe a consistent snapshot. The upsert preserves cluster_* columns
 * because Phase 3 owns them.
 */
export async function computeGraphStats(): Promise<GraphStats> {
  const start = Date.now();

  // Read prior row outside the tx so the anomaly classifier has a stable
  // reference point. NULL on first-ever compute (the seed row has
  // computed_duration_ms IS NULL).
  const prior = await getGraphStats();

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT setseed(${CENTROID_RANDOM_SEED})`);
    const upserted = (await tx.execute(sql`
      WITH
        scale AS (
          SELECT
            (SELECT COUNT(*)::INT FROM public.entities) AS total_entities,
            (SELECT COUNT(*)::INT FROM public.facts) AS total_facts,
            (SELECT COUNT(*)::INT FROM public.facts WHERE expired_at IS NULL) AS total_active_facts,
            (SELECT COUNT(DISTINCT memory_id)::INT FROM public.memory_entities) AS total_memories
        ),
        centroid_a AS (
          SELECT entity_id, centroid
          FROM public.entity_meta
          WHERE centroid IS NOT NULL
          ORDER BY random()
          LIMIT ${CENTROID_SAMPLE_LIMIT}
        ),
        centroid_b AS (
          SELECT entity_id, centroid
          FROM public.entity_meta
          WHERE centroid IS NOT NULL
          ORDER BY random()
          LIMIT ${CENTROID_SAMPLE_LIMIT}
        ),
        centroid_pairs AS (
          SELECT 1 - (a.centroid <=> b.centroid) AS sim
          FROM centroid_a a
          CROSS JOIN centroid_b b
          WHERE a.entity_id <> b.entity_id
        ),
        centroid AS (
          SELECT
            AVG(sim)::FLOAT AS mean,
            (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sim))::FLOAT AS median,
            (PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY sim))::FLOAT AS p10,
            (PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY sim))::FLOAT AS p90,
            COUNT(*)::INT AS sample_size
          FROM centroid_pairs
        ),
        orphan AS (
          SELECT COUNT(*)::INT AS orphan_count
          FROM public.entities e
          WHERE NOT EXISTS (
            SELECT 1 FROM public.facts f
            WHERE f.expired_at IS NULL
              AND (f.subject_entity_id = e.id OR f.object_entity_id = e.id)
          )
        ),
        health AS (
          SELECT
            CASE
              WHEN s.total_entities > 0
              THEN s.total_active_facts::FLOAT / s.total_entities::FLOAT
              ELSE NULL
            END AS fact_density,
            o.orphan_count::FLOAT / NULLIF(s.total_entities, 0)::FLOAT AS orphan_rate,
            (SELECT COUNT(DISTINCT predicate)::INT FROM public.facts WHERE expired_at IS NULL) AS predicate_diversity,
            (SELECT COUNT(*)::INT FROM public.merge_candidates WHERE status IN ('staging', 'candidate')) AS merge_candidates_pending
          FROM scale s, orphan o
        )
      INSERT INTO public.graph_stats (
        id,
        total_entities, total_facts, total_active_facts, total_memories,
        centroid_sim_mean, centroid_sim_median, centroid_sim_p10, centroid_sim_p90, centroid_sample_size,
        fact_density, orphan_rate, predicate_diversity, merge_candidates_pending,
        computed_at, computation_version
      )
      SELECT
        1,
        scale.total_entities, scale.total_facts, scale.total_active_facts, scale.total_memories,
        centroid.mean, centroid.median, centroid.p10, centroid.p90, centroid.sample_size,
        health.fact_density, health.orphan_rate, health.predicate_diversity, health.merge_candidates_pending,
        NOW(), ${COMPUTATION_VERSION}
      FROM scale, centroid, health
      ON CONFLICT (id) DO UPDATE SET
        total_entities          = EXCLUDED.total_entities,
        total_facts             = EXCLUDED.total_facts,
        total_active_facts      = EXCLUDED.total_active_facts,
        total_memories          = EXCLUDED.total_memories,
        centroid_sim_mean       = EXCLUDED.centroid_sim_mean,
        centroid_sim_median     = EXCLUDED.centroid_sim_median,
        centroid_sim_p10        = EXCLUDED.centroid_sim_p10,
        centroid_sim_p90        = EXCLUDED.centroid_sim_p90,
        centroid_sample_size    = EXCLUDED.centroid_sample_size,
        fact_density            = EXCLUDED.fact_density,
        orphan_rate             = EXCLUDED.orphan_rate,
        predicate_diversity     = EXCLUDED.predicate_diversity,
        merge_candidates_pending = EXCLUDED.merge_candidates_pending,
        computed_at             = EXCLUDED.computed_at,
        computation_version     = EXCLUDED.computation_version
      RETURNING *
    `)) as unknown as RawRow[];

    if (!upserted[0]) {
      throw new Error('computeGraphStats: upsert returned no rows');
    }

    // Atomic duration write: the JS-side wall-clock duration is computed and
    // written inside the SAME transaction as the upsert, so process death
    // between the upsert and the duration write can never produce drift
    // between the aggregate columns and computed_duration_ms. See bead
    // nmemo-2yv.48 for the falsifying analysis and option-(a) rationale.
    const durationMs = Date.now() - start;
    await tx.execute(sql`
      UPDATE public.graph_stats SET computed_duration_ms = ${durationMs} WHERE id = 1
    `);

    return [{ ...upserted[0], computed_duration_ms: durationMs }] as RawRow[];
  });

  const stats = rowToGraphStats(rows[0]!);

  // Aggregate-level reasoning_reports row for the test-harden skill (doc 22
  // §7.5 follow-up; bead nmemo-2yv.49). Out-of-tx so a report-write failure
  // can never roll back the compute itself — the human-readable report and
  // anomaly flag are observability, not authoritative state.
  await writeGraphStatsReport(prior, stats).catch((err) => {
    console.warn(
      '[graph-stats] reasoning_reports write failed:',
      err instanceof Error ? err.message : err,
    );
  });

  return stats;
}

/**
 * Write the post-compute reasoning_reports row. The mode='patrol' carrier
 * matches the table CHECK (mode IN ('patrol', 'query')); actor + context_type
 * + anomaly classification live in actions_taken JSONB because the table has
 * no actor/context_type columns. The report TEXT mirrors the existing
 * pipeline.ts:182 console.log so existing observability is preserved as a
 * grep target, then appends a fenced JSON block for machine consumers.
 */
async function writeGraphStatsReport(prior: GraphStats | null, current: GraphStats): Promise<void> {
  const classification = classifyAnomaly(prior, current);
  const numericSnapshot = {
    total_entities: current.totalEntities,
    total_facts: current.totalFacts,
    total_active_facts: current.totalActiveFacts,
    total_memories: current.totalMemories,
    fact_density: current.factDensity,
    orphan_rate: current.orphanRate,
    predicate_diversity: current.predicateDiversity,
    merge_candidates_pending: current.mergeCandidatesPending,
    embedding_cluster_count: current.embeddingClusterCount,
    centroid_sim_mean: current.centroidSimMean,
    centroid_sample_size: current.centroidSampleSize,
    computed_duration_ms: current.computedDurationMs,
    computation_version: current.computationVersion,
  };
  const headline =
    `[graph-stats] total_entities=${current.totalEntities} active_facts=${current.totalActiveFacts} ` +
    `orphan_rate=${current.orphanRate ?? 'null'} predicate_diversity=${current.predicateDiversity ?? 'null'} ` +
    `duration=${current.computedDurationMs}ms anomaly=${classification.tag}`;
  const report = `${headline}\n\n\`\`\`json\n${JSON.stringify(numericSnapshot, null, 2)}\n\`\`\``;

  const actionsTaken = {
    actor: 'graph-stats',
    context_type: 'graph_stats_compute',
    anomaly: classification.tag,
    anomaly_signals: classification.signals,
    anomaly_reason: classification.reason,
    snapshot: numericSnapshot,
  };

  // Use jsonbLiteral for the JSONB payload — drizzle + postgres-js silently
  // stringify object/array values passed via `.values({…})` so the row lands
  // with jsonb_typeof='string' (see audit.ts:24 commentary; falsified
  // empirically by 49a's diagnostic before this fix). Inlining as a quoted
  // SQL literal cast to jsonb is the codebase's standard escape hatch.
  await db.execute(sql`
    INSERT INTO public.reasoning_reports (mode, report, actions_taken)
    VALUES ('patrol', ${report}, ${jsonbLiteral(actionsTaken)})
  `);
}
