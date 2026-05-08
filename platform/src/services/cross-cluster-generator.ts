/**
 * Cross-Cluster Candidate Generator (Phase 4 — doc 25)
 *
 * The generator half of the generate-then-verify pattern. The verifier
 * (`reconciliation_agent.py`) is already deployed; this module produces the
 * cross-component identity candidates the existing 3-signal scorer cannot
 * find — entities in disconnected components that may refer to the same
 * real-world referent.
 *
 * Inputs (already populated by Phase 1–3 ml-services compute):
 *   - entity_topology    (component_id, k_core, is_articulation_point,
 *                         pagerank, predicate_signature)
 *   - entity_clusters    (cluster_id, cluster_probability)
 *   - entity_drift_events(target_cluster_id, triggered_action, detected_at)
 *
 * Output: rows in `merge_candidates` with `candidate_source =
 * 'cross_cluster_generator'`. The 3-signal columns (centroid_similarity,
 * memory_overlap, structural_similarity) are NULL by §2.5 R3 B3 lock —
 * they don't apply to cross-component pairs and signalling them as zero
 * would be a false negative on those signals. The reconciliation_agent's
 * cross-cluster prompt block (the prompt-builder split shipped alongside
 * this module) tells the LLM that NULL is expected, not bad signal.
 *
 * Concurrency: a session-level pg_try_advisory_lock(hashtext(LOCK_KEY))
 * guards against overlapping invocations. Second caller short-circuits.
 *
 * Freshness: skips this cycle when either upstream compute (topology /
 * semantic-clustering) has a completed_at older than the most-recent
 * entities.created_at — the upstream signal would be reading a stale
 * graph. Logged as a skip, not a failure (next patrol retries).
 */

import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import {
  computePredicateSignature,
  cosineSignatureSimilarity,
  populatePredicateSignatures,
} from './predicate-signature.js';

// =============================================================================
// Tunable knobs (env-overridable per doc 25 §3.x)
// =============================================================================

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** A component must hold at least this many entities to be considered. */
function minComponentSize(): number { return envInt('MIN_COMPONENT_SIZE', 2); }
/** Drop entities below this k-core before pair-scoring (default 1 = no orphans). */
function minKCoreForBridge(): number { return envInt('MIN_K_CORE_FOR_BRIDGE', 1); }
/** Keep candidates whose combined score is at least this. */
function bridgeScoreThreshold(): number { return envFloat('BRIDGE_SCORE_THRESHOLD', 0.3); }
/** Cap candidates retained per (component_a, component_b) pair. */
function maxCandidatesPerPair(): number { return envInt('MAX_CANDIDATES_PER_COMPONENT_PAIR', 5); }
/** Drift event recency window for the §2.2 drift signal (days). */
function driftRecencyDays(): number { return envInt('DRIFT_RECENCY_DAYS', 30); }

// Score weights (§2.2). Sum should be 1.0; if env-overridden, we don't enforce
// re-normalisation — the threshold compares directly to the raw weighted sum.
const W_CLUSTER = 0.35;       // w1
const W_DRIFT_A = 0.125;      // w2
const W_DRIFT_B = 0.125;      // w3
const W_ROLE = 0.20;          // w4
const W_CENTRALITY = 0.15;    // w5
const W_ARTICULATION = 0.05;  // w6

const ADVISORY_LOCK_KEY = 'cross_cluster_generator';

// =============================================================================
// Types
// =============================================================================

