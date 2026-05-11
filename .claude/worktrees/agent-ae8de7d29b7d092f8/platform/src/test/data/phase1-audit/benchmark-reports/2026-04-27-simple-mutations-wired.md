# phase1 simple-mutations — wired fixture run (2026-04-27)

## Setup

- **Data set version:** v1.2 (schema-aligned with live migration set)
- **Fixture:** `platform/src/test/data/phase1-audit/fixtures/simple-mutations.sql`
- **Expected:** `platform/src/test/data/phase1-audit/expected/simple-mutations.expected.json`
- **Test file:** `platform/src/test/harness/audit-trail.test.ts`
- **Bead:** `nmemo-klv.1`
- **Helper added:** `loadFixture(relativePath)` in `src/test/setup.ts` — strips outer
  `BEGIN/COMMIT` (postgres.js refuses raw transaction markers in `unsafe`) and
  runs the body inside `sql.begin()`. Returns `{ durationMs }`.

## Schema-drift fixes applied

The pre-existing v1.1 fixture targeted columns that no longer match the live
schema. Both were silent gaps because no test loaded the fixture before today.
Reconciled in this run:

| Object              | v1.1 (broken)                              | v1.2 (current)                                       |
|---------------------|--------------------------------------------|------------------------------------------------------|
| `causal_events`     | column `event_type`, value `'supersede'`   | column `transition_type`, value `'invalidated'`      |
| `reasoning_reports` | columns `(id, summary, created_at)`        | columns `(id, mode, report, created_at)` (mode='patrol') |

The `transition_type` enum (migration 002) is `'created' \| 'strengthened' \| 'weakened' \| 'expired' \| 'invalidated'`. `'invalidated'` is the closest semantic
fit because the seeded event is referenced by the fact_history rows for
`invalidated` (row 5) and `superseded` (row 7) — both transitions where the
prior fact stopped being treated as true.

## Results — correctness

All 43 tests in `audit-trail.test.ts` pass (was 29; +14 new). Run duration: 8.07s.

| Block                                                          | Tests | Status |
|----------------------------------------------------------------|-------|--------|
| Phase 1 — Audit Trail Foundation (existing inline tests)       | 22    | ✓ pass |
| Phase 1 — invalid-actors adversarial suite (fixture-driven)    |  1    | ✓ pass |
| Phase 1 — fixture-driven: simple-mutations (NEW)               | 10    | ✓ pass |
| Phase 1 — simple-mutations benchmarks (NEW)                    |  4    | ✓ pass |

The 10 fixture-driven assertions cover every entry in
`simple-mutations.expected.json`:

1. `row_count` — 8 fact_history rows
2. `column_sequence` ASC — forward-chronological lifecycle
3. `column_sequence` DESC — `getFactHistory` returns reverse-chrono
4. `actor_distribution` — all 7 actor values exercised
5. `column_values` — confidence_raised previous/new/actor
6. `column_values` — revised event links real reasoning_report
7. `foreign_key_integrity` — no dangling FKs (reasoning_report_id, causal_event_id, fact_id)
8. `orphan_retention` — DELETE on parent fact rejected (FK is RESTRICT, NOT NULL); 8 history rows survive
9. `limit_param` — `getFactHistory(factId, 3)` returns most-recent 3
10. `causal_event seed transition_type` regression guard — locks v1.2 schema alignment

## Results — benchmarks

100 iterations per metric. Targets per `klv.1` AC: mutation→audit <10ms,
history query <50ms. Targets per `simple-mutations.expected.json`
`benchmark_targets`: insert p95 <5ms, query p95 <10ms, query-with-limit p95 <8ms.
**All beat both target sets, comfortably.**

| Metric                           | p50   | p95   | max   | AC target | expected.json target | Pass |
|----------------------------------|-------|-------|-------|-----------|----------------------|------|
| `recordFactChange` (insert one)  | 2.33ms | 3.11ms | 3.98ms | <10ms | <5ms | ✓ |
| `getFactHistory` (8 rows)        | 1.59ms | 2.03ms | 2.25ms | <50ms | <10ms | ✓ |
| `getFactHistory` (limit=3)       | 1.51ms | 1.81ms | 2.09ms | <50ms | <8ms  | ✓ |

Environment: local `nmemo-postgres-1` Docker container, port 5433, idle DB.

## Recursive-loop demo status

The `/test-harden` recursive loop has been demoed once on this scenario
(2026-04-27 baseline run, see `2026-04-27-simple-mutations.md`). With this
report the loop now has a real wired fixture to evolve against — gap #1 of
`project_test_harden_skill.md` is closed.

## Outstanding follow-ups (not blocking klv.1)

- Adversarial fixtures `actor-escalation.sql`, `cascade-writes.sql`,
  `concurrent-races.sql` may have the same kind of schema drift — they're not
  yet loaded by tests, so any drift is dormant. Worth a sweep if/when they get
  wired.
- `nmemo-klv.2`, `nmemo-klv.3` (Phase 2/3 test data hardening) follow the same
  pattern: fixtures + expected + benchmark report + wired test.
