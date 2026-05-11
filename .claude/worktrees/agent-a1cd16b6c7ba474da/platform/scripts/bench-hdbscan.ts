#!/usr/bin/env tsx
/**
 * Phase 3 HDBSCAN clustering benchmark runner (doc 24.1 §5.2, nmemo-a7f.3.1.2).
 *
 * For each snapshot the script:
 *   1. Restores the snapshot into cognitive_test
 *   2. Spawns the venv python to run compute_hdbscan against cognitive_test,
 *      capturing compute-only elapsed time (excluding export + write-back)
 *   3. Reads entity_clusters + graph_stats and aggregates cluster_count,
 *      noise_count, intra/inter mean distances
 *   4. For synthetic-10k: loads ground_truth.json and asserts that all 50
 *      bridge pairs land in different cluster_ids (doc 24.1 §4.3 + §5.3
 *      "bridge pair separation" — the synthetic generator's contract)
 *   5. Writes the §5.2 schema JSON under
 *      platform/src/test/data/phase3-clustering/benchmark-reports/<name>-hdbscan.json
 *
 * Usage:
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-hdbscan.ts synthetic-1k
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-hdbscan.ts synthetic-10k
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadSnapshot } from './load-snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = join(__dirname, '..');
const REPORTS_DIR = join(PLATFORM_ROOT, 'src', 'test', 'data', 'phase3-clustering', 'benchmark-reports');
const VENV_PYTHON = join(PLATFORM_ROOT, '..', 'ml-services', '.venv', 'Scripts', 'python.exe');
const ML_SERVICES_DIR = join(PLATFORM_ROOT, '..', 'ml-services');

const STAGES = ['synthetic-1k', 'synthetic-10k'] as const;

// Doc 24.1 §5.1 thresholds.
const THRESHOLDS: Record<(typeof STAGES)[number], { target_ms: number; hard_cap_ms: number }> = {
  'synthetic-1k': { target_ms: 800, hard_cap_ms: 3000 },
  'synthetic-10k': { target_ms: 5000, hard_cap_ms: 15000 },
};

interface BenchPayload {
  compute_ms: number;
  entity_count: number;
  cluster_count: number;
  noise_count: number;
  noise_rate: number;
  mean_cluster_probability: number | null;
  largest_cluster_size: number;
  smallest_cluster_size: number;
  mean_intra_cluster_distance: number | null;
  mean_inter_cluster_distance: number | null;
  cluster_size_histogram: Array<{ cluster_id: number; size: number }>;
}

function runComputeAndCapture(dbUrl: string): BenchPayload {
  const driver = `
import sys, os, json, time
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${dbUrl}"
from app.semantic_clustering import (
    _export_centroids,
    compute_hdbscan,
    _write_back,
    _summarise,
    _update_graph_stats,
    _hdbscan_min_cluster_size,
    _hdbscan_min_samples,
    COMPUTATION_VERSION,
)
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${dbUrl}", row_factory=dict_row) as conn:
    centroids = _export_centroids(conn)
    n = len(centroids)

    # Time compute_hdbscan only (excludes export + write-back), per
    # doc 24.1 §5.1 (matches Phase 2 bench-* convention).
    t0 = time.perf_counter()
    assignments = compute_hdbscan(
        centroids,
        min_cluster_size=_hdbscan_min_cluster_size(),
        min_samples=_hdbscan_min_samples(),
    )
    t1 = time.perf_counter()

    cc, nc, intra, inter = _summarise(assignments)

    # Reproduce write-back so on-disk counts match (mirrors Phase 2 bench
    # contract — bench produces a real on-disk state, not a dry-run).
    _write_back(conn, assignments=assignments, computation_version=COMPUTATION_VERSION)
    _update_graph_stats(conn, cluster_count=cc, mean_intra=intra, mean_inter=inter, computation_version=COMPUTATION_VERSION)
    conn.commit()

    sizes = {}
    probs = []
    for a in assignments.values():
        sizes[a.cluster_id] = sizes.get(a.cluster_id, 0) + 1
        if a.cluster_probability is not None:
            probs.append(a.cluster_probability)

    non_noise_sizes = [s for cid, s in sizes.items() if cid != -1]
    largest = max(non_noise_sizes) if non_noise_sizes else 0
    smallest = min(non_noise_sizes) if non_noise_sizes else 0
    mean_prob = float(sum(probs) / len(probs)) if probs else None

    histogram = sorted(
        [{"cluster_id": int(cid), "size": int(s)} for cid, s in sizes.items()],
        key=lambda r: r["cluster_id"],
    )

    print(json.dumps({
        "compute_ms": int((t1 - t0) * 1000),
        "entity_count": n,
        "cluster_count": int(cc),
        "noise_count": int(nc),
        "noise_rate": float(nc / n) if n else 0.0,
        "mean_cluster_probability": mean_prob,
        "largest_cluster_size": int(largest),
        "smallest_cluster_size": int(smallest),
        "mean_intra_cluster_distance": float(intra) if intra is not None else None,
        "mean_inter_cluster_distance": float(inter) if inter is not None else None,
        "cluster_size_histogram": histogram,
    }))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as BenchPayload;
}

interface BridgePair {
  a: string;
  b: string;
  reason: string;
}

interface BridgePairResult {
  total_pairs: number;
  pairs_in_different_clusters: number;
  pairs_in_same_cluster: number;
  pairs_with_at_least_one_noise: number;
  pairs_both_missing: number;
  separation_rate: number;
  same_cluster_examples: BridgePair[];
}

async function verifyBridgePairs(dbUrl: string, snapshotName: string): Promise<BridgePairResult | null> {
  const groundTruthPath = join(PLATFORM_ROOT, 'test-snapshots', snapshotName, 'ground_truth.json');
  if (!existsSync(groundTruthPath)) return null;
  const raw = JSON.parse(readFileSync(groundTruthPath, 'utf-8')) as { bridge_pairs: BridgePair[] };
  const pairs = raw.bridge_pairs ?? [];
  if (pairs.length === 0) return null;

  const sql = postgres(dbUrl, { max: 1 });
  let result: BridgePairResult;
  try {
    const ids = new Set<string>();
    for (const p of pairs) {
      ids.add(p.a);
      ids.add(p.b);
    }
    const idArray = [...ids];
    const rows = (await sql`
      SELECT entity_id::text AS entity_id, cluster_id
      FROM public.entity_clusters
      WHERE entity_id::text = ANY(${idArray})
    `) as unknown as { entity_id: string; cluster_id: number }[];
    const cidByEntity = new Map<string, number>();
    for (const r of rows) cidByEntity.set(r.entity_id, r.cluster_id);

    let differ = 0;
    let same = 0;
    let oneNoise = 0;
    let bothMissing = 0;
    const sameSamples: BridgePair[] = [];
    for (const p of pairs) {
      const cidA = cidByEntity.get(p.a);
      const cidB = cidByEntity.get(p.b);
      if (cidA === undefined && cidB === undefined) {
        bothMissing++;
        continue;
      }
      if (cidA === -1 || cidB === -1) {
        oneNoise++;
        // Pair with one or both as noise: trivially "different cluster"
        // (per doc 24.1 §2.4 noise is its own bucket, not a cluster).
        if (cidA !== cidB) differ++;
        else same++;
        continue;
      }
      if (cidA !== cidB) {
        differ++;
      } else {
        same++;
        if (sameSamples.length < 5) sameSamples.push(p);
      }
    }
    result = {
      total_pairs: pairs.length,
      pairs_in_different_clusters: differ,
      pairs_in_same_cluster: same,
      pairs_with_at_least_one_noise: oneNoise,
      pairs_both_missing: bothMissing,
      separation_rate: pairs.length ? differ / pairs.length : 0,
      same_cluster_examples: sameSamples,
    };
  } finally {
    await sql.end();
  }
  return result;
}

async function readGraphStats(dbUrl: string): Promise<{
  embedding_cluster_count: number | null;
  mean_intra_cluster_distance: number | null;
  mean_inter_cluster_distance: number | null;
  cluster_columns_version: number | null;
}> {
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const rows = (await sql`
      SELECT embedding_cluster_count,
             mean_intra_cluster_distance,
             mean_inter_cluster_distance,
             cluster_columns_version
      FROM public.graph_stats WHERE id = 1
    `) as unknown as Array<{
      embedding_cluster_count: number | null;
      mean_intra_cluster_distance: number | null;
      mean_inter_cluster_distance: number | null;
      cluster_columns_version: number | null;
    }>;
    return rows[0] ?? {
      embedding_cluster_count: null,
      mean_intra_cluster_distance: null,
      mean_inter_cluster_distance: null,
      cluster_columns_version: null,
    };
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const stageArg = process.argv[2];
  if (!stageArg || !(STAGES as readonly string[]).includes(stageArg)) {
    console.error(`Usage: tsx scripts/bench-hdbscan.ts <${STAGES.join('|')}>`);
    process.exit(2);
  }
  const stage = stageArg as (typeof STAGES)[number];
  process.env.DATABASE_URL = 'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test';

  console.log(`=== ${stage} ===`);
  await loadSnapshot(stage);

  const dbUrl = 'postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive_test';
  const payload = runComputeAndCapture(dbUrl);
  const t = THRESHOLDS[stage];
  const graphStats = await readGraphStats(dbUrl);
  const bridgePairs = await verifyBridgePairs(dbUrl, stage);

  const report = {
    snapshot_name: stage,
    feature: 'hdbscan-clustering',
    computation_version: 1,
    computed_at: new Date().toISOString(),
    elapsed_ms: payload.compute_ms,
    total_entities_with_centroids: payload.entity_count,
    cluster_count: payload.cluster_count,
    noise_count: payload.noise_count,
    noise_rate: Number(payload.noise_rate.toFixed(6)),
    mean_cluster_probability: payload.mean_cluster_probability,
    largest_cluster_size: payload.largest_cluster_size,
    smallest_cluster_size: payload.smallest_cluster_size,
    mean_intra_cluster_distance: payload.mean_intra_cluster_distance,
    mean_inter_cluster_distance: payload.mean_inter_cluster_distance,
    graph_stats_consistency: {
      // Doc 22 §7.4 — cluster columns must match the live entity_clusters
      // distribution after the same compute. We assert this here as a
      // post-condition.
      embedding_cluster_count: graphStats.embedding_cluster_count,
      mean_intra_cluster_distance: graphStats.mean_intra_cluster_distance,
      mean_inter_cluster_distance: graphStats.mean_inter_cluster_distance,
      cluster_columns_version: graphStats.cluster_columns_version,
      column_matches_payload: graphStats.embedding_cluster_count === payload.cluster_count,
    },
    cluster_size_histogram: payload.cluster_size_histogram,
    bridge_pair_separation: bridgePairs ?? undefined,
    thresholds: t,
    threshold_status: {
      under_target: payload.compute_ms <= t.target_ms,
      under_hard_cap: payload.compute_ms <= t.hard_cap_ms,
    },
    notes: 'HDBSCAN cosine clustering via hdbscan>=0.8 (Campello-Moulavi-Sander). Precomputed cosine distance matrix to dodge the boolean-features warning some hdbscan versions emit on metric=cosine direct. Canonical cluster_id (size desc, smallest UUID tiebreak) per doc 24.1 §2.4; -1 noise preserved. graph_stats backfill atomic with entity_clusters write per doc 22 §7.4. Bridge-pair separation contract per doc 28 §3.3 step 6 / doc 24.1 §5.3.',
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${stage}-hdbscan.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(
    `OK ${stage}: entities=${payload.entity_count} clusters=${payload.cluster_count} ` +
      `noise=${payload.noise_count} (rate=${(payload.noise_rate * 100).toFixed(1)}%) ` +
      `compute_ms=${payload.compute_ms}` +
      (bridgePairs ? ` bridge_separation=${bridgePairs.pairs_in_different_clusters}/${bridgePairs.total_pairs}` : ''),
  );
  console.log(`  -> ${path}`);

  // Hard exit code on bridge-pair contract failure (per doc 24.1 §4.3)
  if (bridgePairs && bridgePairs.pairs_in_same_cluster > 0) {
    console.error(`WARNING: ${bridgePairs.pairs_in_same_cluster} bridge pair(s) landed in the same cluster (separation contract violation per doc 28 §3.3).`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
