/**
 * Phase 3 — Drift detection (doc 24.2, nmemo-a7f.3.2)
 *
 * Implements the §4.2 cases. Each test seeds entity_meta + entity_clusters
 * directly, invokes the Python drift compute routine against
 * `cognitive_test`, and asserts on entity_drift_state + entity_drift_events
 * rows.
 *
 * Mirrors clustering-hdbscan.test.ts: spawn the venv python with an inline
 * driver. The subprocess path drives the real app.drift functions with full
 * per-test control of DATABASE_URL / DRIFT_DELTA / DRIFT_ACTION_THRESHOLD.
 *
 * Master §10 cluster-bridging locks exercised:
 * - target_cluster_id (line 429): test 5 (above-threshold + multi-cluster).
 * - last_cluster_id reset (line 430): test 8 (cluster reassignment).
 * - river_version reset (line 431): test 7 (version mismatch reset).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  testDb,
  createTestEntity,
  deleteFromTables,
  skipCtx,
} from '../setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENV_PYTHON = join(__dirname, '..', '..', '..', '..', 'ml-services', '.venv', 'Scripts', 'python.exe');
const ML_SERVICES_DIR = join(__dirname, '..', '..', '..', '..', 'ml-services');
const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive_test';

const CENTROID_DIM = 768;

interface ComputeResult {
  entities_processed: number;
  drift_events_count: number;
  state_resets_cluster: number;
  state_resets_river: number;
  state_resets_corrupt: number;
  skipped_no_snapshot: number;
  skipped_zero_norm: number;
}

/**
 * Run the drift compute pipeline against the test DB.
 * Spawns the venv python with an inline driver, captures the JSON summary line.
 */
function runDriftCompute(extraEnv: Record<string, string> = {}): ComputeResult {
  const envSets = Object.entries(extraEnv)
    .map(([k, v]) => `os.environ[${JSON.stringify(k)}] = ${JSON.stringify(v)}`)
    .join('\n');
  const driver = `
import sys, os, json
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${TEST_DB_URL}"
${envSets}
from app.drift import compute_drift
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${TEST_DB_URL}", row_factory=dict_row) as conn:
    result = compute_drift(conn)
    conn.commit()
    print(json.dumps(result))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as ComputeResult;
}

/**
 * Batched drift loop. Runs many compute_drift() iterations in a single python
 * subprocess to amortise venv startup (~1-3s) across a long iteration count.
 * Each iteration:
 *   - UPDATEs entity_meta.centroid for `entityId` to either `stableVec` (when
 *     iter < transitionAt) or `shiftVec` (otherwise)
 *   - calls compute_drift()
 *   - commits
 *   - records whether a drift event has been emitted for `entityId` yet
 *
 * Returns the per-iteration "detected" bit + the final aggregate ComputeResult.
 * ADWIN state still bulk-loads from / persists to entity_drift_state every
 * iteration — same code path as the production sweep, just without subprocess
 * overhead. Equivalent to runDriftCompute() called in a loop, but ~50x faster.
 */
interface DriftBatchResult {
  finalCompute: ComputeResult;
  detectedAtIter: number | null;
  totalIters: number;
}
function runDriftBatch(args: {
  entityId: string;
  stableVec: number[];
  shiftVec: number[];
  transitionAt: number;
  totalIters: number;
  env?: Record<string, string>;
}): DriftBatchResult {
  const env = args.env ?? {};
  const envSets = Object.entries(env)
    .map(([k, v]) => `os.environ[${JSON.stringify(k)}] = ${JSON.stringify(v)}`)
    .join('\n');
  const stableLit = `[${args.stableVec.join(',')}]`;
  const shiftLit = `[${args.shiftVec.join(',')}]`;
  const driver = `
import sys, os, json
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${TEST_DB_URL}"
${envSets}
from app.drift import compute_drift
import psycopg
from psycopg.rows import dict_row
ENTITY_ID = ${JSON.stringify(args.entityId)}
TRANSITION_AT = ${args.transitionAt}
TOTAL_ITERS = ${args.totalIters}
STABLE_LIT = ${JSON.stringify(stableLit)}
SHIFT_LIT = ${JSON.stringify(shiftLit)}

detected_at = None
final_result = None
with psycopg.connect(r"${TEST_DB_URL}", row_factory=dict_row) as conn:
    for i in range(TOTAL_ITERS):
        lit = STABLE_LIT if i < TRANSITION_AT else SHIFT_LIT
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE public.entity_meta SET centroid = %s::vector WHERE entity_id = %s::uuid",
                (lit, ENTITY_ID),
            )
        result = compute_drift(conn)
        conn.commit()
        final_result = result
        if detected_at is None:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS c FROM public.entity_drift_events WHERE entity_id = %s::uuid",
                    (ENTITY_ID,),
                )
                if cur.fetchone()["c"] > 0:
                    detected_at = i
