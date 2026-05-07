#!/usr/bin/env tsx
/**
 * Phase 2 connected-components benchmark runner (doc 23.1 §5.2, nmemo-a7f.2.1.2).
 *
 * For each snapshot the script:
 *   1. Restores the snapshot into cognitive_test
 *   2. Spawns the venv python to run compute_components against cognitive_test,
 *      capturing the compute-only elapsed time (excluding export + write-back,
 *      per §5.1 thresholds — those are amortised across all 5 features in 23 §5.1)
 *   3. Reads entity_topology and aggregates component-count / size stats
 *   4. Writes the §5.2 schema JSON under
 *      platform/src/test/data/phase2-topology/benchmark-reports/components/<name>.json
 *
 * Usage:
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-topology-components.ts synthetic-1k
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-topology-components.ts synthetic-10k
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadSnapshot } from './load-snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = join(__dirname, '..');
const REPORTS_DIR = join(PLATFORM_ROOT, 'src', 'test', 'data', 'phase2-topology', 'benchmark-reports', 'components');
const VENV_PYTHON = join(PLATFORM_ROOT, '..', 'ml-services', '.venv', 'Scripts', 'python.exe');
const ML_SERVICES_DIR = join(PLATFORM_ROOT, '..', 'ml-services');

const STAGES = ['synthetic-1k', 'synthetic-10k'] as const;

const THRESHOLDS: Record<(typeof STAGES)[number], { target_ms: number; hard_cap_ms: number }> = {
  'synthetic-1k': { target_ms: 50, hard_cap_ms: 200 },     // doc 23.1 §5.1, 1k row
  'synthetic-10k': { target_ms: 300, hard_cap_ms: 1000 },  // doc 23.1 §5.1, 10k row
};

function runComputeAndCapture(dbUrl: string): { compute_ms: number; entity_count: number; edge_count: number } {
  const driver = `
import sys, os, json, time
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${dbUrl}"
from app.topology import _export_graph, compute_components, _write_back, COMPUTATION_VERSION
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${dbUrl}", row_factory=dict_row) as conn:
    g, n, e = _export_graph(conn)
    t0 = time.perf_counter()
    comp = compute_components(g)
    t1 = time.perf_counter()
    _write_back(conn, components=comp, k_core={}, articulation={}, communities={}, centrality={}, computation_version=COMPUTATION_VERSION)
    conn.commit()
    print(json.dumps({"compute_ms": int((t1 - t0) * 1000), "entity_count": n, "edge_count": e}))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as { compute_ms: number; entity_count: number; edge_count: number };
}

interface ComponentSummary {
  total_components: number;
  largest_component_size: number;
  smallest_component_size: number;
  mean_component_size: number;
}

async function summariseComponents(dbUrl: string): Promise<ComponentSummary> {
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const rows = (await sql`
      SELECT component_id, component_size, COUNT(*)::int AS members
      FROM public.entity_topology
      WHERE component_id IS NOT NULL
      GROUP BY component_id, component_size
      ORDER BY component_size DESC, component_id ASC
    `) as unknown as { component_id: number; component_size: number; members: number }[];
    if (rows.length === 0) {
      return { total_components: 0, largest_component_size: 0, smallest_component_size: 0, mean_component_size: 0 };
    }
    const sizes = rows.map((r) => r.component_size);
    const total = rows.length;
    const largest = Math.max(...sizes);
    const smallest = Math.min(...sizes);
    const meanSize = sizes.reduce((acc, s) => acc + s, 0) / total;
    return {
      total_components: total,
      largest_component_size: largest,
      smallest_component_size: smallest,
      mean_component_size: Number(meanSize.toFixed(3)),
    };
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const stageArg = process.argv[2];
  if (!stageArg || !(STAGES as readonly string[]).includes(stageArg)) {
    console.error(`Usage: tsx scripts/bench-topology-components.ts <${STAGES.join('|')}>`);
    process.exit(2);
  }
  const stage = stageArg as (typeof STAGES)[number];
  process.env.DATABASE_URL = 'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test';

  console.log(`=== ${stage} ===`);
  await loadSnapshot(stage);

  const dbUrl = 'postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive_test';
  const { compute_ms, entity_count, edge_count } = runComputeAndCapture(dbUrl);
  const summary = await summariseComponents(dbUrl);

  const report = {
    snapshot_name: stage,
    feature: 'connected_components',
    computation_version: 1,
    computed_at: new Date().toISOString(),
    elapsed_ms_compute_only: compute_ms,
    total_entities: entity_count,
    edge_count,
    component_count: summary.total_components,
    largest_component_size: summary.largest_component_size,
    smallest_component_size: summary.smallest_component_size,
    mean_component_size: summary.mean_component_size,
    thresholds: THRESHOLDS[stage],
    notes: '23.1 connected components only; sibling features (k-core / articulation / community / centrality) are NULL until their beads land.',
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${stage}-components.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`✓ ${stage}: entities=${entity_count} edges=${edge_count} components=${summary.total_components} largest=${summary.largest_component_size} compute_ms=${compute_ms}`);
  console.log(`  → ${path}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