export interface CandidateGenerationResult {
  /** True when the generator ran end-to-end. False when skipped (lock held / stale upstream). */
  ran: boolean;
  /** Reason when ran=false: 'lock_held' | 'stale_upstream' */
  skippedReason?: 'lock_held' | 'stale_upstream';
  /** Component pairs evaluated (zero when skipped). */
  componentPairsEvaluated: number;
  /** Candidates inserted or updated this run. */
  candidatesInserted: number;
  /** Candidate count emitted by the drift-driven pathway (§2.5). Subset of candidatesInserted. */
  driftDrivenCandidates: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

interface EntityRow {
  entity_id: string;
  component_id: number | null;
  /** Total size of this entity's connected component, sourced from
   *  entity_topology.component_size — this is the doc 25 §2 "A.size" used
   *  for the MIN_COMPONENT_SIZE gate. Distinct from the post-k_core bucket
   *  size, which is what we iterate over for scoring. */
  component_size: number | null;
  k_core: number | null;
  is_articulation_point: boolean;
  pagerank: number | null;
  predicate_signature: number[] | null;
  cluster_id: number | null;
  cluster_probability: number | null;
}

interface DriftRow {
  entity_id: string;
  target_cluster_id: number | null;
  detected_at: Date;
}

interface ScoredPair {
  entityA: string;
  entityB: string;
  componentA: number;
  componentB: number;
  score: number;
  contributions: {
    cluster: number;
    drift_a: number;
    drift_b: number;
    role: number;
    centrality: number;
    articulation: number;
  };
  driftDriven: boolean;
}

// =============================================================================
// Read-side helpers
// =============================================================================

/** Loose runner type that matches both the global drizzle `db` handle and
 *  the `tx` parameter passed to `db.transaction()`. We only need `.execute`. */
type Runner = { execute: typeof db.execute };

/** §3.2 freshness check. Returns false if the named runs table is older than
 *  the most recent entities row. NULL on either side counts as not-fresh. */
async function isUpstreamFresh(
  runsTable: 'topology_compute_runs' | 'clustering_compute_runs',
  runner: Runner,
): Promise<boolean> {
  // Two queries, not one — `runsTable` is a static literal so it's safe to
  // sql.raw, but we keep entity-side simple via drizzle `sql`.
  const compute = (await runner.execute(sql`
    SELECT MAX(completed_at) AS ts FROM public.${sql.raw(runsTable)} WHERE status = 'completed'
  `)) as unknown as Array<{ ts: Date | null }>;
  const entity = (await runner.execute(sql`
    SELECT MAX(created_at) AS ts FROM public.entities
  `)) as unknown as Array<{ ts: Date | null }>;
  const computeTs = compute[0]?.ts ?? null;
  const entityTs = entity[0]?.ts ?? null;
  // If the graph is empty there's nothing to compare against — treat as fresh
  // so the downstream pair-iteration falls through to a no-op.
  if (entityTs === null) return true;
  if (computeTs === null) return false;
  return new Date(computeTs).getTime() >= new Date(entityTs).getTime();
}

function parseVec(raw: unknown): number[] | null {
  if (raw == null) return null;
  const s = String(raw);
  if (!s) return null;
  return s.replace(/^\[|\]$/g, '').split(',').map((x) => Number.parseFloat(x));
}

/** Pull every entity that's eligible (k_core >= MIN_K_CORE_FOR_BRIDGE) along
 *  with the topology/cluster signals we need to score it. NULL signature is
 *  fine — role_similarity falls to 0 cleanly. */
async function loadCandidateEntities(runner: Runner): Promise<EntityRow[]> {
  const rows = (await runner.execute(sql`
    SELECT
      et.entity_id::text          AS entity_id,
      et.component_id             AS component_id,
      et.component_size           AS component_size,
      et.k_core                   AS k_core,
      et.is_articulation_point    AS is_articulation_point,
      et.pagerank                 AS pagerank,
      et.predicate_signature::text AS predicate_signature,
      ec.cluster_id               AS cluster_id,
      ec.cluster_probability      AS cluster_probability
    FROM public.entity_topology et
    LEFT JOIN public.entity_clusters ec ON ec.entity_id = et.entity_id
    WHERE et.component_id IS NOT NULL
      AND COALESCE(et.k_core, 0) >= ${minKCoreForBridge()}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    entity_id: r.entity_id as string,
    component_id: (r.component_id as number) ?? null,
    component_size: (r.component_size as number) ?? null,
    k_core: (r.k_core as number) ?? null,
    is_articulation_point: Boolean(r.is_articulation_point),
    pagerank: (r.pagerank as number) ?? null,
    predicate_signature: parseVec(r.predicate_signature),
    cluster_id: (r.cluster_id as number) ?? null,
    cluster_probability: (r.cluster_probability as number) ?? null,
  }));
}

/** Drift events within the recency window (§2.2). One per entity at most —
 *  the most recent. */
async function loadRecentDriftEvents(runner: Runner): Promise<Map<string, DriftRow>> {
  const cutoff = new Date(Date.now() - driftRecencyDays() * 24 * 60 * 60 * 1000);
  const rows = (await runner.execute(sql`
    SELECT DISTINCT ON (entity_id)
      entity_id::text   AS entity_id,
      target_cluster_id AS target_cluster_id,
      detected_at       AS detected_at
    FROM public.entity_drift_events
    WHERE detected_at >= ${cutoff}
    ORDER BY entity_id, detected_at DESC
  `)) as unknown as Array<Record<string, unknown>>;
  const out = new Map<string, DriftRow>();
  for (const r of rows) {
    out.set(r.entity_id as string, {
      entity_id: r.entity_id as string,
      target_cluster_id: (r.target_cluster_id as number) ?? null,
      detected_at: r.detected_at as Date,
    });
  }
  return out;
}

/** Drift events that triggered the action threshold — these become drift-driven
 *  candidates (§2.5). One row per (entity, detected_at) within the window. */
async function loadActionableDriftEvents(runner: Runner): Promise<DriftRow[]> {
  const cutoff = new Date(Date.now() - driftRecencyDays() * 24 * 60 * 60 * 1000);
  const rows = (await runner.execute(sql`
    SELECT entity_id::text AS entity_id, target_cluster_id, detected_at
    FROM public.entity_drift_events
    WHERE detected_at >= ${cutoff}
      AND triggered_action IN ('reconciliation_invoked', 'reconciliation_failed')
      AND target_cluster_id IS NOT NULL
    ORDER BY detected_at DESC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    entity_id: r.entity_id as string,
    target_cluster_id: (r.target_cluster_id as number) ?? null,
    detected_at: r.detected_at as Date,
  }));
}

