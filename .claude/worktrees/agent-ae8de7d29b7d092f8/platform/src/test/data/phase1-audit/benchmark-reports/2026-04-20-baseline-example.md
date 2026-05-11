# Phase 1 Audit — simple-mutations (2026-04-20) — EXAMPLE

**Note:** This is an example report showing format. Replace with real results once Phase 1 lands.

## Setup

- **Data set version:** v1.0
- **Fixture:** `platform/src/test/data/phase1-audit/fixtures/simple-mutations.sql`
- **Expected:** `platform/src/test/data/phase1-audit/expected/simple-mutations.expected.json`
- **Code commit:** `<sha-pending-implementation>`
- **Test run seed:** `42`
- **Machine:** Windows 11, 16GB, PostgreSQL 15 in Docker

## Results

- **Assertions:** 6 / 6 (example — pending implementation)
- **Duration:** 287ms
- **DB state after:** 2 entities, 1 fact, 3 history rows

## Metrics

| Metric | Value | Target | Pass |
|--------|-------|--------|------|
| `recordFactChange` latency (p50) | 4ms | <5ms | ✓ |
| `recordFactChange` latency (p99) | 12ms | <15ms | ✓ |
| `getFactHistory` (3 rows) | 8ms | <50ms | ✓ |
| Total mutation duration | 74ms | <100ms | ✓ |
| Actor attribution correctness | 3/3 | 3/3 | ✓ |
| Audit atomicity | 100% | 100% | ✓ |

## Findings

**All pass** (example output). Baseline established.

Notes:
- Trigger-based causal_event creation adds ~2ms per createFact — within budget
- `updateFactConfidence` does a SELECT + UPDATE + recordFactChange in one transaction — verified atomic

Recommendation: keep this as the Level 1 baseline. Generate Level 1 concurrent-races fixture next.

## Next Iteration

- Add `phase1-audit/fixtures/concurrent-races.sql` (100 parallel createFact on same subject)
- Benchmark target: no lost audit rows, no lost entities under 100-way concurrency
- Expected issues to watch for: advisory-lock contention, auto-increment gap in history IDs (should be gen_random_uuid, gap-tolerant)

## Raw Log

```
$ pnpm vitest run src/test/harness/audit-trail.test.ts

RUN  v0.34.6 /nmemo/platform

  ✓ audit-trail.test.ts (6)
    ✓ fact_history — creation path
      ✓ writes history row when createFact inserts (48ms)
      ✓ links history row to the emitted causal_event (52ms)
    ✓ fact_history — mutation paths
      ✓ writes previous and new confidence on updateFactConfidence (71ms)
      ✓ writes expired event with actor=reasoning_agent and reasoning (63ms)
    ✓ constraints and validation
      ✓ rejects invalid actor values at the DB level (24ms)
    ✓ MCP tool: get_fact_history
      ✓ returns structured history via the MCP handler (29ms)

  Test Files  1 passed (1)
       Tests  6 passed (6)
    Duration  287ms
```
