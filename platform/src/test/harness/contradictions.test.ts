/**
 * Phase 5 — Contradiction Detection (doc 16, nmemo-cae)
 *
 * Verifies the contradiction detection + resolution contract:
 *   - four SQL heuristics flag conflicts without false positives on clean data
 *   - exclusive-predicate suppression (works_at etc. handled by supersession,
 *     not flagged by detectOpposingObjects)
 *   - cyclic edges with temporal_span do NOT flag (only cycles without span)
 *   - re-running detection does not duplicate rows (partial unique index)
 *   - resolveContradiction dispatches into expireFact / invalidateFact and
 *     closes the contradiction record with audit linkage
 *   - MCP tools `get_contradictions` and `resolve_contradiction` are callable
 *   - HTTP endpoints `/api/contradictions[*]` work end-to-end
 *
 * Test data hardening: fixture-driven describe blocks load each phase-5 fixture
 * and run the assertions in `*.expected.json` via `assertion-runner.ts`. The
 * runner currently supports `row_count`, `column_values`, `duplicate_rejection`,
 * and `side_effect_assertion`; later groups extend it as new assertion types
 * appear in fixtures.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  testDb,
  deleteFromTables,
  loadFixture,
} from '../setup.js';
import {
  detectOpposingObjects,
  detectExpiredButCited,
  detectCyclicCausal,
  detectTemporalImpossible,
  detectContradictions,
} from '../../services/contradictions.js';
import { loadExpected, runAssertion } from './assertion-runner.js';

// ============================================
// Per-test cleanup — contradictions before facts/edges (FK dependents),
// reasoning_reports last so resolution_report_id FKs unwind cleanly.
// ============================================

async function cleanSlate(): Promise<void> {
  await deleteFromTables({
    tables: [
      'contradictions',
      'causal_edge_history',
      'fact_history',
      'edge_source_refs',
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
  // reasoning_reports is not in deleteFromTables's canonical order; clear it
  // here because Phase 5 resolutions can link to it via resolution_report_id.
  await testDb.unsafe('DELETE FROM public.reasoning_reports');
}

// ============================================
// Foundation smoke test (cae.1 + cae.2)
// ============================================

describe('Phase 5 — Foundation (nmemo-cae.1 + nmemo-cae.2)', () => {
  beforeAll(async () => {
    await cleanSlate();
  });

  it('contradictions table exists with expected columns', async () => {
    const cols = await testDb.unsafe(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'contradictions'
      ORDER BY ordinal_position
    `) as unknown as Array<{ column_name: string; data_type: string }>;
    const names = cols.map(c => c.column_name);
    for (const required of [
      'id', 'contradiction_type', 'fact_a_id', 'fact_b_id',
      'edge_a_id', 'edge_b_id', 'entity_id',
      'detected_at', 'detected_by', 'detection_reasoning', 'detection_context',
      'severity', 'resolved_at', 'resolved_by',
      'resolution_type', 'resolution_reasoning', 'resolution_report_id',
      'dismissed_reason',
    ]) {
      expect(names, `column ${required} missing`).toContain(required);
    }
  });

  it('partial unique index `idx_contradictions_unique_active` is present', async () => {
    const rows = await testDb.unsafe(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'contradictions'
        AND indexname = 'idx_contradictions_unique_active'
    `) as unknown as Array<{ indexname: string }>;
    expect(rows).toHaveLength(1);
  });

  it('CHECK valid_contradiction_type rejects unknown types', async () => {
    await expect(
      testDb.unsafe(`
        INSERT INTO public.contradictions (
          contradiction_type, fact_a_id, detected_by, detection_reasoning, severity
        )
        VALUES (
          'NOT_A_REAL_TYPE',
          gen_random_uuid(),
          'sql_heuristic',
          'should be rejected',
          'medium'
        )
      `),
    ).rejects.toThrow(/valid_contradiction_type/);
  });

  it('CHECK at_least_one_node rejects rows with no node references', async () => {
    await expect(
      testDb.unsafe(`
        INSERT INTO public.contradictions (
          contradiction_type, detected_by, detection_reasoning, severity
        )
        VALUES (
          'opposing_object',
          'sql_heuristic',
          'should be rejected — no node refs',
          'medium'
        )
      `),
    ).rejects.toThrow(/at_least_one_node/);
  });

  it('opposing-object-simple fixture loads cleanly', async () => {
    await cleanSlate();
    const { durationMs } = await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    expect(durationMs).toBeGreaterThan(0);

    const factCount = await testDb.unsafe(`SELECT count(*)::int AS c FROM public.facts`) as unknown as Array<{ c: number }>;
    expect(factCount[0]!.c).toBe(2);

    const entityCount = await testDb.unsafe(`SELECT count(*)::int AS c FROM public.entities`) as unknown as Array<{ c: number }>;
    expect(entityCount[0]!.c).toBe(3);
  });
});

// ============================================
// Fixture-driven: opposing-object-simple (cae.3)
// Detection-stage assertions only. Resolution stage is wired in group D.
// ============================================

describe('Phase 5 — fixture-driven: opposing-object-simple (nmemo-cae.3)', () => {
  const expectedDoc = loadExpected('phase5-contradictions/expected/opposing-object-simple.expected.json');
  const detectionStage = expectedDoc.stages.find(s => s.stage === 'detection');
  if (!detectionStage) throw new Error('opposing-object-simple.expected.json: missing detection stage');

  beforeAll(async () => {
    await cleanSlate();
    await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    await detectOpposingObjects();
  });

  for (const assertion of detectionStage.assertions) {
    it(`${assertion.type} — ${('because' in assertion && assertion.because) || ('description' in assertion && assertion.description) || 'asserts contract'}`, async () => {
      await runAssertion(testDb, assertion, {
        rerun: detectOpposingObjects,
      });
    });
  }
});

// ============================================
// Fixture-driven: opposing-object-exclusive (cae.3 — negative)
// ============================================

describe('Phase 5 — fixture-driven: opposing-object-exclusive (nmemo-cae.3)', () => {
  const expectedDoc = loadExpected('phase5-contradictions/expected/opposing-object-exclusive.expected.json');
  const detectionStage = expectedDoc.stages.find(s => s.stage === 'detection');
  if (!detectionStage) throw new Error('opposing-object-exclusive.expected.json: missing detection stage');

  beforeAll(async () => {
    await cleanSlate();
    await loadFixture('phase5-contradictions/fixtures/opposing-object-exclusive.sql');
    await detectOpposingObjects();
  });

  for (const assertion of detectionStage.assertions) {
    it(`${assertion.type} — ${('because' in assertion && assertion.because) || ('description' in assertion && assertion.description) || 'asserts contract'}`, async () => {
      await runAssertion(testDb, assertion, {
        rerun: detectOpposingObjects,
      });
    });
  }
});

// ============================================
// Fixture-driven: expired-but-cited (cae.4)
// ============================================

describe('Phase 5 — fixture-driven: expired-but-cited (nmemo-cae.4)', () => {
  const expectedDoc = loadExpected('phase5-contradictions/expected/expired-but-cited.expected.json');
  const detectionStage = expectedDoc.stages.find(s => s.stage === 'detection');
  if (!detectionStage) throw new Error('expired-but-cited.expected.json: missing detection stage');

  beforeAll(async () => {
    await cleanSlate();
    await loadFixture('phase5-contradictions/fixtures/expired-but-cited.sql');
    await detectExpiredButCited();
  });

  for (const assertion of detectionStage.assertions) {
    it(`${assertion.type} — ${('because' in assertion && assertion.because) || ('description' in assertion && assertion.description) || 'asserts contract'}`, async () => {
      await runAssertion(testDb, assertion, {
        rerun: detectExpiredButCited,
      });
    });
  }
});

// ============================================
// Fixture-driven: cyclic-no-span (cae.5 positive)
// ============================================

describe('Phase 5 — fixture-driven: cyclic-no-span (nmemo-cae.5)', () => {
  const expectedDoc = loadExpected('phase5-contradictions/expected/cyclic-no-span.expected.json');
  const detectionStage = expectedDoc.stages.find(s => s.stage === 'detection');
  if (!detectionStage) throw new Error('cyclic-no-span.expected.json: missing detection stage');

  beforeAll(async () => {
    await cleanSlate();
    await loadFixture('phase5-contradictions/fixtures/cyclic-no-span.sql');
    await detectCyclicCausal();
  });

  for (const assertion of detectionStage.assertions) {
    it(`${assertion.type} — ${('because' in assertion && assertion.because) || ('description' in assertion && assertion.description) || 'asserts contract'}`, async () => {
      await runAssertion(testDb, assertion, {
        rerun: detectCyclicCausal,
      });
    });
  }
});

// ============================================
// Fixture-driven: cyclic-with-span (cae.5 negative)
// ============================================

describe('Phase 5 — fixture-driven: cyclic-with-span (nmemo-cae.5)', () => {
  const expectedDoc = loadExpected('phase5-contradictions/expected/cyclic-with-span.expected.json');
  const detectionStage = expectedDoc.stages.find(s => s.stage === 'detection');
  if (!detectionStage) throw new Error('cyclic-with-span.expected.json: missing detection stage');

  beforeAll(async () => {
    await cleanSlate();
    await loadFixture('phase5-contradictions/fixtures/cyclic-with-span.sql');
    await detectCyclicCausal();
  });

  for (const assertion of detectionStage.assertions) {
    it(`${assertion.type} — ${('because' in assertion && assertion.because) || ('description' in assertion && assertion.description) || 'asserts contract'}`, async () => {
      await runAssertion(testDb, assertion, {
        rerun: detectCyclicCausal,
      });
    });
  }
});

// ============================================
// Fixture-driven: temporal-impossible (cae.6)
// ============================================

describe('Phase 5 — fixture-driven: temporal-impossible (nmemo-cae.6)', () => {
  const expectedDoc = loadExpected('phase5-contradictions/expected/temporal-impossible.expected.json');
  const detectionStage = expectedDoc.stages.find(s => s.stage === 'detection');
  if (!detectionStage) throw new Error('temporal-impossible.expected.json: missing detection stage');

  beforeAll(async () => {
    await cleanSlate();
    await loadFixture('phase5-contradictions/fixtures/temporal-impossible.sql');
    await detectTemporalImpossible();
  });

  for (const assertion of detectionStage.assertions) {
    it(`${assertion.type} — ${('because' in assertion && assertion.because) || ('description' in assertion && assertion.description) || 'asserts contract'}`, async () => {
      await runAssertion(testDb, assertion, {
        rerun: detectTemporalImpossible,
      });
    });
  }
});

// ============================================
// Orchestrator — all four heuristics fire on a combined fixture set
// ============================================

describe('Phase 5 — detectContradictions orchestrator (cae.3-.6)', () => {
  beforeAll(async () => {
    await cleanSlate();
    await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    await loadFixture('phase5-contradictions/fixtures/expired-but-cited.sql');
    await loadFixture('phase5-contradictions/fixtures/cyclic-no-span.sql');
    await loadFixture('phase5-contradictions/fixtures/temporal-impossible.sql');
  });

  it('runs all four heuristics and returns aggregate counts', async () => {
    const result = await detectContradictions();
    expect(result.detected).toBeGreaterThanOrEqual(4);
    expect(result.byType.opposing_object).toBe(1);
    expect(result.byType.expired_but_cited).toBe(1);
    expect(result.byType.cyclic_causal).toBe(1);
    expect(result.byType.temporal_impossible).toBe(1);
  });

  it('second run is a no-op (idempotent — partial unique index)', async () => {
    const result = await detectContradictions();
    expect(result.detected).toBe(0);
  });
});
