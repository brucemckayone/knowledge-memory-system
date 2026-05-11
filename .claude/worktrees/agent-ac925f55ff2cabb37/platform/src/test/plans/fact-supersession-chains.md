# Fact Supersession Chain Tests (3+ Levels)

## Current State

### What T1-T8 Cover
Tests T1-T8 in `temporal-pipeline.test.ts` pre-build timelines with explicit `invalid_at` values using `createTestFact()`. They test **querying** pre-seeded data, not the **supersession mechanism** itself. No existing test exercises `createFact()` from `services/facts.ts` with 3+ level chains.

### What DB-003 through DB-010 Cover
- DB-003: 4-timestamp model (all fields present)
- DB-004: 2-level supersession chain
- DB-005: Point-in-time query
- DB-009: Exclusive predicate enforcement
- DB-010: Temporal overlap detection

## Key Findings

1. **`createFact()` only sets `expired_at` on superseded facts, NOT `invalid_at`**. The conflict-resolution agent sets both. Service-layer and agent-layer supersession produce different DB states.

2. **`getEntityFacts()` has inconsistent filtering** — the combined subject+object path filters on `invalid_at`, but subject-only and object-only paths do not. Latent bug.

3. **`findSupersedingFacts()` is single-level** — finds facts overlapping the new one, not the entire chain. Works for chronological insertion, edge cases with back-dated facts.

4. **Temporal convention**: `valid_at` inclusive, `invalid_at` exclusive. Half-open interval `[valid_at, invalid_at)`. `expired_at` = transaction time (record was wrong). `invalid_at` = event time (stopped being true).

## Relevant Files

| File | Purpose |
|------|---------|
| `services/facts.ts` | createFact(), findSupersedingFacts(), expireFact(), invalidateFact(), getEntityFacts() |
| `services/predicates.ts` | Exclusive predicate definitions, isExclusive() |
| `db/migrations/004_facts.sql` | Facts schema, facts_at_time() SQL function, predicate seeds |
| `test/quality/temporal-pipeline.test.ts` | T1-T8 existing tests |
| `test/integration/database.test.ts` | DB-003 through DB-010 |
| `gardener/agents/conflict-resolution.agent.ts` | Agent-level supersession logic |
| `test/setup.ts` | createTestEntity, createTestFact, getActiveFacts |

## Test Scenarios

### SC-01: 3-level employer chain via createFact()
**Setup:** Create entity John. Use `createFact()` (not test helper) to create:
- F1: John works_at Acme, valid_at Jan 1
- F2: John works_at Google, valid_at Apr 1
- F3: John works_at Meta, valid_at Jul 1
**Assert:** F1 has expired_at set (superseded by F2). F2 has expired_at set (superseded by F3). F3 is active. Point-in-time queries return correct employer at Feb, May, Aug.

### SC-02: 5-level chain stress test
**Setup:** Create 5 sequential exclusive facts on same entity/predicate.
**Assert:** Exactly 1 active fact at any given point. `getActiveFacts()` returns only the latest.

### SC-03: Pre-seeded 3-level timeline with boundary queries
**Setup:** Use createTestFact with explicit valid_at/invalid_at for 3-level chain.
**Assert:** Query at each transition boundary returns correct fact.

### SC-04: Back-dated fact (non-overlapping)
**Setup:** F1: works_at Acme, valid Jan-Jun. F2: works_at Google, valid Jul-now. Then insert F3: works_at Startup, valid_at Mar (between F1 range).
**Assert:** F3 overlaps F1 (both exclusive). F1 should be superseded. F2 unaffected.

### SC-05: Back-dated fact (overlapping exclusive)
**Setup:** Active fact works_at Google (Jul-now). Insert back-dated fact works_at Meta valid_at May.
**Assert:** Overlap detected. Supersession resolves correctly.

### SC-06: expired_at vs invalid_at semantic distinction
**Setup:** Create fact F1. Set expired_at (was wrong from start). Create fact F2. Set invalid_at (was true, no longer).
**Assert:** `facts_at_time(entity, 'works_at', past_date)` returns F2 (was valid then) but not F1 (was always wrong).

### SC-07: findSupersedingFacts() direct test
**Setup:** 3-level chain with known date ranges.
**Action:** Call findSupersedingFacts() with a date range overlapping the middle fact.
**Assert:** Returns the overlapping fact(s). Document whether it walks the full chain or just finds direct overlaps.

### SC-08: Non-exclusive predicates — all remain active
**Setup:** Create 3 "knows" facts (non-exclusive) on same entity.
**Assert:** All 3 active. No supersession. `getActiveFacts()` returns all 3.

### SC-09: Mixed exclusive/non-exclusive on same entity
**Setup:** Entity with: works_at Acme (exclusive), knows Alice (non-exclusive), knows Bob (non-exclusive). Add works_at Google.
**Assert:** works_at Acme superseded. Both "knows" facts untouched.

### SC-10: Conflict-resolution agent with 3-level chain
**Setup:** Create 3 sequential contradicting facts for same exclusive predicate via agent.
**Assert:** Agent sets both expired_at AND invalid_at on superseded facts (unlike service-layer which only sets expired_at).

### SC-11: Query at exact valid_at (inclusive)
**Setup:** Fact with valid_at = T.
**Assert:** Query at T returns the fact.

### SC-12: Query at exact invalid_at (exclusive)
**Setup:** Fact with invalid_at = T.
**Assert:** Query at T does NOT return the fact.

### SC-13: Query at transition point
**Setup:** F1 invalid_at = T, F2 valid_at = T (half-open intervals, no overlap).
**Assert:** Query at T returns F2 only (not F1).

### SC-14: Zero-duration fact
**Setup:** Fact with valid_at = T, invalid_at = T.
**Assert:** Never queryable (empty interval [T, T) contains no points).

### SC-15: Overlapping ranges for exclusive predicates
**Setup:** F1 valid [Jan, Jun), F2 valid [Mar, Sep) — both exclusive same predicate.
**Assert:** Overlap detected by findSupersedingFacts(). One must be superseded.

### SC-16: facts_at_time() SQL function
**Setup:** 3-level chain with known timestamps.
**Action:** Call `facts_at_time(entity_id, 'works_at', query_time)` directly via SQL.
**Assert:** Returns correct fact for each query time. Excludes expired_at facts.

### SC-17: getEntityFacts() inconsistent filtering bug
**Setup:** Entity with active and invalidated facts.
**Action:** Call getEntityFacts() with subject only, then with subject+object.
**Assert:** Both should exclude invalidated facts. Document if behavior differs (latent bug).

## Test File

**Location:** `platform/src/test/integration/fact-supersession-chains.test.ts`

**Imports:**
```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { testDb, createTestEntity, createTestFact, getActiveFacts, deleteFromTables } from '../setup.js';
```

## Dependencies

- **Required:** PostgreSQL
- **Not needed:** ML Services, Qdrant, Apache AGE, Ollama

## Setup Pattern

Each test creates its own entity + fact chain to avoid interference. Use `deleteFromTables('facts', 'entities')` in `beforeEach` or use unique entities per test.
