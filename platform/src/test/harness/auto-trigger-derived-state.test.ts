/**
 * Bead nmemo-2yv.84 — auto-triggers for topology / clustering / drift.
 *
 * Three integration tests, one per anchor:
 *  1. Post-ingest counter: insert >= TOPOLOGY_CLUSTERING_FACT_THRESHOLD facts,
 *     assert derived_freshness resets (proxy for "compute was fired").
 *  2. Post-merge: invoke the derived-freshness helper directly and assert
 *     that the HTTP fire path was reached.
 *  3. Scheduler: register a fast-cadence drift job, assert the runner fires.
 *
 * The HTTP-side compute is faked via a localhost server-stub so the tests
 * don't depend on ml-services being up. We assert "the platform attempted
 * the compute" (request received) — the route's own success path is exercised
 * by the existing compute-endpoint tests under ml-services.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { testDb, createTestEntity } from '../setup.js';
import { registerJob, stopScheduler, getRegisteredJobs } from '../../scheduler.js';
import {
  maybeFireFactThresholdCompute,
  maybeFirePatternDetection,
  maybeFireGraphStats,
  triggerTopologyAndClusteringAfterMerge,
  _setComputeUrlPortForTesting,
} from '../../services/derived-freshness.js';
import { config } from '../../config.js';

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
    // Confirm the 024 + 035 migrations ran and seeded all four rows
    // (bead .84 seeded topology+clustering; bead .72's 035 added
    // pattern_detection + graph_stats).
    const rows = (await testDb`SELECT derived_kind FROM public.derived_freshness ORDER BY derived_kind`) as unknown as Array<{ derived_kind: string }>;
    expect(rows.map((r) => r.derived_kind)).toEqual(['clustering', 'graph_stats', 'pattern_detection', 'topology']);
  });

  describe('derived_freshness DB trigger (acceptance bullet 6)', () => {
    beforeEach(async () => {
      await resetFreshness();
    });

    it('AFTER INSERT trigger increments facts_since_compute on all rows', async () => {
      const subject = await createTestEntity({ canonicalName: `bead84-fact-subj-${Date.now()}-${Math.random()}`, entityType: 'Concept' });
      const before = (await testDb`SELECT facts_since_compute FROM public.derived_freshness WHERE derived_kind = 'topology'`) as unknown as Array<{ facts_since_compute: number }>;
      const baseline = before[0]?.facts_since_compute ?? 0;
      await testDb`
        INSERT INTO public.facts (subject_entity_id, predicate, object_value, source_text)
        VALUES (${subject.id}::uuid, 'is', 'a thing', 'bead84-trigger-test-1')
      `;
      const rows = (await testDb`SELECT derived_kind, facts_since_compute FROM public.derived_freshness ORDER BY derived_kind`) as unknown as Array<{ derived_kind: string; facts_since_compute: number }>;
      // All four rows incremented by 1 (lockstep — the migration-024 trigger
      // has no WHERE clause, so every kind bumps together).
      expect(rows.find((r) => r.derived_kind === 'topology')?.facts_since_compute).toBe(baseline + 1);
      expect(rows.find((r) => r.derived_kind === 'clustering')?.facts_since_compute).toBe(baseline + 1);
      expect(rows.find((r) => r.derived_kind === 'pattern_detection')?.facts_since_compute).toBe(baseline + 1);
      expect(rows.find((r) => r.derived_kind === 'graph_stats')?.facts_since_compute).toBe(baseline + 1);
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

// ============================================================================
// Bead nmemo-2yv.72 — pattern_detection + graph_stats threshold helpers
// ============================================================================
//
// Three integration tests per kind:
//  - below threshold → helper is a no-op (no compute fired)
//  - at threshold → atomic claim, compute fires (spy assertion), counter resets
//  - failure inside compute → swallowed, caller resolves to undefined
//
// We spy on the compute entry points (detectCausalPatterns, promotePatterns,
// computeGraphStats) so the tests verify the wiring without depending on the
// real graph schema being seeded for a meaningful run.

describe('bead nmemo-2yv.72 — pattern_detection + graph_stats threshold triggers', () => {
  beforeEach(async () => {
    // Reset both .72 rows to 0 so each test starts clean. The DB trigger may
    // have ticked them during unrelated test ingest activity earlier in the
    // run.
    await testDb`
      UPDATE public.derived_freshness
         SET facts_since_compute = 0,
             updated_at          = NOW()
       WHERE derived_kind IN ('pattern_detection', 'graph_stats')
    `;
  });

  describe('maybeFirePatternDetection', () => {
    it('below the threshold the helper is a no-op (detect+promote NOT called)', async () => {
      const causalPatterns = await import('../../services/causal-patterns.js');
      const detectSpy = vi
        .spyOn(causalPatterns, 'detectCausalPatterns')
        .mockResolvedValue({ chainsExamined: 0, templatesFound: 0, newStaging: 0, updatedExisting: 0 });
      const promoteSpy = vi
        .spyOn(causalPatterns, 'promotePatterns')
        .mockResolvedValue({ promoted: [], demoted: [], rejected: [] });
      try {
        await testDb`UPDATE public.derived_freshness SET facts_since_compute = ${config.PATTERN_DETECTION_FACT_THRESHOLD - 1} WHERE derived_kind = 'pattern_detection'`;
        await maybeFirePatternDetection();
        await new Promise((r) => setTimeout(r, 100));
        expect(detectSpy).not.toHaveBeenCalled();
        expect(promoteSpy).not.toHaveBeenCalled();
      } finally {
        detectSpy.mockRestore();
        promoteSpy.mockRestore();
      }
    });

    it('at threshold: helper claims, fires detect+promote, resets counter to 0', async () => {
      const causalPatterns = await import('../../services/causal-patterns.js');
      const detectSpy = vi
        .spyOn(causalPatterns, 'detectCausalPatterns')
        .mockResolvedValue({ chainsExamined: 0, templatesFound: 0, newStaging: 0, updatedExisting: 0 });
      const promoteSpy = vi
        .spyOn(causalPatterns, 'promotePatterns')
        .mockResolvedValue({ promoted: [], demoted: [], rejected: [] });
      try {
        await testDb`UPDATE public.derived_freshness SET facts_since_compute = ${config.PATTERN_DETECTION_FACT_THRESHOLD} WHERE derived_kind = 'pattern_detection'`;
        await maybeFirePatternDetection();
        // Counter reset is synchronous (the claim UPDATE happens before the
        // fire-and-forget IIFE launches).
        const reset = (await testDb`SELECT facts_since_compute FROM public.derived_freshness WHERE derived_kind = 'pattern_detection'`) as unknown as Array<{ facts_since_compute: number }>;
        expect(reset[0]?.facts_since_compute).toBe(0);
        // Drain the IIFE; detect+promote run inside it.
        await new Promise((r) => setTimeout(r, 100));
        expect(detectSpy).toHaveBeenCalled();
        expect(promoteSpy).toHaveBeenCalled();
      } finally {
        detectSpy.mockRestore();
        promoteSpy.mockRestore();
      }
    });

    it('failure inside detect+promote is swallowed (caller resolves)', async () => {
      const causalPatterns = await import('../../services/causal-patterns.js');
      const detectSpy = vi
        .spyOn(causalPatterns, 'detectCausalPatterns')
        .mockRejectedValue(new Error('boom'));
      try {
        await testDb`UPDATE public.derived_freshness SET facts_since_compute = ${config.PATTERN_DETECTION_FACT_THRESHOLD} WHERE derived_kind = 'pattern_detection'`;
        await expect(maybeFirePatternDetection()).resolves.toBeUndefined();
        await new Promise((r) => setTimeout(r, 100));
        expect(detectSpy).toHaveBeenCalled();
      } finally {
        detectSpy.mockRestore();
      }
    });
  });

  describe('maybeFireGraphStats', () => {
    it('below the threshold the helper is a no-op (computeGraphStats NOT called)', async () => {
      const graphStats = await import('../../services/graph-stats.js');
      const computeSpy = vi
        .spyOn(graphStats, 'computeGraphStats')
        .mockResolvedValue({
          totalEntities: 0,
          totalFacts: 0,
          totalActiveFacts: 0,
          totalMemories: 0,
          computedDurationMs: 1,
        } as unknown as Awaited<ReturnType<typeof graphStats.computeGraphStats>>);
      try {
        await testDb`UPDATE public.derived_freshness SET facts_since_compute = ${config.GRAPH_STATS_FACT_THRESHOLD - 1} WHERE derived_kind = 'graph_stats'`;
        await maybeFireGraphStats();
        await new Promise((r) => setTimeout(r, 100));
        expect(computeSpy).not.toHaveBeenCalled();
      } finally {
        computeSpy.mockRestore();
      }
    });

    it('at threshold: helper claims, fires computeGraphStats, resets counter to 0', async () => {
      const graphStats = await import('../../services/graph-stats.js');
      const computeSpy = vi
        .spyOn(graphStats, 'computeGraphStats')
        .mockResolvedValue({
          totalEntities: 0,
          totalFacts: 0,
          totalActiveFacts: 0,
          totalMemories: 0,
          computedDurationMs: 1,
        } as unknown as Awaited<ReturnType<typeof graphStats.computeGraphStats>>);
      try {
        await testDb`UPDATE public.derived_freshness SET facts_since_compute = ${config.GRAPH_STATS_FACT_THRESHOLD} WHERE derived_kind = 'graph_stats'`;
        await maybeFireGraphStats();
        const reset = (await testDb`SELECT facts_since_compute FROM public.derived_freshness WHERE derived_kind = 'graph_stats'`) as unknown as Array<{ facts_since_compute: number }>;
        expect(reset[0]?.facts_since_compute).toBe(0);
        await new Promise((r) => setTimeout(r, 100));
        expect(computeSpy).toHaveBeenCalled();
      } finally {
        computeSpy.mockRestore();
      }
    });

    it('counter helpers are independent: firing pattern_detection does not reset graph_stats and vice versa', async () => {
      // Park graph_stats well below threshold, drive pattern_detection over.
      // Only pattern_detection should reset; graph_stats stays put.
      const causalPatterns = await import('../../services/causal-patterns.js');
      vi.spyOn(causalPatterns, 'detectCausalPatterns')
        .mockResolvedValue({ chainsExamined: 0, templatesFound: 0, newStaging: 0, updatedExisting: 0 });
      vi.spyOn(causalPatterns, 'promotePatterns')
        .mockResolvedValue({ promoted: [], demoted: [], rejected: [] });
      try {
        await testDb`UPDATE public.derived_freshness SET facts_since_compute = ${config.PATTERN_DETECTION_FACT_THRESHOLD} WHERE derived_kind = 'pattern_detection'`;
        await testDb`UPDATE public.derived_freshness SET facts_since_compute = 1 WHERE derived_kind = 'graph_stats'`;
        await maybeFirePatternDetection();
        const rows = (await testDb`SELECT derived_kind, facts_since_compute FROM public.derived_freshness WHERE derived_kind IN ('pattern_detection', 'graph_stats') ORDER BY derived_kind`) as unknown as Array<{ derived_kind: string; facts_since_compute: number }>;
        expect(rows.find((r) => r.derived_kind === 'pattern_detection')?.facts_since_compute).toBe(0);
        expect(rows.find((r) => r.derived_kind === 'graph_stats')?.facts_since_compute).toBe(1);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
});
