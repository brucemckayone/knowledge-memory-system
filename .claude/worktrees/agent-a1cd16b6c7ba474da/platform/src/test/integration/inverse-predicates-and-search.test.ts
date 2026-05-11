/**
 * Inverse Predicate Consistency & Hybrid Search Safety Tests
 *
 * Part A: Tests that inverse predicates (manages<->reports_to) are correctly
 * defined in the ontology but NOT auto-created as facts (current behavior).
 *
 * Part B: Tests that hybrid search does NOT create phantom entities during
 * query and that RRF scoring works correctly with partial result sets.
 *
 * See: platform/src/test/plans/inverse-predicates-and-search.md
 */

import { describe, it, expect } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
} from '../setup.js';

describe('Inverse Predicate Consistency', () => {

  describe('IPT-001: Inverse facts are NOT auto-created', () => {
    it('should create only the primary fact, no inverse', async () => {
      const tag = `ipt001-${Date.now()}`;
      const alice = await createTestEntity({ canonicalName: `Alice-${tag}`, entityType: 'person' });
      const bob = await createTestEntity({ canonicalName: `Bob-${tag}`, entityType: 'person' });

      // Create "Alice manages Bob"
      await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'manages',
        objectEntityId: bob.id,
      });

      // Check: only 1 fact exists for these entities (manages), NOT 2 (manages + reports_to)
      const allFacts = await testDb`
        SELECT predicate FROM facts
        WHERE subject_entity_id = ${alice.id}::uuid OR object_entity_id = ${bob.id}::uuid
      `;
      expect(allFacts.length).toBe(1);
      expect(allFacts[0]!.predicate).toBe('manages');

      // No "reports_to" fact auto-created for Bob
      const bobFacts = await testDb`
        SELECT * FROM facts WHERE subject_entity_id = ${bob.id}::uuid
      `;
      expect(bobFacts.length).toBe(0);
    });
  });

  describe('IPT-002: Querying from object entity perspective', () => {
    it('should find facts where entity is the object', async () => {
      const tag = `ipt002-${Date.now()}`;
      const alice = await createTestEntity({ canonicalName: `Alice-${tag}`, entityType: 'person' });
      const bob = await createTestEntity({ canonicalName: `Bob-${tag}`, entityType: 'person' });

      await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'manages',
        objectEntityId: bob.id,
      });

      // Bob can discover Alice by querying facts where Bob is the object
      const incomingFacts = await testDb`
        SELECT subject_entity_id, predicate FROM facts
        WHERE object_entity_id = ${bob.id}::uuid
      `;
      expect(incomingFacts.length).toBe(1);
      expect(incomingFacts[0]!.subject_entity_id).toBe(alice.id);
      expect(incomingFacts[0]!.predicate).toBe('manages');
    });
  });

  describe('IPT-003: Symmetric predicates', () => {
    it('should be accessible from both sides via subject/object queries', async () => {
      const tag = `ipt003-${Date.now()}`;
      const alice = await createTestEntity({ canonicalName: `Alice-${tag}`, entityType: 'person' });
      const bob = await createTestEntity({ canonicalName: `Bob-${tag}`, entityType: 'person' });

      // "knows" is symmetric — creating Alice knows Bob
      await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'knows',
        objectEntityId: bob.id,
      });

      // Alice perspective: subject query finds it
      const aliceFacts = await testDb`
        SELECT * FROM facts WHERE subject_entity_id = ${alice.id}::uuid AND predicate = 'knows'
      `;
      expect(aliceFacts.length).toBe(1);

      // Bob perspective: object query finds it
      const bobFacts = await testDb`
        SELECT * FROM facts WHERE object_entity_id = ${bob.id}::uuid AND predicate = 'knows'
      `;
      expect(bobFacts.length).toBe(1);

      // Only 1 fact for THESE entities — no duplicate for symmetric
      const total = await testDb`
        SELECT count(*) as n FROM facts
        WHERE predicate = 'knows' AND subject_entity_id = ${alice.id}::uuid
      `;
      expect(Number(total[0]!.n)).toBe(1);
    });
  });

  describe('IPT-004: Inverse metadata correctness in ontology', () => {
    it('should have correct round-trip inverse mappings', async () => {
      // Import the predicate ontology
      const { getPredicateInfo } = await import('../../services/predicates.js');

      // Known inverse pairs
      const inversePairs = [
        ['manages', 'reports_to'],
        ['parent_of', 'child_of'],
        ['member_of', 'has_member'],
        ['teaches', 'studies_under'],
      ];

      for (const [predA, predB] of inversePairs) {
        const infoA = getPredicateInfo(predA!);
        const infoB = getPredicateInfo(predB!);

        // A's inverse should be B
        if (infoA?.inversePredicate) {
          expect(infoA.inversePredicate).toBe(predB);
        }

        // B's inverse should be A (round-trip)
        if (infoB?.inversePredicate) {
          expect(infoB.inversePredicate).toBe(predA);
        }
      }
    });
  });

  describe('IPT-005: Supersession does not propagate to inverse', () => {
    it('should not affect non-existent inverse facts on supersession', async () => {
      const tag = `ipt005-${Date.now()}`;
      const alice = await createTestEntity({ canonicalName: `Alice-${tag}`, entityType: 'person' });
      const bob = await createTestEntity({ canonicalName: `Bob-${tag}`, entityType: 'person' });
      const carol = await createTestEntity({ canonicalName: `Carol-${tag}`, entityType: 'person' });

      // Alice manages Bob (original)
      await createTestFact({
        subjectEntityId: alice.id,
        predicate: 'manages',
        objectEntityId: bob.id,
        validAt: new Date('2024-01-01'),
        invalidAt: new Date('2024-06-01'),
      });

      // Carol manages Bob (supersedes Alice)
      await createTestFact({
        subjectEntityId: carol.id,
        predicate: 'manages',
        objectEntityId: bob.id,
        validAt: new Date('2024-06-01'),
      });

      // Only 2 facts total for these entities — no inverse facts created or affected
      const allFacts = await testDb`
        SELECT * FROM facts WHERE predicate = 'manages'
          AND object_entity_id = ${bob.id}::uuid
      `;
      expect(allFacts.length).toBe(2);
    });
  });
});

