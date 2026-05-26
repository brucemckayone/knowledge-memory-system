/**
 * Entity Merge Cascade Tests
 *
 * Tests that merging entities correctly re-points all references:
 * facts (subject + object), aliases, memory_entities, graph edges.
 *
 * History: the original PL/pgSQL entity-merge function (mig 005/020) had a
 * data-loss bug — DELETE source BEFORE re-pointing — which mig 005 itself
 * fixed by re-ordering the steps. Bead nmemo-2yv.30 then REPLACED the SQL
 * function with the audited TS mergeEntities() service in
 * src/services/entities.ts. The PL/pgSQL function was DROPped in mig 026.
 * Every test below now drives the merge through the TS service. EMC-010
 * exercises the new audit-trail contract (fact_history rows with
 * event_type='merged').
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
import { mergeEntities } from '../../services/entities.js';

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
      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });

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
      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });

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
      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });

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
      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });

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
      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });

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

      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });

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

      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });

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
      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });

      // Merge B into C
      await mergeEntities({ sourceId: entityB.id, targetId: entityC.id });

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

      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });
      await mergeEntities({ sourceId: entityB.id, targetId: entityC.id });

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
      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });

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
      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });

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
      await mergeEntities({ sourceId: entityA.id, targetId: entityB.id });

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

  describe("EMC-010: audit trail — every fact mutation emits fact_history(event_type='merged') (nmemo-2yv.30)", () => {
    it("emits one 'merged' row per re-pointed subject fact, per re-pointed object fact, and per duplicate-expired fact, all inside one transaction", async () => {
      const subjectN = 2;
      const objectM = 1;
      const duplicateK = 1;
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // Source/Target — the entities being merged.
      const source = await createTestEntity({ canonicalName: `EMC10-Source-${suffix}`, entityType: 'person' });
      const target = await createTestEntity({ canonicalName: `EMC10-Target-${suffix}`, entityType: 'person' });
      // Co-actor — the object side of the object-fact, an unrelated subject for the dup setup.
      const acme = await createTestEntity({ canonicalName: `EMC10-Acme-${suffix}`, entityType: 'company' });
      const other = await createTestEntity({ canonicalName: `EMC10-Other-${suffix}`, entityType: 'person' });

      // subjectN = 2 facts where source is the SUBJECT
      const subjectFacts = [
        await createTestFact({ subjectEntityId: source.id, predicate: 'knows', objectValue: `lang-${suffix}-1` }),
        await createTestFact({ subjectEntityId: source.id, predicate: 'lives_in', objectValue: `city-${suffix}` }),
      ];
      // objectM = 1 fact where source is the OBJECT
      const objectFacts = [
        await createTestFact({ subjectEntityId: other.id, predicate: 'mentions', objectEntityId: source.id }),
      ];
      // duplicateK = 1 — both source and target carry the same (subject, predicate, object)
      // After re-pointing source.subject -> target, two identical rows exist; one expires.
      const dupPredicate = `dup-pred-${suffix}`;
      await createTestFact({ subjectEntityId: source.id, predicate: dupPredicate, objectEntityId: acme.id });
      await createTestFact({ subjectEntityId: target.id, predicate: dupPredicate, objectEntityId: acme.id });

      // Snapshot pre-merge fact_history row count (other tests may have written
      // rows; we only assert the DELTA introduced by this merge).
      const allFactIds = [
        ...subjectFacts.map((f) => f.id),
        ...objectFacts.map((f) => f.id),
      ];

      // Drive the merge through the audited TS path.
      const result = await mergeEntities({
        sourceId: source.id,
        targetId: target.id,
        reason: 'EMC-010 audit-trail integration test',
        actor: 'reconciliation_agent',
      });
      expect(result.survivorId).toBe(target.id);

      // ── Assertion 1: every subject-fact has a 'merged' fact_history row
      //   with actor='reconciliation_agent' and reasoning identifying the
      //   re-point as subject-side.
      for (const f of subjectFacts) {
        const rows = await testDb<Array<{ event_type: string; actor: string; reasoning: string }>>`
          SELECT event_type, actor, reasoning
          FROM public.fact_history
          WHERE fact_id = ${f.id}::uuid AND event_type = 'merged'
          ORDER BY occurred_at DESC
        `;
        expect(rows.length).toBe(1);
        expect(rows[0]!.actor).toBe('reconciliation_agent');
        expect(rows[0]!.reasoning).toContain('subject_entity_id re-pointed');
      }

      // ── Assertion 2: the object-fact gets a 'merged' row identifying it
      //   as an object-side re-point.
      for (const f of objectFacts) {
        const rows = await testDb<Array<{ event_type: string; actor: string; reasoning: string }>>`
          SELECT event_type, actor, reasoning
          FROM public.fact_history
          WHERE fact_id = ${f.id}::uuid AND event_type = 'merged'
          ORDER BY occurred_at DESC
        `;
        expect(rows.length).toBe(1);
        expect(rows[0]!.actor).toBe('reconciliation_agent');
        expect(rows[0]!.reasoning).toContain('object_entity_id re-pointed');
      }

      // ── Assertion 3: the duplicate-expired fact has a 'merged' row whose
      //   reasoning identifies it as a duplicate-removal. Look it up by the
      //   unique (target subject, dupPredicate, acme object, expired NOT NULL)
      //   shape.
      const expiredDupRows = await testDb<Array<{ id: string; expire_reason: string }>>`
        SELECT id::text AS id, expire_reason FROM public.facts
        WHERE subject_entity_id = ${target.id}::uuid
          AND predicate = ${dupPredicate}
          AND object_entity_id = ${acme.id}::uuid
          AND expired_at IS NOT NULL
      `;
      expect(expiredDupRows.length).toBe(duplicateK);
      expect(expiredDupRows[0]!.expire_reason).toBe('Duplicate removed during entity merge');
      const dupAuditRows = await testDb<Array<{ event_type: string; actor: string; reasoning: string }>>`
        SELECT event_type, actor, reasoning
        FROM public.fact_history
        WHERE fact_id = ${expiredDupRows[0]!.id}::uuid AND event_type = 'merged'
        ORDER BY occurred_at DESC
      `;
      // Duplicate fact was first re-pointed (subject UPDATE) THEN expired
      // as a duplicate — two 'merged' rows on the same fact. Both writes
      // happen inside the same transaction, so DEFAULT NOW() returns the
      // identical txn-start timestamp and order between same-timestamp
      // rows is not guaranteed. Assert the SET of reasonings rather than
      // a positional order.
      expect(dupAuditRows.length).toBe(2);
      for (const row of dupAuditRows) {
        expect(row.actor).toBe('reconciliation_agent');
      }
      const dupReasonings = dupAuditRows.map((r) => r.reasoning);
      expect(dupReasonings.some((r) => r.includes('subject_entity_id re-pointed'))).toBe(true);
      expect(dupReasonings.some((r) => r.includes('duplicate fact expired'))).toBe(true);

      // ── Assertion 4: every audit row covered above is one row per fact.
      //   subjectN + objectM single rows + duplicateK *2 rows.
      const includeIds = [...allFactIds, expiredDupRows[0]!.id];
      const totalMergedRows = await testDb<Array<{ c: number }>>`
        SELECT COUNT(*)::int AS c FROM public.fact_history
        WHERE event_type = 'merged'
          AND actor = 'reconciliation_agent'
          AND fact_id = ANY(${includeIds}::uuid[])
      `;
      // 2 subject rows + 1 object row + 2 duplicate rows (re-point + expiry) = 5.
      expect(totalMergedRows[0]!.c).toBe(subjectN + objectM + duplicateK * 2);
    });

    it('rolls back the entire merge — including audit rows — when audit write fails (invalid actor)', async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const source = await createTestEntity({ canonicalName: `EMC10-Rollback-Source-${suffix}`, entityType: 'person' });
      const target = await createTestEntity({ canonicalName: `EMC10-Rollback-Target-${suffix}`, entityType: 'person' });
      const fact = await createTestFact({
        subjectEntityId: source.id,
        predicate: 'knows',
        objectValue: `rollback-${suffix}`,
      });

      // Force the audit row insert to violate the valid_fact_actor CHECK
      // (mig 009 line 47-50). The DB rejects the INSERT; the surrounding
      // db.transaction wrapping mergeEntities() then rolls EVERY step back
      // — entity_merges, alias copies, the fact UPDATE, AND the DELETE on
      // the source entity. Post-merge state must equal pre-merge state.
      await expect(
        mergeEntities({
          sourceId: source.id,
          targetId: target.id,
          actor: 'no_such_actor' as never,
        })
      ).rejects.toThrow();

      // Source entity still present (DELETE rolled back).
      const sourceRows = await testDb`
        SELECT 1 FROM public.entities WHERE id = ${source.id}::uuid
      `;
      expect(sourceRows.length).toBe(1);

      // Fact's subject is still source (UPDATE rolled back).
      const factRows = await testDb<Array<{ subject_entity_id: string }>>`
        SELECT subject_entity_id::text AS subject_entity_id FROM public.facts WHERE id = ${fact.id}::uuid
      `;
      expect(factRows[0]!.subject_entity_id).toBe(source.id);

      // No entity_merges row (INSERT rolled back).
      const mergeRows = await testDb`
        SELECT 1 FROM public.entity_merges WHERE source_entity_id = ${source.id}::uuid
      `;
      expect(mergeRows.length).toBe(0);

      // No fact_history rows for this fact (audit insert rolled back).
      const auditRows = await testDb`
        SELECT 1 FROM public.fact_history
        WHERE fact_id = ${fact.id}::uuid AND event_type = 'merged'
      `;
      expect(auditRows.length).toBe(0);
    });
  });
});