print(json.dumps({"final": final_result, "detected_at_iter": detected_at, "total_iters": TOTAL_ITERS}))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  const parsed = JSON.parse(lastLine) as {
    final: ComputeResult;
    detected_at_iter: number | null;
    total_iters: number;
  };
  return {
    finalCompute: parsed.final,
    detectedAtIter: parsed.detected_at_iter,
    totalIters: parsed.total_iters,
  };
}

interface DriftStateRow {
  entity_id: string;
  observation_count: number;
  last_cluster_id: number | null;
  river_version: string;
  has_blob: boolean;
}

async function getDriftState(entityId: string): Promise<DriftStateRow | null> {
  const rows = (await testDb`
    SELECT entity_id::text AS entity_id,
           observation_count,
           last_cluster_id,
           river_version,
           (octet_length(adwin_state_blob) > 0) AS has_blob
    FROM public.entity_drift_state
    WHERE entity_id = ${entityId}::uuid
  `) as unknown as DriftStateRow[];
  return rows[0] ?? null;
}

interface DriftEventRow {
  event_id: string;
  entity_id: string;
  drift_magnitude: number;
  cluster_id_at_detection: number | null;
  target_cluster_id: number | null;
  triggered_action: string;
}

async function getDriftEvents(entityId: string): Promise<DriftEventRow[]> {
  return (await testDb`
    SELECT id::text AS event_id,
           entity_id::text AS entity_id,
           drift_magnitude,
           cluster_id_at_detection,
           target_cluster_id,
           triggered_action
    FROM public.entity_drift_events
    WHERE entity_id = ${entityId}::uuid
    ORDER BY detected_at ASC
  `) as unknown as DriftEventRow[];
}

async function getAllDriftEvents(): Promise<DriftEventRow[]> {
  return (await testDb`
    SELECT id::text AS event_id,
           entity_id::text AS entity_id,
           drift_magnitude,
           cluster_id_at_detection,
           target_cluster_id,
           triggered_action
    FROM public.entity_drift_events
    ORDER BY detected_at ASC
  `) as unknown as DriftEventRow[];
}

/**
 * Insert/upsert an entity_meta row with a synthetic centroid.
 * Mirrors clustering-hdbscan.test.ts.
 */
async function setLiveCentroid(entityId: string, vec: number[]): Promise<void> {
  if (vec.length !== CENTROID_DIM) {
    throw new Error(`centroid must be ${CENTROID_DIM}-dim; got ${vec.length}`);
  }
  const literal = `[${vec.join(',')}]`;
  await testDb`
    INSERT INTO public.entity_meta (entity_id, centroid)
    VALUES (${entityId}::uuid, ${literal}::vector)
    ON CONFLICT (entity_id) DO UPDATE SET centroid = EXCLUDED.centroid
  `;
}

/**
 * Insert a synthetic entity_clusters row with snapshot + cluster_id.
 * Drift compares live entity_meta.centroid to centroid_snapshot here.
 */
async function setClusterSnapshot(
  entityId: string,
  vec: number[],
  clusterId: number,
): Promise<void> {
  if (vec.length !== CENTROID_DIM) {
    throw new Error(`snapshot must be ${CENTROID_DIM}-dim; got ${vec.length}`);
  }
  const literal = `[${vec.join(',')}]`;
  await testDb`
    INSERT INTO public.entity_clusters (
      entity_id, cluster_id, centroid_snapshot, cluster_probability,
      cluster_size, computed_at, computation_version
    ) VALUES (
      ${entityId}::uuid, ${clusterId}, ${literal}::vector, NULL,
      1, NOW(), 1
    )
    ON CONFLICT (entity_id) DO UPDATE SET
      cluster_id        = EXCLUDED.cluster_id,
      centroid_snapshot = EXCLUDED.centroid_snapshot,
      computed_at       = NOW()
  `;
}

