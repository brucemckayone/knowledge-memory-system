#!/usr/bin/env tsx
/**
 * Phase 2 community detection benchmark runner (doc 23.4 §5.2, nmemo-a7f.2.4.2).
 *
 * For each snapshot the script:
 *   1. Restores the snapshot into cognitive_test
 *   2. Spawns the venv python to run compute_communities against
 *      cognitive_test, capturing the per-feature compute-only elapsed time
 *      (excluding export + write-back, per §5.1 thresholds; the writeback
 *      runs alongside compute_components / compute_k_core / compute_articulation
 *      / compute_bridges to mirror production write-back shape)
 *   3. Reads entity_topology and aggregates community_count, modularity,
 *      participation distribution
 *   4. Writes the §5.2 schema JSON under
 *      platform/src/test/data/phase2-topology/benchmark-reports/communities/<name>-communities.json
 *
 * Usage:
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-topology-communities.ts synthetic-1k
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-topology-communities.ts synthetic-10k
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadSnapshot } from './load-snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = join(__dirname, '..');
const REPORTS_DIR = join(PLATFORM_ROOT, 'src', 'test', 'data', 'phase2-topology', 'benchmark-reports', 'communities');
const VENV_PYTHON = join(PLATFORM_ROOT, '..', 'ml-services', '.venv', 'Scripts', 'python.exe');
const ML_SERVICES_DIR = join(PLATFORM_ROOT, '..', 'ml-services');

const STAGES = ['synthetic-1k', 'synthetic-10k'] as const;

// Doc 23.4 §5.1 thresholds (revised per cold-eyes review W7).
const THRESHOLDS: Record<(typeof STAGES)[number], { target_ms: number; hard_cap_ms: number }> = {
  'synthetic-1k': { target_ms: 800, hard_cap_ms: 3000 },
  'synthetic-10k': { target_ms: 8000, hard_cap_ms: 15000 },
};

interface BenchPayload {
  compute_ms: number;
  entity_count: number;
  edge_count: number;
  community_count: number;
  modularity_score: number;
  largest_community_size: number;
  smallest_community_size: number;
  mean_participation_coef: number;
}

function runComputeAndCapture(dbUrl: string): BenchPayload {
  // We compute Leiden once via the orchestrator pieces, then re-derive the
  // partition object inline to read partition.modularity (which is not
  // returned by compute_communities). This is one extra Leiden run on top of
  // the timed call — but the timed call is what §5.1 thresholds compare against.
  const driver = `
import sys, os, json, time, statistics
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${dbUrl}"
from app.topology import (
    _export_graph,
    compute_components,
    compute_k_core,
    compute_articulation,
    compute_bridges,
    compute_communities,
    _write_back,
    COMPUTATION_VERSION,
    _compute_seed,
    LEIDEN_N_ITERATIONS,
)
import igraph as ig
import leidenalg
import random
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${dbUrl}", row_factory=dict_row) as conn:
    g, n, e = _export_graph(conn)
    comp = compute_components(g)
    kc = compute_k_core(g)
    art = compute_articulation(g)
    br = compute_bridges(g)
    t0 = time.perf_counter()
    communities = compute_communities(g, computation_version=COMPUTATION_VERSION)
    t1 = time.perf_counter()
    _write_back(
        conn,
        components=comp,
        k_core=kc,
        articulation=art,
        communities=communities,
        centrality={},
        bridges=br,
        computation_version=COMPUTATION_VERSION,
    )
    conn.commit()

    # Re-run Leiden (deterministic) to get the modularity score from the
    # partition object — compute_communities returns just the membership map.
    if g.vcount() > 0:
        rng = random.Random(_compute_seed(COMPUTATION_VERSION))
        ig.set_random_number_generator(rng)
        partition = leidenalg.find_partition(
            g,
            leidenalg.ModularityVertexPartition,
            n_iterations=LEIDEN_N_ITERATIONS,
        )
        modularity_score = float(partition.modularity)
    else:
        modularity_score = 0.0

    cids = [cid for cid, _ in communities.values()] if communities else []
    sizes = {}
    for c in cids:
        sizes[c] = sizes.get(c, 0) + 1
    pcs = [pc for _, pc in communities.values() if pc is not None]
    print(json.dumps({
        "compute_ms": int((t1 - t0) * 1000),
        "entity_count": n,
        "edge_count": e,
        "community_count": len(set(cids)),
        "modularity_score": modularity_score,
        "largest_community_size": max(sizes.values()) if sizes else 0,
        "smallest_community_size": min(sizes.values()) if sizes else 0,
        "mean_participation_coef": float(statistics.fmean(pcs)) if pcs else 0.0,
    }))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as BenchPayload;
}

async function verifyTableCounts(dbUrl: string): Promise<{ rows_with_community: number; rows_with_participation: number }> {
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const c = (await sql`
      SELECT COUNT(*)::int AS n FROM public.entity_topology WHERE community_id IS NOT NULL
    `) as unknown as { n: number }[];
    const p = (await sql`
      SELECT COUNT(*)::int AS n FROM public.entity_topology WHERE participation_coef IS NOT NULL
    `) as unknown as { n: number }[];
    return { rows_with_community: c[0]?.n ?? 0, rows_with_participation: p[0]?.n ?? 0 };
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const stageArg = process.argv[2];
  if (!stageArg || !(STAGES as readonly string[]).includes(stageArg)) {
    console.error(`Usage: tsx scripts/bench-topology-communities.ts <${STAGES.join('|')}>`);
    process.exit(2);
  }
  const stage = stageArg as (typeof STAGES)[number];
  process.env.DATABASE_URL = 'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test';

  console.log(`=== ${stage} ===`);
  await loadSnapshot(stage);

  const dbUrl = 'postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive_test';
  const payload = runComputeAndCapture(dbUrl);
  const tableCounts = await verifyTableCounts(dbUrl);

  const report = {
    snapshot_name: stage,
    feature: 'communities',
    computation_version: 1,
    computed_at: new Date().toISOString(),
    elapsed_ms: payload.compute_ms,
    total_entities: payload.entity_count,
    edge_count: payload.edge_count,
    community_count: payload.community_count,
    modularity_score: Number(payload.modularity_score.toFixed(6)),
    largest_community_size: payload.largest_community_size,
    smallest_community_size: payload.smallest_community_size,
    mean_participation_coef: Number(payload.mean_participation_coef.toFixed(6)),
    on_disk_rows_with_community: tableCounts.rows_with_community,
    on_disk_rows_with_participation: tableCounts.rows_with_participation,
    thresholds: THRESHOLDS[stage],
    notes: '23.4 communities via leidenalg + python-igraph (ModularityVertexPartition, gamma=1.0, n_iterations=2). Determinism via igraph.set_random_number_generator() per doc 23.4 section 2.4 (W2). Shares export + write-back with 23.1/23.2/23.3. frankenstein-10chunks and mixed-narrative-technical-1k snapshots deferred (j77.5).',
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${stage}-communities.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(
    `OK ${stage}: entities=${payload.entity_count} edges=${payload.edge_count} ` +
      `communities=${payload.community_count} modularity=${payload.modularity_score.toFixed(4)} ` +
      `compute_ms=${payload.compute_ms}`,
  );
  console.log(`  -> ${path}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
