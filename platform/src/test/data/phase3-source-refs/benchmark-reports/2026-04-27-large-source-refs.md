# phase3 large-source-refs (2026-04-27)

## Setup

- **Data set version:** v1.0
- **Fixture:** `platform/src/test/data/phase3-source-refs/fixtures/large-source-refs.sql`
- **Expected:** `platform/src/test/data/phase3-source-refs/expected/large-source-refs.expected.json`
- **Test file:** `platform/src/test/harness/source-refs-index.test.ts`
- **Bead:** `nmemo-klv.3`
- **Sister fixture:** `drift-detected.sql` — adversarial drift between JSONB and edge_source_refs

## Fixture shape (1000 edges)

| Reference                                          | Type    | Cited by             |
|----------------------------------------------------|---------|----------------------|
| `aaaaaaaa-0000-0000-0000-000000000001`             | memory  | all 1000 edges (hot) |
| `aaaaaaaa-0001-0000-0000-{12hex(n)}` for n ∈ 1..1000 | memory  | edge n only          |
| `bbbbbbbb-0000-0000-0000-000000000001`             | fact    | edges 1..50          |

Total `edge_source_refs` rows after fixture load: **2050** (1000 hot + 1000 unique + 50 fact).

The fixture inserts edges directly (bypassing `syncEdgeSourceRefs`) and then
backfills `edge_source_refs` from JSONB using the same pattern as migration 010.

## Results — correctness

All 22 tests in `source-refs-index.test.ts` pass (was 10; +12 new). Run duration: 13.57s.

| Block                                                          | Tests | Status |
|----------------------------------------------------------------|-------|--------|
| Existing inline tests (sync, lookup semantics, drift on clean) | 10    | ✓ pass |
| Phase 3 — fixture-driven: large-source-refs (NEW)              |  5    | ✓ pass |
| Phase 3 — adversarial: drift-detected (NEW)                    |  3    | ✓ pass |
| Phase 3 — large-source-refs benchmarks (NEW)                   |  4    | ✓ pass |

The 5 large-source-refs assertions cover:

1. **scale** — 1000 edges and 2050 index rows seeded
2. **drift = 0** — JSONB and index in sync after fixture load
3. **hot lookup** — `findEdgesCitingReference('memory', HOT)` returns 1000
4. **unique lookup** — `findEdgesCitingReference('memory', unique-200)` returns 1 with the right edge
5. **mid lookup** — `findEdgesCitingReference('fact', shared-fact)` returns 50

The drift-detected adversarial verifies the *failure mode* the index exists
to surface: `findEdgesCitingReference` silently returns `[]` for a drifted
JSONB ref, and the drift query catches it with `count > 0`.

## Results — benchmarks

100 iterations per metric on the same loaded fixture (no reload between
iterations — measures pure read-path cost).

| Lookup type                | Result size | p50    | p95    | max    | AC target | Pass |
|----------------------------|-------------|--------|--------|--------|-----------|------|
| `memory` HOT (worst-case)  | 1000 rows   | 8.00ms | 12.23ms| 17.07ms| <50ms     | ✓    |
| `memory` UNIQUE (fast path)| 1 row       | 1.41ms | 1.73ms | 1.90ms | <50ms     | ✓    |
| `fact` (mid-cardinality)   | 50 rows     | 1.74ms | 2.30ms | 4.41ms | <50ms     | ✓    |

Phase 3's read path comfortably beats the AC target across the whole
cardinality spectrum. The hot 1000-row lookup is dominated by row
serialisation (drizzle `select({ edge: causalEdges })` returns full edge
rows); the join via `idx_edge_source_refs_lookup` is the cheap part.

Environment: local `nmemo-postgres-1` Docker container, port 5433, idle DB.

## Recursive-loop demo status

Loop already demoed once on phase1. Phase 3 demo follows the same pattern
when the test-harden skill cycles `phase3/large-source-refs`.

## Outstanding follow-ups

- The reverse-lookup result projection currently returns the full causal_edges
  row even when callers only need ids. A column-narrowed variant could shave
  serialisation cost on the hot path — only worth doing if a real workload
  surfaces it. Out of klv.3 scope.
- `nmemo-d1r.7` (P3 scheduled drift detection) covers running the drift query
  on a cron schedule; the drift-detected fixture above is the test target it
  will guard against.
