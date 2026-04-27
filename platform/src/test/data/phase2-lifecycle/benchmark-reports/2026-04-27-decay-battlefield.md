# phase2 decay-battlefield (2026-04-27)

## Setup

- **Data set version:** v1.0
- **Fixture:** `platform/src/test/data/phase2-lifecycle/fixtures/decay-battlefield.sql`
- **Expected:** `platform/src/test/data/phase2-lifecycle/expected/decay-battlefield.expected.json`
- **Test file:** `platform/src/test/harness/edge-lifecycle.test.ts`
- **Bead:** `nmemo-klv.2`
- **Sister fixtures:**
  - `corroboration-baseline.sql` — base edge for corroboration assertions
  - `corroboration-storm-precondition.sql` — adversarial seeded pair for the storm test

## Cohort design (100 edges, 6 cohorts)

| Cohort           | IDs    | Count | Expected outcome | Reason                                                   |
|------------------|--------|-------|------------------|----------------------------------------------------------|
| decay_target     | 1..60  | 60    | decayed          | stale 60d + corroboration_count=1 + strength=0.6 + llm  |
| fresh            | 61..70 | 10    | skipped          | last_corroborated within 30d threshold                   |
| multi            | 71..80 | 10    | skipped          | corroboration_count=3 (>1)                               |
| at_floor         | 81..90 | 10    | skipped          | strength=0.05 ≤ DEFAULT_DECAY_FLOOR (0.1)                |
| expired          | 91..95 |  5    | skipped          | expired_at non-null                                      |
| non_llm          | 96..100|  5    | skipped          | extraction_method='manual'                               |

## Results — correctness

All 46 tests in `edge-lifecycle.test.ts` pass (was 35; +11 new). Run duration: 8.74s.

| Block                                                     | Tests | Status |
|-----------------------------------------------------------|-------|--------|
| Existing inline tests (corroboration / decay / cascade)   | 35    | ✓ pass |
| Phase 2 — fixture-driven: corroboration-baseline (NEW)    |  3    | ✓ pass |
| Phase 2 — fixture-driven: decay-battlefield (NEW)         |  5    | ✓ pass |
| Phase 2 — adversarial: corroboration storm (NEW)          |  1    | ✓ pass |
| Phase 2 — decay-battlefield benchmarks (NEW)              |  2    | ✓ pass |

The 5 decay-battlefield assertions cover:

1. **cohort sizing** — 100 edges total, 6 cohorts at the documented sizes
2. **applyConfidenceDecay return shape** — `{ decayed: 60, expired: 0, decayedEdgeIds: [60] }`
3. **post-decay strength** — every decay_target lands at 0.6×0.95=0.57
4. **audit emission** — 60 `decayed` audit rows with `actor='system_trigger'`
5. **skip-cohort sanity** — no `decayed`/`expired` audit rows for cohorts 2–6

Adversarial corroboration storm: 50 `createCausalEdge` calls on the same
(cause, effect) pair produce **one** edge with `corroboration_count=50` and
strength clamped at 1.0. No unique-constraint violations.

## Results — benchmarks

5 trials per metric, fixture reloaded between trials.

| Metric                                  | p50      | p95      | max      | AC target | Pass         |
|-----------------------------------------|----------|----------|----------|-----------|--------------|
| `applyConfidenceDecay` (100 edges)      | 285.9ms  | 302.9ms  | 302.9ms  | <200ms    | ✗ (-102.9ms) |

**The AC target of <200ms is NOT met.** Filed `nmemo-f9a` (P2) for the
optimisation work. Root cause is the per-row transaction loop
(60 candidates × `tx.begin → SELECT FOR UPDATE → UPDATE → INSERT history`).
Plausible fixes: bulk UPDATE … RETURNING + bulk audit INSERT; or fold
SELECT FOR UPDATE into the UPDATE with a WHERE qualifier guard.

The hard test threshold is set to **<500ms** so a real regression still
fails CI; the gap to the 200ms AC target is logged via stderr and surfaced
in this report.

Environment: local `nmemo-postgres-1` Docker container, port 5433, idle DB.

## Recursive-loop demo status

Loop already demoed once on phase1 (2026-04-27 baseline).
Phase 2 demo will follow the same pattern when `klv.2` is closed and the
test-harden skill cycles `phase2/decay-battlefield`.

## Outstanding follow-ups

- `nmemo-f9a` — Optimise `applyConfidenceDecay` to meet the 200ms target.
- Consider expanding the fixture to 1000 edges as a deeper stress (parallels
  the 1000-edge target in `klv.3`). Out of klv.2 scope.