// =============================================================================
// Scoring
// =============================================================================

function scorePair(
  a: EntityRow,
  b: EntityRow,
  driftMap: Map<string, DriftRow>,
  maxGlobalPagerank: number,
): ScoredPair['contributions'] & { score: number } {
  // w1 — embedding cluster match. min(prob_a, prob_b) when same non-noise cluster.
  let cluster = 0;
  if (
    a.cluster_id !== null && b.cluster_id !== null &&
    a.cluster_id === b.cluster_id && a.cluster_id !== -1
  ) {
    const pa = a.cluster_probability ?? 0;
    const pb = b.cluster_probability ?? 0;
    cluster = Math.min(pa, pb);
  }
  // w2/w3 — drift signal. 1.0 when a recent drift on x targets the partner's cluster.
  const drift_a = driftMap.get(a.entity_id)?.target_cluster_id === b.cluster_id && b.cluster_id !== null ? 1 : 0;
  const drift_b = driftMap.get(b.entity_id)?.target_cluster_id === a.cluster_id && a.cluster_id !== null ? 1 : 0;
  // w4 — role similarity (cosine of predicate signatures). Pre-normalised by populator.
  const role = cosineSignatureSimilarity(a.predicate_signature, b.predicate_signature);
  // w5 — centrality match. min(pr_a, pr_b) / max_global_pagerank. Rewards bridging two protagonists.
  let centrality = 0;
  if (a.pagerank !== null && b.pagerank !== null && maxGlobalPagerank > 0) {
    centrality = Math.min(a.pagerank, b.pagerank) / maxGlobalPagerank;
  }
  // w6 — articulation bonus. 0.5 if either is articulation point.
  const articulation = (a.is_articulation_point || b.is_articulation_point) ? 0.5 : 0;
  const score =
    W_CLUSTER * cluster
    + W_DRIFT_A * drift_a + W_DRIFT_B * drift_b
    + W_ROLE * role
    + W_CENTRALITY * centrality
    + W_ARTICULATION * articulation;
  return { cluster, drift_a, drift_b, role, centrality, articulation, score };
}

