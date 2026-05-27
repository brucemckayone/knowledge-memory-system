/**
 * Bead nmemo-d1r.7 — scheduled source-refs drift patrol.
 *
 * Phase 3 (doc 14, nmemo-d1r) shipped edge_source_refs as a reverse-lookup
 * index over causal_edges.source_references (JSONB authoritative). All wired
 * mutation paths keep them in step today, but a future un-instrumented path
 * could silently desync the index — at which point findEdgesCitingReference()
 * returns false negatives without any user-visible failure (see doc
 * 14 §drift-detection and the adversarial fixture
 * src/test/data/phase3-source-refs/fixtures/drift-detected.sql).
 *
 * The patrol is a monthly DB-only watchdog registered in src/scheduler.ts.
 * It runs the canonical drift-count query and surfaces drift > 0 as a
 * structured warn log. No HTTP fire, no compute side-effects.
 *
 * Tests:
 *   1. checkSourceRefsDrift returns 0 on a clean graph (no drift introduced).
 *   2. checkSourceRefsDrift returns >0 against the drift-detected fixture.
 *   3. runSourceRefsDriftPatrol emits a console.warn when drift > 0.
 *   4. runSourceRefsDriftPatrol does NOT warn when drift = 0 (info-log only).
 *   5. registerJob('source-refs-drift-patrol', ...) ticks the runner on cadence.
 *
 * Mirrors the shape of auto-trigger-reasoning-patrol.test.ts (bead .71).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadFixture, deleteFromTables } from '../setup.js';
import {
  registerJob,
  stopScheduler,
  getRegisteredJobs,
  runSourceRefsDriftPatrol,
  checkSourceRefsDrift,
} from '../../scheduler.js';

function spyMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c: unknown[]) => String(c[0]));
}

async function cleanSlate(): Promise<void> {
  // edge_source_refs CASCADEs from causal_edges; deleting causal_edges first
  // sweeps the index. Match the ordered list used by source-refs-index.test.ts.
  await deleteFromTables({
    tables: [
      'causal_edge_history',
      'fact_history',
      'causal_edges',
      'causal_events',
      'memory_entities',
      'entity_aliases',
      'facts',
      'entity_merges',
      'entities',
    ],
    acknowledgeGlobal: true,
  });
}

describe('bead nmemo-d1r.7 — source-refs drift patrol auto-trigger', () => {
  describe('checkSourceRefsDrift (the alert query)', () => {
    beforeEach(async () => {
      await cleanSlate();
    });

    it('returns 0 on an empty graph (no edges = no drift)', async () => {
      const signal = await checkSourceRefsDrift();
      expect(signal.driftCount).toBe(0);
      expect(signal.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns >0 against the drift-detected fixture', async () => {
      await loadFixture('phase3-source-refs/fixtures/drift-detected.sql');
      const signal = await checkSourceRefsDrift();
      // The fixture seeds one JSONB ref without an index row by design.
      expect(signal.driftCount).toBe(1);
    });
  });

  describe('runSourceRefsDriftPatrol (the alert side)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      await cleanSlate();
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('logs at info level when drift = 0 (no warn)', async () => {
      await runSourceRefsDriftPatrol();
      // No warn — the patrol ticked cleanly. The info log carries the ok marker.
      expect(warnSpy).not.toHaveBeenCalled();
      expect(
        spyMessages(logSpy).some((m) => m.includes('source-refs-drift-patrol') && m.includes('drift=0')),
      ).toBe(true);
    });

    it('warns when drift > 0 (the alert condition)', async () => {
      await loadFixture('phase3-source-refs/fixtures/drift-detected.sql');
      await runSourceRefsDriftPatrol();
      // Patrol surfaces drift via a warn, not an exception.
      expect(warnSpy).toHaveBeenCalled();
      expect(
        spyMessages(warnSpy).some(
          (m) => m.includes('source-refs-drift-patrol') && m.includes('DRIFT DETECTED'),
        ),
      ).toBe(true);
    });
  });

  describe('scheduler integration — cadence', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      await cleanSlate();
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      stopScheduler();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('registerJob + runSourceRefsDriftPatrol ticks on cadence', async () => {
      // 6-field "every second" form for fast verification — production uses
      // the 5-field monthly form via resolveSourceRefsDriftCron(); the
      // registration shape is identical.
      registerJob('test-source-refs-drift-patrol', '* * * * * *', runSourceRefsDriftPatrol);
      expect(getRegisteredJobs()).toContain('test-source-refs-drift-patrol');

      // Wait ~2.5s — expect at least 2 ticks. Graph is clean (cleanSlate
      // ran in beforeEach) so each tick lands as an info-level drift=0 log.
      await new Promise((r) => setTimeout(r, 2500));
      stopScheduler();

      const okTicks = spyMessages(logSpy).filter(
        (m) => m.includes('source-refs-drift-patrol') && m.includes('drift=0'),
      );
      expect(okTicks.length).toBeGreaterThanOrEqual(2);
      // And no warn on a clean graph.
      const warnsAboutDrift = spyMessages(warnSpy).filter(
        (m) => m.includes('source-refs-drift-patrol') && m.includes('DRIFT DETECTED'),
      );
      expect(warnsAboutDrift).toHaveLength(0);
    });
  });
});
