/**
 * Integration: valid_candidate_source CHECK constraint on merge_candidates.
 *
 * Regression guard for bead nmemo-2yv.93. Migration
 * 030_candidate_source_check.sql adds CONSTRAINT valid_candidate_source
 * restricting the column to the two values enumerated in
 * CANDIDATE_SOURCE_VALUES (src/services/enums.ts). Mirrors the
 * RESOLUTION_VALUES canary pattern from bead nmemo-2yv.130
 * (resolve-candidate-integration.test.ts:87).
 *
 * Two assertions:
 *   1. Every literal in CANDIDATE_SOURCE_VALUES is accepted by the CHECK.
 *      Catches future drift where the SSOT module gains a value but the
 *      migration doesn't (or vice versa).
 *   2. A typo'd value (the bug class the bead exists to prevent) is
 *      rejected with a check_violation error. Pins the fail-closed
 *      contract.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { testDb, createTestEntity } from '../setup.js';
import { CANDIDATE_SOURCE_VALUES } from '../../services/enums.js';

describe('valid_candidate_source CHECK (nmemo-2yv.93)', () => {
  const createdCandidateIds: string[] = [];
  const createdEntityIds: string[] = [];

  afterEach(async () => {
    if (createdCandidateIds.length > 0) {
      await testDb`
        DELETE FROM public.merge_candidates
        WHERE id = ANY(${createdCandidateIds}::uuid[])
      `.catch(() => {});
      createdCandidateIds.length = 0;
    }
    if (createdEntityIds.length > 0) {
      await testDb`
        DELETE FROM public.entities
        WHERE id = ANY(${createdEntityIds}::uuid[])
      `.catch(() => {});
      createdEntityIds.length = 0;
    }
  });

  // SSOT canary: every value in CANDIDATE_SOURCE_VALUES must satisfy the
  // CHECK. Catches future drift where the TS tuple and the migration
  // disagree.
  it.each(CANDIDATE_SOURCE_VALUES)(
    'CHECK admits "%s" from CANDIDATE_SOURCE_VALUES (SSOT alignment)',
    async (value) => {
      const a = await createTestEntity({
        canonicalName: `CandidateSource-SSOT-A-${value}`,
        entityType: 'person',
      });
      const b = await createTestEntity({
        canonicalName: `CandidateSource-SSOT-B-${value}`,
        entityType: 'person',
      });
      createdEntityIds.push(a.id, b.id);
      // Honour merge_candidates_ordering CHECK (entity_a_id < entity_b_id).
      const [aId, bId] = [a.id, b.id].sort();

      const rows = await testDb<Array<{ id: string; candidate_source: string }>>`
        INSERT INTO public.merge_candidates (
          entity_a_id, entity_b_id, combined_score, status, candidate_source
        )
        VALUES (
          ${aId!}::uuid, ${bId!}::uuid, 0.85, 'candidate', ${value}
        )
        RETURNING id, candidate_source
      `;
      const inserted = rows[0]!;
      createdCandidateIds.push(inserted.id);
      expect(inserted.candidate_source).toBe(value);
    },
  );

  // Fail-closed: an unknown source string (the bug class the bead exists
  // to prevent — a typo in either writer) is rejected by the CHECK.
  it('CHECK rejects an unknown candidate_source value (fail-closed typo guard)', async () => {
    const a = await createTestEntity({
      canonicalName: 'CandidateSource-Typo-A',
      entityType: 'person',
    });
    const b = await createTestEntity({
      canonicalName: 'CandidateSource-Typo-B',
      entityType: 'person',
    });
    createdEntityIds.push(a.id, b.id);
    const [aId, bId] = [a.id, b.id].sort();

    // A plausible typo: missing the trailing 'r' on 'cross_cluster_generator'.
    await expect(
      testDb`
        INSERT INTO public.merge_candidates (
          entity_a_id, entity_b_id, combined_score, status, candidate_source
        )
        VALUES (
          ${aId!}::uuid, ${bId!}::uuid, 0.85, 'candidate', 'cross_cluster_generato'
        )
      `,
    ).rejects.toThrow(/valid_candidate_source|check constraint/i);
  });
});
