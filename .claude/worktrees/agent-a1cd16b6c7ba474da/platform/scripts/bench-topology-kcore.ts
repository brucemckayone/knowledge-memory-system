#!/usr/bin/env tsx
/**
 * Phase 2 k-core benchmark runner (doc 23.2 §5.2, nmemo-a7f.2.2.2).
 *
 * For each snapshot the script:
 *   1. Restores the snapshot into cognitive_test
 *   2. Spawns the venv python to run compute_k_core against cognitive_test,
 *      capturing the compute-only elapsed time (excluding export + write-back,
 *      per §5.1 thresholds; the writeback runs alongside compute_components
 *      to mirror production write-back shape)
 *   3. Reads entity_topology and aggregates the k_core distribution
 *   4. Writes the §5.2 schema JSON under
 *      platform/src/test/data/phase2-topology/benchmark-reports/kcore/<name>-kcore.json
 *
 * Usage:
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-topology-kcore.ts synthetic-1k
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-topology-kcore.ts synthetic-10k
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadSnapshot } from './load-snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = join(__dirname, '..');
const REPORTS_DIR = join(PLATFORM_ROOT, 'src', 'test', 'data', 'phase2-topology', 'benchmark-reports', 'kcore');
const VENV_PYTHON = join(PLATFORM_ROOT, '..', 'ml-services', '.venv', 'Scripts', 'python.exe');
const ML_SERVICES_DIR = join(PLATFORM_ROOT, '..', 'ml-services');

const STAGES = ['synthetic-1k', 'synthetic-10k'] as const;

const THRESHOLDS: Record<(typeof STAGES)[number], { target_ms: number; hard_cap_ms: number }> = {
  'synthetic-1k': { target_ms: 30, hard_cap_ms: 100 },     // doc 23.2 §5.1, 1k row
  'synthetic-10k': { target_ms: 200, hard_cap_ms: 800 },   // doc 23.2 §5.1, 10k row
};

function runComputeAndCapture(dbUrl: string): { compute_ms: number; entity_count: number; edge_count: number } {
  const driver = `
import sys, os, json, time
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${dbUrl}"
from app.topology import _export_graph, compute_components, compute_k_core, _write_back, COMPUTATION_VERSION
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${dbUrl}", row_factory=dict_row) as conn:
    g, n, e = _export_graph(conn)
    comp = compute_components(g)
    t0 = time.perf_counter()
    kc = compute_k_core(g)
    t1 = time.perf_counter()
    _write_back(conn, components=comp, k_core=kc, articulation={}, communities={}, centrality={}, computation_version=COMPUTATION_VERSION)
    conn.commit()
    print(json.dumps({"compute_ms": int((t1 - t0) * 1000), "entity_count": n, "edge_count": e}))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as { compute_ms: number; entity_count: number; edge_count: number };
}

interface KCoreSummary {
  k_core_distribution: Record<string, number>;
  max_k_core: number;
  mean_k_core: number;
}

async function summariseKCore(dbUrl: string): Promise<KCoreSummary> {
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const rows = (await sql`
      SELECT k_core, COUNT(*)::int AS members
      FROM public.entity_topology
      WHERE k_core IS NOT NULL
      GROUP BY k_core
      ORDER BY k_core ASC
    `) as unknown as { k_core: number; members: number }[];
    if (rows.length === 0) {
      return { k_core_distribution: {}, max_k_core: 0, mean_k_core: 0 };
    }
    const distribution: Record<string, number> = {};
    let total = 0;
    let weightedSum = 0;
    let maxK = 0;
    for (const row of rows) {
      distribution[String(row.k_core)] = row.members;
      total += row.members;
      weightedSum += row.k_core * row.members;
      if (row.k_core > maxK) maxK = row.k_core;
    }
    return {
      k_core_distribution: distribution,
      max_k_core: maxK,
      mean_k_core: Number((weightedSum / total).toFixed(3)),
    };
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const stageArg = process.argv[2];
  if (!stageArg || !(STAGES as readonly string[]).includes(stageArg)) {
    console.error(`Usage: tsx scripts/bench-topology-kcore.ts <${STAGES.join('|')}>`);
    process.exit(2);
  }
  const stage = stageArg as (typeof STAGES)[number];
  process.env.DATABASE_URL = 'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test';

  console.log(`=== ${stage} ===`);
  await loadSnapshot(stage);

  const dbUrl = 'postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive_test';
  const { compute_ms, entity_count, edge_count } = runComputeAndCapture(dbUrl);
  const summary = await summariseKCore(dbUrl);

  const report = {
    snapshot_name: stage,
    feature: 'k_core',
    computation_version: 1,
    computed_at: new Date().toISOString(),
    elapsed_ms_compute_only: compute_ms,
    total_entities: entity_count,
    edge_count,
    max_k_core: summary.max_k_core,
    mean_k_core: summary.mean_k_core,
    k_core_distribution: summary.k_core_distribution,
    thresholds: THRESHOLDS[stage],
    notes: '23.2 k-core via igraph.Graph.coreness(mode="all"); shares export + write-back with 23.1 components. frankenstein-10chunks and mixed-narrative-technical-1k snapshots deferred (j77.5).',
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${stage}-kcore.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`OK ${stage}: entities=${entity_count} edges=${edge_count} max_k_core=${summary.max_k_core} mean_k_core=${summary.mean_k_core} compute_ms=${compute_ms}`);
  console.log(`  -> ${path}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
