#!/usr/bin/env tsx
/**
 * Phase 2 articulation + bridge benchmark runner (doc 23.3 §5.2, nmemo-a7f.2.3.2).
 *
 * For each snapshot the script:
 *   1. Restores the snapshot into cognitive_test
 *   2. Spawns the venv python to run compute_articulation + compute_bridges
 *      against cognitive_test, capturing the per-feature compute-only elapsed
 *      times (excluding export + write-back, per §5.1 thresholds; the
 *      writeback runs alongside compute_components / compute_k_core to mirror
 *      production write-back shape and exercise the topology_bridges rewrite)
 *   3. Reads entity_topology and topology_bridges and aggregates
 *      articulation count + bridge count
 *   4. Writes the §5.2 schema JSON under
 *      platform/src/test/data/phase2-topology/benchmark-reports/articulation/<name>-articulation.json
 *
 * Usage:
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-topology-articulation.ts synthetic-1k
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-topology-articulation.ts synthetic-10k
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadSnapshot } from './load-snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = join(__dirname, '..');
const REPORTS_DIR = join(PLATFORM_ROOT, 'src', 'test', 'data', 'phase2-topology', 'benchmark-reports', 'articulation');
const VENV_PYTHON = join(PLATFORM_ROOT, '..', 'ml-services', '.venv', 'Scripts', 'python.exe');
const ML_SERVICES_DIR = join(PLATFORM_ROOT, '..', 'ml-services');

const STAGES = ['synthetic-1k', 'synthetic-10k'] as const;

// Doc 23.3 §5.1 — articulation + bridges run separately; thresholds cover the
// summed elapsed time. The 1k row interpolates between 100-entity (5/30ms)
// and 10k-entity (250/1000ms) anchors; 30ms target / 100ms hard cap is the
// closest published anchor and matches the same row in 23.1.
const THRESHOLDS: Record<(typeof STAGES)[number], { target_ms: number; hard_cap_ms: number }> = {
  'synthetic-1k': { target_ms: 30, hard_cap_ms: 100 },     // doc 23.3 §5.1, 1k row (interpolated)
  'synthetic-10k': { target_ms: 250, hard_cap_ms: 1000 },  // doc 23.3 §5.1, 10k row
};

interface BenchPayload {
  compute_ms_articulation: number;
  compute_ms_bridges: number;
  entity_count: number;
  edge_count: number;
  articulation_point_count: number;
  bridge_count: number;
}

function runComputeAndCapture(dbUrl: string): BenchPayload {
  const driver = `
import sys, os, json, time
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${dbUrl}"
from app.topology import (
    _export_graph,
    compute_components,
    compute_k_core,
    compute_articulation,
    compute_bridges,
    _write_back,
    COMPUTATION_VERSION,
)
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${dbUrl}", row_factory=dict_row) as conn:
    g, n, e = _export_graph(conn)
    comp = compute_components(g)
    kc = compute_k_core(g)
    t0 = time.perf_counter()
    art = compute_articulation(g)
    t1 = time.perf_counter()
    br = compute_bridges(g)
    t2 = time.perf_counter()
    _write_back(
        conn,
        components=comp,
        k_core=kc,
        articulation=art,
        communities={},
        centrality={},
        bridges=br,
        computation_version=COMPUTATION_VERSION,
    )
    conn.commit()
    print(json.dumps({
        "compute_ms_articulation": int((t1 - t0) * 1000),
        "compute_ms_bridges": int((t2 - t1) * 1000),
        "entity_count": n,
        "edge_count": e,
        "articulation_point_count": sum(1 for v in art.values() if v),
        "bridge_count": len(br),
    }))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as BenchPayload;
}

async function verifyTableCounts(dbUrl: string): Promise<{ ap_rows: number; bridge_rows: number }> {
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const apRows = (await sql`
      SELECT COUNT(*)::int AS n FROM public.entity_topology WHERE is_articulation_point = TRUE
    `) as unknown as { n: number }[];
    const bridgeRows = (await sql`
      SELECT COUNT(*)::int AS n FROM public.topology_bridges
    `) as unknown as { n: number }[];
    return { ap_rows: apRows[0]?.n ?? 0, bridge_rows: bridgeRows[0]?.n ?? 0 };
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const stageArg = process.argv[2];
  if (!stageArg || !(STAGES as readonly string[]).includes(stageArg)) {
    console.error(`Usage: tsx scripts/bench-topology-articulation.ts <${STAGES.join('|')}>`);
    process.exit(2);
  }
  const stage = stageArg as (typeof STAGES)[number];
  process.env.DATABASE_URL = 'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test';

  console.log(`=== ${stage} ===`);
  await loadSnapshot(stage);

  const dbUrl = 'postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive_test';
  const payload = runComputeAndCapture(dbUrl);
  const tableCounts = await verifyTableCounts(dbUrl);

  // Cross-check: the in-memory counts (returned from the python driver) must
  // match what made it onto disk via _write_back. A mismatch signals a writer
  // regression and is worth surfacing in the report.
  const ap_rate = payload.entity_count > 0
    ? Number((payload.articulation_point_count / payload.entity_count).toFixed(4))
    : 0;
  const elapsed_ms_total = payload.compute_ms_articulation + payload.compute_ms_bridges;

  const report = {
    snapshot_name: stage,
    feature: 'articulation_and_bridges',
    computation_version: 1,
    computed_at: new Date().toISOString(),
    elapsed_ms_articulation: payload.compute_ms_articulation,
    elapsed_ms_bridges: payload.compute_ms_bridges,
    elapsed_ms_total,
    total_entities: payload.entity_count,
    edge_count: payload.edge_count,
    articulation_point_count: payload.articulation_point_count,
    bridge_count: payload.bridge_count,
    articulation_rate: ap_rate,
    on_disk_articulation_point_rows: tableCounts.ap_rows,
    on_disk_topology_bridges_rows: tableCounts.bridge_rows,
    thresholds: THRESHOLDS[stage],
    notes: '23.3 articulation via igraph.Graph.articulation_points() + bridges via igraph.Graph.bridges(); shares export + write-back with 23.1/23.2. topology_bridges rewritten unconditionally per master 23 §2.3.2. frankenstein-10chunks and mixed-narrative-technical-1k snapshots deferred (j77.5).',
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${stage}-articulation.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(
    `OK ${stage}: entities=${payload.entity_count} edges=${payload.edge_count} ` +
      `aps=${payload.articulation_point_count} bridges=${payload.bridge_count} ` +
      `compute_ms=${payload.compute_ms_articulation}+${payload.compute_ms_bridges}=${elapsed_ms_total}`,
  );
  console.log(`  -> ${path}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
