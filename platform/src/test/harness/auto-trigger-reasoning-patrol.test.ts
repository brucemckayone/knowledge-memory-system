/**
 * Bead nmemo-2yv.71 — auto-trigger for the reasoning patrol.
 *
 * The patrol now ticks on REASONING_PATROL_CRON / REASONING_PATROL_INTERVAL_MIN
 * via src/scheduler.ts, gated on entity_meta freshness so the Claude Code
 * subprocess only spawns when the graph has actually moved since the last
 * pass.
 *
 * Tests:
 *   1. Freshness gate fires when last_mentioned_at is newer than the
 *      reasoned-side anchor (max of entity_meta.last_reasoned_at +
 *      reasoning_reports.created_at).
 *   2. Freshness gate skips when no mention has landed since the last pass.
 *   3. Scheduler integration — registerJob('reasoning-patrol', ...) drives
 *      runReasoningPatrol on cadence; the runner hits POST /api/reason when
 *      the gate fires; subsequent ticks proceed even after a freshness skip.
 *
 * Mirrors the shape of auto-trigger-derived-state.test.ts (bead .84). The
 * HTTP-side /api/reason is faked via a localhost stub so the test doesn't
 * depend on ml-services or the Claude Code CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { testDb, createTestEntity } from '../setup.js';
import {
  registerJob,
  stopScheduler,
  getRegisteredJobs,
  runReasoningPatrol,
  checkReasoningFreshness,
  _setSchedulerPortForTesting,
} from '../../scheduler.js';

interface StubServer {
  server: Server;
  port: number;
  requests: Array<{ path: string; method: string }>;
  close: () => Promise<void>;
}

async function startReasonStubServer(): Promise<StubServer> {
  const requests: Array<{ path: string; method: string }> = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', method: req.method ?? '' });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ triggered: true, result: 'stub-ok', durationMs: 1 }));
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

/**
 * Clean slate for the freshness gate. The gate reads three rollups across
 * the whole DB (max(last_mentioned_at), max(last_reasoned_at),
 * max(reasoning_reports.created_at)); to make the test deterministic we
 * NULL out the rollup columns across all entity_meta rows and wipe
 * reasoning_reports. We don't TRUNCATE entity_meta because the FK CASCADE
 * would take every entity with it — destructive for sibling test data.
 *
 * NULL'ing the columns is safe: the gate treats both anchors as either
 * absent (cold-start → first-ever-patrol path) or filled, never coercing
 * a NULL to 0.
 */
async function wipeReasoningAnchors(): Promise<void> {
  await testDb`UPDATE public.entity_meta SET last_mentioned_at = NULL, last_reasoned_at = NULL`;
  await testDb`DELETE FROM public.reasoning_reports`;
}

