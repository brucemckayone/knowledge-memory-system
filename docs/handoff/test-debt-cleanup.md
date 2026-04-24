# Test debt cleanup — 2026-04-21

**Branch:** `feat/reasoning-agent`
**Context:** Session immediately after `nmemo-w4j` Phase 1 (audit trail)
closed. Goal was to sweep the pre-existing test debt flagged in
`phase1-findings.md` — remove tests that are out of date, fix the ones
that are still relevant, and accept the ones that test real product
quality (LLM-driven) as a signal rather than debt.

## Result

| | Before | After |
|---|---|---|
| Failed | 39 | **2** |
| Passed | 317 | 324 |
| Skipped | 15 | 31 |
| Total | 371 | 357 |

Both remaining failures are **genuine product-quality signal**, not
test debt:

| Test | Score | Threshold | Actionable |
|---|---|---|---|
| `extraction-quality E5` — contradiction TP rate | 16.7% (1/6) | 80% | Haiku `/check-contradiction` misses real contradictions |
| `extraction-quality E6` — contradiction TN rate | 25% (1/4) | 90% | Haiku `/check-contradiction` false-positives |

These belong to Phase 5 (contradiction detection) work. Do not lower
the thresholds.

## What was deleted

Per explicit scope decision: ingestion pipeline is not a focus until
the graph layer is solid, and the Frankenstein 10/20-min regression
baselines aren't exercised while the reasoning agent is under active
change.

- `src/test/e2e/message-pipeline.test.ts` — classify / embed / scrape /
  extract-task / transcribe round-trip. `src/test/e2e/` directory
  removed too.
- `src/test/harness/frankenstein.test.ts` — 10-chunk quality baseline
  (600s wall clock).
- `src/test/harness/frankenstein-serial.test.ts` — same, serial variant
  (1200s wall clock).
- `src/test/harness/pipeline.test.ts` — standalone `ingest()` assertions.
- `Ontology Stats Endpoint` describe block in
  `src/test/integration/ontology-api.test.ts` — the endpoint
  `/api/ontology/stats` was designed but never implemented, so the
  test was a phantom.

## What was test-code fixed

All of these were tests passing the **wrong** thing, either stale API
shapes or globally-scoped assertions that race under parallelism.

| File | Fix |
|---|---|
| `inverse-predicates-and-search.test.ts` HST-001/002 | `count(*)` → scoped to unique per-run tag |
| `entity-resolution-convergence.test.ts` ERC-PROP-001 | same tag-scoping |
| `entity-resolution.test.ts` ERC-001/007 | removed global `deleteFromTables`, scoped mention names to unique tag |
| `temporal-boundary-precision.test.ts` | removed `deleteFromTables('facts','entities')` from `beforeEach` — unique per-test entity name instead |
| `hybrid-search.test.ts` | Qdrant collection renamed to `memories_hybrid_search_test` (was sharing global `memories` with 6 other test files) |
| `qdrant.test.ts` QD-002 | stronger vector perturbation so HNSW ordering is deterministic |
| `gardener.test.ts` | top-level-await + `describe.skipIf(!HAS_GARDENER_TABLES)`. The previous `beforeAll + skipCtx` didn't propagate to nested describes — 17 phantom tests now skip cleanly instead of erroring |
| `ml-services.test.ts` ML-008 | `describe.skip` — hits external URL, fails with SSL cert-verify in offline/corporate env. Reinstate when a local fixture HTTP server is stood up |
| `causal-mcp.test.ts` / `causal-agent-tools.test.ts` | accept the enriched `{summary, aliases, facts}` handler shape as well as the legacy array shape |
| `extraction-quality.test.ts` E5/E6 | pointed at `/check-contradiction` (was `/detect-contradiction` — 404) |

## The config change that closed the rest

`vitest.config.ts` gained `fileParallelism: false`. Single-line fix.
Reasoning written out in the config comment:

