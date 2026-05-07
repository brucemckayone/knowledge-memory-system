#!/usr/bin/env tsx
/**
 * Phase 2 centrality benchmark runner (doc 23.5 §5.2, nmemo-a7f.2.5.2).
 *
 * For each snapshot the script:
 *   1. Restores the snapshot into cognitive_test
 *   2. Spawns the venv python to run compute_pagerank + compute_betweenness
 *      against cognitive_test, capturing per-feature compute-only elapsed
 *      times (excluding export + write-back, per §5.1 thresholds; the
 *      write-back runs alongside the other four Phase 2 features to mirror
 *      production write-back shape and exercise the unified upsert)
 *   3. Reads entity_topology and aggregates pagerank top-k, betweenness top-k,
 *      percentiles, and sum-invariant sanity check
 *   4. Writes the §5.2 schema JSON under
 *      platform/src/test/data/phase2-topology/benchmark-reports/centrality/<name>-centrality.json
 *
 * Usage:
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-topology-centrality.ts synthetic-1k
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-topology-centrality.ts synthetic-10k
 *
 * Centrality is the heaviest Phase 2 feature (sampled betweenness via NetworkX
 * dominates compute time at 10k vertices, per doc 23.5 §5.1).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadSnapshot } from './load-snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = join(__dirname, '..');
const REPORTS_DIR = join(PLATFORM_ROOT, 'src', 'test', 'data', 'phase2-topology', 'benchmark-reports', 'centrality');
const VENV_PYTHON = join(PLATFORM_ROOT, '..', 'ml-services', '.venv', 'Scripts', 'python.exe');
const ML_SERVICES_DIR = join(PLATFORM_ROOT, '..', 'ml-services');

const STAGES = ['synthetic-1k', 'synthetic-10k'] as const;

// Doc 23.5 §5.1 thresholds (revised per cold-eyes review W8 — the NetworkX
// sampled-betweenness branch dominates at 10k+ vertices). The combined hard
// cap covers PageRank + sampled betweenness end-to-end.
const THRESHOLDS: Record<(typeof STAGES)[number], {
  pagerank_target_ms: number;
  betweenness_target_ms: number;
  combined_hard_cap_ms: number;
}> = {
  'synthetic-1k': { pagerank_target_ms: 50, betweenness_target_ms: 1500, combined_hard_cap_ms: 3000 },
  'synthetic-10k': { pagerank_target_ms: 200, betweenness_target_ms: 8000, combined_hard_cap_ms: 15000 },
};

interface TopK {
  entity_id: string;
  value: number;
}

interface BenchPayload {
  compute_ms_pagerank: number;
  compute_ms_betweenness: number;
  entity_count: number;
  edge_count: number;
  pagerank_sum: number;
  pagerank_max: number;
  pagerank_p50: number;
  pagerank_p95: number;
  betweenness_max: number;
  betweenness_p50: number;
  betweenness_p95: number;
  top10_pagerank: TopK[];
  top10_betweenness: TopK[];
  sample_size_used: number;
  used_exact_betweenness: boolean;
}

function runComputeAndCapture(dbUrl: string): BenchPayload {
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
    compute_pagerank,
    compute_betweenness,
    _write_back,
    COMPUTATION_VERSION,
    BETWEENNESS_SAMPLE_SIZE_DEFAULT,
    BETWEENNESS_EXACT_THRESHOLD,
)
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${dbUrl}", row_factory=dict_row) as conn:
    g, n, e = _export_graph(conn)
    comp = compute_components(g)
    kc = compute_k_core(g)
    art = compute_articulation(g)
    br = compute_bridges(g)
    comm = compute_communities(g, computation_version=COMPUTATION_VERSION)

    # Time PageRank
    t0 = time.perf_counter()
    pr = compute_pagerank(g)
    t1 = time.perf_counter()
    # Time sampled betweenness
    bw = compute_betweenness(g)
    t2 = time.perf_counter()

    # Reassemble centrality dict for write-back
    centrality = {eid: (pr.get(eid, 0.0), bw.get(eid, 0.0)) for eid in pr.keys()}
    _write_back(
        conn,
        components=comp,
        k_core=kc,
        articulation=art,
        communities=comm,
        centrality=centrality,
        bridges=br,
        computation_version=COMPUTATION_VERSION,
    )
    conn.commit()

    pr_pairs = sorted(pr.items(), key=lambda kv: kv[1], reverse=True)
    bw_pairs = sorted(bw.items(), key=lambda kv: kv[1], reverse=True)

    pr_vals = [v for _, v in pr_pairs]
    bw_vals = [v for _, v in bw_pairs]

    def pct(values, p):
        if not values: return 0.0
        s = sorted(values)
        idx = max(0, min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1)))))
        return float(s[idx])

    sample_size = int(os.environ.get("BETWEENNESS_SAMPLE_SIZE", BETWEENNESS_SAMPLE_SIZE_DEFAULT))
    used_exact = (n <= BETWEENNESS_EXACT_THRESHOLD) or (sample_size >= n)

    print(json.dumps({
        "compute_ms_pagerank": int((t1 - t0) * 1000),
        "compute_ms_betweenness": int((t2 - t1) * 1000),
        "entity_count": n,
        "edge_count": e,
        "pagerank_sum": float(sum(pr_vals)),
        "pagerank_max": float(max(pr_vals) if pr_vals else 0.0),
        "pagerank_p50": pct(pr_vals, 50),
        "pagerank_p95": pct(pr_vals, 95),
        "betweenness_max": float(max(bw_vals) if bw_vals else 0.0),
        "betweenness_p50": pct(bw_vals, 50),
        "betweenness_p95": pct(bw_vals, 95),
        "top10_pagerank": [{"entity_id": eid, "value": float(v)} for eid, v in pr_pairs[:10]],
        "top10_betweenness": [{"entity_id": eid, "value": float(v)} for eid, v in bw_pairs[:10]],
        "sample_size_used": sample_size,
        "used_exact_betweenness": bool(used_exact),
    }))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as BenchPayload;
}

async function verifyTableCounts(dbUrl: string): Promise<{ rows_with_pagerank: number; rows_with_betweenness: number }> {
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const pr = (await sql`
      SELECT COUNT(*)::int AS n FROM public.entity_topology WHERE pagerank IS NOT NULL
    `) as unknown as { n: number }[];
    const bw = (await sql`
      SELECT COUNT(*)::int AS n FROM public.entity_topology WHERE betweenness_sampled IS NOT NULL
    `) as unknown as { n: number }[];
    return { rows_with_pagerank: pr[0]?.n ?? 0, rows_with_betweenness: bw[0]?.n ?? 0 };
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const stageArg = process.argv[2];
  if (!stageArg || !(STAGES as readonly string[]).includes(stageArg)) {
    console.error(`Usage: tsx scripts/bench-topology-centrality.ts <${STAGES.join('|')}>`);
    process.exit(2);
  }
  const stage = stageArg as (typeof STAGES)[number];
  process.env.DATABASE_URL = 'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test';

  console.log(`=== ${stage} ===`);
  await loadSnapshot(stage);

  const dbUrl = 'postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive_test';
  const payload = runComputeAndCapture(dbUrl);
  const tableCounts = await verifyTableCounts(dbUrl);
  const combinedMs = payload.compute_ms_pagerank + payload.compute_ms_betweenness;
  const t = THRESHOLDS[stage];

  const report = {
    snapshot_name: stage,
    feature: 'centrality',
    computation_version: 1,
    computed_at: new Date().toISOString(),
    elapsed_ms_pagerank: payload.compute_ms_pagerank,
    elapsed_ms_betweenness: payload.compute_ms_betweenness,
    elapsed_ms_combined: combinedMs,
    total_entities: payload.entity_count,
    edge_count: payload.edge_count,
    pagerank_sum: Number(payload.pagerank_sum.toFixed(9)),
    pagerank_max: Number(payload.pagerank_max.toFixed(9)),
    pagerank_p50: Number(payload.pagerank_p50.toFixed(9)),
    pagerank_p95: Number(payload.pagerank_p95.toFixed(9)),
    betweenness_max: Number(payload.betweenness_max.toFixed(9)),
    betweenness_p50: Number(payload.betweenness_p50.toFixed(9)),
    betweenness_p95: Number(payload.betweenness_p95.toFixed(9)),
    top10_pagerank: payload.top10_pagerank.map((r) => ({ entity_id: r.entity_id, value: Number(r.value.toFixed(9)) })),
    top10_betweenness: payload.top10_betweenness.map((r) => ({ entity_id: r.entity_id, value: Number(r.value.toFixed(9)) })),
    sample_size_used: payload.sample_size_used,
    used_exact_betweenness: payload.used_exact_betweenness,
    on_disk_rows_with_pagerank: tableCounts.rows_with_pagerank,
    on_disk_rows_with_betweenness: tableCounts.rows_with_betweenness,
    thresholds: t,
    threshold_status: {
      pagerank_under_target: payload.compute_ms_pagerank <= t.pagerank_target_ms,
      betweenness_under_target: payload.compute_ms_betweenness <= t.betweenness_target_ms,
      combined_under_hard_cap: combinedMs <= t.combined_hard_cap_ms,
    },
    notes: '23.5 PageRank via igraph.pagerank(damping=0.85) — PRPACK implementation, deterministic by construction. Sampled betweenness via NetworkX betweenness_centrality(k=BETWEENNESS_SAMPLE_SIZE_DEFAULT, normalized=True, seed=42) — Riondato-Kornaropoulos source-vertex sampling per doc 23.5 §3.1 cold-eyes review B3 (igraph has no sample_size kwarg). Exact-igraph fallback for n<=200 OR sample_size>=n. Shares export + write-back with 23.1/23.2/23.3/23.4. frankenstein-10chunks and mixed-narrative-technical-1k snapshots deferred (j77.5). Hardware note: on this dev machine, sampled betweenness on synthetic-10k runs ~18-27s, overshooting the §5.1 component-level 8s target / 15s hard cap (the doc itself flags "5–10s in CPython" as the basis for those thresholds — a faster machine reproduces them). Master 23 §5.1 end-to-end envelope (12s target / 30s cap) still accommodates this. Threshold tracking surfaced in threshold_status; tighten when faster CI hardware lands or sample_size is reduced to k=500 (top-100 ranking stability remains acceptable per doc 23.5 §5.3).',
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${stage}-centrality.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(
    `OK ${stage}: entities=${payload.entity_count} edges=${payload.edge_count} ` +
      `pr_sum=${payload.pagerank_sum.toFixed(6)} pr_max=${payload.pagerank_max.toFixed(4)} ` +
      `bw_max=${payload.betweenness_max.toFixed(4)} ` +
      `pr_ms=${payload.compute_ms_pagerank} bw_ms=${payload.compute_ms_betweenness} ` +
      `(${payload.used_exact_betweenness ? 'exact' : `sampled k=${payload.sample_size_used}`})`,
  );
  console.log(`  -> ${path}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
