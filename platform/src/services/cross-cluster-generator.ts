/**
 * Cross-Cluster Candidate Generator (Phase 4 — doc 25; refactored under
 * bead nmemo-2yv.42)
 *
 * Owns the enumerator half of the cross-component identity-candidate pipeline:
 *   - §2.2 cluster-pair sweep (a ∈ compA, b ∈ compB for every distinct
 *     component pair, capped per pair).
 *   - §2.5 drift-driven additions (drifted entities paired with entities in
 *     their target_cluster_id from OTHER components).
 *   - Concurrency: pg_try_advisory_xact_lock guards against overlapping runs.
 *   - Freshness: skips when topology/clustering compute is stale.
 *   - Telemetry: cross_cluster_runs row INSERTed in a separate short tx
 *     BEFORE the main tx so error paths still leave a forensic record.
 *
 * Signal computation and the merge_candidates write surface moved to
 * merge-scorer.ts (bead .42). This module no longer scores pairs in-process;
 * it builds a pair list, delegates to scoreMergeCandidates, then routes the
 * scored set through upsertScoredCandidates with cross-cluster reasoning
 * extras (component IDs, drift_driven flag). Output rows still carry
 * candidate_source='cross_cluster_generator'; the 3-signal columns are now
 * NULL because their INPUTS are absent (cross-component pairs typically have
 * no shared memories / centroids), not because of a per-source lock — uniform
 * NULL semantics replace the pre-bead §2.5 R3 B3 lock.
 *
 * Inputs (already populated by Phase 1–3 ml-services compute):
 *   - entity_topology    (component_id, k_core, is_articulation_point,
 *                         pagerank, predicate_signature)
 *   - entity_clusters    (cluster_id, cluster_probability)
 *   - entity_drift_events(target_cluster_id, triggered_action, detected_at)
 *
 * Score-weight env overrides (bead .91) survive: computeWeights() reads the
 * CROSS_CLUSTER_W_* env vars, normalises, warns on drift, then the result is
 * mapped into MergeScorerWeights for the scoring call.
 */

import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import {
  computePredicateSignature,
  populatePredicateSignatures,
} from './predicate-signature.js';
import {
  scoreMergeCandidates,
  upsertScoredCandidates,
  DEFAULT_WEIGHTS as MERGE_SCORER_DEFAULT_WEIGHTS,
  type MergeScorerWeights,
  type PairInput,
  type ScoredCandidate,
} from './merge-scorer.js';
import { getGraphStats } from './graph-stats.js';
import { parsePredicateSignature } from './topology.js';

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
/** Cap candidates retained per drift event in the §2.5 path. One drift event
 *  whose target_cluster_id points at a large cluster could otherwise pair the
 *  drifted entity with every cross-component member of that cluster (500+ for
 *  signal-rich domains), flooding the reconciliation_agent's prompt budget.
 *  Mirrors MAX_CANDIDATES_PER_COMPONENT_PAIR for the §2.2 sweep. Bead .97. */
function maxDriftDrivenCandidatesPerEvent(): number { return envInt('MAX_DRIFT_DRIVEN_CANDIDATES_PER_EVENT', 10); }
/** Drift event recency window for the §2.2 drift signal (days). */
function driftRecencyDays(): number { return envInt('DRIFT_RECENCY_DAYS', 30); }

// Score weight defaults (§2.2). Per-invocation env-override + normalisation
// applies in computeWeights() — see bead nmemo-2yv.91. Operators tune via
// CROSS_CLUSTER_W_<NAME>; the pipeline normalises and emits a console.warn
// when |sum - 1.0| > 1e-3 so typos surface instead of being silently rescaled.
const W_CLUSTER_DEFAULT = 0.35;       // w1
const W_DRIFT_A_DEFAULT = 0.125;      // w2
const W_DRIFT_B_DEFAULT = 0.125;      // w3
const W_ROLE_DEFAULT = 0.20;          // w4
const W_CENTRALITY_DEFAULT = 0.15;    // w5
const W_ARTICULATION_DEFAULT = 0.05;  // w6

