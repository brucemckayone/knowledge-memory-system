# Entity Merge Cascade Tests

## Status

**Historical design notes.** This file recorded the EMC-001..EMC-009 test cases
that were originally written against the PL/pgSQL entity-merge function in
`db/migrations/005_reconciliation.sql`. The function had a data-loss bug
(DELETE source BEFORE re-pointing facts) which mig 005 itself corrected by
re-ordering the steps.

Bead **nmemo-2yv.30** then replaced the PL/pgSQL function with the audited TS
service `mergeEntities()` in `platform/src/services/entities.ts`. The
PL/pgSQL function was dropped in `db/migrations/026_merge_entities_audit_event.sql`.

The implemented test cases live at
`platform/src/test/integration/entity-merge-cascade.test.ts` and now drive
the merge through the TS service. EMC-010 (added by nmemo-2yv.30) covers the
new audit-trail contract — every fact mutation emits a `fact_history` row
with `event_type='merged'`, and the whole merge is atomic.

## Current behaviour (after bead nmemo-2yv.30)

The TS `mergeEntities()` service:

1. Records audit row in `entity_merges`
2. Copies aliases from source to target (`ON CONFLICT DO NOTHING`)
3. Adds source canonical name as `merged_name` alias on target
4. Re-points `facts.subject_entity_id` from source to target — **emits one
   `fact_history(event_type='merged')` row per affected fact**
5. Re-points `facts.object_entity_id` from source to target — **emits one
   `fact_history(event_type='merged')` row per affected fact**
6. Expires exact-duplicate facts after re-pointing — **emits one
   `fact_history(event_type='merged')` row per duplicate**
7. Re-points `memory_entities` (with unique-constraint dedup)
8. Re-points `causal_events.subject_entity_id`
9. Re-points `same_as_links` (preserves a<b canonical ordering)
10. Re-points `contradictions` (mig 020 / nmemo-2yv.63 dedup + re-point)
11. Appends source ID to target's `merged_from` array, updates last_seen_at
12. Deletes the source entity

The entire merge runs in `db.transaction(...)`. An invalid actor, a CHECK
violation, or any DB error rolls the whole thing back — including the audit
rows.

## Test scenarios (EMC-001..EMC-010)

### EMC-001 — facts with merged entity as SUBJECT are re-pointed
### EMC-002 — facts with merged entity as OBJECT are re-pointed
### EMC-003 — aliases consolidated onto target
### EMC-004 — memory_entities links re-pointed
### EMC-005 — entity_merges audit trail row written
### EMC-007 — multi-level merge chain (A->B->C)
### EMC-008 — conflicting exclusive-predicate facts preserved after merge
### EMC-009 — exact duplicate facts are collapsed during merge

(EMC-006 — AGE graph edge re-routing — was never implemented; the AGE graph
is a derived traversal index and stays in sync via the entity sync triggers,
not via the merge path. Tracked separately if needed.)

### EMC-010 (nmemo-2yv.30) — audit trail
- Every re-pointed subject fact has one `fact_history(event_type='merged')`
  row with the configured `actor` and reasoning identifying it as a subject
  re-point.
- Every re-pointed object fact has the same shape with object-side reasoning.
- Every duplicate-expired fact has reasoning identifying it as a
  duplicate-removal.
- A merge with an invalid actor leaves zero partial state (rollback test).

## Dependencies

- **Required:** PostgreSQL (test DB).
- **Not needed:** ML Services, Qdrant, Ollama.

## Test file

`platform/src/test/integration/entity-merge-cascade.test.ts`
