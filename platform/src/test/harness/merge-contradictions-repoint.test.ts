/**
 * Integration: merge_entities() re-points contradictions through a merge.
 *
 * Regression guard for bead nmemo-2yv.63. mig 011 added
 * contradictions.entity_id REFERENCES entities(id) with no ON DELETE
 * clause, so a source entity with any contradictions row caused
 * merge_entities() to fail with an FK violation at its final DELETE.
 *
 * mig 020 rewrites merge_entities() to:
 *   1. Delete source contradictions that would clash with an existing
 *      unresolved target row (same type + same fact/edge tuple).
 *   2. Re-point the rest via UPDATE entity_id = target_id.
 *   3. Then DELETE the source entity — now safe.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';

describe('merge_entities contradictions re-point (nmemo-2yv.63)', () => {
  let sourceId: string;
  let targetId: string;
  let factAId: string;
  let factBId: string;
  let contradictionId: string;

  beforeAll(async () => {
    const source = await createTestEntity({
      canonicalName: 'Merge-Repoint Source',
      entityType: 'person',
    });
    const target = await createTestEntity({
      canonicalName: 'Merge-Repoint Target',
      entityType: 'person',
    });
    sourceId = source.id;
    targetId = target.id;

    const factA = await createTestFact({
      subjectEntityId: sourceId,
      predicate: 'works_at',
      objectValue: 'Acme Corp',
    });
    const factB = await createTestFact({
      subjectEntityId: sourceId,
      predicate: 'works_at',
      objectValue: 'Acme Corporation',
    });
    factAId = factA.id;
    factBId = factB.id;

    const [row] = await testDb<Array<{ id: string }>>`
      INSERT INTO public.contradictions (
        contradiction_type, fact_a_id, fact_b_id, entity_id,
        detected_by, detection_reasoning, severity
      )
      VALUES (
        'opposing_object',
        ${factAId}::uuid, ${factBId}::uuid, ${sourceId}::uuid,
        'sql_heuristic',
        'Two different works_at values for the same subject — regression test for merge_entities re-point of contradictions.',
        'medium'
      )
      RETURNING id
    `;
    contradictionId = row!.id;
  });

  afterAll(async () => {
    await testDb`DELETE FROM public.contradictions WHERE id = ${contradictionId}::uuid`.catch(() => {});
    await testDb`DELETE FROM public.facts WHERE id IN (${factAId}::uuid, ${factBId}::uuid)`.catch(() => {});
    await testDb`DELETE FROM public.entities WHERE id IN (${sourceId}::uuid, ${targetId}::uuid)`.catch(() => {});
  });

  it('merge_entities succeeds when source has a contradiction, and the contradiction follows the survivor', async () => {
    const result = await testDb<Array<{ merge_entities: string }>>`
      SELECT merge_entities(${sourceId}::uuid, ${targetId}::uuid, 'regression test', 'auto', 0.99) AS merge_entities
    `;
    expect(result[0]!.merge_entities).toBe(targetId);

    // Contradiction re-pointed to target.
    const [c] = await testDb<Array<{ entity_id: string }>>`
      SELECT entity_id::text AS entity_id FROM public.contradictions WHERE id = ${contradictionId}::uuid
    `;
    expect(c).toBeDefined();
    expect(c!.entity_id).toBe(targetId);

    // Source entity gone.
    const sourceRows = await testDb`
      SELECT 1 FROM public.entities WHERE id = ${sourceId}::uuid
    `;
    expect(sourceRows.length).toBe(0);

    // Target entity still present.
    const targetRows = await testDb`
      SELECT 1 FROM public.entities WHERE id = ${targetId}::uuid
    `;
    expect(targetRows.length).toBe(1);
  });
});
