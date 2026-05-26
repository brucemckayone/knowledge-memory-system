/**
 * Phase 4 — cross-cluster generator benchmark on synthetic snapshots (doc 25 §5)
 *
 * This is the "live integration" benchmark for the cross-cluster generator:
 *   1. Restore synthetic-10k (or synthetic-1k for fast feedback) into
 *      cognitive_test via ensureSnapshot().
 *   2. Invoke ml-services topology + clustering compute against the
 *      restored DB by driving the same Python entrypoints used by the
 *      sibling drift / topology snapshot tests (no HTTP — direct python
 *      subprocess so the benchmark works without the platform server).
 *   3. Run the TypeScript generator end-to-end.
 *   4. Score the emitted candidates against `ground_truth.bridge_pairs`
 *      from the manifest's side-channel JSON: recall / precision / F1 +
 *      the per-signal contribution distribution per §7.4.
 *   5. Write a baseline JSON report under
 *      `platform/src/test/data/phase4-cross-cluster/benchmark-reports/`.
 *
 * Doc 25 §5.1 latency targets and §5.2 quality targets:
 *   - synthetic-10k total wall clock < 35s target / 150s hard cap.
 *   - synthetic-10k recall ≥ 0.6 at default thresholds (acceptance gate).
 *   - precision ≥ 0.3 (we tolerate FPs because the LLM verifier filters).
 *
 * The snapshot vitest config (single fork, file-parallelism off) keeps
 * pg_restore from racing with other tests.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  testDb,
  ensureSnapshot,
  loadGroundTruth,
  skipCtx,
  type BridgePair,
} from '../setup.js';
import { generateCrossClusterCandidates } from '../../services/cross-cluster-generator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '..', 'data', 'phase4-cross-cluster', 'benchmark-reports');
const VENV_PYTHON = join(__dirname, '..', '..', '..', '..', 'ml-services', '.venv', 'Scripts', 'python.exe');
const ML_SERVICES_DIR = join(__dirname, '..', '..', '..', '..', 'ml-services');
const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive_test';

interface TopologyResult {
  entity_count: number;
  edge_count: number;
  pagerank_max: number;
}
interface ClusteringResult {
  entity_count: number;
  cluster_count: number;
  noise_count: number;
}

/** Run the full Phase 2 topology compute (components, k_core, articulation,
 *  bridges, communities, centrality) against cognitive_test. Mirrors
 *  topology-centrality.test.ts. */
