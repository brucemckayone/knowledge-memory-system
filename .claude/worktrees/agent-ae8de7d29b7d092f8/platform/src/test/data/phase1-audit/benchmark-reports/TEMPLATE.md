# Phase <N> <Phase Name> — <scenario> (<YYYY-MM-DD>)

## Setup

- **Data set version:** v<major>.<minor>
- **Fixture:** `platform/src/test/data/<path/to/fixture.sql>`
- **Expected:** `platform/src/test/data/<path/to/scenario.expected.json>`
- **Code commit:** `<git sha>`
- **Test run seed:** `<random seed if stochastic>`
- **Machine:** `<OS/CPU if perf matters>`

## Results

- **Assertions:** `<passed> / <total>`
- **Duration:** `<ms>`
- **DB state after:** `<summary — e.g. '5 entities, 3 facts, 9 history rows'>`

## Metrics

| Metric | Value | Target | Pass |
|--------|-------|--------|------|
| <metric-name> | <measured> | <target from doc> | ✓ / ✗ |

## Findings

<One of:>

- **All pass.** No anomalies. Recommendation: <graduate to next level | add scenarios X/Y/Z | maintain as regression>.
- **<N> failures.** Summary of what failed and why. Links to beads issues filed (e.g. `nmemo-w4j.4` — bug in actor threading).
- **Performance regression.** Metric X degraded from <previous> to <current>. Investigate commit range.

## Next Iteration

- <concrete change to fixture or code>
- <next scenario to generate if graduating>
- <benchmark target to revise if real-world data changes baseline>

## Raw Log

<optional — truncated test output or psql session for debugging>