interface ScoreWeights {
  cluster: number;
  driftA: number;
  driftB: number;
  role: number;
  centrality: number;
  articulation: number;
}

/** Per-invocation: read env overrides for each weight, normalise if the sum
 *  drifts from 1.0, and warn so operators notice typos. Returns a vector that
 *  always sums to 1.0 (or all-zero, when every weight is zeroed). */
function computeWeights(): ScoreWeights {
  const raw: ScoreWeights = {
    cluster:      envFloat('CROSS_CLUSTER_W_CLUSTER',      W_CLUSTER_DEFAULT),
    driftA:       envFloat('CROSS_CLUSTER_W_DRIFT_A',      W_DRIFT_A_DEFAULT),
    driftB:       envFloat('CROSS_CLUSTER_W_DRIFT_B',      W_DRIFT_B_DEFAULT),
    role:         envFloat('CROSS_CLUSTER_W_ROLE',         W_ROLE_DEFAULT),
    centrality:   envFloat('CROSS_CLUSTER_W_CENTRALITY',   W_CENTRALITY_DEFAULT),
    articulation: envFloat('CROSS_CLUSTER_W_ARTICULATION', W_ARTICULATION_DEFAULT),
  };
  const sum = raw.cluster + raw.driftA + raw.driftB + raw.role + raw.centrality + raw.articulation;
  const EPS = 1e-3;
  // Abs check catches both exact-zero (every weight zeroed) and near-zero
  // (mixed-sign cancellation like +0.5 + -0.5 + …). Without this, the
  // normalise branch would divide by ~0 and produce astronomical weights.
  if (Math.abs(sum) < EPS) {
    console.warn(`[cross-cluster] score weights sum=${sum.toExponential(2)} too close to 0; pipeline will produce no candidates. Check CROSS_CLUSTER_W_* env vars.`);
    return raw;
  }
  if (Math.abs(sum - 1.0) > EPS) {
    console.warn(`[cross-cluster] score weights sum=${sum.toFixed(4)} != 1.0; normalising. Check CROSS_CLUSTER_W_* env overrides.`);
    return {
      cluster:      raw.cluster / sum,
      driftA:       raw.driftA / sum,
      driftB:       raw.driftB / sum,
      role:         raw.role / sum,
      centrality:   raw.centrality / sum,
      articulation: raw.articulation / sum,
    };
  }
  return raw;
}

/** Translate the cross-cluster 6-signal weight vector into the merge-scorer's
 *  9-signal weight vector. The cross-cluster-historic signals map directly to
 *  the corresponding scorer signals; the pre-bead drift_a + drift_b split is
 *  summed into drift_recency_either (the unified replacement). The three
 *  signal weights NOT in the cross-cluster vector (centroid/memory/structural)
 *  and componentMatch stay at the merge-scorer's static defaults — they
 *  contribute only when their signals are non-NULL, which for cross-component
 *  pairs is usually never (no shared memories, etc.), so the renormalisation
 *  in computeCombinedScore drops them out for the typical cross-cluster pair. */
function toMergeScorerWeights(cc: ScoreWeights): MergeScorerWeights {
  return {
    centroidSimilarity:       MERGE_SCORER_DEFAULT_WEIGHTS.centroidSimilarity,
    memoryOverlap:            MERGE_SCORER_DEFAULT_WEIGHTS.memoryOverlap,
    structuralSimilarity:     MERGE_SCORER_DEFAULT_WEIGHTS.structuralSimilarity,
    clusterMatch:             cc.cluster,
    predicateSignatureCosine: cc.role,
    driftRecencyEither:       cc.driftA + cc.driftB,
    centralityMatch:          cc.centrality,
    articulationBonus:        cc.articulation,
    componentMatch:           MERGE_SCORER_DEFAULT_WEIGHTS.componentMatch,
  };
}

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
  /** ID of the cross_cluster_runs row for this invocation. Set for every result —
   *  the runs row is INSERTed in a short separate tx BEFORE the main work, so it
   *  exists even when the main tx rolls back. Used by viz / HTTP for correlation. */
  runId: string;
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