// =============================================================================
// Insert side
// =============================================================================

async function upsertCandidate(p: ScoredPair, runner: Runner): Promise<void> {
  // Canonical pair ordering — schema CHECK forces entity_a_id < entity_b_id.
  const [aId, bId] = p.entityA < p.entityB
    ? [p.entityA, p.entityB]
    : [p.entityB, p.entityA];
  const reasoning = JSON.stringify({
    contributions: p.contributions,
    component_a: aId === p.entityA ? p.componentA : p.componentB,
    component_b: bId === p.entityB ? p.componentB : p.componentA,
    drift_driven: p.driftDriven,
  });
  // §2.5 R3 B4 lock: if an existing row is already 'cross_cluster_generator',
  // never downgrade. CASE expression on EXCLUDED preserves stronger source.
  await runner.execute(sql`
    INSERT INTO public.merge_candidates (
      entity_a_id, entity_b_id,
      centroid_similarity, memory_overlap, structural_similarity,
      combined_score, status, candidate_source,
      detection_count, last_detected_at, resolution_reasoning
    ) VALUES (
      ${aId}::uuid, ${bId}::uuid,
      NULL, NULL, NULL,
      ${p.score}, 'candidate', 'cross_cluster_generator',
      1, NOW(), ${reasoning}
    )
    ON CONFLICT (entity_a_id, entity_b_id) DO UPDATE SET
      combined_score = EXCLUDED.combined_score,
      status = CASE WHEN merge_candidates.status = 'resolved'
                    THEN merge_candidates.status ELSE EXCLUDED.status END,
      candidate_source = CASE WHEN merge_candidates.candidate_source = 'cross_cluster_generator'
                              THEN merge_candidates.candidate_source
                              ELSE EXCLUDED.candidate_source END,
      detection_count = merge_candidates.detection_count + 1,
      last_detected_at = NOW(),
      resolution_reasoning = EXCLUDED.resolution_reasoning
  `);
}

// =============================================================================
// Main entry
// =============================================================================

