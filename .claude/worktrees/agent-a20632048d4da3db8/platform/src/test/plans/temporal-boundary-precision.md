# Temporal Boundary Precision Tests

## Precision Analysis

| System | Precision | Notes |
|--------|-----------|-------|
| PostgreSQL `timestamptz` | Microsecond (6 decimal places) | Full μs precision |
| JavaScript `Date` | Millisecond (3 decimal places) | Truncates μs |

**Implication:** No precision loss going JS -> PG (JS ms fits in PG μs). But PG -> JS rounds to nearest ms. If PG stores `2024-06-01T00:00:00.000001Z`, JS reads it as `2024-06-01T00:00:00.000Z`. This could affect boundary comparisons if μs-precision timestamps are stored by raw SQL.

## Temporal Conventions (from code)

The `facts_at_time()` SQL function (004_facts.sql) uses:
```sql
valid_at <= query_time AND (invalid_at IS NULL OR invalid_at > query_time) AND expired_at IS NULL
```

This confirms:
- **`valid_at` is INCLUSIVE** — fact is true starting AT this moment
- **`invalid_at` is EXCLUSIVE** — fact was true UP TO but NOT INCLUDING this moment
- **Half-open interval: `[valid_at, invalid_at)`**
- **NULL `invalid_at`** = still true (open-ended: `[valid_at, +inf)`)
- **NULL `valid_at`** = undocumented; `valid_at <= query_time` would be `NULL <= T` which is NULL (falsy in SQL), so fact would NEVER be returned. This is effectively an error state.
- **`expired_at` NOT NULL** = record was wrong, excluded from all queries regardless of valid_at/invalid_at

## Existing Test Gaps

- T1-T8 use whole dates (`new Date('2024-01-01')`), never milliseconds
- No test at exact boundary timestamps
- No test for NULL valid_at behavior
- No test for zero-duration facts
- No timezone handling tests
- No test confirms the inclusive/exclusive convention

## Test Scenarios

### TBP-001: Query at exact valid_at (inclusive — INCLUDED)
**Setup:** Fact with `valid_at = 2024-06-01T12:00:00.000Z`, `invalid_at = NULL`.
**Query:** `facts_at_time(entity, predicate, '2024-06-01T12:00:00.000Z')`
**Assert:** Fact IS returned. Confirms valid_at is inclusive.

### TBP-002: Query at exact invalid_at (exclusive — EXCLUDED)
**Setup:** Fact with `valid_at = 2024-01-01`, `invalid_at = 2024-06-01T12:00:00.000Z`.
**Query:** `facts_at_time(entity, predicate, '2024-06-01T12:00:00.000Z')`
**Assert:** Fact is NOT returned. Confirms invalid_at is exclusive.

### TBP-003: Query 1ms before invalid_at (INCLUDED)
**Setup:** Same fact as TBP-002.
**Query:** `facts_at_time(entity, predicate, '2024-06-01T11:59:59.999Z')`
**Assert:** Fact IS returned.

### TBP-004: Query 1ms after valid_at (INCLUDED)
**Setup:** Same fact as TBP-001.
**Query:** `facts_at_time(entity, predicate, '2024-06-01T12:00:00.001Z')`
**Assert:** Fact IS returned.

### TBP-005: Zero-duration fact (valid_at === invalid_at)
**Setup:** Fact with `valid_at = T`, `invalid_at = T` (same timestamp).
**Query:** `facts_at_time(entity, predicate, T)`
**Assert:** Fact is NOT returned. Half-open interval `[T, T)` is empty. Document: zero-duration facts are never queryable.

### TBP-006: NULL invalid_at = open-ended
**Setup:** Fact with `valid_at = 2024-01-01`, `invalid_at = NULL`.
**Query:** `facts_at_time(entity, predicate, '2099-12-31')`
**Assert:** Fact IS returned. NULL invalid_at means "still true forever".

### TBP-007: NULL valid_at = never queryable
**Setup:** Insert fact with `valid_at = NULL` via raw SQL (bypass service layer).
**Query:** `facts_at_time(entity, predicate, any_date)`
**Assert:** Fact is NOT returned (NULL <= T is NULL, falsy). Document: NULL valid_at is an invalid state; service layer should prevent it.

### TBP-008: Exclusive predicate boundary — no overlap with half-open intervals
**Setup:** Create two facts for same exclusive predicate:
- F1: `valid_at = Jan 1`, `invalid_at = Jun 1`
- F2: `valid_at = Jun 1`, `invalid_at = NULL`
**Assert:** These do NOT overlap. `[Jan, Jun)` and `[Jun, +inf)` are disjoint. No conflict should be detected.

### TBP-009: Exclusive predicate overlap by 1ms
**Setup:** Two facts for same exclusive predicate:
- F1: `invalid_at = T`
- F2: `valid_at = T - 1ms`
**Assert:** Overlap detected. `[F1.valid_at, T)` and `[T-1ms, F2.invalid_at)` overlap by 1ms. findSupersedingFacts() should find the conflict.

### TBP-010: Back-dated correction
**Setup:** Active fact: works_at Google, `valid_at = Jul 1`. Insert new fact: works_at Meta, `valid_at = Mar 1` (before existing).
**Assert:** Both facts have overlapping ranges for exclusive predicate. findSupersedingFacts() detects the overlap.

### TBP-011: Timezone handling
**Setup:** Create fact with `valid_at = new Date('2024-06-01')` (local TZ interpretation varies).
**Assert:** Stored as UTC in PostgreSQL. Read back matches. No TZ drift between insert and query.

### TBP-012: Microsecond truncation
**Setup:** Insert fact via raw SQL with μs precision: `valid_at = '2024-06-01T12:00:00.000001Z'`.
**Action:** Read back via JS service layer.
**Assert:** JS Date truncates to `2024-06-01T12:00:00.000Z`. Document: μs precision is lost in JS layer. All comparisons should use ms-precision timestamps.

## Convention Recommendations

| Case | Convention | Rationale |
|------|-----------|-----------|
| valid_at boundary | Inclusive | Matches SQL: `valid_at <= T` |
| invalid_at boundary | Exclusive | Matches SQL: `invalid_at > T` |
| NULL invalid_at | Open-ended (still true) | Matches SQL: `invalid_at IS NULL` clause |
| NULL valid_at | Invalid state — prevent | `NULL <= T` is NULL (falsy), fact invisible |
| Zero-duration | Empty interval — prevent or allow as tombstone | `[T, T)` contains no points |
| Timestamp precision | Use milliseconds in JS, let PG store as μs | Avoid μs-only comparisons from JS |

## Test File

**Location:** `platform/src/test/integration/temporal-boundary-precision.test.ts`

**Imports:**
```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { testDb, createTestEntity, createTestFact, deleteFromTables } from '../setup.js';
```

## Dependencies

- **Required:** PostgreSQL
- **Not needed:** ML Services, Qdrant, Ollama, Apache AGE