/** Per-pair metadata that this module owns (component IDs from the
 *  enumerator, drift-driven flag from the §2.5 sweep). The scorer doesn't
 *  know about these; we keep them in a side Map keyed by canonical pair and
 *  inject via upsertScoredCandidates's reasoningFor callback. */
interface PairMetadata {
  componentA: number;
  componentB: number;
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
      -- Stream-speaker guard (bead nmemo-3f9.6). Anonymous speaker entities
      -- (3f9.1) share identical fact shapes across streams, so the topology +
      -- predicate-signature loop would FALSELY converge two distinct users on
      -- structural similarity alone (no embedding gate on this path). Exclude
      -- any entity that owns a stream_participants row from the candidate set.
      -- This covers the §2.2 sweep AND the §2.5 drift target/driver scans,
      -- which both iterate this loaded set.
      AND NOT EXISTS (
        SELECT 1 FROM public.stream_participants sp WHERE sp.entity_id = et.entity_id
      )
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    entity_id: r.entity_id as string,
    component_id: (r.component_id as number) ?? null,
    component_size: (r.component_size as number) ?? null,
    k_core: (r.k_core as number) ?? null,
    is_articulation_point: Boolean(r.is_articulation_point),
    pagerank: (r.pagerank as number) ?? null,
    predicate_signature: parsePredicateSignature(r.predicate_signature),
    cluster_id: (r.cluster_id as number) ?? null,
    cluster_probability: (r.cluster_probability as number) ?? null,
  }));
}

/** Drift events that triggered the action threshold — these become drift-driven
 *  candidates (§2.5). One row per (entity, detected_at) within the window. */
