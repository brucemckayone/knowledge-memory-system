#!/usr/bin/env tsx
/**
 * Phase 3.2 ADWIN drift detection benchmark runner (doc 24.2 §5.2,
 * nmemo-a7f.3.2.2).
 *
 * For each (snapshot, mode) pair the script:
 *   1. Restores the snapshot into cognitive_test
 *   2. Runs HDBSCAN clustering (so entity_clusters.centroid_snapshot is
 *      populated — drift compares live centroid against this)
 *   3. Runs the drift sweep cycle:
 *        baseline mode:   1 compute_drift() over stable centroids → expect 0 events
 *        perturbed mode:  50 stable warm-up + 30 shifted iterations on N entities
 *                         → expect ≈N drift events
 *   4. Captures elapsed_ms (final sweep only, in line with bench-hdbscan), event
 *      counts, false-positive rate (events on unperturbed entities), and the
 *      reconciliation_invocations split (triggered_action='reconciliation_invoked')
 *   5. Writes platform/src/test/data/phase3-clustering/benchmark-reports/drift/
 *      <snapshot>[-perturbed]-drift.json
 *
 * Usage:
 *   tsx scripts/bench-drift.ts synthetic-1k
 *   tsx scripts/bench-drift.ts synthetic-1k perturbed
 *   tsx scripts/bench-drift.ts synthetic-10k
 *   tsx scripts/bench-drift.ts synthetic-10k perturbed
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from './load-snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = join(__dirname, '..');
const REPORTS_DIR = join(
  PLATFORM_ROOT,
  'src',
  'test',
  'data',
  'phase3-clustering',
  'benchmark-reports',
  'drift',
);
const VENV_PYTHON = join(PLATFORM_ROOT, '..', 'ml-services', '.venv', 'Scripts', 'python.exe');
const ML_SERVICES_DIR = join(PLATFORM_ROOT, '..', 'ml-services');

const STAGES = ['synthetic-1k', 'synthetic-10k'] as const;
type Stage = (typeof STAGES)[number];

const PERTURB_COUNT: Record<Stage, number> = {
  'synthetic-1k': 50,
  'synthetic-10k': 100,
};

// Doc 24.2 §5.1 thresholds.
const THRESHOLDS: Record<Stage, { target_ms: number; hard_cap_ms: number }> = {
  'synthetic-1k': { target_ms: 1000, hard_cap_ms: 5000 },
  'synthetic-10k': { target_ms: 1000, hard_cap_ms: 5000 },
};

interface BenchPayload {
  total_entities: number;
  entities_perturbed: number;
  drift_events_emitted: number;
  reconciliation_invocations: number;
  events_on_perturbed: number;
  events_on_unperturbed: number;
  false_positive_rate: number;
  warmup_iters: number;
  shift_iters: number;
  warmup_ms: number;
  shift_ms: number;
  final_sweep_ms: number;
  hdbscan_ms: number;
}

function runBench(dbUrl: string, stage: Stage, perturbed: boolean): BenchPayload {
  const perturbN = perturbed ? PERTURB_COUNT[stage] : 0;
  const warmup = perturbed ? 50 : 0;
  const shift = perturbed ? 30 : 0;

  const driver = `
import sys, os, json, time, random
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${dbUrl}"
os.environ["DRIFT_DELTA"] = "0.05"

from app.semantic_clustering import (
    _export_centroids, compute_hdbscan, _write_back, _summarise,
    _update_graph_stats, _hdbscan_min_cluster_size, _hdbscan_min_samples,
    COMPUTATION_VERSION as HDBSCAN_VERSION,
)
from app.drift import compute_drift
import psycopg
from psycopg.rows import dict_row

PERTURB_N = ${perturbN}
WARMUP = ${warmup}
SHIFT = ${shift}

with psycopg.connect(r"${dbUrl}", row_factory=dict_row) as conn:
    # 1) HDBSCAN clustering — populates entity_clusters.centroid_snapshot
    t0 = time.perf_counter()
    centroids = _export_centroids(conn)
    n = len(centroids)
    assignments = compute_hdbscan(
        centroids,
        min_cluster_size=_hdbscan_min_cluster_size(),
        min_samples=_hdbscan_min_samples(),
    )
    cc, nc, intra, inter = _summarise(assignments)
    _write_back(conn, assignments=assignments, computation_version=HDBSCAN_VERSION)
    _update_graph_stats(conn, cluster_count=cc, mean_intra=intra, mean_inter=inter, computation_version=HDBSCAN_VERSION)
    conn.commit()
    hdbscan_ms = int((time.perf_counter() - t0) * 1000)

    perturbed_ids = []
    rotated_centroid = None

    if PERTURB_N > 0:
        # 2a) ADWIN warm-up: WARMUP stable iterations on the unmodified centroids.
        t0 = time.perf_counter()
        for _ in range(WARMUP):
            compute_drift(conn)
            conn.commit()
        warmup_ms = int((time.perf_counter() - t0) * 1000)

        # 2b) Pick PERTURB_N entity IDs deterministically.
        with conn.cursor() as cur:
            cur.execute("SELECT entity_id::text AS eid FROM public.entity_meta ORDER BY entity_id LIMIT %s", (PERTURB_N,))
            perturbed_ids = [r["eid"] for r in cur]
            cur.execute("DELETE FROM public.entity_drift_events WHERE 1=1")
        conn.commit()

        # 2c) Pick a fixed rotation centroid (any non-noise cluster snapshot).
        # Rotating each perturbed entity's live centroid to this fixed vector
        # produces a clean orthogonal-ish shift away from its own cluster.
        with conn.cursor() as cur:
            cur.execute("""
                SELECT centroid_snapshot
                FROM public.entity_clusters
                WHERE cluster_id != -1
                ORDER BY entity_id
                LIMIT 1
            """)
            row = cur.fetchone()
            rotated_centroid = row["centroid_snapshot"] if row else None

        if rotated_centroid is None:
            raise RuntimeError("no non-noise cluster centroid available for rotation")

        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE public.entity_meta SET centroid = %s::vector
                WHERE entity_id = ANY(%s::uuid[])
                """,
                (rotated_centroid, perturbed_ids),
            )
        conn.commit()

        # 2d) Shift phase: SHIFT iterations of compute_drift over the new state.
        t0 = time.perf_counter()
        final_t0 = None
        for i in range(SHIFT):
            if i == SHIFT - 1:
                final_t0 = time.perf_counter()
            compute_drift(conn)
            conn.commit()
        shift_ms = int((time.perf_counter() - t0) * 1000)
        final_sweep_ms = int((time.perf_counter() - final_t0) * 1000) if final_t0 else 0
    else:
        # Baseline: single compute_drift on the stable snapshot — no events expected.
        warmup_ms = 0
        shift_ms = 0
        t0 = time.perf_counter()
        compute_drift(conn)
        conn.commit()
        final_sweep_ms = int((time.perf_counter() - t0) * 1000)

    # 3) Aggregate event counts.
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS c FROM public.entity_drift_events")
        total_events = int(cur.fetchone()["c"])

        cur.execute("SELECT COUNT(*) AS c FROM public.entity_drift_events WHERE triggered_action = 'reconciliation_invoked'")
        recon_count = int(cur.fetchone()["c"])

        if perturbed_ids:
            cur.execute(
                "SELECT COUNT(*) AS c FROM public.entity_drift_events WHERE entity_id = ANY(%s::uuid[])",
                (perturbed_ids,),
            )
            on_perturbed = int(cur.fetchone()["c"])
        else:
            on_perturbed = 0
        on_unperturbed = max(0, total_events - on_perturbed)

    print(json.dumps({
        "total_entities": int(n),
        "entities_perturbed": int(PERTURB_N),
        "drift_events_emitted": total_events,
        "reconciliation_invocations": recon_count,
        "events_on_perturbed": on_perturbed,
        "events_on_unperturbed": on_unperturbed,
        "false_positive_rate": float(on_unperturbed / n) if n else 0.0,
        "warmup_iters": int(WARMUP),
        "shift_iters": int(SHIFT),
        "warmup_ms": warmup_ms,
        "shift_ms": shift_ms,
        "final_sweep_ms": final_sweep_ms,
        "hdbscan_ms": hdbscan_ms,
    }))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as BenchPayload;
}

async function main(): Promise<void> {
  const stageArg = process.argv[2];
  const modeArg = (process.argv[3] ?? '').toLowerCase();
  if (!stageArg || !(STAGES as readonly string[]).includes(stageArg)) {
    console.error(`Usage: tsx scripts/bench-drift.ts <${STAGES.join('|')}> [perturbed]`);
    process.exit(2);
  }
  const stage = stageArg as Stage;
  const perturbed = modeArg === 'perturbed';
  const reportName = perturbed ? `${stage}-perturbed-drift` : `${stage}-drift`;

  process.env.DATABASE_URL = 'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test';
  console.log(`=== ${reportName} ===`);
  await loadSnapshot(stage);

  const dbUrl = 'postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive_test';
  const payload = runBench(dbUrl, stage, perturbed);
  const t = THRESHOLDS[stage];

  const report = {
    snapshot_name: stage,
    feature: 'adwin-drift-detection',
    mode: perturbed ? 'perturbed' : 'baseline',
    computation_version: 1,
    computed_at: new Date().toISOString(),
    elapsed_ms: payload.final_sweep_ms,
    total_entities: payload.total_entities,
    entities_perturbed: payload.entities_perturbed,
    drift_events_emitted: payload.drift_events_emitted,
    reconciliation_invocations: payload.reconciliation_invocations,
    events_on_perturbed: payload.events_on_perturbed,
    events_on_unperturbed: payload.events_on_unperturbed,
    false_positive_rate: Number(payload.false_positive_rate.toFixed(6)),
    warmup_iters: payload.warmup_iters,
    shift_iters: payload.shift_iters,
    warmup_ms: payload.warmup_ms,
    shift_ms: payload.shift_ms,
    hdbscan_ms: payload.hdbscan_ms,
    thresholds: t,
    threshold_status: {
      under_target: payload.final_sweep_ms <= t.target_ms,
      under_hard_cap: payload.final_sweep_ms <= t.hard_cap_ms,
    },
    notes:
      'ADWIN(delta=0.05) drift sweep over per-entity cosine drift magnitude ' +
      'against entity_clusters.centroid_snapshot. Bulk-load pattern (W4): all ' +
      'state pickle/unpickle bracketed around the per-entity loop; no ' +
      'per-entity round-trip during compute. Perturbation = rotate live ' +
      'centroid of N entities to a non-self cluster centroid. Warm-up of 50 ' +
      'stable iterations precedes the shift to seed ADWIN windows; the shift ' +
      'phase runs 30 more iterations and ADWIN fires on the perturbed cohort. ' +
      'elapsed_ms is the FINAL compute_drift() sweep only (matches ' +
      'bench-hdbscan convention). false_positive_rate = ' +
      'events_on_unperturbed / total_entities. Per master 21 §10 / doc 24.2 §5.',
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${reportName}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(
    `OK ${reportName}: entities=${payload.total_entities} perturbed=${payload.entities_perturbed} ` +
      `events=${payload.drift_events_emitted} (on_perturbed=${payload.events_on_perturbed}, ` +
      `on_unperturbed=${payload.events_on_unperturbed}) reconciliation_invocations=${payload.reconciliation_invocations} ` +
      `final_sweep_ms=${payload.final_sweep_ms} (warmup=${payload.warmup_ms} shift=${payload.shift_ms} hdbscan=${payload.hdbscan_ms})`,
  );
  console.log(`  -> ${path}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
