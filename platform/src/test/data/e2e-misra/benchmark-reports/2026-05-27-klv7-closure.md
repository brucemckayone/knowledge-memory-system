# E2E MISRA Benchmark — klv.7 closure (2026-05-27)

## Bead

`nmemo-klv.7` — TEST-E2E: End-to-end MISRA benchmark (bad C++ → violation query)

## Acceptance criteria mapping

| Bead bullet | Artifact | Status |
|-------------|----------|--------|
| Benchmark queries JSON | `platform/src/test/data/e2e-misra/queries.json` — 8 curated queries (7 positive across Chapter 22 rules 22.1, 22.3, 22.5, 22.6, 22.7/22.8, 22.9, 22.10 + 1 negative-control out-of-chapter snippet) with bad C++ snippets, questions, expected rule citations, expected rule topics, and ground-truth answers | DONE |
| Expected rule citations documented | Per-query `expected_rule_citations` (canonical `MISRA-CPP-2023-Rule-22.X` ids) + `expected_rule_topics` cross-referenced to entity property `topic` strings in the L3 fixture `misra-chapter-impact.sql` | DONE |
| Semantic similarity scoring functional | `platform/src/test/data/e2e-misra/scoring.ts` exposes `detectRuleCitations` (substring over canonical + alias forms), `detectAnyChapter22Citation` (negative-control guard), `scoreQuery` (per-query rule-hit + cosine on optional embedder), `runBenchmark` (aggregate rule-hit rate + mean cosine + verdict). 8 unit tests in `platform/src/test/integration/e2e-misra-benchmark.test.ts` prove the scaffold is functional end-to-end against a deterministic stub embedder. | DONE |

## Corpus shape

```
queries.json
├─ name: "e2e-misra-benchmark"
├─ version: "1.0"
├─ corpus_anchor:
│    live_db:   live cognitive DB carries the MISRA/AUTOSAR/C++ technical-standards corpus
│                (~145 entities per canonical-corpus.json)
│    fixture:   platform/src/test/data/phase4-blastradius/fixtures/misra-chapter-impact.sql
│                (10 MISRA C++:2023 Chapter 22 rules + 4 supporting concept entities)
├─ scoring_protocol:
│    rule_citation:    fuzzy-substring-then-semantic over canonical id + alias forms
│    answer_semantic:  cosine on nomic-embed-text (768-dim)
│    aggregate:        rule_hit_rate_pass=0.6, target=0.8; answer_mean_cosine_pass=0.65
└─ queries: [Q1..Q8]
```

Per-query coverage:

| Q | Rule(s) targeted | Topic                                       | Snippet violation                          |
|---|------------------|---------------------------------------------|--------------------------------------------|
| 1 | 22.3 + 22.2      | smart_pointer_usage + raii_required         | raw `new`/no `delete`                      |
| 2 | 22.7 + 22.8      | delete_must_match_new + array form          | `delete` on `new[]`                        |
| 3 | 22.9 + 22.5      | no_double_free + dangling                   | double `delete`                            |
| 4 | 22.5             | no_dangling_pointer_dereference             | return ptr to local                        |
| 5 | 22.6             | raw_pointer_arithmetic_forbidden            | `++p` loop                                 |
| 6 | 22.10            | weak_ptr_must_be_locked                     | direct `*w` deref                          |
| 7 | 22.1             | heap_allocation_forbidden_in_safety_critical | `std::vector` in real-time path           |
| 8 | (none)           | out-of-chapter-22 negative control          | uninitialised variable                     |

## Scoring scaffold — pure (live-infra-independent) verification

`platform/src/test/integration/e2e-misra-benchmark.test.ts` runs 13 tests:

```
$ pnpm vitest run src/test/integration/e2e-misra-benchmark.test.ts

 Test Files  1 passed (1)
      Tests  13 passed | 1 skipped (14)
Type Errors  no errors
   Duration  328ms
```

The 13 green tests prove:

1. **Schema invariants** (5 tests) — corpus loads; aggregate thresholds are sane; every query has all required fields; at least one negative-control query exists; every positive query cites a rule that lives in the L3 chapter-22 fixture (so the agent can reason from fixture alone if the live DB isn't loaded).
2. **Rule-citation matching** (2 tests) — `detectRuleCitations` catches `MISRA-CPP-2023-Rule-22.3` / `Rule 22.3` / `R22.3` / `rule 22.3` etc., and rejects non-matches. `detectAnyChapter22Citation` catches *any* Rule 22.X reference (used for negative-control queries).
3. **Per-query scoring** (4 tests) — `scoreQuery` returns `rule_citation_hit=true` + answer cosine > 0.5 on a perfect positive answer; flips to `passed=false` when the agent cites the wrong rule; passes a negative-control query when no Chapter 22 rule is cited; flips to `passed=false` when the agent falsely cites a Chapter 22 rule on a negative-control snippet.
4. **Aggregation** (2 tests) — `runBenchmark` computes rule_hit_rate=1.0 + verdict=pass on a perfect stub answerer; flips to rule_hit_rate=0 + verdict=fail when the answerer always returns "I do not know."

The 1 skipped test is the live-run describe block, which is gated on `MISRA_BENCHMARK_LIVE=1` (see protocol below).

## Live-run protocol (deferred — mirrors nmemo-2yv.108)

The live block in `e2e-misra-benchmark.test.ts` calls the platform's actual reasoning path:

```
for each Q in queries.json:
  answer = invokeReasoningAgent({
    mode:     'query',
    question: `Source C++ snippet:\n\`\`\`cpp\n${Q.snippet}\n\`\`\`\n\n${Q.question}`,
  }).result
  per_query[Q.id] = scoreQuery(Q, answer, embedder = ml.embed)
