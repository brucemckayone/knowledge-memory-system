# Self-Referential Facts

**Priority:** High — data integrity
**Complexity:** Low
**Branch:** `fix/self-referential-facts`
**Date:** 2026-04-16

---

## Problem

There is zero prevention of self-referential facts — facts where `subject_entity_id = object_entity_id`. No database constraint, no application validation, no prompt instruction. Facts like `The Gardener --[same_entity_as]--> The Gardener` get created and stored.

These are semantically meaningless and pollute the graph. They arise when the graph agent extracts a relationship between an entity and itself (e.g., from text like "The Gardener should merge identical names" the agent creates `The Gardener --[should_merge_identical_names]--> The Gardener`).

---

## What Exists

- `merge_entities()` function (`src/db/migrations/005_reconciliation.sql:142-145`) cleans up self-referential `same_as_links` after merges — acknowledging they can arise as a side effect
- No other prevention anywhere in the codebase

## What's Missing

- No CHECK constraint on `facts` table
- No validation in `createFact()` (`src/services/facts.ts`)
- No validation in `create_fact` tool handler (`src/services/causal-agent.ts`)
- No prompt instruction in graph agent (`ml-services/app/graph_agent.py`) or gardener (`ml-services/app/gardener_agent.py`)
- Existing self-referential facts in the database need cleanup

---

## Proposed Fix

Three layers of prevention plus cleanup:

### 1. Database constraint

New migration `007_no_self_reference.sql`:

```sql
-- Expire existing self-referential facts
UPDATE public.facts
SET expired_at = NOW(), expire_reason = 'Self-referential fact cleanup'
WHERE object_entity_id = subject_entity_id AND expired_at IS NULL;

-- Prevent future self-referential facts
ALTER TABLE public.facts ADD CONSTRAINT no_self_reference
  CHECK (object_entity_id IS NULL OR subject_entity_id != object_entity_id);
```

This allows attribute facts (`object_value` set, `object_entity_id` NULL) but prevents self-pointing relationship facts.

### 2. Application validation

In `createFact()` (`src/services/facts.ts`), before the insert:

```typescript
if (objectEntityId && objectEntityId === subjectEntityId) {
  throw new Error('Self-referential facts are not allowed: subject and object must be different entities');
}
```

The `create_fact` tool handler in `src/services/causal-agent.ts` already catches errors and returns them to the agent, so this will surface as a clear error message.

### 3. Prompt instructions

Add to graph agent PHASE 3 rules (`ml-services/app/graph_agent.py`):
```
Subject and object must be DIFFERENT entities. Never create a fact where an entity points to itself.
```

Add same rule to gardener prompt (`ml-services/app/gardener_agent.py`).

---

## Files to Modify

| File | Change |
|------|--------|
| `src/db/migrations/007_no_self_reference.sql` | New migration — cleanup + CHECK constraint |
| `src/db/schema.ts` | Document the constraint in comments |
| `src/services/facts.ts` | Validation guard in `createFact()` |
| `ml-services/app/graph_agent.py` | PHASE 3 rules: no self-reference |
| `ml-services/app/gardener_agent.py` | Rules: no self-reference |

---

## Test Strategy

1. **Unit:** Attempt to create self-referential fact via `createFact()`, verify it throws
2. **Unit:** Attempt to insert self-referential fact directly in SQL, verify CHECK constraint blocks it
3. **Integration:** Run ingest with text that might trigger self-reference (e.g., "The Gardener explores the graph"), verify no self-referential facts created
4. **Cleanup verification:** After migration, query `SELECT count(*) FROM facts WHERE object_entity_id = subject_entity_id AND expired_at IS NULL` — should be 0

---

## Current Data

To see existing self-referential facts before cleanup:
```sql
SELECT f.id, s.canonical_name as subject, f.predicate, f.confidence
FROM facts f
JOIN entities s ON f.subject_entity_id = s.id
WHERE f.object_entity_id = f.subject_entity_id AND f.expired_at IS NULL;
```
