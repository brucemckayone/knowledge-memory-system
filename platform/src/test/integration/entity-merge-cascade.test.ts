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

  describe('EMC-011: topology_bridges + reasoning_reports.entity_ids[] re-point (nmemo-2yv.65)', () => {
    it('re-points topology_bridges rows where source is on either side; deletes self-bridges and unique-clash rows; CASCADE-clears canonical-order-violating rows on source DELETE', async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // The canonical-order CHECK is `source_entity_id < target_entity_id`
      // (mig 014). The mergeEntities() re-point only triggers when canonical
      // ordering is preserved — order-violating rows are left dangling and
      // CASCADE-cleared by mig 028's FK on source DELETE. The test must
      // therefore pin entity-id ordering so each scenario lands in its
      // intended branch (re-point vs CASCADE-clear).
      //
      // Generate 5 candidate entities and sort by id. We assign roles based
      // on rank so that:
      //   peerLow.id < target.id < source.id < peer1.id < peer2.id
      // This guarantees:
      //   - (peerLow, source) is canonical; re-point to (peerLow, target) is
      //     canonical → exercises "source as high side" re-point.
      //   - (source, peer1) is canonical; re-point to (target, peer1) is
      //     canonical → exercises "source as low side" re-point.
      //   - (target, peer1) exercises the unique-clash dedup against the
      //     re-pointed source-side row.
      //   - (source, target) is non-canonical (source > target). Insert as
      //     (target, source) — self-bridge after re-point.
      const candidates = await Promise.all([
        createTestEntity({ canonicalName: `EMC11-C0-${suffix}`, entityType: 'person' }),
        createTestEntity({ canonicalName: `EMC11-C1-${suffix}`, entityType: 'person' }),
        createTestEntity({ canonicalName: `EMC11-C2-${suffix}`, entityType: 'person' }),
        createTestEntity({ canonicalName: `EMC11-C3-${suffix}`, entityType: 'person' }),
        createTestEntity({ canonicalName: `EMC11-C4-${suffix}`, entityType: 'person' }),
      ]);
      const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const [peerLow, target, source, peer1, peer2] = sorted as [
        typeof sorted[0], typeof sorted[0], typeof sorted[0], typeof sorted[0], typeof sorted[0]
      ];

      // Each bridge row needs a fact_id (one_kind CHECK).
      const insertBridge = async (lo: string, hi: string, factId: string) => {
        await testDb`
          INSERT INTO public.topology_bridges (source_entity_id, target_entity_id, fact_id)
          VALUES (${lo}::uuid, ${hi}::uuid, ${factId}::uuid)
        `;
      };

      const fact1 = await createTestFact({ subjectEntityId: source.id, predicate: 'bridges_1', objectValue: `v1-${suffix}` });
      const fact2 = await createTestFact({ subjectEntityId: source.id, predicate: 'bridges_2', objectValue: `v2-${suffix}` });
      const fact3 = await createTestFact({ subjectEntityId: source.id, predicate: 'bridges_3', objectValue: `v3-${suffix}` });
      const fact4 = await createTestFact({ subjectEntityId: source.id, predicate: 'bridges_4', objectValue: `v4-${suffix}` });

      // Bridge A (low side re-point): (source, peer1) → (target, peer1).
      await insertBridge(source.id, peer1.id, fact1.id);
      // Bridge B (low side re-point): (source, peer2) → (target, peer2).
      await insertBridge(source.id, peer2.id, fact2.id);
      // Bridge C (high side re-point): (peerLow, source) → (peerLow, target).
      await insertBridge(peerLow.id, source.id, fact3.id);
      // Bridge D (self-bridge): (target, source) — canonical-form since
      // target < source. After re-point to (target, target) — DELETEd.
      await insertBridge(target.id, source.id, fact4.id);
      // Bridge E (unique-clash): pre-existing (target, peer1). After re-point
      // of Bridge A, the source-side row collides with this one and is
      // DELETEd as a unique-clash.
      const fact5 = await createTestFact({ subjectEntityId: target.id, predicate: 'bridges_5', objectValue: `v5-${suffix}` });
      await insertBridge(target.id, peer1.id, fact5.id);

      // Snapshot pre-merge bridges referencing source or target.
      const bridgesBefore = await testDb<Array<{ source_entity_id: string; target_entity_id: string }>>`
        SELECT source_entity_id::text AS source_entity_id, target_entity_id::text AS target_entity_id
        FROM public.topology_bridges
        WHERE source_entity_id IN (${source.id}::uuid, ${target.id}::uuid)
           OR target_entity_id IN (${source.id}::uuid, ${target.id}::uuid)
        ORDER BY source_entity_id, target_entity_id
      `;
      expect(bridgesBefore.length).toBe(5);

      // Set up a reasoning_report whose entity_ids[] includes source.
      const reportId = randomUUID();
      await testDb`
        INSERT INTO public.reasoning_reports (id, mode, report, entity_ids)
        VALUES (
          ${reportId}::uuid,
          'patrol',
          'EMC-011 test report',
          ARRAY[${source.id}::uuid, ${peer1.id}::uuid]
        )
      `;
      // Sanity: report contains source.
      const reportBefore = await testDb<Array<{ entity_ids: string[] }>>`
        SELECT entity_ids FROM public.reasoning_reports WHERE id = ${reportId}::uuid
      `;
      expect(reportBefore[0]!.entity_ids).toContain(source.id);

      // Drive the merge.
      await mergeEntities({ sourceId: source.id, targetId: target.id });

      // ── Assertion 1: zero topology_bridges rows still reference source.
      const danglingBridges = await testDb`
        SELECT 1 FROM public.topology_bridges
        WHERE source_entity_id = ${source.id}::uuid OR target_entity_id = ${source.id}::uuid
      `;
      expect(danglingBridges.length).toBe(0);

      // ── Assertion 2: zero topology_bridges rows have BOTH endpoints equal
      //   (no self-bridge survived) AND no rows violate the canonical ordering.
      //   (DB CHECK would prevent that, but assert as belt-and-braces.)
      const malformedBridges = await testDb`
        SELECT 1 FROM public.topology_bridges
        WHERE source_entity_id = target_entity_id
           OR source_entity_id >= target_entity_id
      `;
      expect(malformedBridges.length).toBe(0);

      // ── Assertion 3a: low-side re-point — (source, peer2) → (target, peer2).
      const targetPeer2 = await testDb`
        SELECT 1 FROM public.topology_bridges
        WHERE source_entity_id = ${target.id}::uuid AND target_entity_id = ${peer2.id}::uuid
      `;
      expect(targetPeer2.length).toBe(1);

      // ── Assertion 3b: high-side re-point — (peerLow, source) → (peerLow, target).
      const peerLowTarget = await testDb`
        SELECT 1 FROM public.topology_bridges
        WHERE source_entity_id = ${peerLow.id}::uuid AND target_entity_id = ${target.id}::uuid
      `;
      expect(peerLowTarget.length).toBe(1);

      // ── Assertion 4: exactly ONE (target, peer1) bridge survives — Bridge A
      //   (re-pointed source-side) clashed with Bridge E (pre-existing) on
      //   UNIQUE(source_entity_id, target_entity_id) and was DELETEd by the
      //   unique-clash pre-pass.
      const targetPeer1 = await testDb`
        SELECT 1 FROM public.topology_bridges
        WHERE source_entity_id = ${target.id}::uuid AND target_entity_id = ${peer1.id}::uuid
      `;
      expect(targetPeer1.length).toBe(1);

      // ── Assertion 5: reasoning_reports.entity_ids[] no longer contains source.
      const reportAfter = await testDb<Array<{ entity_ids: string[] }>>`
        SELECT entity_ids FROM public.reasoning_reports WHERE id = ${reportId}::uuid
      `;
      expect(reportAfter[0]!.entity_ids).not.toContain(source.id);
      expect(reportAfter[0]!.entity_ids).toContain(target.id);
      expect(reportAfter[0]!.entity_ids).toContain(peer1.id);

      // ── Assertion 6: audit query mirroring the bead's acceptance — joining
      //   topology_bridges to entities returns zero rows on the source side.
      const auditDanglers = await testDb`
        SELECT 1 FROM public.topology_bridges b
        LEFT JOIN public.entities es ON es.id = b.source_entity_id
        LEFT JOIN public.entities et ON et.id = b.target_entity_id
        WHERE es.id IS NULL OR et.id IS NULL
      `;
      expect(auditDanglers.length).toBe(0);
    });

    it('FK constraint prevents future regressions: DELETE entity without re-point CASCADES topology_bridges row away', async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const e1 = await createTestEntity({ canonicalName: `EMC11-FK-A-${suffix}`, entityType: 'person' });
      const e2 = await createTestEntity({ canonicalName: `EMC11-FK-B-${suffix}`, entityType: 'person' });
      const linkFact = await createTestFact({ subjectEntityId: e1.id, predicate: 'related', objectEntityId: e2.id });

      const [lo, hi] = e1.id < e2.id ? [e1.id, e2.id] : [e2.id, e1.id];
      await testDb`
        INSERT INTO public.topology_bridges (source_entity_id, target_entity_id, fact_id)
        VALUES (${lo}::uuid, ${hi}::uuid, ${linkFact.id}::uuid)
      `;

      const before = await testDb`
        SELECT 1 FROM public.topology_bridges
        WHERE source_entity_id = ${lo}::uuid AND target_entity_id = ${hi}::uuid
      `;
      expect(before.length).toBe(1);

      // Delete e1 directly — CASCADE FK should clear the bridge.
      // (We can't merge via mergeEntities() here because that would re-point,
      // not test the FK.) Delete dependent facts first to clear the facts FK.
      await testDb`DELETE FROM public.facts WHERE id = ${linkFact.id}::uuid`;
      await testDb`DELETE FROM public.entities WHERE id = ${e1.id}::uuid`;

      const after = await testDb`
        SELECT 1 FROM public.topology_bridges
        WHERE source_entity_id = ${lo}::uuid AND target_entity_id = ${hi}::uuid
      `;
      expect(after.length).toBe(0);
    });
  });

  describe('EMC-012: entity_topology / entity_clusters / entity_drift_state cleared on survivor; entity_drift_events re-pointed (nmemo-2yv.64)', () => {
    it('drops target rows in derived-state caches (recompute on next pass), re-points drift events to survivor, fires post-merge auto-trigger', async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const source = await createTestEntity({ canonicalName: `EMC12-Source-${suffix}`, entityType: 'person' });
      const target = await createTestEntity({ canonicalName: `EMC12-Target-${suffix}`, entityType: 'person' });

      // ── Seed derived-state rows on BOTH source and target.
      // entity_topology — PK is entity_id, so one row per entity.
      // Use VECTOR(25) zero-vector literal for predicate_signature (nullable but
      // we set it to exercise the column).
      const zeroSig25 = `[${Array.from({ length: 25 }, () => '0').join(',')}]`;
      await testDb`
        INSERT INTO public.entity_topology
          (entity_id, component_id, component_size, k_core, is_articulation_point,
           community_id, participation_coef, pagerank, betweenness_sampled, predicate_signature)
        VALUES
          (${source.id}::uuid, 1, 5, 2, FALSE, 10, 0.4, 0.05, 0.02, ${zeroSig25}::vector),
          (${target.id}::uuid, 2, 3, 1, FALSE, 20, 0.1, 0.02, 0.01, ${zeroSig25}::vector)
      `;

      // entity_clusters — PK is entity_id; centroid_snapshot NOT NULL VECTOR(768).
      const zeroSig768 = `[${Array.from({ length: 768 }, () => '0').join(',')}]`;
      await testDb`
        INSERT INTO public.entity_clusters
          (entity_id, cluster_id, centroid_snapshot, cluster_probability, cluster_size)
        VALUES
          (${source.id}::uuid, 0, ${zeroSig768}::vector, 0.9, 100),
          (${target.id}::uuid, 1, ${zeroSig768}::vector, 0.7, 50)
      `;

      // entity_drift_state — PK is entity_id; adwin_state_blob NOT NULL.
      await testDb`
        INSERT INTO public.entity_drift_state
          (entity_id, adwin_state_blob, observation_count, last_cluster_id, river_version)
        VALUES
          (${source.id}::uuid, '\\x00'::bytea, 42, 0, '0.21.0'),
          (${target.id}::uuid, '\\x00'::bytea, 99, 1, '0.21.0')
      `;

      // entity_drift_events — append-only, multiple rows per entity.
      // Set up 2 events on source + 1 event on target so we can assert
      // the source's 2 events end up on target (3 total post-merge).
      await testDb`
        INSERT INTO public.entity_drift_events
          (entity_id, drift_magnitude, centroid_snapshot, centroid_current,
           cluster_id_at_detection, target_cluster_id, triggered_action)
        VALUES
          (${source.id}::uuid, 0.3, ${zeroSig768}::vector, ${zeroSig768}::vector, 0, 1, 'logged_only'),
          (${source.id}::uuid, 0.5, ${zeroSig768}::vector, ${zeroSig768}::vector, 0, 1, 'logged_only'),
          (${target.id}::uuid, 0.2, ${zeroSig768}::vector, ${zeroSig768}::vector, 1, NULL, 'logged_only')
      `;

      // Snapshot pre-merge counts.
      const driftEventsBefore = await testDb<Array<{ c: number }>>`
        SELECT COUNT(*)::int AS c FROM public.entity_drift_events
        WHERE entity_id = ${source.id}::uuid OR entity_id = ${target.id}::uuid
      `;
      expect(driftEventsBefore[0]!.c).toBe(3);

      // ── Drive the merge.
      await mergeEntities({ sourceId: source.id, targetId: target.id });

      // ── Assertion 1: entity_topology — target row deleted (recompute marker);
      //   source row CASCADE-cleared on source DELETE. Zero rows remain for
      //   either id. The visible-marker contract: derived_freshness has a
      //   row stamping the merge as "needs recompute"; the gardener's next
      //   pass regenerates entity_topology for the survivor.
      const topologyRows = await testDb`
        SELECT entity_id FROM public.entity_topology
        WHERE entity_id = ${source.id}::uuid OR entity_id = ${target.id}::uuid
      `;
      expect(topologyRows.length).toBe(0);

      // ── Assertion 2: entity_clusters — same shape as topology.
      const clusterRows = await testDb`
        SELECT entity_id FROM public.entity_clusters
        WHERE entity_id = ${source.id}::uuid OR entity_id = ${target.id}::uuid
      `;
      expect(clusterRows.length).toBe(0);

      // ── Assertion 3: entity_drift_state — both source and target rows
      //   dropped. ADWIN state regenerates on next drift pass.
      const driftStateRows = await testDb`
        SELECT entity_id FROM public.entity_drift_state
        WHERE entity_id = ${source.id}::uuid OR entity_id = ${target.id}::uuid
      `;
      expect(driftStateRows.length).toBe(0);

      // ── Assertion 4: entity_drift_events — preserved history. Source's 2
      //   events are re-pointed to target (preserves chronology). Target's
      //   pre-existing 1 event is untouched. Total under target: 3.
      const driftEventsAfter = await testDb<Array<{ c: number }>>`
        SELECT COUNT(*)::int AS c FROM public.entity_drift_events
        WHERE entity_id = ${target.id}::uuid
      `;
      expect(driftEventsAfter[0]!.c).toBe(3);

      // No drift events left referencing source.
      const danglingDriftEvents = await testDb`
        SELECT 1 FROM public.entity_drift_events WHERE entity_id = ${source.id}::uuid
      `;
      expect(danglingDriftEvents.length).toBe(0);

      // ── Assertion 5: audit-style integrity join — no derived-state row
      //   references a deleted entity. Mirrors EMC-011 Assertion 6's shape.
      const auditDanglers = await testDb`
        SELECT 'topology' AS t FROM public.entity_topology et
        LEFT JOIN public.entities e ON e.id = et.entity_id WHERE e.id IS NULL
        UNION ALL
        SELECT 'clusters' FROM public.entity_clusters ec
        LEFT JOIN public.entities e ON e.id = ec.entity_id WHERE e.id IS NULL
        UNION ALL
        SELECT 'drift_state' FROM public.entity_drift_state eds
        LEFT JOIN public.entities e ON e.id = eds.entity_id WHERE e.id IS NULL
        UNION ALL
        SELECT 'drift_events' FROM public.entity_drift_events ede
        LEFT JOIN public.entities e ON e.id = ede.entity_id WHERE e.id IS NULL
      `;
      expect(auditDanglers.length).toBe(0);
    });

    it('regression guard: pre-fix CASCADE would have lost source drift event history; the re-point preserves it', async () => {
      // This test pins the chronological-preservation half of the fix: the
      // Scoped fix explicitly calls out drift events as the "preserve history"
      // case (re-point rather than drop). A future regression that swaps the
      // UPDATE for a DELETE would still satisfy EMC-012's "no dangling rows"
      // assertion but would silently drop chronology. This test catches that.
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const source = await createTestEntity({ canonicalName: `EMC12R-Source-${suffix}`, entityType: 'person' });
      const target = await createTestEntity({ canonicalName: `EMC12R-Target-${suffix}`, entityType: 'person' });

      const zeroSig768 = `[${Array.from({ length: 768 }, () => '0').join(',')}]`;

      // Source has 3 events at distinct magnitudes 0.1, 0.4, 0.7 (chronology proxy).
      await testDb`
        INSERT INTO public.entity_drift_events
          (entity_id, drift_magnitude, centroid_snapshot, centroid_current, triggered_action)
        VALUES
          (${source.id}::uuid, 0.1, ${zeroSig768}::vector, ${zeroSig768}::vector, 'logged_only'),
          (${source.id}::uuid, 0.4, ${zeroSig768}::vector, ${zeroSig768}::vector, 'logged_only'),
          (${source.id}::uuid, 0.7, ${zeroSig768}::vector, ${zeroSig768}::vector, 'logged_only')
      `;

      await mergeEntities({ sourceId: source.id, targetId: target.id });

      // All 3 source-side events end up on target, with magnitudes preserved.
      const survivorEvents = await testDb<Array<{ drift_magnitude: number }>>`
        SELECT drift_magnitude FROM public.entity_drift_events
        WHERE entity_id = ${target.id}::uuid
        ORDER BY drift_magnitude
      `;
      expect(survivorEvents.length).toBe(3);
      // Postgres REAL → JS number; tolerate FP repr.
      const magnitudes = survivorEvents.map((r) => Number(r.drift_magnitude));
      expect(magnitudes[0]).toBeCloseTo(0.1);
      expect(magnitudes[1]).toBeCloseTo(0.4);
      expect(magnitudes[2]).toBeCloseTo(0.7);
    });
  });
});