function runTopologyCompute(): TopologyResult {
  const driver = `
import sys, os, json
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${TEST_DB_URL}"
from app.topology import (
    _export_graph,
    compute_components, compute_k_core, compute_articulation,
    compute_bridges, compute_communities, compute_centrality,
    _write_back, COMPUTATION_VERSION,
)
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${TEST_DB_URL}", row_factory=dict_row) as conn:
    g, n, e = _export_graph(conn)
    comp = compute_components(g)
    kc = compute_k_core(g)
    art = compute_articulation(g)
    br = compute_bridges(g)
    comm = compute_communities(g, computation_version=COMPUTATION_VERSION)
    cent = compute_centrality(g)
    _write_back(conn, components=comp, k_core=kc, articulation=art,
                communities=comm, centrality=cent, bridges=br,
                computation_version=COMPUTATION_VERSION)
    # Mark a completed run so the freshness gate clears.
    conn.execute(
        "INSERT INTO public.topology_compute_runs "
        "(started_at, completed_at, status, computation_version, entities_processed) "
        "VALUES (NOW() - INTERVAL '1 second', NOW() + INTERVAL '5 minutes', 'completed', %s, %s)",
        (COMPUTATION_VERSION, n),
    )
    conn.commit()
    pr_vals = [pr for pr, _ in cent.values()] if cent else []
    print(json.dumps({
        "entity_count": n,
        "edge_count": e,
        "pagerank_max": max(pr_vals) if pr_vals else 0.0,
    }))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as TopologyResult;
}

/** Run Phase 3 HDBSCAN clustering compute against cognitive_test. Mirrors
 *  the driver used by clustering-hdbscan.test.ts — calls the internal
 *  pieces directly because there's no single `compute_clustering` entry
 *  in app.semantic_clustering (the FastAPI handler is `clustering_compute`
 *  which builds its own connection). */
function runClusteringCompute(): ClusteringResult {
  const driver = `
import sys, os, json
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${TEST_DB_URL}"
from app.semantic_clustering import (
    _export_centroids, compute_hdbscan, _write_back, _summarise,
    _update_graph_stats, _hdbscan_min_cluster_size, _hdbscan_min_samples,
    COMPUTATION_VERSION,
)
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${TEST_DB_URL}", row_factory=dict_row) as conn:
    centroids = _export_centroids(conn)
    if not centroids:
        print(json.dumps({"entity_count": 0, "cluster_count": 0, "noise_count": 0}))
    else:
        assignments = compute_hdbscan(
            centroids,
            min_cluster_size=_hdbscan_min_cluster_size(),
            min_samples=_hdbscan_min_samples(),
        )
        cc, nc, intra, inter = _summarise(assignments)
        _write_back(conn, assignments=assignments, computation_version=COMPUTATION_VERSION)
        _update_graph_stats(conn, cluster_count=cc, mean_intra=intra,
                            mean_inter=inter, computation_version=COMPUTATION_VERSION)
        conn.execute(
            "INSERT INTO public.clustering_compute_runs "
            "(started_at, completed_at, status, computation_version, entities_processed, cluster_count, noise_count) "
            "VALUES (NOW() - INTERVAL '1 second', NOW() + INTERVAL '5 minutes', 'completed', %s, %s, %s, %s)",
            (COMPUTATION_VERSION, len(assignments), cc, nc),
        )
        conn.commit()
        print(json.dumps({"entity_count": len(assignments), "cluster_count": cc, "noise_count": nc}))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as ClusteringResult;
}

interface ScoreReport {
  recall: number;
  precision: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  candidatesEmitted: number;
  groundTruthSize: number;
}

/** Score candidates emitted against ground-truth bridge pairs. Pairs are
 *  unordered — we compare canonical (min, max) tuples. */
function scoreAgainstGroundTruth(
  emittedPairs: Array<{ a: string; b: string }>,
  groundTruth: BridgePair[],
): ScoreReport {
  const canon = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const truth = new Set(groundTruth.map((p) => canon(p.a, p.b)));
  const emitted = new Set(emittedPairs.map((p) => canon(p.a, p.b)));
  let tp = 0;
  for (const k of emitted) if (truth.has(k)) tp++;
  const fp = emitted.size - tp;
  const fn = truth.size - tp;
  const recall = truth.size === 0 ? 0 : tp / truth.size;
  const precision = emitted.size === 0 ? 0 : tp / emitted.size;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return {
    recall, precision, f1,
    truePositives: tp, falsePositives: fp, falseNegatives: fn,
    candidatesEmitted: emitted.size,
    groundTruthSize: truth.size,
  };
}

/** Compute the per-signal contribution distribution from the candidates'
 *  resolution_reasoning JSON — for the §7.4 weight-tuning protocol. */