> fileParallelism: false serializes file execution so cross-file
> cleanup hooks (deleteFromTables, TRUNCATE, broad DELETE FROM…)
> can't race each other. Tests within a file still run sequentially
> by default. Trade-off: slower wall clock on clean runs, but no
> flaky FK violations or global-state collisions.

Root cause: several test files call `deleteFromTables(...)` in
`beforeAll`/`beforeEach` hooks. `deleteFromTables` does an unscoped
`DELETE FROM <table>` — it nukes the table globally regardless of the
argument list. Under vitest's thread pool that means any file in a
sibling worker that's mid-test gets its rows yanked, producing FK
violations on triggers (notably `causal_edges_cause_event_id_fkey`
after `causal_events` rows are wiped, and
`entity_aliases_entity_id_fkey` after `entities` rows are wiped).

Known callers still using the global-destructive pattern:
- `src/test/harness/audit-trail.test.ts` (own Phase 1 suite — expects
  clean slate for comprehensive assertions)
- `src/test/quality/e2e-ml-judge.test.ts`
- `src/test/quality/retrieval-quality.test.ts`
- `src/test/quality/temporal-pipeline.test.ts` (in `quality/`, not
  `integration/`)
- `src/test/benchmarks/performance.bench.ts` (still uses
  `truncateTables`)

Serializing file execution is the pragmatic fix. Refactoring each
caller to use scoped cleanup would be a larger, riskier change; if
wall-clock becomes a problem later, split the suite into a "fast
parallel" tier and a "slow serial" tier with separate vitest configs.

## Wall-clock impact

Full suite with `fileParallelism: false`:
`Duration 2154s` (~36 minutes). That's dominated by LLM-heavy suites:
`extraction-quality` ~27 min, `retrieval-quality` similar,
`e2e-ml-judge` similar. The infrastructure tests (harness + integration
minus LLM) run in under 5 min total.

## Follow-ups

1. **Phase 5: improve the contradiction detector**
   Current Haiku-only `/check-contradiction` endpoint scores TP=16.7%,
   TN=25%. Must reach TP≥80% and TN≥90% for E5/E6 to go green.
   Requires prompt/model work in `ml-services/app/…`, not test code.

2. **Defer the test-suite tier split**
   If full-suite wall clock becomes painful, move the 3 `quality/*`
   files plus `audit-trail.test.ts` into a `slow` project in
   `vitest.config.ts` (or a second config file) and run the fast tier
   in parallel, slow tier serially.

3. **Harden `deleteFromTables`**
   Rename to `deleteFromTablesDangerous` or require an
   `{ acknowledgeGlobal: true }` flag so future callers can't
   accidentally nuke parallel workers again. Out of Phase 1 scope.

4. **Stand up a local fixture HTTP server for `/scrape` tests**
   ML-008 is currently skipped; if scraping becomes a focus again, add
   a tiny node http server in the test suite rather than hitting
   `https://example.com`.

## Files changed, at a glance

Production code: none.

Test files (10 edited, 4 deleted):
```
deleted:    src/test/e2e/message-pipeline.test.ts
deleted:    src/test/harness/frankenstein-serial.test.ts
deleted:    src/test/harness/frankenstein.test.ts
deleted:    src/test/harness/pipeline.test.ts
modified:   src/test/harness/causal-agent-tools.test.ts
modified:   src/test/harness/causal-mcp.test.ts
modified:   src/test/harness/entity-resolution.test.ts
modified:   src/test/integration/entity-resolution-convergence.test.ts
modified:   src/test/integration/gardener.test.ts
modified:   src/test/integration/hybrid-search.test.ts
modified:   src/test/integration/inverse-predicates-and-search.test.ts
modified:   src/test/integration/ml-services.test.ts
modified:   src/test/integration/ontology-api.test.ts
modified:   src/test/integration/qdrant.test.ts
modified:   src/test/integration/temporal-boundary-precision.test.ts
modified:   src/test/quality/extraction-quality.test.ts
modified:   vitest.config.ts
```
