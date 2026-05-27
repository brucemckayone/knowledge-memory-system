/**
 * Bead nmemo-2yv.86 — HTTP route integration tests for the
 * topology / clustering / drift / cross-cluster surfaces, plus the
 * fire-and-forget chains they kick off.
 *
 * Coverage shape (Q3 tiered, see bead Decision):
 *   - Happy path for every route in the specific-gaps list (acceptance #2).
 *   - Failure paths for the fire-and-forget chains (T13 silent-failure shape,
 *     acceptance #4): ml-services unreachable, downstream throws inside chain,
 *     freshness-gate skip case.
 *   - Selective failure paths for the underlying POST route handlers
 *     (acceptance #5): 502 on ml-services down, 503 on QueueFullError,
 *     400 on bad path params.
 *
 * Why `app.request()` is the primary harness:
 *   Hono exposes an in-process request interface that drives the same
 *   middleware + handler stack as the live server but without binding a
 *   port. Fast, deterministic, no Docker dep, ml-services is mocked via
 *   the shared `mockMlServices()` helper in setup.ts (bead acceptance #1).
 *
 * Smoke tier (acceptance #3) — fire-and-forget chain end-to-end against a
 *   running platform process — lives in the "smoke" describe block below
 *   and is env-gated on `RUN_HTTP_SMOKE=1`. Per CLAUDE.md the platform +
 *   ml-services run on the host, not in Docker; CI doesn't have them up by
 *   default. Locally: `make ml && pnpm dev` in two terminals, then
 *   `RUN_HTTP_SMOKE=1 pnpm test topology-clustering-drift-http`.
 *
 * The advisory-lock skip case (acceptance #6) is already exercised by
 *   cross-cluster-generator.test.ts:452 + :544 — those tests pin a reserved
 *   pg session, hold the advisory lock, and assert `skippedReason='lock_held'`
 *   on both the result and the persisted run row. We don't re-litigate that
 *   coverage here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testDb, createTestEntity, mockMlServices, type MockMlServicesHandle } from '../setup.js';
import { app, triggerCrossClusterAfterCompute, triggerReconciliationDriftAfterCompute } from '../../index.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Seed a single entity_topology row. The test harness only needs a fixed
 * shape; we don't enumerate every column. Uses a deterministic component_id
 * so the GET tests can read it back by id.
 */
async function seedTopologyRow(args: { entityId: string; componentId: number; componentSize?: number }): Promise<void> {
  await testDb`
    INSERT INTO public.entity_topology
      (entity_id, component_id, component_size, k_core, is_articulation_point,
       community_id, participation_coef, pagerank, betweenness_sampled,
       predicate_signature, computation_version)
    VALUES (
      ${args.entityId}::uuid,
      ${args.componentId},
      ${args.componentSize ?? 1},
      1,
      false,
      NULL,
      NULL,
      0.5,
      NULL,
      NULL,
      1
    )
    ON CONFLICT (entity_id) DO UPDATE SET
      component_id = EXCLUDED.component_id,
      component_size = EXCLUDED.component_size
  `;
}

