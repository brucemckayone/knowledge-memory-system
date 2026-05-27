/**
 * Integration: ON DELETE SET NULL on every FK referencing
 * public.reasoning_reports(id). Regression guard for bead nmemo-2yv.78.
 *
 * Migration 033_reasoning_report_fk_on_delete_set_null.sql replaces the
 * default NO ACTION policy on three FK columns with an explicit
 * ON DELETE SET NULL:
 *   - fact_history.reasoning_report_id          (009_audit_trail.sql:36)
 *   - causal_edge_history.reasoning_report_id   (009_audit_trail.sql:82)
 *   - contradictions.resolution_report_id       (011_contradictions.sql:57)
 *
 * Pattern mirrors trigger-type-check.test.ts (bead nmemo-2yv.69) /
 * reasoning-reports-query-question-check.test.ts (bead nmemo-2yv.74) /
 * candidate-source-check.test.ts (bead nmemo-2yv.93).
 *
 * Acceptance criteria covered:
 *   - pg_constraint reports confdeltype='n' (SET NULL) on all three FKs.
 *   - DELETE FROM reasoning_reports succeeds while a fact_history row
 *     references it; the history row survives with reasoning_report_id=NULL.
 *   - Same behaviour for causal_edge_history.reasoning_report_id.
 *   - Same behaviour for contradictions.resolution_report_id.
 *   - reasoning_reports now lives in deleteFromTables's canonical order
 *     (src/test/setup.ts) — the old contradictions.test.ts hand-DELETE
 *     workaround is no longer needed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  deleteFromTables,
  createTestEntity,
  createTestFact,
} from '../setup.js';
import { recordFactChange, recordEdgeChange } from '../../services/audit.js';
import { createContradiction } from '../../services/contradictions.js';

const TEST_REPORT_MARKER = '[bead-78-test]';

async function cleanSlate(): Promise<void> {
  await deleteFromTables({
    tables: [
      'contradictions',
      'causal_edge_history',
      'fact_history',
      'causal_edges',
      'causal_events',
      'memory_entities',
      'entity_aliases',
      'entity_merges',
      'facts',
      'entities',
    ],
    acknowledgeGlobal: true,
  });
  await testDb`
    DELETE FROM public.reasoning_reports
    WHERE report LIKE ${`${TEST_REPORT_MARKER}%`}
  `.catch(() => {});
}

async function insertReasoningReport(label: string): Promise<string> {
  const rows = await testDb<Array<{ id: string }>>`
    INSERT INTO public.reasoning_reports (mode, report)
    VALUES ('patrol', ${`${TEST_REPORT_MARKER} ${label}`})
    RETURNING id
  `;
  return rows[0]!.id;
}

describe('reasoning_reports FK ON DELETE SET NULL (nmemo-2yv.78)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('pg_constraint reports SET NULL on all three FKs', async () => {
    const rows = await testDb<Array<{
      table_name: string;
      conname: string;
      confdeltype: string;
    }>>`
      SELECT conrelid::regclass::text AS table_name, conname, confdeltype
      FROM pg_constraint
      WHERE contype = 'f'
        AND conrelid IN (
          'public.fact_history'::regclass,
          'public.causal_edge_history'::regclass,
          'public.contradictions'::regclass
        )
        AND pg_get_constraintdef(oid) LIKE '%reasoning_reports%'
      ORDER BY conrelid::regclass::text, conname
    `;

    // confdeltype: 'a' = NO ACTION (default, pre-fix), 'n' = SET NULL (post-fix)
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(
        row.confdeltype,
        `${row.table_name}.${row.conname} should be SET NULL ('n')`,
      ).toBe('n');
    }
    const names = rows.map(r => r.conname).sort();
    expect(names).toEqual([
      'causal_edge_history_reasoning_report_id_fkey',
      'contradictions_resolution_report_id_fkey',
      'fact_history_reasoning_report_id_fkey',
    ]);
  });

  it('DELETE reasoning_reports nulls fact_history.reasoning_report_id but preserves the row', async () => {
    const subj = await createTestEntity({ canonicalName: 'Bead78-Subject', entityType: 'person' });
    const obj = await createTestEntity({ canonicalName: 'Bead78-Object', entityType: 'person' });
    const fact = await createTestFact({
      subjectEntityId: subj.id,
      predicate: 'knows',
      objectEntityId: obj.id,
      confidence: 0.9,
    });
    const reportId = await insertReasoningReport('fact-history-fk');

    const historyId = await recordFactChange({
      factId: fact.id,
      eventType: 'confidence_raised',
      previousConfidence: 0.5,
      newConfidence: 0.9,
      reasoning: 'Bead-78 test: raise confidence with provenance link to a reasoning report.',
      actor: 'reasoning_agent',
      reasoningReportId: reportId,
    });
    expect(historyId).toBeTruthy();

    const beforeRows = await testDb<Array<{ reasoning_report_id: string | null }>>`
      SELECT reasoning_report_id FROM public.fact_history WHERE id = ${historyId}::uuid
    `;
    expect(beforeRows[0]!.reasoning_report_id).toBe(reportId);

    await testDb`DELETE FROM public.reasoning_reports WHERE id = ${reportId}::uuid`;

    const afterRows = await testDb<Array<{ id: string; reasoning_report_id: string | null }>>`
      SELECT id, reasoning_report_id FROM public.fact_history WHERE id = ${historyId}::uuid
    `;
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]!.reasoning_report_id).toBeNull();
  });

  it('DELETE reasoning_reports nulls causal_edge_history.reasoning_report_id but preserves the row', async () => {
    // Need a causal_edge to attach edge_history rows to. The simplest path is
    // a direct INSERT via raw SQL — services/causal expects more wiring than
    // this FK test needs.
    const subj = await createTestEntity({ canonicalName: 'Bead78-EdgeSubject', entityType: 'person' });
    const obj = await createTestEntity({ canonicalName: 'Bead78-EdgeObject', entityType: 'person' });
    const causeRows = await testDb<Array<{ id: string }>>`
      INSERT INTO public.causal_events (subject_entity_id, transition_type, occurred_at)
      VALUES (${subj.id}::uuid, 'created', NOW())
      RETURNING id
    `;
    const effectRows = await testDb<Array<{ id: string }>>`
      INSERT INTO public.causal_events (subject_entity_id, transition_type, occurred_at)
      VALUES (${obj.id}::uuid, 'strengthened', NOW())
      RETURNING id
    `;
    const edgeRows = await testDb<Array<{ id: string }>>`
      INSERT INTO public.causal_edges (
        cause_event_id, effect_event_id, strength,
        extraction_method, reasoning, source_references, initial_strength
      ) VALUES (
        ${causeRows[0]!.id}::uuid,
        ${effectRows[0]!.id}::uuid,
        0.8,
        'manual',
        'Bead-78 edge created to attach an edge_history row with a reasoning_report link.',
        '[]'::jsonb,
        0.5
      )
      RETURNING id
    `;
    const edgeId = edgeRows[0]!.id;

    const reportId = await insertReasoningReport('edge-history-fk');

    const historyId = await recordEdgeChange({
      edgeId,
      eventType: 'strengthened',
      previousStrength: 0.5,
      newStrength: 0.8,
      reasoning: 'Bead-78 test: edge strengthened with provenance link to a reasoning report.',
      actor: 'reasoning_agent',
      reasoningReportId: reportId,
    });
    expect(historyId).toBeTruthy();

    const beforeRows = await testDb<Array<{ reasoning_report_id: string | null }>>`
      SELECT reasoning_report_id FROM public.causal_edge_history WHERE id = ${historyId}::uuid
    `;
    expect(beforeRows[0]!.reasoning_report_id).toBe(reportId);

    await testDb`DELETE FROM public.reasoning_reports WHERE id = ${reportId}::uuid`;

    const afterRows = await testDb<Array<{ id: string; reasoning_report_id: string | null }>>`
      SELECT id, reasoning_report_id FROM public.causal_edge_history WHERE id = ${historyId}::uuid
    `;
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]!.reasoning_report_id).toBeNull();
  });

  it('DELETE reasoning_reports nulls contradictions.resolution_report_id but preserves the row', async () => {
    const entity = await createTestEntity({ canonicalName: 'Bead78-ContradictionSubject', entityType: 'person' });
    const factA = await createTestFact({
      subjectEntityId: entity.id,
      predicate: 'reports_to',
      objectValue: 'Alice',
      confidence: 0.7,
    });
    const factB = await createTestFact({
      subjectEntityId: entity.id,
      predicate: 'reports_to',
      objectValue: 'Bob',
      confidence: 0.7,
    });

    const { id: contradictionId } = await createContradiction({
      contradictionType: 'chain_conflict',
      entityId: entity.id,
      factAId: factA.id,
      factBId: factB.id,
      detectedBy: 'reasoning_agent',
      detectionReasoning: 'Bead-78 seeded contradiction to test resolution_report_id FK ON DELETE SET NULL.',
      severity: 'medium',
    });

    const reportId = await insertReasoningReport('contradiction-resolution-fk');

    // Resolve via direct UPDATE rather than via resolveContradiction so we
    // attach the report without exercising the full resolver dispatch — this
    // test guards the FK behaviour, not the service layer.
    await testDb`
      UPDATE public.contradictions
      SET resolution_report_id = ${reportId}::uuid,
          resolved_at = NOW(),
          resolved_by = 'reasoning_agent',
          resolution_type = 'both_valid',
          resolution_reasoning = 'Bead-78: attaching report only to verify FK behaviour on delete.'
      WHERE id = ${contradictionId}::uuid
    `;

    const beforeRows = await testDb<Array<{ resolution_report_id: string | null }>>`
      SELECT resolution_report_id FROM public.contradictions WHERE id = ${contradictionId}::uuid
    `;
    expect(beforeRows[0]!.resolution_report_id).toBe(reportId);

    await testDb`DELETE FROM public.reasoning_reports WHERE id = ${reportId}::uuid`;

    const afterRows = await testDb<Array<{ id: string; resolution_report_id: string | null }>>`
      SELECT id, resolution_report_id FROM public.contradictions WHERE id = ${contradictionId}::uuid
    `;
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]!.resolution_report_id).toBeNull();
  });
});
