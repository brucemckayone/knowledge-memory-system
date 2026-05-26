/**
 * Bead nmemo-2yv.84 — auto-triggers for topology / clustering / drift.
 *
 * Three integration tests, one per anchor:
 *  1. Post-ingest counter: insert >= TOPOLOGY_CLUSTERING_FACT_THRESHOLD facts,
 *     assert derived_freshness resets (proxy for "compute was fired").
 *  2. Post-merge: invoke merge_entities() at SQL level, assert that the
 *     derived-freshness helper's HTTP fire path was reached.
 *  3. Scheduler: register a fast-cadence drift job, assert the runner fires.
 *
 * The HTTP-side compute is faked via a localhost server-stub so the tests
 * don't depend on ml-services being up. We assert "the platform attempted
 * the compute" (request received) — the route's own success path is exercised
 * by the existing compute-endpoint tests under ml-services.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { testDb, createTestEntity } from '../setup.js';
import { registerJob, stopScheduler, getRegisteredJobs } from '../../scheduler.js';
import {
  maybeFireFactThresholdCompute,
  triggerTopologyAndClusteringAfterMerge,
  _setComputeUrlPortForTesting,
} from '../../services/derived-freshness.js';

interface StubServer {
  server: Server;
  port: number;
  requests: Array<{ path: string; method: string }>;
  close: () => Promise<void>;
}

/**
 * Tiny localhost stub that records every request. The derived-freshness
 * helpers POST to http://127.0.0.1:PLATFORM_PORT/api/{kind}/compute; we
 * override PLATFORM_PORT to point at this stub for the duration of the test.
 */
