/**
 * Entity Merge Cascade Tests
 *
 * Tests that merging entities correctly re-points all references:
 * facts (subject + object), aliases, memory_entities, graph edges.
 *
 * KNOWN BUG: merge_entities() in 003_entities.sql deletes the source entity
 * BEFORE updating facts. This triggers ON DELETE CASCADE on subject facts
 * (data loss) and ON DELETE SET NULL on object facts (data degradation).
 * Tests EMC-001 and EMC-002 document the EXPECTED correct behavior and
 * will fail until the merge function is fixed.
 *
 * See: platform/src/test/plans/entity-merge-cascade.md
 */

import { describe, it, expect } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  createTestMemoryEntity,
  randomUUID,
} from '../setup.js';

describe('Entity Merge Cascade', () => {
  // No global deleteFromTables — parallel tests share DB.
  // Each test uses unique entity names to avoid interference.

  describe('EMC-001: Facts with merged entity as SUBJECT are re-pointed', () => {
    it('should update subject_entity_id on all facts when source entity is merged', async () => {
      // Setup: entity A (source) with 3 facts as subject
      const entityA = await createTestEntity({ canonicalName: `EntityA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, entityType: 'person' });
      const entityB = await createTestEntity({ canonicalName: `EntityB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, entityType: 'person' });
      const entityC = await createTestEntity({ canonicalName: 'Target Co', entityType: 'company' });

      const f1 = await createTestFact({ subjectEntityId: entityA.id, predicate: 'works_at', objectEntityId: entityC.id });
      const f2 = await createTestFact({ subjectEntityId: entityA.id, predicate: 'knows', objectValue: 'programming' });
      const f3 = await createTestFact({ subjectEntityId: entityA.id, predicate: 'lives_in', objectValue: 'London' });

      // Action: merge A into B
      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;

      // Assert: all 3 facts should now have subject_entity_id = B
      // BUG: Currently CASCADE-deletes these facts instead of re-pointing them
      const facts = await testDb`
        SELECT id, subject_entity_id, predicate FROM facts
        WHERE id IN (${f1.id}::uuid, ${f2.id}::uuid, ${f3.id}::uuid)
      `;

      expect(facts.length).toBe(3); // BUG: returns 0 (facts deleted by CASCADE)
      for (const fact of facts) {
        expect(fact.subject_entity_id).toBe(entityB.id);
      }
    });
  });

  describe('EMC-002: Facts with merged entity as OBJECT are re-pointed', () => {
    it('should update object_entity_id on facts when source entity is the object', async () => {
      // Setup: entity A is the OBJECT of a fact
      const entityA = await createTestEntity({ canonicalName: 'Acme Corp', entityType: 'company' });
      const entityB = await createTestEntity({ canonicalName: 'Acme Inc', entityType: 'company' });
      const person = await createTestEntity({ canonicalName: 'John', entityType: 'person' });

      const fact = await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: entityA.id,
      });

      // Action: merge A into B
      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;

      // Assert: fact should have object_entity_id = B (not NULL)
      // BUG: Currently SET NULL by FK constraint when source deleted
      const result = await testDb`
        SELECT object_entity_id FROM facts WHERE id = ${fact.id}::uuid
      `;

      expect(result.length).toBe(1);
      expect(result[0]!.object_entity_id).toBe(entityB.id); // BUG: returns null
    });
  });

  describe('EMC-003: Aliases consolidated onto target', () => {
    it('should move all aliases from source to target and add source name as alias', async () => {
      const entityA = await createTestEntity({ canonicalName: 'Johnny', entityType: 'person' });
      const entityB = await createTestEntity({ canonicalName: 'John Smith', entityType: 'person' });

      // Add aliases to source
      await testDb`INSERT INTO entity_aliases (entity_id, alias, source) VALUES (${entityA.id}::uuid, 'J', 'test')`;
      await testDb`INSERT INTO entity_aliases (entity_id, alias, source) VALUES (${entityA.id}::uuid, 'John', 'test')`;

      // Add alias to target
      await testDb`INSERT INTO entity_aliases (entity_id, alias, source) VALUES (${entityB.id}::uuid, 'J. Smith', 'test')`;

      // Action
      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;

      // Assert: target should have all aliases
      const aliases = await testDb`
        SELECT alias FROM entity_aliases WHERE entity_id = ${entityB.id}::uuid ORDER BY alias
      `;
      const aliasNames = aliases.map((a) => (a as { alias: string }).alias);

      expect(aliasNames).toContain('J');
      expect(aliasNames).toContain('John');
      expect(aliasNames).toContain('J. Smith');
      expect(aliasNames).toContain('Johnny'); // source canonical name added as alias

      // Source should have no aliases
      const sourceAliases = await testDb`
        SELECT alias FROM entity_aliases WHERE entity_id = ${entityA.id}::uuid
      `;
      expect(sourceAliases.length).toBe(0);
    });
  });

  describe('EMC-004: memory_entities links re-pointed', () => {
    it('should update memory_entities from source to target', async () => {
      const entityA = await createTestEntity({ canonicalName: `EntityA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, entityType: 'person' });
      const entityB = await createTestEntity({ canonicalName: `EntityB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, entityType: 'person' });
      const memoryId = randomUUID();

      await createTestMemoryEntity({
        memoryId,
        entityId: entityA.id,
        mentionText: 'Entity A',
      });

      // Action
      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;

      // Assert
      const links = await testDb`
        SELECT entity_id FROM memory_entities WHERE memory_id = ${memoryId}::uuid
      `;
      expect(links.length).toBe(1);
      expect(links[0]!.entity_id).toBe(entityB.id);
    });

    it('should handle unique constraint when both entities link to same memory', async () => {
      const entityA = await createTestEntity({ canonicalName: `EntityA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, entityType: 'person' });
      const entityB = await createTestEntity({ canonicalName: `EntityB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, entityType: 'person' });
      const memoryId = randomUUID();

      // Both entities linked to same memory
      await createTestMemoryEntity({ memoryId, entityId: entityA.id, mentionText: 'A mention' });
      await createTestMemoryEntity({ memoryId, entityId: entityB.id, mentionText: 'B mention' });

      // Action: should not throw on unique constraint
      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;

      // Assert: only one link to B remains
      const links = await testDb`
        SELECT entity_id FROM memory_entities WHERE memory_id = ${memoryId}::uuid
      `;
      expect(links.length).toBe(1);
      expect(links[0]!.entity_id).toBe(entityB.id);
    });
  });

  describe('EMC-005: entity_merges audit trail', () => {
    it('should record merge in entity_merges table', async () => {
      const entityA = await createTestEntity({ canonicalName: 'Source', entityType: 'person' });
      const entityB = await createTestEntity({ canonicalName: 'Target', entityType: 'person' });

      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;

      const merges = await testDb`
        SELECT source_entity_id, target_entity_id, merged_at
        FROM entity_merges
        WHERE source_entity_id = ${entityA.id}::uuid
      `;

      expect(merges.length).toBe(1);
      expect(merges[0]!.source_entity_id).toBe(entityA.id);
      expect(merges[0]!.target_entity_id).toBe(entityB.id);
      expect(merges[0]!.merged_at).toBeDefined();
    });

    it('should append source ID to target merged_from array', async () => {
      const entityA = await createTestEntity({ canonicalName: 'Source', entityType: 'person' });
      const entityB = await createTestEntity({ canonicalName: 'Target', entityType: 'person' });

      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;

      const target = await testDb`
        SELECT merged_from FROM entities WHERE id = ${entityB.id}::uuid
      `;

      expect(target[0]!.merged_from).toContain(entityA.id);
    });
  });

  describe('EMC-007: Multi-level merge chain (A->B->C)', () => {
    it('should handle transitive merge: facts from A end up on C', async () => {
      const entityA = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
      const entityB = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
      const entityC = await createTestEntity({ canonicalName: 'C', entityType: 'person' });

      const fact = await createTestFact({
        subjectEntityId: entityA.id,
        predicate: 'knows',
        objectValue: 'TypeScript',
      });

      // Merge A into B
      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;

      // Merge B into C
      await testDb`SELECT merge_entities(${entityB.id}::uuid, ${entityC.id}::uuid)`;

      // Assert: fact originally on A should now be on C
      // BUG: fact was CASCADE-deleted when A was merged into B
      const result = await testDb`
        SELECT subject_entity_id FROM facts WHERE id = ${fact.id}::uuid
      `;

      expect(result.length).toBe(1);
      expect(result[0]!.subject_entity_id).toBe(entityC.id);
    });

    it('should accumulate merged_from across chain', async () => {
      const entityA = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
      const entityB = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
      const entityC = await createTestEntity({ canonicalName: 'C', entityType: 'person' });

      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;
      await testDb`SELECT merge_entities(${entityB.id}::uuid, ${entityC.id}::uuid)`;

      const target = await testDb`
        SELECT merged_from FROM entities WHERE id = ${entityC.id}::uuid
      `;

      // C should know about both A and B
      expect(target[0]!.merged_from).toContain(entityB.id);
    });
  });

  describe('EMC-008: Merge with conflicting exclusive-predicate facts', () => {
    it('should preserve both facts after merge (conflict needs separate resolution)', async () => {
      const entityA = await createTestEntity({ canonicalName: 'John A', entityType: 'person' });
      const entityB = await createTestEntity({ canonicalName: 'John B', entityType: 'person' });
      const acme = await createTestEntity({ canonicalName: 'Acme', entityType: 'company' });
      const google = await createTestEntity({ canonicalName: 'Google', entityType: 'company' });

      // Both have active works_at facts (exclusive predicate)
      await createTestFact({ subjectEntityId: entityA.id, predicate: 'works_at', objectEntityId: acme.id });
      await createTestFact({ subjectEntityId: entityB.id, predicate: 'works_at', objectEntityId: google.id });

      // Merge A into B
      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;

      // Assert: B now has TWO active works_at facts (conflict state)
      // Conflict resolution should handle this in a subsequent pass
      // BUG: A's fact is CASCADE-deleted, so only 1 fact remains (masking the conflict)
      const facts = await testDb`
        SELECT predicate, object_entity_id FROM facts
        WHERE subject_entity_id = ${entityB.id}::uuid
          AND predicate = 'works_at'
          AND expired_at IS NULL
      `;

      expect(facts.length).toBe(2); // BUG: returns 1 (A's fact deleted)
    });
  });

  describe('EMC-009: Exact duplicate facts are collapsed during merge', () => {
    it('should expire duplicate facts when both entities share identical triples', async () => {
      const entityA = await createTestEntity({ canonicalName: `DupA-${Date.now()}`, entityType: 'person' });
      const entityB = await createTestEntity({ canonicalName: `DupB-${Date.now()}`, entityType: 'person' });

      // Both entities have the exact same fact: knows -> TypeScript (object_value)
      await createTestFact({ subjectEntityId: entityA.id, predicate: 'knows', objectValue: 'TypeScript' });
      await createTestFact({ subjectEntityId: entityB.id, predicate: 'knows', objectValue: 'TypeScript' });

      // Merge A into B
      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;

      // Assert: only 1 active fact remains (duplicate expired)
      const activeFacts = await testDb`
        SELECT id, predicate, object_value FROM facts
        WHERE subject_entity_id = ${entityB.id}::uuid
          AND predicate = 'knows'
          AND object_value = 'TypeScript'
          AND expired_at IS NULL
      `;
      expect(activeFacts.length).toBe(1);

      // Assert: the expired duplicate has the correct reason
      const expiredFacts = await testDb`
        SELECT id, expire_reason FROM facts
        WHERE subject_entity_id = ${entityB.id}::uuid
          AND predicate = 'knows'
          AND object_value = 'TypeScript'
          AND expired_at IS NOT NULL
      `;
      expect(expiredFacts.length).toBe(1);
      expect(expiredFacts[0]!.expire_reason).toBe('Duplicate removed during entity merge');
    });

    it('should keep both facts when objects differ (not duplicates)', async () => {
      const entityA = await createTestEntity({ canonicalName: `DiffA-${Date.now()}`, entityType: 'person' });
      const entityB = await createTestEntity({ canonicalName: `DiffB-${Date.now()}`, entityType: 'person' });

      // Different object values — these are NOT duplicates
      await createTestFact({ subjectEntityId: entityA.id, predicate: 'knows', objectValue: 'TypeScript' });
      await createTestFact({ subjectEntityId: entityB.id, predicate: 'knows', objectValue: 'Python' });

      // Merge A into B
      await testDb`SELECT merge_entities(${entityA.id}::uuid, ${entityB.id}::uuid)`;

      // Assert: both facts remain active (different objects)
      const activeFacts = await testDb`
        SELECT id, object_value FROM facts
        WHERE subject_entity_id = ${entityB.id}::uuid
          AND predicate = 'knows'
          AND expired_at IS NULL
      `;
      expect(activeFacts.length).toBe(2);
    });
  });
});