describe('bead nmemo-2yv.71 — reasoning patrol auto-trigger', () => {
  describe('freshness gate (acceptance bullet 5)', () => {
    beforeEach(async () => {
      await wipeReasoningAnchors();
    });

    it('skips when entity_meta is empty (cold start)', async () => {
      const signal = await checkReasoningFreshness();
      expect(signal.fresh).toBe(false);
      expect(signal.reason).toContain('no mentions');
    });

    it('fires on first-ever patrol when entity has mentions but no prior reasoning anchor', async () => {
      const subject = await createTestEntity({
        canonicalName: `bead71-fresh-${Date.now()}-${Math.random()}`,
        entityType: 'Concept',
      });
      const now = new Date().toISOString();
      await testDb`
        INSERT INTO public.entity_meta (entity_id, last_mentioned_at, last_reasoned_at)
        VALUES (${subject.id}::uuid, ${now}::timestamptz, NULL)
        ON CONFLICT (entity_id) DO UPDATE SET last_mentioned_at = EXCLUDED.last_mentioned_at, last_reasoned_at = NULL
      `;
      const signal = await checkReasoningFreshness();
      expect(signal.fresh).toBe(true);
      expect(signal.reason).toContain('first-ever patrol');
    });

    it('fires when last_mentioned_at is newer than max(last_reasoned_at, reasoning_reports.created_at)', async () => {
      const subject = await createTestEntity({
        canonicalName: `bead71-fresh-newer-${Date.now()}-${Math.random()}`,
        entityType: 'Concept',
      });
      const oldTs = new Date(Date.now() - 60_000).toISOString();
      const newTs = new Date().toISOString();
      // Old reasoning anchor.
      await testDb`
        INSERT INTO public.entity_meta (entity_id, last_mentioned_at, last_reasoned_at)
        VALUES (${subject.id}::uuid, ${newTs}::timestamptz, ${oldTs}::timestamptz)
        ON CONFLICT (entity_id) DO UPDATE
          SET last_mentioned_at = EXCLUDED.last_mentioned_at,
              last_reasoned_at  = EXCLUDED.last_reasoned_at
      `;
      // Older reasoning_reports anchor.
      await testDb`
        INSERT INTO public.reasoning_reports (mode, report, created_at)
        VALUES ('patrol', 'old-report', ${oldTs}::timestamptz)
      `;
      const signal = await checkReasoningFreshness();
      expect(signal.fresh).toBe(true);
      expect(signal.reason).toContain('mentions newer than last patrol');
    });

    it('skips when no mention has landed since the last reasoning anchor', async () => {
      const subject = await createTestEntity({
        canonicalName: `bead71-stale-${Date.now()}-${Math.random()}`,
        entityType: 'Concept',
      });
      const oldTs = new Date(Date.now() - 60_000).toISOString();
      const newTs = new Date().toISOString();
      // mentioned-side is OLD, reasoned-side is NEW → skip.
      await testDb`
        INSERT INTO public.entity_meta (entity_id, last_mentioned_at, last_reasoned_at)
        VALUES (${subject.id}::uuid, ${oldTs}::timestamptz, ${newTs}::timestamptz)
        ON CONFLICT (entity_id) DO UPDATE
          SET last_mentioned_at = EXCLUDED.last_mentioned_at,
              last_reasoned_at  = EXCLUDED.last_reasoned_at
      `;
      const signal = await checkReasoningFreshness();
      expect(signal.fresh).toBe(false);
      expect(signal.reason).toContain('no new mentions');
    });

    it('skips when last_mentioned_at equals the reasoned anchor (deterministic boundary)', async () => {
      const subject = await createTestEntity({
        canonicalName: `bead71-equal-${Date.now()}-${Math.random()}`,
        entityType: 'Concept',
      });
      const ts = new Date().toISOString();
      await testDb`
        INSERT INTO public.entity_meta (entity_id, last_mentioned_at, last_reasoned_at)
        VALUES (${subject.id}::uuid, ${ts}::timestamptz, ${ts}::timestamptz)
        ON CONFLICT (entity_id) DO UPDATE
          SET last_mentioned_at = EXCLUDED.last_mentioned_at,
              last_reasoned_at  = EXCLUDED.last_reasoned_at
      `;
      const signal = await checkReasoningFreshness();
      // strict `>`, so equality counts as "not fresh" — guarantees no
      // self-retriggering after a patrol that touched the same entity.
      expect(signal.fresh).toBe(false);
    });
  });

  describe('runReasoningPatrol fires POST /api/reason via stub (acceptance bullet 2)', () => {
    let stub: StubServer;

    beforeEach(async () => {
      stub = await startReasonStubServer();
      _setSchedulerPortForTesting(stub.port);
      await wipeReasoningAnchors();
    });

    afterEach(async () => {
      _setSchedulerPortForTesting(null);
      await stub.close();
    });

    it('fires POST /api/reason when the freshness gate says fresh', async () => {
      const subject = await createTestEntity({
        canonicalName: `bead71-fire-${Date.now()}-${Math.random()}`,
        entityType: 'Concept',
      });
      await testDb`
        INSERT INTO public.entity_meta (entity_id, last_mentioned_at)
        VALUES (${subject.id}::uuid, NOW())
        ON CONFLICT (entity_id) DO UPDATE SET last_mentioned_at = NOW()
      `;
      await runReasoningPatrol();
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.path).toBe('/api/reason');
      expect(stub.requests[0]?.method).toBe('POST');
    });

    it('skips POST /api/reason when the freshness gate says stale', async () => {
      const subject = await createTestEntity({
        canonicalName: `bead71-skip-${Date.now()}-${Math.random()}`,
        entityType: 'Concept',
      });
      // mentioned older than reasoned → stale.
      const oldTs = new Date(Date.now() - 60_000).toISOString();
      await testDb`
        INSERT INTO public.entity_meta (entity_id, last_mentioned_at, last_reasoned_at)
        VALUES (${subject.id}::uuid, ${oldTs}::timestamptz, NOW())
        ON CONFLICT (entity_id) DO UPDATE
          SET last_mentioned_at = EXCLUDED.last_mentioned_at,
              last_reasoned_at  = NOW()
      `;
      await runReasoningPatrol();
      expect(stub.requests).toHaveLength(0);
    });
  });

  describe('scheduler integration — cadence + cooldown (acceptance bullet 6)', () => {
    let stub: StubServer;

    beforeEach(async () => {
      stub = await startReasonStubServer();
      _setSchedulerPortForTesting(stub.port);
      await wipeReasoningAnchors();
    });

    afterEach(async () => {
      stopScheduler();
      _setSchedulerPortForTesting(null);
      await stub.close();
    });

    it('registerJob + runReasoningPatrol fire on cadence; the env-var cadence is the cooldown', async () => {
      // Force the gate to "fresh" so the cadence is the only thing limiting fires.
      const subject = await createTestEntity({
        canonicalName: `bead71-cadence-${Date.now()}-${Math.random()}`,
        entityType: 'Concept',
      });
      await testDb`
        INSERT INTO public.entity_meta (entity_id, last_mentioned_at)
        VALUES (${subject.id}::uuid, NOW())
        ON CONFLICT (entity_id) DO UPDATE SET last_mentioned_at = NOW()
      `;
      // 6-field "every second" form for fast verification — production uses
      // the 5-field minute form via resolveReasoningCron(); the registration
      // shape is identical.
      registerJob('test-reasoning-patrol', '* * * * * *', runReasoningPatrol);
      expect(getRegisteredJobs()).toContain('test-reasoning-patrol');

      // Wait ~2.5s — expect at least 2 fires.
      await new Promise((r) => setTimeout(r, 2500));
      stopScheduler();
      expect(stub.requests.length).toBeGreaterThanOrEqual(2);
      // Every tick hit /api/reason (no spurious calls to other paths).
      for (const req of stub.requests) {
        expect(req.path).toBe('/api/reason');
      }
    });

    it('a freshness skip does not break subsequent ticks (next tick still runs the gate)', async () => {
      // Gate starts stale → no fires.
      const subject = await createTestEntity({
        canonicalName: `bead71-resume-${Date.now()}-${Math.random()}`,
        entityType: 'Concept',
      });
      await testDb`
        INSERT INTO public.entity_meta (entity_id, last_mentioned_at, last_reasoned_at)
        VALUES (${subject.id}::uuid, NOW() - INTERVAL '1 minute', NOW())
        ON CONFLICT (entity_id) DO UPDATE
          SET last_mentioned_at = NOW() - INTERVAL '1 minute',
              last_reasoned_at  = NOW()
      `;
      registerJob('test-reasoning-patrol-resume', '* * * * * *', runReasoningPatrol);
      await new Promise((r) => setTimeout(r, 1500));
      expect(stub.requests).toHaveLength(0);

      // Bump mentioned past reasoned → gate flips to fresh; next tick fires.
      await testDb`
        UPDATE public.entity_meta
           SET last_mentioned_at = NOW() + INTERVAL '1 second'
         WHERE entity_id = ${subject.id}::uuid
      `;
      await new Promise((r) => setTimeout(r, 2000));
      stopScheduler();
      expect(stub.requests.length).toBeGreaterThanOrEqual(1);
    });
  });
});