/**
 * Deterministic unit vector at a one-hot position. Used to create
 * cosine-distant pairs for drift fixtures (one-hot at idx i is orthogonal
 * to one-hot at idx j for i != j).
 */
function unitAt(idx: number): number[] {
  const v = new Array(CENTROID_DIM).fill(0);
  v[idx % CENTROID_DIM] = 1.0;
  return v;
}

/**
 * Build a vector that is mostly the snapshot direction with a small fraction
 * of an orthogonal direction. Cosine similarity is approximately
 * snapshotWeight / sqrt(snapshotWeight^2 + driftWeight^2). Used to seed
 * sub-action-threshold (small) drifts.
 */
function blendedVec(baseIdx: number, driftIdx: number, snapshotWeight: number, driftWeight: number): number[] {
  const v = new Array(CENTROID_DIM).fill(0);
  v[baseIdx % CENTROID_DIM] = snapshotWeight;
  v[driftIdx % CENTROID_DIM] = driftWeight;
  // L2-normalise.
  let nrm = 0;
  for (let i = 0; i < CENTROID_DIM; i++) nrm += v[i] * v[i];
  nrm = Math.sqrt(nrm);
  if (nrm > 0) {
    for (let i = 0; i < CENTROID_DIM; i++) v[i] /= nrm;
  }
  return v;
}

async function cleanSlate(): Promise<void> {
  await testDb`DELETE FROM public.entity_drift_events`;
  await testDb`DELETE FROM public.entity_drift_state`;
  await testDb`DELETE FROM public.drift_compute_runs`;
  await testDb`DELETE FROM public.entity_clusters`;
  await testDb`DELETE FROM public.clustering_compute_runs`;
  await testDb`DELETE FROM public.entity_meta`;
  await deleteFromTables({
    tables: ['fact_history', 'memory_entities', 'facts', 'merge_candidates', 'entities'],
    acknowledgeGlobal: true,
  });
}

// Per-spawn cost: venv python startup + import river + connect ~1-2s. Tests
// that loop runDriftCompute() 30+ times need generous timeouts. The default
// 30s testTimeout / 30s hookTimeout is too tight. Phase 3.1's
// clustering-hdbscan.test.ts uses the same pattern; we mirror its bumps.
const DRIFT_TEST_TIMEOUT_MS = 240_000; // 4 min — covers 60+ python spawns
const DRIFT_HOOK_TIMEOUT_MS = 60_000;  // cleanSlate after a long test