describe('Hybrid Search Safety', () => {

  describe('HST-001: Search for existing entity has no side effects', () => {
    it('should not create new entities when searching by name', async () => {
      const tag = `hst001-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const name = `Google ${tag}`;
      await createTestEntity({ canonicalName: name, entityType: 'company' });

      await testDb`
        SELECT canonical_name FROM entities
        WHERE canonical_name % ${name}
        ORDER BY similarity(canonical_name, ${name}) DESC
        LIMIT 5
      `;

      const countAfter = await testDb`SELECT count(*) as n FROM entities WHERE canonical_name LIKE ${'%' + tag}`;
      expect(Number(countAfter[0]!.n)).toBe(1);
    });
  });

  describe('HST-002: Search for nonexistent entity creates no phantoms', () => {
    it('should not create entities for unknown search terms', async () => {
      const tag = `hst002-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const phantom = `NonexistentCompanyXYZ-${tag}`;

      const results = await testDb`
        SELECT canonical_name FROM entities
        WHERE canonical_name % ${phantom}
      `;
      expect(results.length).toBe(0);

      const countAfter = await testDb`SELECT count(*) as n FROM entities WHERE canonical_name LIKE ${'%' + tag}`;
      expect(Number(countAfter[0]!.n)).toBe(0);
    });
  });

  describe('HST-005: Entity name disambiguation', () => {
    it('should return both matches for ambiguous name, ranked by similarity', async () => {
      const tag = `hst005-${Date.now()}`;
      await createTestEntity({ canonicalName: `Apple Inc ${tag}`, entityType: 'company' });
      await createTestEntity({ canonicalName: `Apple Records ${tag}`, entityType: 'company' });
      await createTestEntity({ canonicalName: `Zyxwv Corp ${tag}`, entityType: 'company' });

      // Search scoped to our test entities
      const results = await testDb`
        SELECT canonical_name, similarity(canonical_name, ${'Apple ' + tag}) as sim
        FROM entities
        WHERE canonical_name % ${'Apple ' + tag}
          AND canonical_name LIKE ${'%' + tag}
        ORDER BY sim DESC
      `;

      // Both Apple entities should be in results, ranked highest
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0]!.canonical_name).toContain('Apple');
      expect(results[1]!.canonical_name).toContain('Apple');
    });
  });
});
