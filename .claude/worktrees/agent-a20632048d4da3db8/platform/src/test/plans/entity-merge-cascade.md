# Entity Merge Cascade Tests

## Critical Bug: CASCADE Deletion on Merge

The `merge_entities()` PL/pgSQL function in `db/migrations/003_entities.sql` (lines 138-188) has a **data-loss bug**:

- `facts.subject_entity_id` has `ON DELETE CASCADE` (004_facts.sql:19). When the source entity is deleted during merge, PostgreSQL CASCADE-deletes **every fact where the source is the subject**.
- `facts.object_entity_id` has `ON DELETE SET NULL` (004_facts.sql:21). Facts referencing the source as object get `object_entity_id` silently set to NULL.

The function correctly handles aliases and memory_entities, but **completely ignores facts and graph edges**.

## Current State

### What merge_entities() does today:
1. Records audit in `entity_merges`
2. Moves aliases to target (`ON CONFLICT DO NOTHING`)
3. Adds source canonical name as `merged_name` alias on target
4. Updates `memory_entities.entity_id` from source to target
5. Appends source ID to target's `merged_from` array
6. **Deletes source entity** (triggering CASCADE on facts)

### What it does NOT do:
- Update `facts.subject_entity_id` before delete (data loss via CASCADE)
- Update `facts.object_entity_id` before delete (data degradation via SET NULL)
- Handle `memory_entities` unique constraint conflicts when both entities reference same memory
- Re-route Apache AGE graph edges
- Handle transitive merge chains (A->B then B->C)
- Detect conflicting exclusive-predicate facts after merge

## Relevant Files

| File | Lines | Purpose |
|------|-------|---------|
| `db/migrations/003_entities.sql` | 138-188 | `merge_entities()` PL/pgSQL function |
| `db/migrations/004_facts.sql` | 15-46 | Facts schema, FK constraints (CASCADE/SET NULL) |
| `db/migrations/005_apache_age.sql` | — | Graph sync triggers |
| `services/entities.ts` | — | App-level entity resolution |
| `services/facts.ts` | — | Fact CRUD |
| `services/graph.ts` | — | AGE graph queries |
| `db/schema.ts` | 142, 190, 206, 232 | entities, entityMerges, memoryEntities, facts |
| `test/integration/database.test.ts` | 299 | DB-006 merge audit test (audit only) |
| `test/integration/knowledge-graph.test.ts` | 375 | KG-007 graph merge test (audit only) |
| `test/setup.ts` | — | createTestEntity, createTestFact, createTestMemoryEntity |

## Test Scenarios

### EMC-001: Facts with merged entity as SUBJECT are re-pointed
**Setup:** Create entity A, entity B. Create 3 facts with A as subject.
**Action:** Merge A into B.
**Assert:** All 3 facts now have `subject_entity_id = B.id`. No facts deleted.
**Note:** Currently FAILS — facts are CASCADE-deleted. This test documents the bug.

### EMC-002: Facts with merged entity as OBJECT are re-pointed
**Setup:** Create entities A, B, C. Create fact: C works_at A (A is object).
**Action:** Merge A into B.
**Assert:** Fact now has `object_entity_id = B.id` (not NULL).
**Note:** Currently FAILS — object_entity_id is SET NULL.

### EMC-003: Aliases consolidated onto target entity
**Setup:** Create entity A with aliases ["Johnny", "J"]. Create entity B with aliases ["John S"].
**Action:** Merge A into B.
**Assert:** B has aliases ["John S", "Johnny", "J", <A's canonical name>]. A's aliases removed.

### EMC-004: memory_entities links re-pointed (unique constraint conflict)
**Setup:** Create entities A, B. Create memory M. Link M to A and M to B (both reference same memory).
**Action:** Merge A into B.
**Assert:** M is linked to B only (no duplicate). memory_entities has single row for M-B.

### EMC-005: entity_merges audit trail
**Setup:** Create entities A, B.
**Action:** Merge A into B.
**Assert:** `entity_merges` has row with `source_entity_id=A, target_entity_id=B, merged_at=now()`.

### EMC-006: Graph edges re-routed (AGE-gated)
**Setup:** Create entities A, B, C. Create fact C->knows->A (creates graph edge C->A).
**Action:** Merge A into B.
**Assert:** Graph edge now points C->B. No orphaned edge to A.
**Skip if:** Apache AGE not available.

### EMC-007: Multi-level merge chain (A->B->C)
**Setup:** Create entities A, B, C. Create facts on A.
**Action:** Merge A into B. Then merge B into C.
**Assert:** All facts originally on A now have `subject_entity_id = C.id`. A's aliases and B's aliases all on C.

### EMC-008: Merge with conflicting exclusive-predicate facts
**Setup:** Create entity A with fact "works_at Acme". Create entity B with fact "works_at Google". Both exclusive predicate, both active (no invalid_at).
**Action:** Merge A into B.
**Assert:** After merge, B has TWO active works_at facts (conflict). Should either: (a) flag for conflict resolution, or (b) document that merge doesn't resolve conflicts.

## Test File

**Location:** `platform/src/test/integration/entity-merge-cascade.test.ts`

**Imports:**
```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { testDb, createTestEntity, createTestFact, createTestMemoryEntity, deleteFromTables, randomUUID } from '../setup.js';
```

## Dependencies

- **Required:** PostgreSQL (test DB)
- **Optional:** Apache AGE (gate EMC-006 with `skipIf(!ageAvailable)`)
- **Not needed:** ML Services, Qdrant, Ollama

## Implementation Note

**The merge function itself needs fixing before most tests can pass.** Tests EMC-001, EMC-002, EMC-006, EMC-007 will fail against current code — they document the EXPECTED behavior. Write them first as failing tests, then fix `merge_entities()` to make them pass.

Fix requires adding these lines BEFORE the `DELETE FROM entities`:
```sql
UPDATE facts SET subject_entity_id = target_id WHERE subject_entity_id = source_id;
UPDATE facts SET object_entity_id = target_id WHERE object_entity_id = source_id;
```