async function startStubServer(): Promise<StubServer> {
  const requests: Array<{ path: string; method: string }> = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', method: req.method ?? '' });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub server failed to bind');
  return {
    server,
    port: addr.port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function resetFreshness(): Promise<void> {
  await testDb`
    UPDATE public.derived_freshness
       SET facts_since_compute = 0,
           last_computed_at    = NULL,
           updated_at          = NOW()
  `;
}

describe('bead nmemo-2yv.84 — derived-state auto-triggers', () => {
  beforeAll(async () => {
    // Confirm the 024 migration ran and seeded both rows.
    const rows = (await testDb`SELECT derived_kind FROM public.derived_freshness ORDER BY derived_kind`) as unknown as Array<{ derived_kind: string }>;
    expect(rows.map((r) => r.derived_kind)).toEqual(['clustering', 'topology']);
  });

  describe('derived_freshness DB trigger (acceptance bullet 6)', () => {
    beforeEach(async () => {
      await resetFreshness();
    });

    it('AFTER INSERT trigger increments facts_since_compute on both rows', async () => {
      const subject = await createTestEntity({ canonicalName: `bead84-fact-subj-${Date.now()}-${Math.random()}`, entityType: 'Concept' });
      const before = (await testDb`SELECT facts_since_compute FROM public.derived_freshness WHERE derived_kind = 'topology'`) as unknown as Array<{ facts_since_compute: number }>;
      const baseline = before[0]?.facts_since_compute ?? 0;
      await testDb`
        INSERT INTO public.facts (subject_entity_id, predicate, object_value, source_text)
        VALUES (${subject.id}::uuid, 'is', 'a thing', 'bead84-trigger-test-1')
      `;
      const rows = (await testDb`SELECT derived_kind, facts_since_compute FROM public.derived_freshness ORDER BY derived_kind`) as unknown as Array<{ derived_kind: string; facts_since_compute: number }>;
      // Both rows incremented by 1 (lockstep).
      expect(rows.find((r) => r.derived_kind === 'topology')?.facts_since_compute).toBe(baseline + 1);
      expect(rows.find((r) => r.derived_kind === 'clustering')?.facts_since_compute).toBe(baseline + 1);
    });
  });

  describe('post-ingest counter trigger (acceptance bullet 6)', () => {
    let stub: StubServer;

    beforeEach(async () => {
      stub = await startStubServer();
      _setComputeUrlPortForTesting(stub.port);
      await testDb`DELETE FROM public.facts WHERE source_text LIKE 'bead84-counter-%'`;
      await resetFreshness();
    });

    afterEach(async () => {
      _setComputeUrlPortForTesting(null);
      await stub.close();
    });

    it('crossing the threshold fires topology + clustering compute (via stub) and resets both rows', async () => {
      // Drive the counter past the default threshold (100) directly. The
      // helper reads config.TOPOLOGY_CLUSTERING_FACT_THRESHOLD at call time;
      // config is module-cached at vitest boot so we can't tune the
      // threshold per-test — instead we satisfy the default by setting the
      // counter to 100 on both rows.
      await testDb`UPDATE public.derived_freshness SET facts_since_compute = 100`;
      await maybeFireFactThresholdCompute();

      // Allow the fire-and-forget HTTP fetch microtask to drain.
      await new Promise((r) => setTimeout(r, 200));

      // Both compute endpoints were hit (the helper fires both sequentially).
      const paths = stub.requests.map((r) => r.path).sort();
      expect(paths).toContain('/api/topology/compute');
      expect(paths).toContain('/api/clustering/compute');

      // Both counters reset to 0.
      const rows = (await testDb`SELECT derived_kind, facts_since_compute FROM public.derived_freshness ORDER BY derived_kind`) as unknown as Array<{ derived_kind: string; facts_since_compute: number }>;
      expect(rows.find((r) => r.derived_kind === 'topology')?.facts_since_compute).toBe(0);
      expect(rows.find((r) => r.derived_kind === 'clustering')?.facts_since_compute).toBe(0);
    });

    it('below the threshold the helper is a no-op (no compute fired)', async () => {
      await testDb`UPDATE public.derived_freshness SET facts_since_compute = 5`;
      await maybeFireFactThresholdCompute();
      await new Promise((r) => setTimeout(r, 100));
      expect(stub.requests).toHaveLength(0);
    });
  });

  describe('post-merge trigger (acceptance bullet 5)', () => {
    let stub: StubServer;

    beforeEach(async () => {
      stub = await startStubServer();
      _setComputeUrlPortForTesting(stub.port);
    });

    afterEach(async () => {
      _setComputeUrlPortForTesting(null);
      await stub.close();
    });

    it('triggerTopologyAndClusteringAfterMerge fires both compute endpoints (via stub)', async () => {
      await triggerTopologyAndClusteringAfterMerge('test-merge-reason');

      // Sequential awaits inside helper — by the time the promise resolves
      // both requests have landed.
      const paths = stub.requests.map((r) => r.path).sort();
      expect(paths).toEqual(['/api/clustering/compute', '/api/topology/compute']);
    });
  });

  describe('scheduler (acceptance bullets 2 + 3 + 4)', () => {
    afterEach(() => {
      stopScheduler();
    });

    it('registerJob fires the runner on cadence; getRegisteredJobs surfaces the registration', async () => {
      let tickCount = 0;
      // Every second — node-cron supports a 6-field "seconds" form when the
      // expression has 6 fields. Use that for fast test verification.
      registerJob('test-drift-patrol', '* * * * * *', async () => {
        tickCount += 1;
      });
      expect(getRegisteredJobs()).toContain('test-drift-patrol');

      // Wait ~2.5s — should observe at least 2 ticks.
      await new Promise((r) => setTimeout(r, 2500));
      stopScheduler();
      expect(tickCount).toBeGreaterThanOrEqual(2);
      expect(getRegisteredJobs()).toEqual([]);
    });

    it('a throwing runner does not unhandled-reject; subsequent ticks proceed', async () => {
      let attempted = 0;
      registerJob('test-throwing-job', '* * * * * *', async () => {
        attempted += 1;
        throw new Error('intentional');
      });
      await new Promise((r) => setTimeout(r, 2200));
      stopScheduler();
      expect(attempted).toBeGreaterThanOrEqual(2);
    });
  });
});