async function perSignalContributionStats(): Promise<Record<string, { mean: number; max: number; nonZero: number }>> {
  const rows = await testDb<{ resolution_reasoning: string | null }[]>`
    SELECT resolution_reasoning FROM public.merge_candidates
    WHERE candidate_source = 'cross_cluster_generator'
  `;
  const sums: Record<string, number[]> = {
    cluster: [], drift_a: [], drift_b: [], role: [], centrality: [], articulation: [],
  };
  for (const r of rows) {
    if (!r.resolution_reasoning) continue;
    try {
      const j = JSON.parse(r.resolution_reasoning) as { contributions?: Record<string, number> };
      if (j.contributions) {
        for (const k of Object.keys(sums)) {
          if (typeof j.contributions[k] === 'number') sums[k]!.push(j.contributions[k]!);
        }
      }
    } catch { /* ignore malformed json */ }
  }
  const out: Record<string, { mean: number; max: number; nonZero: number }> = {};
  for (const [k, vals] of Object.entries(sums)) {
    if (vals.length === 0) {
      out[k] = { mean: 0, max: 0, nonZero: 0 };
      continue;
    }
    const max = Math.max(...vals);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const nonZero = vals.filter((v) => v > 0).length;
    out[k] = { mean, max, nonZero };
  }
  return out;
}

interface BenchmarkReport {
  snapshot: string;
  generatedAt: string;
  weights: Record<string, number>;
  thresholds: Record<string, number | string>;
  topology: TopologyResult;
  clustering: ClusteringResult;
  generator: {
    ran: boolean;
    skippedReason?: string;
    componentPairsEvaluated: number;
    candidatesInserted: number;
    driftDrivenCandidates: number;
    durationMs: number;
  };
  score: ScoreReport;
  perSignalContributions: Record<string, { mean: number; max: number; nonZero: number }>;
  /** Diagnostic — how the ground-truth bridge pairs partition by component.
   *  Phase 4 only targets crossComp pairs; sameComp and unknownComp are
   *  structurally invisible to this generator. */
  groundTruthDistribution: { crossComponent: number; sameComponent: number; unknown: number };
  totalElapsedMs: number;
  notes: string;
}

async function runBenchmark(snapshotName: string): Promise<BenchmarkReport> {
  const t0 = Date.now();
  const topology = runTopologyCompute();
  const clustering = runClusteringCompute();
  const genResult = await generateCrossClusterCandidates();

  // Read emitted candidates back to score.
  const emittedRows = await testDb<{ entity_a_id: string; entity_b_id: string }[]>`
    SELECT entity_a_id::text AS entity_a_id, entity_b_id::text AS entity_b_id
    FROM public.merge_candidates
    WHERE candidate_source = 'cross_cluster_generator'
  `;
  const groundTruth = await loadGroundTruth(snapshotName);
  const score = scoreAgainstGroundTruth(
    emittedRows.map((r) => ({ a: r.entity_a_id, b: r.entity_b_id })),
    groundTruth,
  );
  const perSignalContributions = await perSignalContributionStats();

  // Diagnostic — how many ground-truth bridge pairs are intra-component vs
  // cross-component? Phase 4 by design only targets cross-component pairs;
  // if the fixture's bridges are mostly intra-component, recall on this
  // fixture is structurally bounded by that fraction.
  const groundTruthIds = [...new Set(groundTruth.flatMap((p) => [p.a, p.b]))];
  const componentRows = groundTruthIds.length === 0 ? [] : await testDb<{ entity_id: string; component_id: number | null }[]>`
    SELECT entity_id::text AS entity_id, component_id
    FROM public.entity_topology
    WHERE entity_id = ANY(${groundTruthIds}::uuid[])
  `;
  const compById = new Map(componentRows.map((r) => [r.entity_id, r.component_id] as const));
  let crossComp = 0;
  let sameComp = 0;
  let unknownComp = 0;
  for (const p of groundTruth) {
    const ca = compById.get(p.a);
    const cb = compById.get(p.b);
    if (ca == null || cb == null) unknownComp++;
    else if (ca === cb) sameComp++;
    else crossComp++;
  }

  const totalElapsedMs = Date.now() - t0;
  return {
    snapshot: snapshotName,
    generatedAt: new Date().toISOString(),
    weights: {
      cluster: 0.35, drift_a: 0.125, drift_b: 0.125,
      role: 0.20, centrality: 0.15, articulation: 0.05,
    },
    thresholds: {
      MIN_COMPONENT_SIZE: process.env.MIN_COMPONENT_SIZE ?? 'default(2)',
      MIN_K_CORE_FOR_BRIDGE: process.env.MIN_K_CORE_FOR_BRIDGE ?? 'default(1)',
      BRIDGE_SCORE_THRESHOLD: process.env.BRIDGE_SCORE_THRESHOLD ?? 'default(0.3)',
      MAX_CANDIDATES_PER_COMPONENT_PAIR: process.env.MAX_CANDIDATES_PER_COMPONENT_PAIR ?? 'default(5)',
      DRIFT_RECENCY_DAYS: process.env.DRIFT_RECENCY_DAYS ?? 'default(30)',
    },
    topology,
    clustering,
    generator: {
      ran: genResult.ran,
      skippedReason: genResult.skippedReason,
      componentPairsEvaluated: genResult.componentPairsEvaluated,
      candidatesInserted: genResult.candidatesInserted,
      driftDrivenCandidates: genResult.driftDrivenCandidates,
      durationMs: genResult.durationMs,
    },
    score,
    perSignalContributions,
    groundTruthDistribution: {
      crossComponent: crossComp, sameComponent: sameComp, unknown: unknownComp,
    },
    totalElapsedMs,
    notes:
      'Per doc 25 §5.2 baseline (acceptance: recall >= 0.6 / precision >= 0.3, tuneable). ' +
      'Phase 4 by design targets cross-component identity pairs only; intra-component ' +
      'and orphan-singleton pairs are structurally invisible to this generator. The ' +
      'groundTruthDistribution field surfaces how many ground-truth pairs fall into each ' +
      'class so the recall figure is interpretable: a recall of 0 against a fixture whose ' +
      'sameComponent count is high is NOT a generator regression — it indicates the fixture ' +
      'is testing intra-component ambiguity, which is the existing 3-signal scorer\'s domain. ' +
      'Run via vitest snapshot config (single fork). Topology + clustering compute drive ' +
      'the same Python entrypoints exercised by topology-*.test.ts / clustering-hdbscan.test.ts.',
  };
}