async function loadActionableDriftEvents(runner: Runner): Promise<DriftRow[]> {
  const cutoff = new Date(Date.now() - driftRecencyDays() * 24 * 60 * 60 * 1000);
  const rows = (await runner.execute(sql`
    SELECT entity_id::text AS entity_id, target_cluster_id, detected_at
    FROM public.entity_drift_events ede
    WHERE detected_at >= ${cutoff}
      AND triggered_action IN ('reconciliation_invoked', 'reconciliation_failed')
      AND target_cluster_id IS NOT NULL
      -- Stream-speaker guard (bead nmemo-3f9.6). A drifted speaker must not
      -- become a drift-driven candidate driver. loadCandidateEntities already
      -- removes speakers from the target/driver pool, but the DESIGN locks the
      -- guard at BOTH loaders so neither path can introduce a speaker even if
      -- one loader's filter were later weakened.
      AND NOT EXISTS (
        SELECT 1 FROM public.stream_participants sp WHERE sp.entity_id = ede.entity_id
      )
    ORDER BY detected_at DESC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    entity_id: r.entity_id as string,
    target_cluster_id: (r.target_cluster_id as number) ?? null,
    detected_at: r.detected_at as Date,
  }));
}

// =============================================================================
// Main entry
// =============================================================================

export async function generateCrossClusterCandidates(): Promise<CandidateGenerationResult> {
  const t0 = Date.now();
  // INSERT the run row in a SHORT separate transaction BEFORE opening the
  // main advisory-lock tx. The row survives main-tx rollback — error paths
  // still leave a forensic record. Mirrors sibling topology/clustering runs
  // pattern (doc 25 §3.x; bead nmemo-2yv.92).
  const runInsert = (await db.execute(sql`
    INSERT INTO public.cross_cluster_runs (status)
    VALUES ('running')
    RETURNING id::text AS id
  `)) as unknown as Array<{ id: string }>;
  const runId = runInsert[0]!.id;

  let result: CandidateGenerationResult | null = null;
  let mainError: unknown;
  let errored = false;
  // Wrap the whole pipeline in a single transaction so that:
  //   1. pg_try_advisory_xact_lock pins acquisition + release to the same
  //      session (transaction-scoped — auto-released on COMMIT/ROLLBACK,
  //      can never leak past this function), and
  //   2. all reads + the upserts share one consistent snapshot.
  // Catch errors via .catch() so we can UPDATE the run row to 'error' in the
  // separate post-tx path below, then rethrow (preserves caller behaviour).
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
        runId,
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
        runId,
      };
      return;
    }

    // Phase 4 prep — Phase 2 leaves predicate_signature NULL; we own population.
    // populatePredicateSignatures uses the global db handle; that's fine —
    // it's an idempotent upsert that we want visible to subsequent reads.
    await populatePredicateSignatures();

    // Load eligible entities + actionable drift events on the transaction's
    // snapshot. driftMap (the per-entity recent-drift map the pre-bead scorer
    // consumed) is no longer needed here — drift_recency_either lives inside
    // scoreMergeCandidates against entity_drift_events directly.
    const entities = await loadCandidateEntities(tx);
    const actionableDrifts = await loadActionableDriftEvents(tx);

    // Per-invocation weights: env-overridable + normalised (bead .91). Map
    // into the merge-scorer's 9-signal vector for the scoring call.
    const ccWeights = computeWeights();
    const scorerWeights = toMergeScorerWeights(ccWeights);

    // Bucket entities by component, and capture the doc 25 §2 "A.size" via
    // the entity_topology.component_size metadata column. Bucket length and
    // component_size differ when k_core filtering drops entities — A.size is
    // the *full* component size (the gate), bucket length is the iteration
    // surface for scoring.
    const byComponent = new Map<number, EntityRow[]>();
    const componentSizeMeta = new Map<number, number>();
    const componentsMissingSize = new Set<number>();
    for (const e of entities) {
      if (e.component_id === null) continue;
      let bucket = byComponent.get(e.component_id);
      if (!bucket) { bucket = []; byComponent.set(e.component_id, bucket); }
      bucket.push(e);
      if (e.component_size !== null) {
        if (!componentSizeMeta.has(e.component_id)) {
          componentSizeMeta.set(e.component_id, e.component_size);
        }
      } else {
        componentsMissingSize.add(e.component_id);
      }
    }
    // Doc 25 §2.1 invariant: the MIN_COMPONENT_SIZE gate is the *full* component
    // size (entity_topology.component_size), not the post-k_core bucket length.
    // A NULL component_size means upstream (Phase 2 topology compute) didn't
    // populate the metadata — treat as stale_upstream per bead nmemo-2yv.96
    // Decision (locked 2026-05-21). Surfacing this as a skip avoids the
    // pre-bead silent fallback to bucket length, which inverts the invariant.
    if (componentsMissingSize.size > 0) {
      const sample = [...componentsMissingSize].slice(0, 10);
      const suffix = componentsMissingSize.size > sample.length
        ? ` (and ${componentsMissingSize.size - sample.length} more)`
        : '';
      console.warn(`[cross-cluster] entity_topology.component_size NULL for component_ids=[${sample.join(',')}]${suffix}; skipping with skippedReason='stale_upstream' — Phase 2 topology compute should populate component_size.`);
      result = {
        ran: false,
        skippedReason: 'stale_upstream',
        componentPairsEvaluated: 0,
        candidatesInserted: 0,
        driftDrivenCandidates: 0,
        durationMs: Date.now() - t0,
        runId,
      };
      return;
    }
    const componentIds = [...byComponent.keys()].filter(
      (cid) => componentSizeMeta.get(cid)! >= minComponentSize(),
    );
    componentIds.sort((a, b) => a - b);

    // Enumerate §2.2 (cross-component cluster sweep) and §2.5 (drift-driven)
    // pairs. Both feed into ONE scoreMergeCandidates call; per-pair metadata
    // (componentA / componentB / driftDriven) lives in a side-Map keyed by
    // canonical pair key so we can route it into the upsert reasoning blob
    // and apply per-(compA, compB) capping on the §2.2 partition only.
    const canonKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const pairMetadata = new Map<string, PairMetadata>();
    let componentPairsEvaluated = 0;

    // §2.2 — every (componentA, componentB) pair contributes its bucket-cross.
    for (let i = 0; i < componentIds.length; i++) {
      for (let j = i + 1; j < componentIds.length; j++) {
        componentPairsEvaluated++;
        const aBucket = byComponent.get(componentIds[i]!)!;
        const bBucket = byComponent.get(componentIds[j]!)!;
        for (const a of aBucket) {
          for (const b of bBucket) {
            const k = canonKey(a.entity_id, b.entity_id);
            if (pairMetadata.has(k)) continue;
            pairMetadata.set(k, {
              componentA: a.component_id!,
              componentB: b.component_id!,
              driftDriven: false,
            });
          }
        }
      }
    }

    // §2.5 — drift-driven additions. Pair drifted entity with target-cluster
    // members in OTHER components. Drift-driven semantics OVERRIDE §2.2 — a
    // pair already enumerated by the cluster-pair sweep gets its metadata
    // promoted to driftDriven=true so it survives the always-insert rule and
    // the upsert reasoning blob carries drift_driven=true. Pre-bead behaviour:
    // §2.2's threshold could drop a pair that §2.5 then re-inserted as drift-
    // driven with no threshold check; preserving that semantic requires the
    // override here. (Without it, the "drifted entity produces candidates"
    // test fails when the (drifted, target) score lands just below the §2.2
    // threshold.)
    //
    // Per-event pair sets (bead .97) — one Set<canonKey> per drift event. The
    // policy-partition pass below uses these to apply the per-event top-N cap
    // (MAX_DRIFT_DRIVEN_CANDIDATES_PER_EVENT) so a drift event into a 500-
    // member target cluster doesn't flood the reconciliation_agent's prompt.
    // A pair pulled by multiple events appears in each event's set; the union
    // of kept-after-cap subsets forms the final drift-driven partition.
    const entityById = new Map(entities.map((e) => [e.entity_id, e] as const));
    const driftEventPairKeys: Set<string>[] = [];
    for (const drift of actionableDrifts) {
      const driftedEntity = entityById.get(drift.entity_id);
      if (!driftedEntity || drift.target_cluster_id === null) {
        driftEventPairKeys.push(new Set());
        continue;
      }
      const eventKeys = new Set<string>();
      for (const e of entities) {
        if (e.entity_id === drift.entity_id) continue;
        if (e.cluster_id !== drift.target_cluster_id) continue;
        if (e.component_id === driftedEntity.component_id) continue;
        if (driftedEntity.component_id === null || e.component_id === null) continue;
        const k = canonKey(driftedEntity.entity_id, e.entity_id);
        // Set unconditionally — overwrite §2.2's driftDriven=false if present.
        pairMetadata.set(k, {
          componentA: driftedEntity.component_id,
          componentB: e.component_id,
          driftDriven: true,
        });
        eventKeys.add(k);
      }
      driftEventPairKeys.push(eventKeys);
    }

    // Score every enumerated pair in ONE set-based pass (bead .42 perf accept).
    const allPairs: PairInput[] = [];
    for (const k of pairMetadata.keys()) {
      const [a, b] = k.split('|');
      allPairs.push({ entityAId: a!, entityBId: b! });
    }
    // Bead nmemo-2yv.43 — read graph_stats once per generator run and pass
    // into the scorer for adaptive weighting. Read uses the module-level
    // `db` handle (separate connection from `tx`) so it doesn't observe the
    // in-flight transaction's uncommitted writes — that's the right snapshot
    // (graph_stats is a singleton refreshed by its own /compute path; the
    // scorer wants the most recently committed view, not whatever this run
    // is partway through writing). Null is fine — adaptWeights() handles
    // null identically to "static weights".
    const graphStats = allPairs.length === 0 ? null : await getGraphStats();
    const scored = allPairs.length === 0
      ? []
      : await scoreMergeCandidates(allPairs, { runner: tx, weights: scorerWeights, graphStats });

    // Apply policies per partition:
    //   §2.2 (driftDriven=false): drop below BRIDGE_SCORE_THRESHOLD; cap by
    //         (componentA, componentB) at MAX_CANDIDATES_PER_COMPONENT_PAIR.
    //   §2.5 (driftDriven=true):  always insert (no threshold), but cap per
    //         drift event at MAX_DRIFT_DRIVEN_CANDIDATES_PER_EVENT — top-N by
    //         score (bead .97). Preserves the "always insert" semantics for
    //         the strongest N per event while bounding blast radius when one
    //         drift event targets a large cluster.
    const threshold = bridgeScoreThreshold();
    const cap = maxCandidatesPerPair();
    const driftCap = maxDriftDrivenCandidatesPerEvent();
    const scoredByKey = new Map<string, ScoredCandidate>();
    const sweepByCompPair = new Map<string, ScoredCandidate[]>();
    for (const s of scored) {
      const k = canonKey(s.entityAId, s.entityBId);
      scoredByKey.set(k, s);
      const meta = pairMetadata.get(k);
      if (!meta) continue;
      if (meta.driftDriven) continue;  // drift partition handled below
      if (s.combinedScore < threshold) continue;
      const cpKey = `${meta.componentA}|${meta.componentB}`;
      let bucket = sweepByCompPair.get(cpKey);
      if (!bucket) { bucket = []; sweepByCompPair.set(cpKey, bucket); }
      bucket.push(s);
    }
    const sweepKept: ScoredCandidate[] = [];
    for (const bucket of sweepByCompPair.values()) {
      bucket.sort((x, y) => y.combinedScore - x.combinedScore);
      sweepKept.push(...bucket.slice(0, cap));
    }
    // §2.5 per-event cap: for each drift event, collect its scored pairs,
    // sort by combinedScore DESC, slice to driftCap, union across events into
    // the kept set. Dedupe by canonical pair key — a pair pulled by multiple
    // events still appears once in the final drift-driven partition.
    const driftKeptKeys = new Set<string>();
    const driftKept: ScoredCandidate[] = [];
    for (const eventKeys of driftEventPairKeys) {
      const eventScored: ScoredCandidate[] = [];
      for (const k of eventKeys) {
        const s = scoredByKey.get(k);
        if (s) eventScored.push(s);
      }
      eventScored.sort((x, y) => y.combinedScore - x.combinedScore);
      for (const s of eventScored.slice(0, driftCap)) {
        const k = canonKey(s.entityAId, s.entityBId);
        if (driftKeptKeys.has(k)) continue;
        driftKeptKeys.add(k);
        driftKept.push(s);
      }
    }

    const finalSet = [...sweepKept, ...driftKept];
    const candidatesInserted = finalSet.length === 0
      ? 0
      : await upsertScoredCandidates(finalSet, {
          runner: tx,
          candidateSource: 'cross_cluster_generator',
          statusFor: () => 'candidate',
          reasoningFor: (s) => {
            const meta = pairMetadata.get(canonKey(s.entityAId, s.entityBId))!;
            // Preserve the pre-bead reasoning shape so the reconciliation_agent's
            // cross-cluster prompt block (doc 25 §2.4) and the snapshot test's
            // perSignalContributionStats keep reading the same field names.
            // Legacy drift_a / drift_b both carry the unified
            // drift_recency_either value (bead .42 consolidated the split);
            // downstream readers see a non-zero where one of the legacy halves
            // used to fire — conservative direction.
            return {
              contributions: {
                cluster:      s.signals.cluster_match ?? 0,
                drift_a:      s.signals.drift_recency_either ?? 0,
                drift_b:      s.signals.drift_recency_either ?? 0,
                role:         s.signals.predicate_signature_cosine ?? 0,
                centrality:   s.signals.centrality_match ?? 0,
                articulation: s.signals.articulation_bonus ?? 0,
              },
              component_a: meta.componentA,
              component_b: meta.componentB,
              drift_driven: meta.driftDriven,
            };
          },
        });
    const driftDriven = driftKept.length;

    result = {
      ran: true,
      componentPairsEvaluated,
      candidatesInserted,
      driftDrivenCandidates: driftDriven,
      durationMs: Date.now() - t0,
      runId,
    };
  }).catch((err: unknown) => {
    mainError = err;
    errored = true;
  });
  // pg_try_advisory_xact_lock auto-releases on transaction COMMIT/ROLLBACK —
  // no explicit unlock needed. On the success/skip path `result` is set inside
  // the closure; on the error path `.catch()` above flips `errored` and we
  // route through the error branch before reading `result`.

  // Error path: UPDATE the run row to 'error' and rethrow. The `errored` flag
  // (vs `mainError !== null`) guards against `throw null/undefined/0` cases —
  // a falsy thrown value would otherwise mis-route into the success branch.
  if (errored) {
    const message = mainError instanceof Error ? mainError.message : String(mainError);
    await db.execute(sql`
      UPDATE public.cross_cluster_runs
      SET status = 'error',
          completed_at = NOW(),
          duration_ms = ${Date.now() - t0},
          error = ${message}
      WHERE id = ${runId}::uuid
    `);
    throw mainError;
  }

  // Success / skip path: every closure exit assigned `result` (including the
  // two skip branches and the success branch), so it is non-null here.
  const finalResult = result!;
  const finalStatus = finalResult.ran ? 'completed' : 'skipped';
  await db.execute(sql`
    UPDATE public.cross_cluster_runs
    SET status                    = ${finalStatus},
        completed_at              = NOW(),
        skipped_reason            = ${finalResult.skippedReason ?? null},
        component_pairs_evaluated = ${finalResult.componentPairsEvaluated},
        candidates_inserted       = ${finalResult.candidatesInserted},
        drift_driven_candidates   = ${finalResult.driftDrivenCandidates},
        duration_ms               = ${finalResult.durationMs}
    WHERE id = ${runId}::uuid
  `);
  return finalResult;
}

/** Valid merge_candidates.status values (CHECK constraint in 003_graph_meta.sql:67-69).
 *  Exported for the /api/cross-cluster/candidates route's input validation
 *  (bead nmemo-2yv.98). */
export const CROSS_CLUSTER_CANDIDATE_STATUSES = [
  'candidate',
  'staging',
  'provisional',
  'resolved',
] as const;

/** Default status filter when listCrossClusterCandidates is called without an
 *  explicit statusFilter. Matches the viz panel's intent — never show resolved
 *  rows. Aligns with the partial indexes idx_merge_candidates_score /
 *  idx_merge_candidates_status (003_graph_meta.sql:75-79, both WHERE status !=
 *  'resolved'). Bead nmemo-2yv.98 locked Decision (2026-05-22): default to
 *  ['candidate', 'staging']. */
const DEFAULT_CROSS_CLUSTER_STATUS_FILTER: readonly string[] = ['candidate', 'staging'];

/** GET endpoint helper — list cross-cluster-generated candidates with entity
 *  display info, ordered by score. Used by viz / debugging per §3.4.
 *
 *  The default `statusFilter` (`['candidate', 'staging']`) hides resolved rows
 *  so the viz panel stops re-rendering historical resolutions forever (bead
 *  nmemo-2yv.98). Callers needing the audit view pass an explicit filter:
 *  `listCrossClusterCandidates(100, ['resolved'])` returns only resolved.
 */
export async function listCrossClusterCandidates(
  limit = 100,
  statusFilter: readonly string[] = DEFAULT_CROSS_CLUSTER_STATUS_FILTER,
): Promise<Array<{
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
      AND mc.status = ANY(ARRAY[${sql.join(statusFilter.map(s => sql`${s}`), sql`, `)}]::text[])
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

/** GET endpoint helper — list the most recent cross_cluster_runs rows for the
 *  viz panel header + operational dashboards. Mirrors the sibling pattern for
 *  topology_compute_runs / clustering_compute_runs (bead nmemo-2yv.92). */
export async function listCrossClusterRuns(limit = 20): Promise<Array<{
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'skipped' | 'error';
  skippedReason: string | null;
  componentPairsEvaluated: number | null;
  candidatesInserted: number | null;
  driftDrivenCandidates: number | null;
  durationMs: number | null;
  error: string | null;
}>> {
  const rows = (await db.execute(sql`
    SELECT
      id::text                  AS id,
      started_at                AS started_at,
      completed_at              AS completed_at,
      status                    AS status,
      skipped_reason            AS skipped_reason,
      component_pairs_evaluated AS component_pairs_evaluated,
      candidates_inserted       AS candidates_inserted,
      drift_driven_candidates   AS drift_driven_candidates,
      duration_ms               AS duration_ms,
      error                     AS error
    FROM public.cross_cluster_runs
    ORDER BY started_at DESC
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, unknown>>;
  const toIso = (v: unknown): string | null => {
    if (v == null) return null;
    return v instanceof Date ? v.toISOString() : String(v);
  };
  return rows.map((r) => ({
    id: r.id as string,
    startedAt: toIso(r.started_at) ?? '',
    completedAt: toIso(r.completed_at),
    status: r.status as 'running' | 'completed' | 'skipped' | 'error',
    skippedReason: (r.skipped_reason as string | null) ?? null,
    componentPairsEvaluated: (r.component_pairs_evaluated as number | null) ?? null,
    candidatesInserted: (r.candidates_inserted as number | null) ?? null,
    driftDrivenCandidates: (r.drift_driven_candidates as number | null) ?? null,
    durationMs: (r.duration_ms as number | null) ?? null,
    error: (r.error as string | null) ?? null,
  }));
}

// Test-only internal exports for direct exercise from the harness.
export const _internal = { computePredicateSignature };

/** ============================================================
 * Post-compute trigger (bead nmemo-2yv.85, relocated by .88).
 *
 * Fire-and-forget the cross-cluster candidate generator after a successful
 * /api/{topology,clustering,drift}/compute. The generator's own freshness
 * gate handles the "both upstreams fresh" precondition; the advisory lock
 * inside generateCrossClusterCandidates() handles overlap.
 *
 * Was previously a top-level helper in index.ts. Moved here so the trigger
 * lives next to the service it invokes — index.ts no longer needs to know
 * about the dynamic-import shape. Caller signature is unchanged
 * (void-returning, never throws) so existing route handlers keep
 * `void triggerCrossClusterAfterCompute('topology')` semantics.
 * ============================================================ */
export async function triggerCrossClusterAfterCompute(
  after: 'topology' | 'clustering' | 'drift',
): Promise<void> {
  try {
    const result = await generateCrossClusterCandidates();
    if (result.ran) {
      console.log(
        `[cross-cluster] auto-trigger after ${after}/compute: candidates=${result.candidatesInserted} ` +
        `drift_driven=${result.driftDrivenCandidates} component_pairs=${result.componentPairsEvaluated} ` +
        `duration=${result.durationMs}ms`,
      );
    } else {
      console.log(`[cross-cluster] auto-trigger after ${after}/compute skipped: ${result.skippedReason}`);
    }
  } catch (err) {
    console.warn(
      `[cross-cluster] auto-trigger after ${after}/compute failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}