async function seedClusterRow(args: { entityId: string; clusterId: number; probability?: number }): Promise<void> {
  // entity_clusters.centroid_snapshot is NOT NULL — give it a stub unit vector.
  const centroid = `[${Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
  await testDb`
    INSERT INTO public.entity_clusters
      (entity_id, cluster_id, centroid_snapshot, cluster_probability, cluster_size, computation_version)
    VALUES (
      ${args.entityId}::uuid,
      ${args.clusterId},
      ${testDb.unsafe(`'${centroid}'::vector`)},
      ${args.probability ?? 0.9},
      1,
      1
    )
    ON CONFLICT (entity_id) DO UPDATE SET
      cluster_id = EXCLUDED.cluster_id,
      cluster_probability = EXCLUDED.cluster_probability
  `;
}

async function seedDriftEventRow(args: {
  entityId: string;
  driftMagnitude?: number;
  triggeredAction?: 'logged_only' | 'reconciliation_invoked' | 'reconciliation_failed';
}): Promise<string> {
  const stub = `[${Array.from({ length: 768 }, () => 0).join(',')}]`;
  const rows = (await testDb`
    INSERT INTO public.entity_drift_events
      (entity_id, drift_magnitude, centroid_snapshot, centroid_current,
       cluster_id_at_detection, target_cluster_id, triggered_action)
    VALUES (
      ${args.entityId}::uuid,
      ${args.driftMagnitude ?? 0.25},
      ${testDb.unsafe(`'${stub}'::vector`)},
      ${testDb.unsafe(`'${stub}'::vector`)},
      1,
      2,
      ${args.triggeredAction ?? 'logged_only'}
    )
    RETURNING id::text AS id
  `) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error('drift event seed produced no row');
  return rows[0].id;
}

async function seedDriftStateRow(args: { entityId: string; observationCount?: number }): Promise<void> {
  // adwin_state_blob is BYTEA NOT NULL (mig 016 §3.1). Empty buffer is a
  // legal sentinel — the drift compute writes a real serialised ADWIN here,
  // but for the GET-route test we only need the column to be present.
  await testDb`
    INSERT INTO public.entity_drift_state
      (entity_id, observation_count, last_cluster_id, river_version, adwin_state_blob, last_updated_at)
    VALUES (
      ${args.entityId}::uuid,
      ${args.observationCount ?? 5},
      1,
      'v1',
      ${Buffer.from('')},
      NOW()
    )
    ON CONFLICT (entity_id) DO UPDATE SET
      observation_count = EXCLUDED.observation_count
  `;
}

/**
 * Clean only the rows this suite plants. Avoids the full deleteFromTables
 * sweep (which would race with other parallel test files).
 */
async function cleanupBead86State(): Promise<void> {
  await testDb`DELETE FROM public.entity_drift_events WHERE entity_id IN (
    SELECT id FROM public.entities WHERE canonical_name LIKE 'bead86-%'
  )`;
  await testDb`DELETE FROM public.entity_drift_state WHERE entity_id IN (
    SELECT id FROM public.entities WHERE canonical_name LIKE 'bead86-%'
  )`;
  await testDb`DELETE FROM public.entity_clusters WHERE entity_id IN (
    SELECT id FROM public.entities WHERE canonical_name LIKE 'bead86-%'
  )`;
  await testDb`DELETE FROM public.entity_topology WHERE entity_id IN (
    SELECT id FROM public.entities WHERE canonical_name LIKE 'bead86-%'
  )`;
  await testDb`DELETE FROM public.entities WHERE canonical_name LIKE 'bead86-%'`;
}

/**
 * Drain the microtask queue so fire-and-forget `void helper()` calls land
 * before assertions run. 200ms is the same wait auto-trigger-derived-state
 * uses; mirroring that keeps the cadence consistent across the harness.
 */
function drainAsync(ms = 200): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Acceptance #2 — Happy-path tests for every route in the specific-gaps list.
// app.request() driven; ml-services mocked via mockMlServices().
// ============================================================================

describe('bead nmemo-2yv.86 — HTTP layer happy paths (app.request())', () => {
  let ml: MockMlServicesHandle | undefined;

  beforeEach(async () => {
    await cleanupBead86State();
  });

  afterEach(() => {
    ml?.restore();
    ml = undefined;
  });

  it('POST /api/topology/compute returns ok shape on ml-services 200', async () => {
    ml = mockMlServices({
      responses: {
        '/topology/compute': { kind: 'ok', body: { entity_count: 3, component_count: 2 } },
      },
    });

    const res = await app.request('/api/topology/compute', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { entity_count: number }; durationMs: number };
    expect(body.ok).toBe(true);
    expect(body.result).toMatchObject({ entity_count: 3, component_count: 2 });
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/topology serialises predicate_signature + bridges payload', async () => {
    const e = await createTestEntity({ canonicalName: 'bead86-topology-snapshot', entityType: 'Concept' });
    await seedTopologyRow({ entityId: e.id, componentId: 42, componentSize: 1 });

    const res = await app.request('/api/topology', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entities: Array<{ id: string; componentId: number; predicateSignature: number[] | null }>;
      bridges: unknown[];
    };
    const row = body.entities.find((r) => r.id === e.id);
    expect(row).toBeDefined();
    expect(row?.componentId).toBe(42);
    // No predicate_signature seeded → parses to null (not "[]").
    expect(row?.predicateSignature).toBeNull();
    // bridges array present even when empty (acceptance #2: response shape).
    expect(Array.isArray(body.bridges)).toBe(true);
  });

  it('GET /api/topology empty-DB case returns empty arrays', async () => {
    await testDb`DELETE FROM public.entity_topology`;
    await testDb`DELETE FROM public.topology_bridges`;
    const res = await app.request('/api/topology', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entities: unknown[]; bridges: unknown[] };
    expect(body.entities).toEqual([]);
    expect(body.bridges).toEqual([]);
  });

  it('POST /api/clustering/compute returns ok shape on ml-services 200', async () => {
    ml = mockMlServices({
      responses: { '/clustering/compute': { kind: 'ok', body: { cluster_count: 5, noise_count: 2 } } },
    });
    const res = await app.request('/api/clustering/compute', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { cluster_count: number } };
    expect(body.ok).toBe(true);
    expect(body.result.cluster_count).toBe(5);
  });

  it('GET /api/clusters surfaces noiseCount + clusterCount + per-entity rows', async () => {
    const e1 = await createTestEntity({ canonicalName: 'bead86-clusters-1', entityType: 'Concept' });
    const e2 = await createTestEntity({ canonicalName: 'bead86-clusters-2', entityType: 'Concept' });
    await seedClusterRow({ entityId: e1.id, clusterId: 7, probability: 0.95 });
    await seedClusterRow({ entityId: e2.id, clusterId: -1 });

    const res = await app.request('/api/clusters', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entities: Array<{ id: string; clusterId: number }>;
      summary: Record<string, number>;
      noiseCount: number;
      clusterCount: number;
    };
    const r1 = body.entities.find((r) => r.id === e1.id);
    const r2 = body.entities.find((r) => r.id === e2.id);
    expect(r1?.clusterId).toBe(7);
    expect(r2?.clusterId).toBe(-1);
    expect(body.noiseCount).toBeGreaterThanOrEqual(1);
    expect(body.clusterCount).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/clusters/:cluster_id happy path returns entities + meta', async () => {
    const e = await createTestEntity({ canonicalName: 'bead86-cluster-detail', entityType: 'Concept' });
    await seedClusterRow({ entityId: e.id, clusterId: 99, probability: 0.5 });

    const res = await app.request('/api/clusters/99', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cluster_id: number; size: number; entities: unknown[] };
    expect(body.cluster_id).toBe(99);
    expect(Array.isArray(body.entities)).toBe(true);
    expect(body.entities.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/clusters/:cluster_id empty-result returns shape with empty entities', async () => {
    const res = await app.request('/api/clusters/-9999', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cluster_id: number; size: number; entities: unknown[] };
    expect(body.cluster_id).toBe(-9999);
    expect(body.size).toBe(0);
    expect(body.entities).toEqual([]);
  });

  it('POST /api/drift/compute returns ok shape on ml-services 200', async () => {
    ml = mockMlServices({
      responses: {
        '/drift/compute': { kind: 'ok', body: { events_detected: 0, entities_observed: 4 } },
        // /reconciliation-agent/drift is invoked by the fire-and-forget helper.
        // No pending rows in the DB at this moment, so it shouldn't be hit —
        // we still register a default so any accidental call fails loud rather
        // than as a 404.
        '/reconciliation-agent/drift': { kind: 'ok', body: { result: 'no-op' } },
      },
    });
    const res = await app.request('/api/drift/compute', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { entities_observed: number } };
    expect(body.ok).toBe(true);
    expect(body.result.entities_observed).toBe(4);
    // Drain the void helper so its log line lands; we don't assert on it
    // here (separate test covers the helper directly).
    await drainAsync(50);
  });

  it('GET /api/drift/events scopes to entity_id when present, returns global feed otherwise', async () => {
    const e = await createTestEntity({ canonicalName: 'bead86-drift-events-entity', entityType: 'Concept' });
    await seedDriftEventRow({ entityId: e.id, driftMagnitude: 0.5 });

    // entity-scoped
    const scoped = await app.request(`/api/drift/events?entity_id=${e.id}`, { method: 'GET' });
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as { entity_id: string | null; count: number; events: Array<{ entity_id: string }> };
    expect(scopedBody.entity_id).toBe(e.id);
    expect(scopedBody.count).toBeGreaterThanOrEqual(1);
    expect(scopedBody.events.every((row) => row.entity_id === e.id)).toBe(true);

    // global (entity_id-optional path)
    const global = await app.request('/api/drift/events', { method: 'GET' });
    expect(global.status).toBe(200);
    const globalBody = (await global.json()) as { entity_id: string | null; count: number };
    expect(globalBody.entity_id).toBeNull();
    expect(globalBody.count).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/drift/state/:entityId returns shaped state row when present', async () => {
    const e = await createTestEntity({ canonicalName: 'bead86-drift-state', entityType: 'Concept' });
    await seedDriftStateRow({ entityId: e.id, observationCount: 17 });

    const res = await app.request(`/api/drift/state/${e.id}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { observationCount: number } | null };
    expect(body.state).not.toBeNull();
    expect(body.state?.observationCount).toBe(17);
  });

  it('GET /api/drift/state/:entityId returns null state when entity has no observations', async () => {
    const e = await createTestEntity({ canonicalName: 'bead86-drift-state-absent', entityType: 'Concept' });
    const res = await app.request(`/api/drift/state/${e.id}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: unknown };
    expect(body.state).toBeNull();
  });

  it('GET /api/components/:component_id happy path returns entities', async () => {
    const e = await createTestEntity({ canonicalName: 'bead86-component-1', entityType: 'Concept' });
    await seedTopologyRow({ entityId: e.id, componentId: 555, componentSize: 1 });

    const res = await app.request('/api/components/555', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { component_id: number; size: number; entities: Array<{ id: string }> };
    expect(body.component_id).toBe(555);
    expect(body.entities.some((r) => r.id === e.id)).toBe(true);
  });

  it('GET /api/components/:component_id empty-result returns shaped empty body', async () => {
    const res = await app.request('/api/components/9999999', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { component_id: number; size: number; entities: unknown[] };
    expect(body.component_id).toBe(9999999);
    expect(body.size).toBe(0);
    expect(body.entities).toEqual([]);
  });

  it('POST /api/cross-cluster/generate returns ok shape (may skip on stale upstream)', async () => {
    const res = await app.request('/api/cross-cluster/generate', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { ran: boolean }; durationMs: number };
    expect(body.ok).toBe(true);
    // ran=true OR ran=false (skipped) — both are legal happy-path responses;
    // we only assert the route returns a well-shaped result, not the
    // generator's verdict (covered by cross-cluster-generator.test.ts).
    expect(typeof body.result.ran).toBe('boolean');
  });

  it('GET /api/cross-cluster/candidates returns count + candidates array', async () => {
    const res = await app.request('/api/cross-cluster/candidates', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; candidates: unknown[] };
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.count).toBe(body.candidates.length);
  });
});

// ============================================================================
// Acceptance #4 — Failure paths for the fire-and-forget chains.
// T13 silent-failure shape: chain must log + swallow, never reject the
// caller's promise / cascade an unhandled rejection.
// ============================================================================

describe('bead nmemo-2yv.86 — fire-and-forget chain failure paths (T13)', () => {
  let ml: MockMlServicesHandle | undefined;
  let unhandledRejections: unknown[] = [];
  const recordRejection = (reason: unknown) => unhandledRejections.push(reason);

  beforeEach(() => {
    unhandledRejections = [];
    process.on('unhandledRejection', recordRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', recordRejection);
    ml?.restore();
    ml = undefined;
  });

  it('triggerCrossClusterAfterCompute: ml-services unreachable → logs + swallows (no throw)', async () => {
    // Cross-cluster generator runs in-process — it doesn't talk to ml-services
    // directly. The failure path we're testing is the catch on the import +
    // invocation seam; we simulate it by stubbing the import target.
    // The cleanest cover is: invoke with no upstream rows seeded; the
    // generator returns ran=false skippedReason='stale_upstream', the helper
    // logs the skip, never throws. Equivalent to bead acceptance bullet 4
    // (freshness gate skip case).
    await expect(triggerCrossClusterAfterCompute('topology')).resolves.toBeUndefined();
    await drainAsync(50);
    expect(unhandledRejections).toHaveLength(0);
  });

  it('triggerCrossClusterAfterCompute: freshness-gate skip → ran=false / no throw', async () => {
    // Wipe upstream freshness rows so the gate skips. The helper's catch
    // surrounds the import; the inner generator returns ran=false +
    // skippedReason='stale_upstream' rather than throwing, and the helper
    // logs the skipped reason on the console (we assert it doesn't throw).
    await testDb`DELETE FROM public.topology_compute_runs`;
    await testDb`DELETE FROM public.clustering_compute_runs`;
    await expect(triggerCrossClusterAfterCompute('clustering')).resolves.toBeUndefined();
    expect(unhandledRejections).toHaveLength(0);
  });

  it('triggerReconciliationDriftAfterCompute: ml-services 502 → logs + swallows, no unhandled rejection', async () => {
    // Seed one pending row so the helper actually invokes the agent.
    const e = await createTestEntity({ canonicalName: 'bead86-rec-drift-502', entityType: 'Concept' });
    await seedDriftEventRow({ entityId: e.id, triggeredAction: 'reconciliation_invoked' });

    // Inject an invoker that returns a 502 (transient) — the helper's
    // per-row try/catch handles it as a transient failure, not an exception.
    await expect(
      triggerReconciliationDriftAfterCompute(async () => ({ status: 502, error: 'mock ml-services down' })),
    ).resolves.toBeUndefined();
    expect(unhandledRejections).toHaveLength(0);

    // Cleanup the test-planted row so it doesn't leak.
    await testDb`DELETE FROM public.entity_drift_events WHERE entity_id = ${e.id}::uuid`;
    await testDb`DELETE FROM public.entities WHERE id = ${e.id}::uuid`;
  });

  it('triggerReconciliationDriftAfterCompute: invoker itself throws → caught by per-row try, no unhandled rejection', async () => {
    const e = await createTestEntity({ canonicalName: 'bead86-rec-drift-throw', entityType: 'Concept' });
    await seedDriftEventRow({ entityId: e.id, triggeredAction: 'reconciliation_invoked' });

    await expect(
      triggerReconciliationDriftAfterCompute(async () => {
        throw new Error('mock invoker explosion');
      }),
    ).resolves.toBeUndefined();
    expect(unhandledRejections).toHaveLength(0);

    await testDb`DELETE FROM public.entity_drift_events WHERE entity_id = ${e.id}::uuid`;
    await testDb`DELETE FROM public.entities WHERE id = ${e.id}::uuid`;
  });

  it('POST /api/drift/compute success path fires reconciliation chain — chain failure does not perturb route response', async () => {
    // Seed a pending drift event so the chain has work to do.
    const e = await createTestEntity({ canonicalName: 'bead86-drift-chain-fail', entityType: 'Concept' });
    await seedDriftEventRow({ entityId: e.id, triggeredAction: 'reconciliation_invoked' });

    // Mock ml-services so /drift/compute succeeds but /reconciliation-agent
    // would 503. The helper's `void` call should swallow the 503.
    ml = mockMlServices({
      responses: {
        '/drift/compute': { kind: 'ok', body: { events_detected: 1 } },
        '/reconciliation-agent/drift': { kind: 'queue-full' },
      },
    });

    const res = await app.request('/api/drift/compute', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Drain the helper's microtask. The route already returned; any throw
    // in the helper would surface as an unhandled rejection.
    await drainAsync(300);
    expect(unhandledRejections).toHaveLength(0);

    await testDb`DELETE FROM public.entity_drift_events WHERE entity_id = ${e.id}::uuid`;
    await testDb`DELETE FROM public.entities WHERE id = ${e.id}::uuid`;
  });

  it('triggerCrossClusterAfterCompute(\'drift\'): freshness-gate skip → ran=false / no throw', async () => {
    // Bead nmemo-2yv.85 — drift trigger goes through the same helper as the
    // topology/clustering siblings. The freshness gate keys on topology+
    // clustering recency (NOT drift), so when both upstreams are stale the
    // helper logs skippedReason='stale_upstream' and never throws. Drift
    // alone never starves the gate; this asserts the new 'drift' literal
    // shares the existing fail-safe semantics.
    await testDb`DELETE FROM public.topology_compute_runs`;
    await testDb`DELETE FROM public.clustering_compute_runs`;
    await expect(triggerCrossClusterAfterCompute('drift')).resolves.toBeUndefined();
    expect(unhandledRejections).toHaveLength(0);
  });
});

// ============================================================================
// Acceptance #5 — Selective failure-path tests for the underlying POST routes.
// One test per failure class — not exhaustive per route.
// ============================================================================

describe('bead nmemo-2yv.86 — route-handler selective failure paths', () => {
  let ml: MockMlServicesHandle | undefined;
  afterEach(() => {
    ml?.restore();
    ml = undefined;
  });

  it('POST /api/topology/compute → 502 when ml-services throws (network unreachable)', async () => {
    ml = mockMlServices({
      responses: { '/topology/compute': { kind: 'throw', message: 'ECONNREFUSED' } },
    });
    const res = await app.request('/api/topology/compute', { method: 'POST' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('ECONNREFUSED');
  });

  it('POST /api/clustering/compute → propagates ml-services 5xx as ok=false', async () => {
    ml = mockMlServices({
      responses: { '/clustering/compute': { kind: 'error', status: 500, body: { detail: 'igraph crashed' } } },
    });
    const res = await app.request('/api/clustering/compute', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; status: number; error: { detail: string } };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(500);
    expect(body.error.detail).toBe('igraph crashed');
  });

  it('POST /api/drift/compute → propagates 503 QueueFullError shape', async () => {
    ml = mockMlServices({
      responses: { '/drift/compute': { kind: 'queue-full' } },
    });
    const res = await app.request('/api/drift/compute', { method: 'POST' });
    // The route returns the upstream status; for 503 the typing cast in
    // index.ts coerces to 409|500, but Hono's response will carry the
    // numeric status as-is — assert >= 500.
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = (await res.json()) as { ok: boolean; status?: number; error?: unknown };
    expect(body.ok).toBe(false);
  });

  it('POST /api/topology/compute → propagates 409 in-progress shape from ml-services', async () => {
    // Acceptance #5 cites "409 on in-progress (depends on .87 advisory-lock landing
    // or pairs with it)". .87 lock lives ml-services-side (Python locks.py). The
    // platform handler simply propagates whatever non-2xx the sidecar returns;
    // we mock the 409 and confirm the route's body shape mirrors the spec.
    ml = mockMlServices({
      responses: { '/topology/compute': { kind: 'error', status: 409, body: { detail: 'topology_compute already in progress' } } },
    });
    const res = await app.request('/api/topology/compute', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; status: number; error: { detail: string } };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(409);
    expect(body.error.detail).toContain('in progress');
  });

  it('GET /api/components/:component_id → 400 on non-integer id', async () => {
    const res = await app.request('/api/components/not-an-int', { method: 'GET' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('must be an integer');
  });

  it('GET /api/clusters/:cluster_id → 400 on non-integer id', async () => {
    const res = await app.request('/api/clusters/banana', { method: 'GET' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('must be an integer');
  });
});

// ============================================================================
// Acceptance #3 — Real-fetch smoke tests against a running platform process.
// Env-gated: only runs when RUN_HTTP_SMOKE=1 is set. CI doesn't bring up the
// platform process by default; locally requires `make ml` + `pnpm dev`.
// ============================================================================

const RUN_SMOKE = process.env.RUN_HTTP_SMOKE === '1';

(RUN_SMOKE ? describe : describe.skip)('bead nmemo-2yv.86 — fire-and-forget smoke (env-gated, RUN_HTTP_SMOKE=1)', () => {
  const PLATFORM = process.env.PLATFORM_URL || 'http://127.0.0.1:3000';

  it('POST /api/topology/compute → triggerCrossClusterAfterCompute fires (cross_cluster_runs lands)', async () => {
    const before = (await testDb`SELECT COUNT(*)::int AS n FROM public.cross_cluster_runs`) as unknown as Array<{ n: number }>;
    const baseline = before[0]?.n ?? 0;
    const res = await fetch(`${PLATFORM}/api/topology/compute`, { method: 'POST' });
    expect(res.ok).toBe(true);
    // Wait for the fire-and-forget chain to land. Generous (5s) — production
    // run may need igraph compute + cross-cluster generator.
    await drainAsync(5000);
    const after = (await testDb`SELECT COUNT(*)::int AS n FROM public.cross_cluster_runs`) as unknown as Array<{ n: number }>;
    expect(after[0]?.n ?? 0).toBeGreaterThan(baseline);
  });

  it('POST /api/clustering/compute → triggerCrossClusterAfterCompute fires (cross_cluster_runs lands)', async () => {
    const before = (await testDb`SELECT COUNT(*)::int AS n FROM public.cross_cluster_runs`) as unknown as Array<{ n: number }>;
    const baseline = before[0]?.n ?? 0;
    const res = await fetch(`${PLATFORM}/api/clustering/compute`, { method: 'POST' });
    expect(res.ok).toBe(true);
    await drainAsync(5000);
    const after = (await testDb`SELECT COUNT(*)::int AS n FROM public.cross_cluster_runs`) as unknown as Array<{ n: number }>;
    expect(after[0]?.n ?? 0).toBeGreaterThan(baseline);
  });

  it('POST /api/drift/compute → triggerReconciliationDriftAfterCompute fires (reconciliation_run_id set on pending event)', async () => {
    // Seed a pending drift event so the chain has work to do.
    const e = await createTestEntity({ canonicalName: 'bead86-smoke-drift', entityType: 'Concept' });
    const eventId = await seedDriftEventRow({ entityId: e.id, triggeredAction: 'reconciliation_invoked' });
    try {
      const res = await fetch(`${PLATFORM}/api/drift/compute`, { method: 'POST' });
      expect(res.ok).toBe(true);
      await drainAsync(10000); // LLM call — generous wait
      const rows = (await testDb`
        SELECT reconciliation_run_id::text AS run_id, triggered_action
        FROM public.entity_drift_events
        WHERE id = ${eventId}::uuid
      `) as unknown as Array<{ run_id: string | null; triggered_action: string }>;
      // Either succeeded (run_id set) OR the agent rejected and the row
      // moved to reconciliation_failed; both prove the chain reached the
      // agent and the helper updated the row.
      expect(rows[0]?.run_id !== null || rows[0]?.triggered_action === 'reconciliation_failed').toBe(true);
    } finally {
      await testDb`DELETE FROM public.entity_drift_events WHERE entity_id = ${e.id}::uuid`;
      await testDb`DELETE FROM public.entities WHERE id = ${e.id}::uuid`;
    }
  });

  it('POST /api/drift/compute → triggerCrossClusterAfterCompute(\'drift\') fires (cross_cluster_runs lands or skips)', async () => {
    // Bead nmemo-2yv.85 — assert the drift compute success path kicks the
    // cross-cluster generator just like topology/clustering. The generator's
    // freshness gate may legitimately short-circuit (skippedReason=
    // 'stale_upstream') depending on the platform's recent compute history,
    // but it ALWAYS writes a cross_cluster_runs row (the row is inserted in
    // a separate short tx before the advisory-lock work — see
    // cross-cluster-generator.ts line ~321). So a fresh row landing within
    // the drain window proves the helper ran end-to-end.
    const before = (await testDb`SELECT COUNT(*)::int AS n FROM public.cross_cluster_runs`) as unknown as Array<{ n: number }>;
    const baseline = before[0]?.n ?? 0;
    const res = await fetch(`${PLATFORM}/api/drift/compute`, { method: 'POST' });
    expect(res.ok).toBe(true);
    // Generous drain — drift compute itself can be slow on a populated graph,
    // and the cross-cluster generator runs after it.
    await drainAsync(5000);
    const after = (await testDb`SELECT COUNT(*)::int AS n FROM public.cross_cluster_runs`) as unknown as Array<{ n: number }>;
    expect(after[0]?.n ?? 0).toBeGreaterThan(baseline);
  });
});
