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

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  testDb,
  deleteFromTables,
  loadFixture,
  createTestEntity,
  createTestFact,
  getFact,
} from '../setup.js';
import {
  detectOpposingObjects,
  detectExpiredButCited,
  detectCyclicCausal,
  detectTemporalImpossible,
  detectContradictions,
  resolveContradiction,
  getContradictions,
  getContradictionById,
} from '../../services/contradictions.js';
import { loadExpected, runAssertion } from './assertion-runner.js';
import { handleToolCall } from '../../services/causal-agent.js';
import { app } from '../../index.js';

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

// ============================================
// Resolver dispatch (cae.7)
// ============================================

describe('Phase 5 — resolveContradiction dispatcher (nmemo-cae.7)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  /**
   * Seed an opposing-object contradiction by creating two facts on the same
   * (subject, predicate) with different objects, then running detection.
   * Returns the contradiction id + both fact ids so each resolver branch can
   * verify its specific side effect.
   */
  async function seedOpposingContradiction(): Promise<{
    contradictionId: string;
    factAId: string;
    factBId: string;
  }> {
    const subj = await createTestEntity({ canonicalName: 'Resolver-Subject', entityType: 'person' });
    const objA = await createTestEntity({ canonicalName: 'Resolver-Object-A', entityType: 'person' });
    const objB = await createTestEntity({ canonicalName: 'Resolver-Object-B', entityType: 'person' });
    await createTestFact({ subjectEntityId: subj.id, predicate: 'knows', objectEntityId: objA.id, confidence: 0.9 });
    await createTestFact({ subjectEntityId: subj.id, predicate: 'knows', objectEntityId: objB.id, confidence: 0.9 });
    await detectOpposingObjects();
    const rows = await getContradictions({ contradictionType: 'opposing_object', unresolvedOnly: true });
    if (rows.length !== 1) {
      throw new Error(`seedOpposingContradiction: expected 1 contradiction, got ${rows.length}`);
    }
    return {
      contradictionId: rows[0]!.id,
      factAId: rows[0]!.factAId!,
      factBId: rows[0]!.factBId!,
    };
  }

  it('expire_a expires fact_a and closes the contradiction', async () => {
    const { contradictionId, factAId, factBId } = await seedOpposingContradiction();
    await resolveContradiction({
      contradictionId,
      resolutionType: 'expire_a',
      resolutionReasoning: 'Fact A had a stale source from 2019; B is supported by 2026 evidence.',
      actor: 'reasoning_agent',
    });

    const factA = await getFact(factAId) as { expired_at: Date | null } | null;
    const factB = await getFact(factBId) as { expired_at: Date | null } | null;
    expect(factA?.expired_at).not.toBeNull();
    expect(factB?.expired_at).toBeNull();

    const c = await getContradictionById(contradictionId);
    expect(c?.resolvedAt).not.toBeNull();
    expect(c?.resolutionType).toBe('expire_a');
    expect(c?.resolvedBy).toBe('reasoning_agent');
  });

  it('expire_b expires fact_b only', async () => {
    const { contradictionId, factAId, factBId } = await seedOpposingContradiction();
    await resolveContradiction({
      contradictionId,
      resolutionType: 'expire_b',
      resolutionReasoning: 'Fact B contradicts the canonical source; expiring it preserves A.',
      actor: 'reasoning_agent',
    });
    const factA = await getFact(factAId) as { expired_at: Date | null } | null;
    const factB = await getFact(factBId) as { expired_at: Date | null } | null;
    expect(factA?.expired_at).toBeNull();
    expect(factB?.expired_at).not.toBeNull();
  });

  it('expire_both expires both facts', async () => {
    const { contradictionId, factAId, factBId } = await seedOpposingContradiction();
    await resolveContradiction({
      contradictionId,
      resolutionType: 'expire_both',
      resolutionReasoning: 'Both facts depend on a now-debunked source; expiring both is correct.',
      actor: 'reasoning_agent',
    });
    const factA = await getFact(factAId) as { expired_at: Date | null } | null;
    const factB = await getFact(factBId) as { expired_at: Date | null } | null;
    expect(factA?.expired_at).not.toBeNull();
    expect(factB?.expired_at).not.toBeNull();
  });

  it('invalidate_a sets fact_a invalid_at without expiring', async () => {
    const { contradictionId, factAId } = await seedOpposingContradiction();
    await resolveContradiction({
      contradictionId,
      resolutionType: 'invalidate_a',
      resolutionReasoning: 'Fact A was true once but is no longer; invalidating preserves history.',
      actor: 'reasoning_agent',
    });
    const factA = await getFact(factAId) as { expired_at: Date | null; invalid_at: Date | null } | null;
    expect(factA?.invalid_at).not.toBeNull();
    expect(factA?.expired_at).toBeNull();
  });

  it('both_valid closes without mutating either fact', async () => {
    const { contradictionId, factAId, factBId } = await seedOpposingContradiction();
    await resolveContradiction({
      contradictionId,
      resolutionType: 'both_valid',
      resolutionReasoning: 'Person can know multiple people simultaneously; non-exclusive predicate.',
      actor: 'reasoning_agent',
    });
    const factA = await getFact(factAId) as { expired_at: Date | null } | null;
    const factB = await getFact(factBId) as { expired_at: Date | null } | null;
    expect(factA?.expired_at).toBeNull();
    expect(factB?.expired_at).toBeNull();

    const c = await getContradictionById(contradictionId);
    expect(c?.resolvedAt).not.toBeNull();
    expect(c?.resolutionType).toBe('both_valid');
  });

  it('dismissed closes with dismissed_reason captured', async () => {
    const { contradictionId } = await seedOpposingContradiction();
    await resolveContradiction({
      contradictionId,
      resolutionType: 'dismissed',
      resolutionReasoning: 'False positive — the predicate semantics here permit multiple objects.',
      actor: 'reasoning_agent',
      dismissedReason: 'predicate-semantics-permits-multi',
    });
    const c = await getContradictionById(contradictionId);
    expect(c?.resolvedAt).not.toBeNull();
    expect(c?.resolutionType).toBe('dismissed');
    expect(c?.dismissedReason).toBe('predicate-semantics-permits-multi');
  });

  it('reconcile closes without mutation', async () => {
    const { contradictionId, factAId, factBId } = await seedOpposingContradiction();
    await resolveContradiction({
      contradictionId,
      resolutionType: 'reconcile',
      resolutionReasoning: 'Both facts represent valid temporal windows; reconciliation noted.',
      actor: 'reasoning_agent',
    });
    const factA = await getFact(factAId) as { expired_at: Date | null } | null;
    const factB = await getFact(factBId) as { expired_at: Date | null } | null;
    expect(factA?.expired_at).toBeNull();
    expect(factB?.expired_at).toBeNull();

    const c = await getContradictionById(contradictionId);
    expect(c?.resolutionType).toBe('reconcile');
  });

  it('rejects reasoning shorter than 20 characters', async () => {
    const { contradictionId } = await seedOpposingContradiction();
    await expect(
      resolveContradiction({
        contradictionId,
        resolutionType: 'both_valid',
        resolutionReasoning: 'too short',
        actor: 'reasoning_agent',
      }),
    ).rejects.toThrow(/reasoning must be at least/);
  });

  it('rejects already-resolved contradictions', async () => {
    const { contradictionId } = await seedOpposingContradiction();
    await resolveContradiction({
      contradictionId,
      resolutionType: 'both_valid',
      resolutionReasoning: 'First resolution: both facts represent valid relationships.',
      actor: 'reasoning_agent',
    });
    await expect(
      resolveContradiction({
        contradictionId,
        resolutionType: 'expire_a',
        resolutionReasoning: 'Second resolution: actually expire fact_a after re-evaluation.',
        actor: 'reasoning_agent',
      }),
    ).rejects.toThrow(/already resolved/);
  });

  it('records resolution_report_id when supplied', async () => {
    const { contradictionId } = await seedOpposingContradiction();
    const reportRows = await testDb.unsafe(`
      INSERT INTO public.reasoning_reports (mode, report)
      VALUES ('patrol', 'test-report-for-contradiction-resolution')
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const reportId = reportRows[0]!.id;

    await resolveContradiction({
      contradictionId,
      resolutionType: 'both_valid',
      resolutionReasoning: 'Linked to a reasoning report — provenance check.',
      actor: 'reasoning_agent',
      reasoningReportId: reportId,
    });
    const c = await getContradictionById(contradictionId);
    expect(c?.resolutionReportId).toBe(reportId);
  });
});

// ============================================
// Edge-mutating resolution (nmemo-2yv.37)
//
// expire_edge_a / expire_edge_b / expire_both_edges route resolveContradiction
// into expireCausalEdge, closing the broken edge in the graph rather than
// only marking the contradiction "resolved" while the cycle / temporal
// inversion / expired-citation edge persists.
// ============================================

describe('Phase 5 — edge-mutating resolution (nmemo-2yv.37)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  async function getCyclicContradiction(): Promise<{ id: string; edgeAId: string; edgeBId: string }> {
    await loadFixture('phase5-contradictions/fixtures/cyclic-no-span.sql');
    await detectCyclicCausal();
    const [row] = await getContradictions({ unresolvedOnly: true, contradictionType: 'cyclic_causal' });
    if (!row?.edgeAId || !row.edgeBId) {
      throw new Error('expected cyclic_causal contradiction with both edge ids populated');
    }
    return { id: row.id, edgeAId: row.edgeAId, edgeBId: row.edgeBId };
  }

  async function readEdge(edgeId: string): Promise<{ expired_at: Date | null }> {
    const rows = await testDb<Array<{ expired_at: Date | null }>>`
      SELECT expired_at FROM public.causal_edges WHERE id = ${edgeId}::uuid
    `;
    if (!rows[0]) throw new Error(`causal_edge ${edgeId} not found`);
    return rows[0];
  }

  async function readEdgeHistory(edgeId: string, eventType: string): Promise<number> {
    const [count] = await testDb<Array<{ n: string }>>`
      SELECT COUNT(*)::text AS n
      FROM public.causal_edge_history
      WHERE edge_id = ${edgeId}::uuid AND event_type = ${eventType}
    `;
    return Number(count!.n);
  }

  it('cyclic_causal + expire_edge_a expires edge A and closes the contradiction', async () => {
    const { id, edgeAId, edgeBId } = await getCyclicContradiction();

    await resolveContradiction({
      contradictionId: id,
      resolutionType: 'expire_edge_a',
      resolutionReasoning: 'Edge A is the weaker of the two cycle edges (lower-confidence reasoning); expiring it breaks the cycle.',
      actor: 'reasoning_agent',
    });

    expect((await readEdge(edgeAId)).expired_at).not.toBeNull();
    expect((await readEdge(edgeBId)).expired_at).toBeNull();
    expect(await readEdgeHistory(edgeAId, 'expired')).toBe(1);

    const c = await getContradictionById(id);
    expect(c?.resolvedAt).not.toBeNull();
    expect(c?.resolutionType).toBe('expire_edge_a');
  });

  it('cyclic_causal + expire_edge_b expires edge B and closes the contradiction', async () => {
    const { id, edgeAId, edgeBId } = await getCyclicContradiction();

    await resolveContradiction({
      contradictionId: id,
      resolutionType: 'expire_edge_b',
      resolutionReasoning: 'Edge B contradicts the established temporal direction; expiring it breaks the cycle.',
      actor: 'reasoning_agent',
    });

    expect((await readEdge(edgeBId)).expired_at).not.toBeNull();
    expect((await readEdge(edgeAId)).expired_at).toBeNull();
    expect(await readEdgeHistory(edgeBId, 'expired')).toBe(1);

    const c = await getContradictionById(id);
    expect(c?.resolutionType).toBe('expire_edge_b');
  });

  it('cyclic_causal + expire_both_edges expires both edges and closes the contradiction', async () => {
    const { id, edgeAId, edgeBId } = await getCyclicContradiction();

    await resolveContradiction({
      contradictionId: id,
      resolutionType: 'expire_both_edges',
      resolutionReasoning: 'Both edges depend on the same now-debunked source; expiring both is the only honest close.',
      actor: 'reasoning_agent',
    });

    expect((await readEdge(edgeAId)).expired_at).not.toBeNull();
    expect((await readEdge(edgeBId)).expired_at).not.toBeNull();
    expect(await readEdgeHistory(edgeAId, 'expired')).toBe(1);
    expect(await readEdgeHistory(edgeBId, 'expired')).toBe(1);

    const c = await getContradictionById(id);
    expect(c?.resolutionType).toBe('expire_both_edges');
  });

  it('temporal_impossible + expire_edge_a expires the offending edge', async () => {
    await loadFixture('phase5-contradictions/fixtures/temporal-impossible.sql');
    await detectTemporalImpossible();
    const [row] = await getContradictions({ unresolvedOnly: true, contradictionType: 'temporal_impossible' });
    if (!row?.edgeAId) throw new Error('expected temporal_impossible with edge_a_id populated');

    await resolveContradiction({
      contradictionId: row.id,
      resolutionType: 'expire_edge_a',
      resolutionReasoning: 'Edge cause.occurred_at is after effect.occurred_at — causal direction reversed; expire.',
      actor: 'reasoning_agent',
    });

    expect((await readEdge(row.edgeAId)).expired_at).not.toBeNull();
    expect(await readEdgeHistory(row.edgeAId, 'expired')).toBe(1);
    const c = await getContradictionById(row.id);
    expect(c?.resolutionType).toBe('expire_edge_a');
  });

  it('expired_but_cited + expire_edge_a expires the citing edge', async () => {
    await loadFixture('phase5-contradictions/fixtures/expired-but-cited.sql');
    await detectExpiredButCited();
    const [row] = await getContradictions({ unresolvedOnly: true, contradictionType: 'expired_but_cited' });
    if (!row?.edgeAId) throw new Error('expected expired_but_cited with edge_a_id populated');

    await resolveContradiction({
      contradictionId: row.id,
      resolutionType: 'expire_edge_a',
      resolutionReasoning: 'Edge cites a fact that has been expired; the citation is no longer sound — expire the edge.',
      actor: 'reasoning_agent',
    });

    expect((await readEdge(row.edgeAId)).expired_at).not.toBeNull();
    expect(await readEdgeHistory(row.edgeAId, 'expired')).toBe(1);
    const c = await getContradictionById(row.id);
    expect(c?.resolutionType).toBe('expire_edge_a');
  });

  it('expire_edge_a throws when contradiction has no edge_a_id (e.g. opposing_object)', async () => {
    await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    await detectOpposingObjects();
    const [row] = await getContradictions({ unresolvedOnly: true, contradictionType: 'opposing_object' });
    if (!row) throw new Error('expected opposing_object contradiction');

    await expect(
      resolveContradiction({
        contradictionId: row.id,
        resolutionType: 'expire_edge_a',
        resolutionReasoning: 'Attempting an edge resolution on a fact-based contradiction should be rejected.',
        actor: 'reasoning_agent',
      }),
    ).rejects.toThrow(/expire_edge_a requires edge_a_id/);
  });
});

// ============================================
// Concurrent resolution (nmemo-2yv.38)
//
// resolveContradiction wraps SELECT FOR UPDATE + side effects + closing
// UPDATE in a single transaction so two simultaneous callers serialise on
// the row lock: exactly one wins, the other observes resolved_at set and
// throws "already resolved". Pre-fix shape did a SELECT, JS check, side
// effects, and a final unconditional UPDATE — two concurrent callers
// could both pass the resolvedAt check, both run their side effects, and
// race their UPDATEs (silent double-mutation).
// ============================================

describe('Phase 5 — concurrent resolution serialisation (nmemo-2yv.38)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  async function seedOpposingForRace(): Promise<{ contradictionId: string; factAId: string; factBId: string }> {
    await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    await detectOpposingObjects();
    const [row] = await getContradictions({ unresolvedOnly: true, contradictionType: 'opposing_object' });
    if (!row?.factAId || !row.factBId) {
      throw new Error('seed: expected opposing_object contradiction with both fact ids');
    }
    return { contradictionId: row.id, factAId: row.factAId, factBId: row.factBId };
  }

  async function readFactExpiry(factId: string): Promise<Date | null> {
    const rows = await testDb<Array<{ expired_at: Date | null }>>`
      SELECT expired_at FROM public.facts WHERE id = ${factId}::uuid
    `;
    return rows[0]?.expired_at ?? null;
  }

  it('two simultaneous expire_a / expire_b calls — exactly one wins, exactly one fact expired', async () => {
    const { contradictionId, factAId, factBId } = await seedOpposingForRace();

    const callA = resolveContradiction({
      contradictionId,
      resolutionType: 'expire_a',
      resolutionReasoning: 'Concurrent caller A picks expire_a — fact A is the superseded one.',
      actor: 'reasoning_agent',
    });
    const callB = resolveContradiction({
      contradictionId,
      resolutionType: 'expire_b',
      resolutionReasoning: 'Concurrent caller B picks expire_b — fact B is the superseded one.',
      actor: 'user',
    });

    const results = await Promise.allSettled([callA, callB]);
    const succeeded = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];

    expect(succeeded.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String(rejected[0]!.reason)).toMatch(/already resolved/);

    // Exactly one fact ended up expired — the one chosen by the winning caller.
    const aExpired = await readFactExpiry(factAId);
    const bExpired = await readFactExpiry(factBId);
    const expiredCount = (aExpired ? 1 : 0) + (bExpired ? 1 : 0);
    expect(expiredCount).toBe(1);

    const c = await getContradictionById(contradictionId);
    expect(c?.resolvedAt).not.toBeNull();
    expect(c?.resolutionType).toMatch(/^expire_(a|b)$/);
  });

  it('second call after first commits — observes resolved_at and throws', async () => {
    const { contradictionId } = await seedOpposingForRace();

    await resolveContradiction({
      contradictionId,
      resolutionType: 'expire_a',
      resolutionReasoning: 'First caller resolves — second should now reject.',
      actor: 'reasoning_agent',
    });

    await expect(
      resolveContradiction({
        contradictionId,
        resolutionType: 'expire_b',
        resolutionReasoning: 'Second caller arrives after commit — should observe resolved_at and reject.',
        actor: 'user',
      }),
    ).rejects.toThrow(/already resolved/);
  });
});

// ============================================
// MCP tool dispatch (cae.8)
// ============================================

describe('Phase 5 — MCP tools (nmemo-cae.8)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('get_contradictions returns unresolved rows by default', async () => {
    await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    await detectOpposingObjects();

    const result = await handleToolCall('get_contradictions', {}, { agent: 'reasoning_agent' });
    const parsed = JSON.parse(result) as { contradictions: Array<{ contradictionType: string }> };
    expect(parsed.contradictions.length).toBeGreaterThanOrEqual(1);
    expect(parsed.contradictions[0]!.contradictionType).toBe('opposing_object');
  });

  it('get_contradictions filters by contradiction_type', async () => {
    await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    await loadFixture('phase5-contradictions/fixtures/temporal-impossible.sql');
    await detectContradictions();

    const result = await handleToolCall(
      'get_contradictions',
      { contradiction_type: 'temporal_impossible' },
      { agent: 'reasoning_agent' },
    );
    const parsed = JSON.parse(result) as { contradictions: Array<{ contradictionType: string }> };
    expect(parsed.contradictions.every(c => c.contradictionType === 'temporal_impossible')).toBe(true);
  });

  it('resolve_contradiction via MCP applies the resolution', async () => {
    await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    await detectOpposingObjects();
    const [row] = await getContradictions({ unresolvedOnly: true });

    const result = await handleToolCall(
      'resolve_contradiction',
      {
        contradiction_id: row!.id,
        resolution_type: 'both_valid',
        resolution_reasoning: 'Non-exclusive predicate — both facts can stand simultaneously.',
      },
      { agent: 'reasoning_agent' },
    );
    expect(JSON.parse(result)).toEqual({ resolved: true });

    const c = await getContradictionById(row!.id);
    expect(c?.resolvedAt).not.toBeNull();
    expect(c?.resolvedBy).toBe('reasoning_agent');
  });
});

// ============================================
// HTTP endpoints (cae.10)
// ============================================

describe('Phase 5 — HTTP endpoints (nmemo-cae.10)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('POST /api/contradictions/detect runs the orchestrator', async () => {
    await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    const res = await app.request('/api/contradictions/detect', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      triggered: boolean;
      detected: number;
      byType: Record<string, number>;
      durationMs: number;
    };
    expect(body.triggered).toBe(true);
    expect(body.detected).toBeGreaterThanOrEqual(1);
    expect(body.byType.opposing_object).toBeGreaterThanOrEqual(1);
    expect(typeof body.durationMs).toBe('number');
  });

  it('GET /api/contradictions returns the unresolved list by default', async () => {
    await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    await detectOpposingObjects();

    const res = await app.request('/api/contradictions');
    expect(res.status).toBe(200);
    const body = await res.json() as { contradictions: Array<{ contradictionType: string }> };
    expect(body.contradictions.length).toBeGreaterThanOrEqual(1);
    expect(body.contradictions[0]!.contradictionType).toBe('opposing_object');
  });

  it('GET /api/contradictions filters by ?type=', async () => {
    await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    await loadFixture('phase5-contradictions/fixtures/temporal-impossible.sql');
    await detectContradictions();

    const res = await app.request('/api/contradictions?type=temporal_impossible');
    const body = await res.json() as { contradictions: Array<{ contradictionType: string }> };
    expect(body.contradictions.every(c => c.contradictionType === 'temporal_impossible')).toBe(true);
  });

  it('POST /api/contradictions/:id/resolve closes a contradiction', async () => {
    await loadFixture('phase5-contradictions/fixtures/opposing-object-simple.sql');
    await detectOpposingObjects();
    const [row] = await getContradictions({ unresolvedOnly: true });

    const res = await app.request(`/api/contradictions/${row!.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resolution_type: 'both_valid',
        resolution_reasoning: 'Endpoint round-trip: knows is non-exclusive, both facts stand.',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolved: true });

    const c = await getContradictionById(row!.id);
    expect(c?.resolvedAt).not.toBeNull();
    expect(c?.resolvedBy).toBe('user');
  });

  it('POST /api/contradictions/:id/resolve rejects missing fields with 400', async () => {
    const res = await app.request('/api/contradictions/00000000-0000-0000-0000-000000000000/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { resolved: boolean; error?: string };
    expect(body.resolved).toBe(false);
    expect(body.error).toMatch(/required/);
  });
});