export async function generateCrossClusterCandidates(): Promise<CandidateGenerationResult> {
  const t0 = Date.now();
  let result: CandidateGenerationResult | null = null;
  // Wrap the whole pipeline in a single transaction so that:
  //   1. pg_try_advisory_xact_lock pins acquisition + release to the same
  //      session (transaction-scoped — auto-released on COMMIT/ROLLBACK,
  //      can never leak past this function), and
  //   2. all reads + the upserts share one consistent snapshot.
  await db.transaction(async (tx) => {
    const lockResult = (await tx.execute(sql`
      SELECT pg_try_advisory_xact_lock(hashtext(${ADVISORY_LOCK_KEY})) AS acquired
    `)) as unknown as Array<{ acquired: boolean }>;
    if (!lockResult[0]?.acquired) {
      result = {
        ran: false,
        skippedReason: 'lock_held',
        componentPairsEvaluated: 0,
        candidatesInserted: 0,
        driftDrivenCandidates: 0,
        durationMs: Date.now() - t0,
      };
      return;
    }

    // Freshness gate (intra-tx so the read sees the same snapshot as the writes).
    const [topoFresh, clusterFresh] = await Promise.all([
      isUpstreamFresh('topology_compute_runs', tx),
      isUpstreamFresh('clustering_compute_runs', tx),
    ]);
    if (!topoFresh || !clusterFresh) {
      result = {
        ran: false,
        skippedReason: 'stale_upstream',
        componentPairsEvaluated: 0,
        candidatesInserted: 0,
        driftDrivenCandidates: 0,
        durationMs: Date.now() - t0,
      };
      return;
    }

    // Phase 4 prep — Phase 2 leaves predicate_signature NULL; we own population.
    // populatePredicateSignatures uses the global db handle; that's fine —
    // it's an idempotent upsert that we want visible to subsequent reads.
    await populatePredicateSignatures();

    // Load eligible entities + drift events on the transaction's snapshot.
    const entities = await loadCandidateEntities(tx);
    const driftMap = await loadRecentDriftEvents(tx);
    const actionableDrifts = await loadActionableDriftEvents(tx);

    // Compute max global pagerank for centrality_match denominator.
    let maxGlobalPagerank = 0;
    for (const e of entities) if ((e.pagerank ?? 0) > maxGlobalPagerank) maxGlobalPagerank = e.pagerank!;

    // Bucket entities by component, and capture the doc 25 §2 "A.size" via
    // the entity_topology.component_size metadata column. Bucket length and
    // component_size differ when k_core filtering drops entities — A.size is
    // the *full* component size (the gate), bucket length is the iteration
    // surface for scoring.
    const byComponent = new Map<number, EntityRow[]>();
    const componentSizeMeta = new Map<number, number>();
    for (const e of entities) {
      if (e.component_id === null) continue;
      let bucket = byComponent.get(e.component_id);
      if (!bucket) { bucket = []; byComponent.set(e.component_id, bucket); }
      bucket.push(e);
      // First non-null component_size wins; per Phase 2 contract every row
      // in the same component carries the same value.
      if (e.component_size !== null && !componentSizeMeta.has(e.component_id)) {
        componentSizeMeta.set(e.component_id, e.component_size);
      }
    }
    // Components above MIN_COMPONENT_SIZE — read from metadata, not bucket
    // length (which is post-k_core and would mis-gate small dense graphs).
    const componentIds = [...byComponent.keys()].filter(
      (cid) => (componentSizeMeta.get(cid) ?? byComponent.get(cid)!.length) >= minComponentSize(),
    );
    componentIds.sort((a, b) => a - b);

    let componentPairsEvaluated = 0;
    let candidatesInserted = 0;
    let driftDriven = 0;
    const threshold = bridgeScoreThreshold();
    const cap = maxCandidatesPerPair();
    const seen = new Set<string>();  // canonical pair key — dedupe within a run

    // Pair-up across distinct components.
    for (let i = 0; i < componentIds.length; i++) {
      for (let j = i + 1; j < componentIds.length; j++) {
        componentPairsEvaluated++;
        const aBucket = byComponent.get(componentIds[i]!)!;
        const bBucket = byComponent.get(componentIds[j]!)!;
        const scored: ScoredPair[] = [];
        for (const a of aBucket) {
          for (const b of bBucket) {
            const c = scorePair(a, b, driftMap, maxGlobalPagerank);
            if (c.score < threshold) continue;
            scored.push({
              entityA: a.entity_id, entityB: b.entity_id,
              componentA: a.component_id!, componentB: b.component_id!,
              score: c.score,
              contributions: {
                cluster: c.cluster, drift_a: c.drift_a, drift_b: c.drift_b,
                role: c.role, centrality: c.centrality, articulation: c.articulation,
              },
              driftDriven: false,
            });
          }
        }
        scored.sort((x, y) => y.score - x.score);
        const kept = scored.slice(0, cap);
        for (const p of kept) {
          const k = p.entityA < p.entityB ? `${p.entityA}|${p.entityB}` : `${p.entityB}|${p.entityA}`;
          if (seen.has(k)) continue;
          seen.add(k);
          await upsertCandidate(p, tx);
          candidatesInserted++;
        }
      }
    }

    // §2.5 — Drift-driven candidates: pair drifted entity with target_cluster
    // members in OTHER components. This is additive to the §2.2 sweep above
    // — drift events that already produced candidates above the threshold
    // are de-duped via `seen`.
    const entityById = new Map(entities.map((e) => [e.entity_id, e] as const));
    for (const drift of actionableDrifts) {
      const driftedEntity = entityById.get(drift.entity_id);
      if (!driftedEntity || drift.target_cluster_id === null) continue;
      // Pair with entities whose cluster_id == target_cluster_id AND
      // component_id != drifted entity's component (cross-component invariant).
      for (const e of entities) {
        if (e.entity_id === drift.entity_id) continue;
        if (e.cluster_id !== drift.target_cluster_id) continue;
        if (e.component_id === driftedEntity.component_id) continue;
        if (driftedEntity.component_id === null || e.component_id === null) continue;
        const c = scorePair(driftedEntity, e, driftMap, maxGlobalPagerank);
        const key = driftedEntity.entity_id < e.entity_id
          ? `${driftedEntity.entity_id}|${e.entity_id}`
          : `${e.entity_id}|${driftedEntity.entity_id}`;
        if (seen.has(key)) continue;  // already emitted by the §2.2 sweep
        seen.add(key);
        // Drift-driven rows always insert (per §2.5: pair the drift mechanism
        // with the candidate-generation mechanism so they reinforce each other).
        await upsertCandidate({
          entityA: driftedEntity.entity_id, entityB: e.entity_id,
          componentA: driftedEntity.component_id, componentB: e.component_id,
          score: c.score,
          contributions: {
            cluster: c.cluster, drift_a: c.drift_a, drift_b: c.drift_b,
            role: c.role, centrality: c.centrality, articulation: c.articulation,
          },
          driftDriven: true,
        }, tx);
        candidatesInserted++;
        driftDriven++;
      }
    }

    result = {
      ran: true,
      componentPairsEvaluated,
      candidatesInserted,
      driftDrivenCandidates: driftDriven,
      durationMs: Date.now() - t0,
    };
  });
  // pg_try_advisory_xact_lock auto-releases on transaction COMMIT — no
  // explicit unlock needed. `result` is set inside the closure either way.
  return result ?? {
    ran: false,
    skippedReason: 'lock_held',
    componentPairsEvaluated: 0,
    candidatesInserted: 0,
    driftDrivenCandidates: 0,
    durationMs: Date.now() - t0,
  };
}