verdict = runBenchmark(corpus, answerer, embedder)
```

It is skipped by default for two compounding reasons (the same reasons that justify nmemo-2yv.108's Linux-Linux-defer pattern):

1. **`invokeReasoningAgent` posts to `ml-services` `/reasoning-agent`**, which shells out to Claude Code with the reasoning-agent MCP config. That requires (a) ml-services running on `127.0.0.1:8000` (`cd ml-services && make ml`), (b) Claude Code CLI on PATH, and (c) the live cognitive DB carrying the MISRA/AUTOSAR/C++ corpus. None of those are guaranteed in vitest's `cognitive_test` database.
2. **Running 8 queries through Claude Code is slow** (estimated 30-120s per query × 8 = 4-16min wall-clock) and consumes paid API quota. Gating it behind an explicit env opt-in matches the canonical-corpus.json pattern (`source: "live-dev-db"` rather than `cognitive_test`).

### How to run the live block

```powershell
# Prereqs (host):
#   - ml-services up:               cd ml-services; make ml
#   - Claude Code CLI on PATH:      where.exe claude   (expects a hit)
#   - Live cognitive DB seeded with the MISRA/AUTOSAR/C++ corpus
#     (or, at minimum, the L3 chapter-22 fixture loaded into the dev DB)

cd platform
$env:MISRA_BENCHMARK_LIVE = "1"
$env:DATABASE_URL = "postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_dev"
pnpm vitest run src/test/integration/e2e-misra-benchmark.test.ts -t "live run"
```

The live block:

1. Verifies `ml-services` is reachable (`GET /health`); skips with a console warning if not.
2. Iterates `queries.json` and calls `invokeReasoningAgent` per query.
3. Embeds expected + actual answers via `ml.embed` (nomic-embed-text, 768-dim).
4. Logs `[e2e-misra-benchmark] live result: {...}` with the full `BenchmarkResult` JSON.
5. Asserts `rule_hit_rate >= 0.6` and (when embeddings landed) `answer_mean_cosine >= 0.65`.

### Capture a benchmark report (per re-run)

After a successful live run, paste the logged JSON into a new dated report alongside this one:

```
platform/src/test/data/e2e-misra/benchmark-reports/YYYY-MM-DD-live-run.md
```

Use the structure:

```
# E2E MISRA Benchmark — live run (YYYY-MM-DD)

## Setup
- Code commit: <SHA>
- Machine: <OS / docker / PG version>
- DB: cognitive_dev with MISRA/AUTOSAR/C++ corpus (entity count: N)
- ml-services: <commit / image>
- Model: <reasoning-agent model id>

## Results
- rule_hit_rate: X / 7 = Y%
- answer_mean_cosine: Z (over 8 queries)
- verdict: pass / fail
- per-query table (id, category, matched_rules, answer_cosine, passed, notes)
```

This matches the structure nmemo-2yv.108 used for the Re-measurement section in `phase4-blastradius/benchmark-reports/2026-04-28-baseline.md`.

## Deviation note

Per the bead body: "If the live infrastructure (Claude CLI, ml-services) isn't trivially available in tests, document a deferred runnable protocol like .108 did rather than executing live. The acceptance just needs the JSON + scoring scaffold + documented protocol." That is exactly the shape landed here:

- JSON queries: `platform/src/test/data/e2e-misra/queries.json` (8 queries, 7 positive + 1 negative-control).
- Scoring scaffold: `platform/src/test/data/e2e-misra/scoring.ts` (4 exported functions, all verified by 8 unit tests against a deterministic stub embedder).
- Documented protocol: this file's "Live-run protocol (deferred)" section plus the live `describe` block in the test file (which is the executable form of the protocol).

The live block is wired but skipped by default; it is the *executable* form of the protocol. A future run with `MISRA_BENCHMARK_LIVE=1` against the live dev DB will produce the first dated live-run report.

## Out of scope (intentional)

- **Loading the L3 chapter-22 fixture into the live block.** The live block uses the live cognitive DB; loading the fixture into `cognitive_test` would lose the agent's semantic-search surface (Qdrant memories from the live corpus). The fixture's purpose for this benchmark is to anchor the corpus shape — what rules + topics the agent is reasoning against — not to substitute for the live DB.
- **Tightening the rule-hit-rate pass bar above 0.6.** A 0.6 bar on 7 positive queries (= at least 4 hits) is the minimum credible signal. The 0.8 stretch target is in the scoring protocol; the first live run will inform whether to promote it to the pass bar.
- **Multi-hop reasoning queries** (e.g. "this snippet violates the chapter-root rule's downstream effect at depth 3"). The L3 fixture supports those tests via `analyzeImpact` already (see klv.4); the e2e benchmark deliberately keeps each query bounded to one or two adjacent rules so per-query scoring stays interpretable.

## Files landed under this bead

- `platform/src/test/data/e2e-misra/queries.json` — corpus.
- `platform/src/test/data/e2e-misra/scoring.ts` — scoring scaffold.
- `platform/src/test/integration/e2e-misra-benchmark.test.ts` — 13 unit tests + 1 deferred live test.
- `platform/src/test/data/e2e-misra/benchmark-reports/2026-05-27-klv7-closure.md` — this file.