// ============================================
// Adversarial fixtures (cae.13)
// ============================================

describe('Phase 5 — fixture-driven: near-contradiction-temporal (nmemo-cae.13)', () => {
  const expectedDoc = loadExpected('phase5-contradictions/expected/near-contradiction-temporal.expected.json');
  const detectionStage = expectedDoc.stages.find(s => s.stage === 'detection');
  if (!detectionStage) throw new Error('near-contradiction-temporal.expected.json: missing detection stage');

  beforeAll(async () => {
    await cleanSlate();
    await loadFixture('phase5-contradictions/fixtures/near-contradiction-temporal.sql');
    await detectOpposingObjects();
  });

  for (const assertion of detectionStage.assertions) {
    it(`${assertion.type} — ${('because' in assertion && assertion.because) || 'asserts contract'}`, async () => {
      await runAssertion(testDb, assertion, { rerun: detectOpposingObjects });
    });
  }
});

describe('Phase 5 — adversarial flood (nmemo-cae.13)', () => {
  beforeAll(async () => {
    await cleanSlate();
    await loadFixture('phase5-contradictions/fixtures/adversarial-flood.sql');
  });

  it('detectOpposingObjects flags exactly 100 contradictions on a 100-pair flood', async () => {
    await detectOpposingObjects();
    const rows = await getContradictions({ contradictionType: 'opposing_object', unresolvedOnly: true, limit: 1000 });
    expect(rows.length).toBe(100);
  });

  it('flood detection completes in <2s (design-doc target)', async () => {
    // Pre-clear flagged rows so we time the heuristic, not the dedup short-circuit.
    await testDb.unsafe('DELETE FROM public.contradictions');
    const start = Date.now();
    await detectOpposingObjects();
    const elapsed = Date.now() - start;
    console.log(`[bench] flood detectOpposingObjects elapsed=${elapsed}ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});