describe('drift-detection §24.2 — Phase 3 / T1', () => {
  beforeEach(async () => {
    await cleanSlate();
  }, DRIFT_HOOK_TIMEOUT_MS);

  it('1. river smoke test — pinned API surface (ADWIN(delta=...).update().drift_detected)', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Master §10 lock W3 / doc 24.2 §3.1 — verify the three pinned API calls
    // work without raising on the installed river version.
    const driver = `
import sys
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
import river
from river.drift import ADWIN
detector = ADWIN(delta=0.002)
detector.update(0.1)
detector.update(0.2)
v = detector.drift_detected
assert isinstance(v, bool), f"drift_detected returned {type(v)}, expected bool"
print("ok", river.__version__, v)
`;
    const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8' }).trim();
    expect(out).toMatch(/^ok \S+ (True|False)$/);
  });

  it('2. first-time clustering: no drift events; ADWIN state seeded for each entity', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Seed 5 entities with centroid == snapshot (cosine = 1, magnitude = 0).
    const entities: { id: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await createTestEntity({ canonicalName: `ft_e${i}`, entityType: 'thing' });
      entities.push(e);
      const vec = unitAt(0);
      await setLiveCentroid(e.id, vec);
      await setClusterSnapshot(e.id, vec, 0);
    }
    const r = runDriftCompute();
    expect(r.entities_processed).toBe(5);
    expect(r.drift_events_count).toBe(0);
    expect((await getAllDriftEvents()).length).toBe(0);
    for (const e of entities) {
      const state = await getDriftState(e.id);
      expect(state).not.toBeNull();
      expect(state!.observation_count).toBe(1);
      expect(state!.last_cluster_id).toBe(0);
      expect(state!.has_blob).toBe(true);
      expect(state!.river_version.length).toBeGreaterThan(0);
    }
  });

  it('3. no-change recompute: still no drift events; observation count grows', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 'nc_e', entityType: 'thing' });
    const vec = unitAt(1);
    await setLiveCentroid(e.id, vec);
    await setClusterSnapshot(e.id, vec, 0);
    runDriftCompute();
    runDriftCompute();
    runDriftCompute();
    expect((await getDriftEvents(e.id)).length).toBe(0);
    const state = await getDriftState(e.id);
    expect(state!.observation_count).toBe(3);
  });

  it('4. small drift below action threshold: event with triggered_action=logged_only', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Stable run-up at magnitude ≈ 1.25e-5, then shift to magnitude ≈ 0.25
    // (cosine ≈ 0.75, snapshot weight 1.0 + drift weight 0.882). With
    // delta=0.05 and 30 stable iters, ADWIN's Hoeffding bound clears the
    // 0→0.25 step around iter 159 (probed empirically). 0.25 < 0.3 action
    // threshold so triggered_action must be 'logged_only'.
    const e = await createTestEntity({ canonicalName: 'sm_e', entityType: 'thing' });
    const snapVec = unitAt(2);
    await setClusterSnapshot(e.id, snapVec, 0);
    await setLiveCentroid(e.id, blendedVec(2, 100, 1.0, 0.005));

    const batch = runDriftBatch({
      entityId: e.id,
      stableVec: blendedVec(2, 100, 1.0, 0.005),
      shiftVec: blendedVec(2, 100, 1.0, 0.882),
      transitionAt: 30,
      totalIters: 200,
      env: { DRIFT_DELTA: '0.05' },
    });
    expect(batch.detectedAtIter).not.toBeNull();
    expect(batch.detectedAtIter).toBeGreaterThanOrEqual(30);

    const events = await getDriftEvents(e.id);
    expect(events.length).toBeGreaterThan(0);
    const first = events[0]!;
    // Magnitude must be > 0 (a real shift) and < 0.3 (below action threshold).
    expect(first.drift_magnitude).toBeGreaterThan(0);
    expect(first.drift_magnitude).toBeLessThan(0.3);
    expect(first.triggered_action).toBe('logged_only');
  }, DRIFT_TEST_TIMEOUT_MS);

  it('5. large drift above action threshold: triggered_action=reconciliation_invoked + target_cluster_id set', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Seed two distinct cluster snapshots so cluster_means has multiple
    // entries; the drifted entity should target the OTHER cluster.
    for (let i = 0; i < 3; i++) {
      const seed = await createTestEntity({ canonicalName: `lc_a${i}`, entityType: 'thing' });
      const v = unitAt(10);
      await setLiveCentroid(seed.id, v);
      await setClusterSnapshot(seed.id, v, 0);
    }
    for (let i = 0; i < 3; i++) {
      const seed = await createTestEntity({ canonicalName: `lc_b${i}`, entityType: 'thing' });
      const v = unitAt(20);
      await setLiveCentroid(seed.id, v);
      await setClusterSnapshot(seed.id, v, 1);
    }

    // Target entity: snapshot at idx 10 (cluster 0); will drift to idx 20
    // direction (cluster 1). Magnitude after the flip = 1 - cos = 1.0.
    const target = await createTestEntity({ canonicalName: 'lc_t', entityType: 'thing' });
    const snap = unitAt(10);
    await setClusterSnapshot(target.id, snap, 0);
    await setLiveCentroid(target.id, snap);

    // ADWIN(delta=0.05) on a clean 0→1 step fires by ~iter 63. Use 30 stable
    // + 70 shift iterations for headroom.
    const batch = runDriftBatch({
      entityId: target.id,
      stableVec: unitAt(10),
      shiftVec: unitAt(20),
      transitionAt: 30,
      totalIters: 100,
      env: { DRIFT_DELTA: '0.05' },
    });
    expect(batch.detectedAtIter).not.toBeNull();
    expect(batch.detectedAtIter).toBeGreaterThanOrEqual(30);

    const events = await getDriftEvents(target.id);
    const above = events.find((evt) => evt.drift_magnitude >= 0.3);
    expect(above).toBeDefined();
    expect(above!.triggered_action).toBe('reconciliation_invoked');
    expect(above!.cluster_id_at_detection).toBe(0);
    // target_cluster_id is the nearest *other* cluster mean — must be 1.
    expect(above!.target_cluster_id).toBe(1);
  }, DRIFT_TEST_TIMEOUT_MS);

  it('6. ADWIN state persists: state blob round-trips across multiple computes', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 'ps_e', entityType: 'thing' });
    const vec = unitAt(3);
    await setLiveCentroid(e.id, vec);
    await setClusterSnapshot(e.id, vec, 0);
    for (let i = 0; i < 10; i++) runDriftCompute();
    const state = await getDriftState(e.id);
    expect(state!.observation_count).toBe(10);
    expect(state!.has_blob).toBe(true);
  }, DRIFT_TEST_TIMEOUT_MS);

  it('7. river version mismatch: stored state with bogus river_version is reset on next compute', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 'rv_e', entityType: 'thing' });
    const vec = unitAt(4);
    await setLiveCentroid(e.id, vec);
    await setClusterSnapshot(e.id, vec, 0);
    runDriftCompute();
    // Manually corrupt the stored river_version so the next compute treats
    // the row as version-mismatched and resets it.
    await testDb`
      UPDATE public.entity_drift_state
      SET river_version = '0.0.1-fake'
      WHERE entity_id = ${e.id}::uuid
    `;
    const r = runDriftCompute();
    expect(r.state_resets_river).toBeGreaterThanOrEqual(1);
    const state = await getDriftState(e.id);
    // After reset, the state row exists with the *current* river_version
    // and an observation_count of 1 (the post-reset compute is the first
    // observation against the fresh detector).
    expect(state!.river_version).not.toBe('0.0.1-fake');
    expect(state!.observation_count).toBe(1);
  }, DRIFT_TEST_TIMEOUT_MS);

  it('8. cluster reassignment: ADWIN state resets when last_cluster_id != current cluster_id', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Master §10 lock B2 / doc 24.2 §2.4 reset trigger.
    const e = await createTestEntity({ canonicalName: 'cr_e', entityType: 'thing' });
    const vec = unitAt(5);
    await setLiveCentroid(e.id, vec);
    await setClusterSnapshot(e.id, vec, 0);
    for (let i = 0; i < 5; i++) runDriftCompute();
    let state = await getDriftState(e.id);
    expect(state!.observation_count).toBe(5);
    expect(state!.last_cluster_id).toBe(0);

    // Reassign the entity to cluster 1 (HDBSCAN simulated).
    await testDb`
      UPDATE public.entity_clusters
      SET cluster_id = 1
      WHERE entity_id = ${e.id}::uuid
    `;
    const r = runDriftCompute();
    expect(r.state_resets_cluster).toBeGreaterThanOrEqual(1);
    state = await getDriftState(e.id);
    expect(state!.observation_count).toBe(1);
    expect(state!.last_cluster_id).toBe(1);
  }, DRIFT_TEST_TIMEOUT_MS);

  it('9. cascade-delete: deleting an entity removes drift state and events', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 'cd_e', entityType: 'thing' });
    const vec = unitAt(6);
    await setLiveCentroid(e.id, vec);
    await setClusterSnapshot(e.id, vec, 0);
    runDriftCompute();
    // Inject a synthetic drift event (compute didn't fire one) to also
    // exercise the events-cascade.
    const literal = `[${vec.join(',')}]`;
    await testDb`
      INSERT INTO public.entity_drift_events (
        entity_id, drift_magnitude, centroid_snapshot, centroid_current,
        cluster_id_at_detection, target_cluster_id, triggered_action,
        computation_version
      ) VALUES (
        ${e.id}::uuid, 0.5, ${literal}::vector, ${literal}::vector,
        0, NULL, 'logged_only', 1
      )
    `;
    expect(await getDriftState(e.id)).not.toBeNull();
    expect((await getDriftEvents(e.id)).length).toBeGreaterThanOrEqual(1);

    await testDb`DELETE FROM public.entities WHERE id = ${e.id}::uuid`;

    expect(await getDriftState(e.id)).toBeNull();
    expect((await getDriftEvents(e.id)).length).toBe(0);
  });

  it('10. zero-norm snapshot: skipped without raising', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 'zn_e', entityType: 'thing' });
    // Live centroid is fine; snapshot is the zero vector — compute should
    // skip the entity per §6 edge case ("Cosine of zero vector").
    await setLiveCentroid(e.id, unitAt(7));
    const zero = new Array(CENTROID_DIM).fill(0);
    await setClusterSnapshot(e.id, zero, 0);
    const r = runDriftCompute();
    expect(r.skipped_zero_norm).toBeGreaterThanOrEqual(1);
    expect(r.drift_events_count).toBe(0);
    expect(await getDriftState(e.id)).toBeNull();
  });

  it('11. determinism: two consecutive computes on identical state produce identical event counts', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Seed many stable entities; with no drift, two consecutive runs should
    // both report 0 events.
    for (let i = 0; i < 10; i++) {
      const e = await createTestEntity({ canonicalName: `det_e${i}`, entityType: 'thing' });
      const v = unitAt(i + 1);
      await setLiveCentroid(e.id, v);
      await setClusterSnapshot(e.id, v, 0);
    }
    const r1 = runDriftCompute();
    const r2 = runDriftCompute();
    expect(r1.drift_events_count).toBe(0);
    expect(r2.drift_events_count).toBe(0);
    expect(r1.entities_processed).toBe(r2.entities_processed);
  });

  it('13. reconciliation_agent sibling endpoint: drift payload reaches the prompt verbatim', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Acceptance criterion: "reconciliation_agent sibling endpoint shipped +
    // integration test verifies agent receives drift payload". We exercise
    // the prompt-builder path that the FastAPI handler invokes — a real
    // /reconciliation-agent/drift POST would also feed the same prompt to
    // the LLM. Asserting the prompt embeds entity_id, drift_magnitude,
    // source_cluster_id, target_cluster_id verifies the wire format the
    // agent receives.
    const driver = `
import sys, json
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
from app.drift import (
    ReconciliationDriftRequest,
    _build_reconciliation_drift_prompt,
    RECONCILIATION_DRIFT_SYSTEM_PROMPT,
)

req = ReconciliationDriftRequest(
    entity_id="00000000-0000-0000-0000-0000deadbeef",
    drift_magnitude=0.7321,
    centroid_snapshot=[0.0] * 768,
    centroid_current=[0.0] * 768,
    source_cluster_id=3,
    target_cluster_id=7,
    mcp_config_path="/tmp/mcp.json",
)
prompt = _build_reconciliation_drift_prompt(req)
out = {
    "prompt": prompt,
    "system_prompt_len": len(RECONCILIATION_DRIFT_SYSTEM_PROMPT),
    "system_prompt_keywords": [
        "drift-investigation" in RECONCILIATION_DRIFT_SYSTEM_PROMPT,
        "SAME_AS" in RECONCILIATION_DRIFT_SYSTEM_PROMPT,
        "target_cluster_id" in RECONCILIATION_DRIFT_SYSTEM_PROMPT,
        "MCP" in RECONCILIATION_DRIFT_SYSTEM_PROMPT,
    ],
}
print(json.dumps(out))
`;
    const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8' });
    const parsed = JSON.parse(out.trim().split(/\r?\n/).pop() ?? '{}') as {
      prompt: string;
      system_prompt_len: number;
      system_prompt_keywords: boolean[];
    };
    expect(parsed.prompt).toContain('00000000-0000-0000-0000-0000deadbeef');
    expect(parsed.prompt).toContain('0.7321');
    expect(parsed.prompt).toContain('source_cluster_id: 3');
    expect(parsed.prompt).toContain('target_cluster_id: 7');
    expect(parsed.prompt).toContain('query_entity_facts');
    expect(parsed.system_prompt_len).toBeGreaterThan(500);
    expect(parsed.system_prompt_keywords.every((b) => b === true)).toBe(true);
  });

  it('12. corrupt pickle: malformed adwin_state_blob is reset cleanly with a counter bump', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 'cp_e', entityType: 'thing' });
    const vec = unitAt(8);
    await setLiveCentroid(e.id, vec);
    await setClusterSnapshot(e.id, vec, 0);
    runDriftCompute();
    // Corrupt the blob (random bytes that are not a valid pickle).
    await testDb`
      UPDATE public.entity_drift_state
      SET adwin_state_blob = decode('deadbeef', 'hex')
      WHERE entity_id = ${e.id}::uuid
    `;
    const r = runDriftCompute();
    expect(r.state_resets_corrupt).toBeGreaterThanOrEqual(1);
    const state = await getDriftState(e.id);
    expect(state!.observation_count).toBe(1);
  });
});
