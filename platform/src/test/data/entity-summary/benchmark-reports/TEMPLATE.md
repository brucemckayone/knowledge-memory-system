# Entity-Summary Benchmark — <scenario> (<YYYY-MM-DD>)

> Template for benchmark reports against the entity-summary feature (write
> path = causal-agent.ts:1679 update_entity_summary handler; read paths =
> entity-profile.ts getEntityProfile + the .51 GET /api/entity/:id/profile
> endpoint once landed; viz panel = .52 detail.js summary block).
>
> One report per fixture-driven test run. Fill in the sections below and
> commit alongside the test artefacts. The test-harden skill consumes these
> reports to detect regressions in the four headline metrics.

## Setup

- **Data set version:** v<major>.<minor>
- **Fixture:** `platform/src/test/data/entity-summary/fixtures/<name>.sql`
- **Expected:** `platform/src/test/data/entity-summary/expected/<name>.expected.json` (if applicable)
- **Code commit:** `<git sha>`
- **Test run seed:** `<random seed if stochastic, else "deterministic">`
- **Machine:** `<OS / CPU if perf matters>`

## Results

- **Assertions:** `<passed> / <total>`
- **Duration:** `<ms>`
- **DB state after:** `<summary — e.g. '6 entities, 5 entity_meta, 1 oversize, 1 stale'>`

## Metrics

The four headline metrics for this feature. Targets are doc-stamped — pull
the latest from `docs/architecture/truth-graph/37-entity-living-summary.md` §9.

### 1. Summary-length distribution

Per-fixture-run characterisation of the persisted `entity_meta.summary`
column across all written rows. Useful for catching drift in agent verbosity
and for sizing the .53 hard cap.

| Statistic | Value | Target (doc 37 §9) | Pass |
|-----------|-------|--------------------|------|
| count(summary IS NOT NULL) | <n> | n/a | n/a |
| min(length) | <n> | ≥ 50 | ✓ / ✗ |
| p50(length) | <n> | 400-1500 | ✓ / ✗ |
| p95(length) | <n> | ≤ 2000 (.53 soft cap) | ✓ / ✗ |
| max(length) | <n> | ≤ 3000 (.53 hard cap) | ✓ / ✗ |

### 2. Writes-per-patrol

Across a patrol invocation (graph_agent + causal_agent + reconciliation tail),
how many distinct entities had `update_entity_summary` called on them?
Surfaces the agent's coverage policy. A patrol that writes 0 summaries
indicates the agent doesn't see fresh material; a patrol that writes >50%
of entities indicates over-writing (potentially erasing nuance).

| Statistic | Value | Target | Pass |
|-----------|-------|--------|------|
| distinct entities written | <n> | < 0.3 × total entities (rough heuristic) | ✓ / ✗ |
| total update calls | <n> | 1.0-1.5 × distinct entities (no per-entity over-write) | ✓ / ✗ |
| zero-write patrols / total patrols | <ratio> | n/a (descriptive) | n/a |

### 3. First-write vs update ratio

Distinguishes net-new summaries (first write into NULL) from rewrites
(overwrite of an existing summary). High first-write rate = agent is
catching up on a backlog; high update rate = the corpus is mature.

| Statistic | Value | Target | Pass |
|-----------|-------|--------|------|
| first-writes (summary WAS NULL) | <n> | n/a | n/a |
| updates (summary HAD a value) | <n> | n/a | n/a |
| first-write ratio | <n_first / n_total> | descriptive | n/a |
| diff-size on update (p50 % char-diff) | <n>% | < 80 (.53 follow-up — bulk overwrite probe) | ✓ / ✗ |

### 4. Stale-write rate (post .55)

After bead .55 lands optimistic locking, how often does an attempted write
fail the `summary_updated_at` precondition (concurrent writer beat us)?
A non-trivial stale-write rate validates the locking is doing work; a
0% rate over many patrols may mean the locking is dead code.

| Statistic | Value | Target | Pass |
|-----------|-------|--------|------|
| stale-write attempts (412-ish failures) | <n> | descriptive | n/a |
| stale-write rate (failures / total writes) | <ratio> | < 0.1 (under contention) | ✓ / ✗ |
| max retries before success | <n> | ≤ 3 | ✓ / ✗ |

> Until .55 is closed this section is N/A — record N/A in every cell and
> note "blocked on .55" in Findings.

## Findings

<One of:>

- **All pass.** No anomalies. Recommendation: <graduate to next fixture | maintain as regression baseline>.
- **<N> failures.** Summary of what failed. Filed: <bd issue id(s)>.
- **Drift detected.** Metric X moved from <previous baseline> to <current>. Likely commit range: <SHA..SHA>. Investigate.

## Next Iteration

- <concrete fixture change>
- <next scenario to add — see .56 follow-ups for staged graduations>
- <metric target revision if real-world data updates baseline>

## Raw Log

<optional — psql output, vitest log, or curl JSON for debugging>