function writeReport(name: string, report: BenchmarkReport) {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
}

describe('cross-cluster benchmark — synthetic-1k', () => {
  let report: BenchmarkReport;
  beforeAll(async (ctx) => {
    if (!existsSync(VENV_PYTHON)) {
      console.warn('[benchmark] venv python not found — skipping');
      skipCtx(ctx);
      return;
    }
    await ensureSnapshot('synthetic-1k');
    report = await runBenchmark('synthetic-1k');
    writeReport('synthetic-1k', report);
  }, 600_000);

  it('generator ran end-to-end', () => {
    expect(report.generator.ran).toBe(true);
  });

  it('candidates-inserted count is RECORDED (zero is valid when fixture has no cross-component pairs)', () => {
    // synthetic-1k bridge pairs are intra-component (all in component_0).
    // Phase 4 by design only targets cross-component pairs, so 0
    // candidates is the expected outcome until the synthetic generator
    // is updated to produce cross-component bridges.
    expect(report.generator.candidatesInserted).toBeGreaterThanOrEqual(0);
  });

  it('total wall clock under doc 25 §5.1 hard cap (150s)', () => {
    expect(report.totalElapsedMs).toBeLessThan(150_000);
  });
});

describe('cross-cluster benchmark — synthetic-10k', () => {
  let report: BenchmarkReport;
  beforeAll(async (ctx) => {
    if (!existsSync(VENV_PYTHON)) {
      console.warn('[benchmark] venv python not found — skipping');
      skipCtx(ctx);
      return;
    }
    await ensureSnapshot('synthetic-10k');
    report = await runBenchmark('synthetic-10k');
    writeReport('synthetic-10k', report);
  }, 1_200_000);

  it('generator ran end-to-end on 10k entities', () => {
    expect(report.generator.ran).toBe(true);
    expect(report.topology.entity_count).toBe(10_000);
  });

  it('candidates count is RECORDED (10k variant — same fixture caveat as 1k)', () => {
    expect(report.generator.candidatesInserted).toBeGreaterThanOrEqual(0);
  });

  it('recall is RECORDED in the benchmark report (doc 25 §5.2 acceptance is "tuneable; recorded")', () => {
    // The bead acceptance criteria explicitly say "tuneable; recorded in
    // benchmark report". We record but do not gate on the absolute value
    // because synthetic-10k's ground-truth bridge pairs are intra-
    // component (all in component_0), and Phase 4 by design only targets
    // cross-component pairs. groundTruthDistribution captures this so the
    // 0 recall is interpretable. The cross-component sibling fixture
    // (`synthetic-10k-cross-component`, nmemo-2yv.95) is the recall-gated
    // variant; this `synthetic-10k` suite is retained as the intra-component
    // baseline so existing snapshot infrastructure stays stable.
    expect(report.score.recall).toBeGreaterThanOrEqual(0);
    expect(report.groundTruthDistribution).toBeDefined();
  });

  it('precision is RECORDED in the benchmark report', () => {
    expect(report.score.precision).toBeGreaterThanOrEqual(0);
  });

  it('total wall clock under doc 25 §5.1 hard cap (150s)', () => {
    expect(report.totalElapsedMs).toBeLessThan(150_000);
  });
});

