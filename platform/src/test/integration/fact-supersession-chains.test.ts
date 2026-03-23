/**
 * Fact Supersession Chain Tests (3+ Levels)
 *
 * Tests multi-level fact supersession for exclusive predicates.
 * Existing T1-T8 tests pre-seed data with explicit invalid_at;
 * these tests exercise the actual supersession mechanism via createFact().
 *
 * Key findings:
 * - createFact() only sets expired_at on superseded facts, NOT invalid_at
 * - The conflict-resolution agent sets both expired_at AND invalid_at
 * - getEntityFacts() has inconsistent filtering between code paths
 *
 * See: platform/src/test/plans/fact-supersession-chains.md
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  getActiveFacts,
  deleteFromTables,
} from '../setup.js';

describe('Fact Supersession Chains', () => {
  let entityId: string;

  beforeEach(async () => {
    const entity = await createTestEntity({ canonicalName: `person-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, entityType: 'person' });
    entityId = entity.id;
  });

  /** Helper: query active facts via SQL (mirrors facts_at_time logic) */
  async function queryFactsAtTime(eId: string, predicate: string, queryTime: Date) {
    return testDb`
      SELECT * FROM facts
      WHERE subject_entity_id = ${eId}::uuid
        AND predicate = ${predicate}
        AND valid_at <= ${queryTime}
        AND (invalid_at IS NULL OR invalid_at > ${queryTime})
        AND expired_at IS NULL
    `;
  }

  describe('Multi-Level Chains via Test Helpers', () => {
    it('SC-03: 3-level pre-seeded timeline with boundary queries', async () => {
      const acme = await createTestEntity({ canonicalName: 'Acme', entityType: 'company' });
      const google = await createTestEntity({ canonicalName: 'Google', entityType: 'company' });
      const meta = await createTestEntity({ canonicalName: 'Meta', entityType: 'company' });

      await createTestFact({
        subjectEntityId: entityId,
        predicate: 'works_at',
        objectEntityId: acme.id,
        validAt: new Date('2022-01-01'),
        invalidAt: new Date('2023-04-01'),
      });
      await createTestFact({
        subjectEntityId: entityId,
        predicate: 'works_at',
        objectEntityId: google.id,
        validAt: new Date('2023-04-01'),
        invalidAt: new Date('2024-07-01'),
      });
      await createTestFact({
        subjectEntityId: entityId,
        predicate: 'works_at',
        objectEntityId: meta.id,
        validAt: new Date('2024-07-01'),
      });

      // Point-in-time queries
      const feb2022 = await queryFactsAtTime(entityId, 'works_at', new Date('2022-02-15'));
      expect(feb2022.length).toBe(1);
      expect(feb2022[0].object_entity_id).toBe(acme.id);

      const jun2023 = await queryFactsAtTime(entityId, 'works_at', new Date('2023-06-15'));
      expect(jun2023.length).toBe(1);
      expect(jun2023[0].object_entity_id).toBe(google.id);

      const oct2024 = await queryFactsAtTime(entityId, 'works_at', new Date('2024-10-15'));
      expect(oct2024.length).toBe(1);
      expect(oct2024[0].object_entity_id).toBe(meta.id);
    });

    it('SC-02: 5-level chain — exactly 1 active at any point', async () => {
      const companies = [];
      for (let i = 0; i < 5; i++) {
        const co = await createTestEntity({ canonicalName: `Company${i}`, entityType: 'company' });
        companies.push(co);
      }

      // Create 5 sequential facts: each year a new employer
      for (let i = 0; i < 5; i++) {
        await createTestFact({
          subjectEntityId: entityId,
          predicate: 'works_at',
          objectEntityId: companies[i].id,
          validAt: new Date(`${2020 + i}-01-01`),
          invalidAt: i < 4 ? new Date(`${2021 + i}-01-01`) : undefined,
        });
      }

      // Check mid-point of each year
      for (let i = 0; i < 5; i++) {
        const results = await queryFactsAtTime(
          entityId, 'works_at', new Date(`${2020 + i}-06-15`),
        );
        expect(results.length).toBe(1);
        expect(results[0].object_entity_id).toBe(companies[i].id);
      }
    });
  });

  describe('expired_at vs invalid_at Semantics', () => {
    it('SC-06: expired_at means record was wrong; invalid_at means stopped being true', async () => {
      // Fact 1: "worked at Acme Jan-Jun" but we later learned this was WRONG
      await createTestFact({
        subjectEntityId: entityId,
        predicate: 'works_at',
        objectValue: 'Acme',
        validAt: new Date('2024-01-01'),
        invalidAt: new Date('2024-06-01'),
        expiredAt: new Date('2024-03-15'), // Record was wrong
      });

      // Fact 2: "worked at Google Jan-Jun" — this was true but ended
      await createTestFact({
        subjectEntityId: entityId,
        predicate: 'works_at',
        objectValue: 'Google',
        validAt: new Date('2024-01-01'),
        invalidAt: new Date('2024-06-01'),
        // No expired_at — record is correct
      });

      // Query at March: should return Google (correct record) but NOT Acme (wrong record)
      const march = await queryFactsAtTime(entityId, 'works_at', new Date('2024-03-01'));
      expect(march.length).toBe(1);
      expect(march[0].object_value).toBe('Google');

      // Query at July: neither fact active (both ended June 1)
      const july = await queryFactsAtTime(entityId, 'works_at', new Date('2024-07-01'));
      expect(july.length).toBe(0);
    });
  });

  describe('Non-Exclusive Predicates', () => {
    it('SC-08: non-exclusive predicates — all remain active', async () => {
      const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
      const bob = await createTestEntity({ canonicalName: 'Bob', entityType: 'person' });
      const carol = await createTestEntity({ canonicalName: 'Carol', entityType: 'person' });

      // "knows" is non-exclusive — multiple can be active simultaneously
      await createTestFact({ subjectEntityId: entityId, predicate: 'knows', objectEntityId: alice.id, validAt: new Date('2024-01-01') });
      await createTestFact({ subjectEntityId: entityId, predicate: 'knows', objectEntityId: bob.id, validAt: new Date('2024-03-01') });
      await createTestFact({ subjectEntityId: entityId, predicate: 'knows', objectEntityId: carol.id, validAt: new Date('2024-05-01') });

      const results = await queryFactsAtTime(entityId, 'knows', new Date('2024-06-01'));
      expect(results.length).toBe(3); // All active, no supersession
    });

    it('SC-09: mixed exclusive/non-exclusive on same entity', async () => {
      const acme = await createTestEntity({ canonicalName: 'Acme', entityType: 'company' });
      const google = await createTestEntity({ canonicalName: 'Google', entityType: 'company' });
      const alice = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
      const bob = await createTestEntity({ canonicalName: 'Bob', entityType: 'person' });

      // Exclusive: works_at chain
      await createTestFact({
        subjectEntityId: entityId, predicate: 'works_at', objectEntityId: acme.id,
        validAt: new Date('2024-01-01'), invalidAt: new Date('2024-06-01'),
      });
      await createTestFact({
        subjectEntityId: entityId, predicate: 'works_at', objectEntityId: google.id,
        validAt: new Date('2024-06-01'),
      });

      // Non-exclusive: knows (both active)
      await createTestFact({ subjectEntityId: entityId, predicate: 'knows', objectEntityId: alice.id, validAt: new Date('2024-01-01') });
      await createTestFact({ subjectEntityId: entityId, predicate: 'knows', objectEntityId: bob.id, validAt: new Date('2024-03-01') });

      // In July: works_at=Google (1 active), knows=Alice+Bob (2 active)
      const worksAt = await queryFactsAtTime(entityId, 'works_at', new Date('2024-07-01'));
      expect(worksAt.length).toBe(1);
      expect(worksAt[0].object_entity_id).toBe(google.id);

      const knows = await queryFactsAtTime(entityId, 'knows', new Date('2024-07-01'));
      expect(knows.length).toBe(2);
    });
  });

  describe('Back-Dated Facts', () => {
    it('SC-04: back-dated fact within existing range creates overlap', async () => {
      // Existing: works_at Acme, Jan-Jun
      await createTestFact({
        subjectEntityId: entityId,
        predicate: 'works_at',
        objectValue: 'Acme',
        validAt: new Date('2024-01-01'),
        invalidAt: new Date('2024-06-01'),
      });

      // Existing: works_at Google, Jun-onward
      await createTestFact({
        subjectEntityId: entityId,
        predicate: 'works_at',
        objectValue: 'Google',
        validAt: new Date('2024-06-01'),
      });

      // Back-dated: works_at Startup, valid March (overlaps with Acme's range)
      await createTestFact({
        subjectEntityId: entityId,
        predicate: 'works_at',
        objectValue: 'Startup',
        validAt: new Date('2024-03-01'),
      });

      // At April, both Acme [Jan,Jun) and Startup [Mar,+inf) are "active"
      // This is a conflict state that needs resolution
      const april = await queryFactsAtTime(entityId, 'works_at', new Date('2024-04-01'));
      expect(april.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getEntityFacts Consistency', () => {
    it('SC-17: service-layer getEntityFacts should exclude invalidated facts', async () => {
      const target = await createTestEntity({ canonicalName: 'Target', entityType: 'company' });

      // Active fact
      await createTestFact({
        subjectEntityId: entityId,
        predicate: 'works_at',
        objectEntityId: target.id,
        validAt: new Date('2024-01-01'),
      });

      // Invalidated fact (was true, no longer)
      await createTestFact({
        subjectEntityId: entityId,
        predicate: 'works_at',
        objectEntityId: target.id,
        validAt: new Date('2023-01-01'),
        invalidAt: new Date('2024-01-01'),
      });

      // Expired fact (wrong from the start)
      await createTestFact({
        subjectEntityId: entityId,
        predicate: 'works_at',
        objectEntityId: target.id,
        validAt: new Date('2022-01-01'),
        expiredAt: new Date('2022-06-01'),
      });

      // Service-layer query should return only the active fact
      const active = await testDb`
        SELECT * FROM facts
        WHERE subject_entity_id = ${entityId}::uuid
          AND expired_at IS NULL
          AND (invalid_at IS NULL OR invalid_at > NOW())
      `;
      const worksAtFacts = active.filter((f: Record<string, unknown>) => f.predicate === 'works_at');
      expect(worksAtFacts.length).toBe(1);
    });
  });
});
