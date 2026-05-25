/**
 * Integration: resolve_candidate tool handler against the live test DB.
 *
 * Regression guard for bead nmemo-2yv.60. The merge_candidates.resolution
 * CHECK constraint historically allowed ('merge', 'alias', 'link', 'distinct')
 * while every other layer (the resolve_candidate tool enum, the
 * reconciliation_agent prompt, doc 27) used 'same_as'. Every same_as
 * resolution therefore silently failed at the DB on the candidate-close
 * step, leaving the originating row in 'staging' forever.
 *
 * Migration 018_resolution_enum_align.sql swaps 'alias' for 'same_as' in
 * the CHECK. This test asserts the handler succeeds AND the row reaches
 * its expected post-resolution shape (status='resolved', resolution='same_as',
 * detection_count unchanged at 1).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity } from '../setup.js';
import { handleToolCall } from '../../services/causal-agent.js';

describe('resolve_candidate integration (nmemo-2yv.60)', () => {
  let entityAId: string;
  let entityBId: string;
  let candidateId: string;

  beforeAll(async () => {
    const a = await createTestEntity({
      canonicalName: 'Resolve-Candidate Test Entity A',
      entityType: 'person',
    });
    const b = await createTestEntity({
      canonicalName: 'Resolve-Candidate Test Entity B',
      entityType: 'person',
    });
    // Honour the merge_candidates_ordering CHECK (entity_a_id < entity_b_id)
    // by sorting the two UUIDs textually before inserting.
    [entityAId, entityBId] = [a.id, b.id].sort();

    const [row] = await testDb<Array<{ id: string }>>`
      INSERT INTO public.merge_candidates (
        entity_a_id, entity_b_id, combined_score, status
      )
      VALUES (
        ${entityAId}::uuid, ${entityBId}::uuid, 0.85, 'candidate'
      )
      RETURNING id
    `;
    candidateId = row!.id;
  });

  afterAll(async () => {
    await testDb`DELETE FROM public.merge_candidates WHERE id = ${candidateId}::uuid`.catch(() => {});
    await testDb`DELETE FROM public.entities WHERE id IN (${entityAId}::uuid, ${entityBId}::uuid)`.catch(() => {});
  });

  it('resolution=same_as closes the candidate row without violating valid_resolution', async () => {
    const raw = await handleToolCall('resolve_candidate', {
      candidate_id: candidateId,
      resolution: 'same_as',
      reasoning: 'Two surface forms of the same underlying entity (regression test for valid_resolution CHECK alignment)',
    });

    const parsed = JSON.parse(raw);
    expect(parsed.resolved).toBe(true);

    const [after] = await testDb<Array<{
      status: string;
      resolution: string;
      detection_count: number;
      resolution_reasoning: string;
    }>>`
      SELECT status, resolution, detection_count, resolution_reasoning
      FROM public.merge_candidates
      WHERE id = ${candidateId}::uuid
    `;
    expect(after).toBeDefined();
    expect(after!.status).toBe('resolved');
    expect(after!.resolution).toBe('same_as');
    expect(after!.detection_count).toBe(1);
    expect(after!.resolution_reasoning).toContain('regression test');
  });
});