/**
 * Cross-component synthetic fixture (nmemo-2yv.95). Same shape as the
 * synthetic-10k suite above, but the underlying snapshot is generated in
 * `cross-component` mode — the 50 bridge pairs land across distinct
 * connected components, which is the regime Phase 4's cross-cluster
 * generator is designed to target. Recall is gated here (doc 25 §5.2:
 * recall >= 0.6, precision >= 0.3) because the fixture supports it; the
 * intra-component synthetic-10k suite above remains as the legacy
 * baseline whose ground-truth shape is structurally invisible to Phase 4.
 */
describe('cross-cluster benchmark — synthetic-10k-cross-component', () => {
  let report: BenchmarkReport;
  beforeAll(async (ctx) => {
    if (!existsSync(VENV_PYTHON)) {
      console.warn('[benchmark] venv python not found — skipping');
      skipCtx(ctx);
      return;
    }
    await ensureSnapshot('synthetic-10k-cross-component');
    report = await runBenchmark('synthetic-10k-cross-component');
    writeReport('synthetic-10k-cross-component', report);
  }, 1_200_000);

  it('generator ran end-to-end on 10k entities', () => {
    expect(report.generator.ran).toBe(true);
    expect(report.topology.entity_count).toBe(10_000);
  });

  it('ground-truth bridges are cross-component (no same-component / unknown pairs)', () => {
    // The whole point of the cross-component fixture: every ground-truth
    // bridge pair sits across two distinct connected components. If any
    // pair lands in the sameComponent or unknown bucket, the cross-cluster
    // facts / non-bridge same_as_links suppression in cross-component mode
    // failed to isolate the cluster modes — regenerate the snapshot with
    // `pnpm snapshot:ensure --force synthetic-10k-cross-component`.
    expect(report.groundTruthDistribution.crossComponent).toBeGreaterThan(0);
    expect(report.groundTruthDistribution.sameComponent).toBe(0);
    expect(report.groundTruthDistribution.unknown).toBe(0);
  });

  it('recall >= 0.6 (doc 25 §5.2 acceptance)', () => {
    expect(report.score.recall).toBeGreaterThanOrEqual(0.6);
  });

  it('precision >= 0.3 (doc 25 §5.2 acceptance)', () => {
    expect(report.score.precision).toBeGreaterThanOrEqual(0.3);
  });

  it('total wall clock under doc 25 §5.1 hard cap (150s)', () => {
    expect(report.totalElapsedMs).toBeLessThan(150_000);
  });
});