/** GET endpoint helper — list cross-cluster-generated candidates with entity
 *  display info, ordered by score. Used by viz / debugging per §3.4. */
export async function listCrossClusterCandidates(limit = 100): Promise<Array<{
  id: string;
  entityA: { id: string; name: string; type: string };
  entityB: { id: string; name: string; type: string };
  combinedScore: number;
  status: string;
  resolutionReasoning: string | null;
  detectionCount: number;
  lastDetectedAt: string;
}>> {
  const rows = (await db.execute(sql`
    SELECT
      mc.id::text                    AS id,
      mc.entity_a_id::text           AS entity_a_id,
      mc.entity_b_id::text           AS entity_b_id,
      mc.combined_score              AS combined_score,
      mc.status                      AS status,
      mc.resolution_reasoning        AS resolution_reasoning,
      mc.detection_count             AS detection_count,
      mc.last_detected_at            AS last_detected_at,
      a.canonical_name               AS a_name,
      a.entity_type                  AS a_type,
      b.canonical_name               AS b_name,
      b.entity_type                  AS b_type
    FROM public.merge_candidates mc
    JOIN public.entities a ON a.id = mc.entity_a_id
    JOIN public.entities b ON b.id = mc.entity_b_id
    WHERE mc.candidate_source = 'cross_cluster_generator'
    ORDER BY mc.combined_score DESC
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    entityA: { id: r.entity_a_id as string, name: r.a_name as string, type: r.a_type as string },
    entityB: { id: r.entity_b_id as string, name: r.b_name as string, type: r.b_type as string },
    combinedScore: r.combined_score as number,
    status: r.status as string,
    resolutionReasoning: (r.resolution_reasoning as string | null) ?? null,
    detectionCount: r.detection_count as number,
    lastDetectedAt: r.last_detected_at instanceof Date
      ? r.last_detected_at.toISOString()
      : String(r.last_detected_at),
  }));
}

// Test-only reset helper if needed by the harness — not currently used but
// kept here for symmetry with pipeline.ts._resetReasoningPatrolCount.
export const _internal = { computePredicateSignature };
