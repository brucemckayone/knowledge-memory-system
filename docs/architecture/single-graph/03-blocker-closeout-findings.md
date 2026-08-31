# Blocker close-out — what was actually wrong, and what it changes

**Date:** 2026-08-31 · **Branch:** `feat/single-graph-retrieval` (from `feat/cross-corpus-audit`)
**Basis:** the blockers in `00-consolidated-keep-list.md` §1 and the kickoff order in `01-kickoff-goal.md`.
Every number below is measured against the live `cognitive` / `cognitive_test` databases or read off code.
Tags: **[M]** measured · **[C]** read off code.

---

## 0. The one-line summary

Nine defects are closed. Seven of them were **features reporting success while doing nothing**, which is
the failure mode the keep list §2.6 told us to hunt specifically. Two results are large enough to change
the plan:

1. **Graph C was empty for a one-line reason, and now populates ~130x better per document.** 9 causal
   edges from 294 documents (0.031/doc) became **120 edges from 30 documents** (4.0/doc) — a mid-ingest
   snapshot, see §2. **[M]**
2. **Filtered vector search silently truncated or returned nothing** — a corpus-scoped fact search
   returned **zero rows** where the true nearest fact sat at similarity 0.732. This affects every
   filtered vector query in the codebase, not just the one being fixed. **[M]**

---

## 1. Corrections to the keep list

Recorded first, because these change how the rest should be read.

| keep list said | actually |
|---|---|
| §2.5 "the 294-document substrate" | Lives in **`cognitive_test`**, not `cognitive`. `cognitive` has 4 entities / 2 facts. **[M]** |
| §0.2 "`facts.fact_embedding` is NULL on the epoch path" | True **at production defaults** but not on the substrate: `arxiv-nlp` 2,862/2,862 and `arxiv-cv` 2,852/2,852 facts DO carry embeddings, because both ingests ran with the flag on. Only `default`-corpus facts are NULL (0/136). The **read** end (`searchFacts`, zero callers) was broken unconditionally. **[M]** |
| §1 blocker 3 "all 2,512 canonical entities have `description` NULL" | Understated: **all 3,406 entities across all 8 corpora**. **[M]** |
| §1 blocker 4 "`fact_units` … returns `[]` and logs `fallback_skipped_no_anchor` — the wrong diagnosis" | Quieter and worse. `expandFromAnchors` returns **20 evidence rows for one anchor, every one with `units: []`** — success with zero usable text. And the root cause is a layer deeper: `facts.source_memory_id` is **NULL on all 6,538 facts in every corpus**, so the unit mapper could not run even if it were called. **[M]** |
| §1 blocker 5 "~1,071 AGE nodes / 2,000 edges" | Exact for `cognitive`. In `cognitive_test` it is **7,250 nodes / 5,670 edges against 3,513 entities / 6,039 active facts** — so AGE is simultaneously carrying **52% phantoms** and **missing real edges**. The drift runs both ways. **[M]** |
| §2 "the input corpora were never committed" (validity-harness row) | For the **arXiv substrate this is wrong**: `convergence-artifacts/corpus-A.json` and `corpus-B.json` (147 + 147 documents, title + abstract) are both **tracked in git**. The run is reproducible. The claim may still hold for the separate validity/benchmark corpora — not checked. **[M]** |

---

## 2. Graph C — a one-line bug held the whole layer empty

**The chain [C][M].** `_build_causal_prompt` renders every scope event, predicate and source text into
one string. `llm.py` passed it as `cmd = ["claude", "-p", prompt, ...]` — an **argv element**. Windows
`CreateProcess` caps the command line at 32,767 characters. The causal pass is non-fatal by design, so
every batch logged `[WinError 206] The filename or extension is too long`, the epoch reported success,
and the layer stayed empty. At `batch=1` the scope fits, so single-document tests passed and every real
run failed silently.

The fix already existed **fourteen lines below the bug**, applied to the *system* prompt via
`--system-prompt-file`, with a comment naming the exact problem. The user prompt never got it.

**Verified in both directions rather than assumed [M]:**

| check | result |
|---|---|
| 40,053-char prompt via argv | `WinError 206` — defect reproduced |
| same prompt on stdin | `rc=0` |
| 57,651-char prompt, answer at **offset 57,580** | answered correctly — so stdin is not truncating |
| end-to-end via `ClaudeCodeProvider.generate` (39,451 chars) | correct late-content answer |
| `generate_json` + Pydantic schema + 36,000-char system prompt | correct, and 0 temp files leaked |

The third row matters: "it returned OK" would also happen if stdin silently truncated, so the test was
built so that only an untruncated prompt can pass.

**Effect on the real pipeline [M].** `causal_edges.created_at`, grouped by day, separates the runs cleanly:

| date | edges | documents | edges/document |
|---|---|---|---|
| 2026-08-24 (pre-fix, the 294-doc run) | **9** | 294 | 0.031 |
| 2026-08-31 (post-fix, this session) | **120** | 30 | **4.0** |

The post-fix row is a **snapshot taken mid-ingest**, not a final count — the re-ingest was still running
when it was read, and the total had reached 166 edges a little later. The comparison that matters is the
per-document rate against the pre-fix run, and that is what the last column reports.

**This does not mean Graph C is good.** It means every prior impression of Graph C was an impression of
a layer that was empty for mechanical reasons. The keep list §7.5 sequencing stands, and the second,
independent problem is untouched: the causal pass is delta-scoped per epoch and capped at
`CAUSAL_PASS_SCOPE_CAP=200`, so with `batch=10` a cause in batch 1 and its effect in batch 5 are never
in the same scope, and per `nmemo-an9` no global re-sweep exists any more.

---

## 3. Filtered vector search — the systemic finding

Found while exercising `searchFacts` for the first time (it had zero callers, so its defects had never
run). Every filtered vector query in the codebase has this shape:

```sql
SELECT ... FROM public.facts f
WHERE f.corpus_id = $1 AND ...          -- b-tree-able predicates
ORDER BY f.fact_embedding <=> $2 LIMIT k
```

pgvector's HNSW index **cannot apply that WHERE during the graph walk**. It returns the
`hnsw.ef_search` nearest candidates **globally** (default 40) and Postgres filters afterwards, without
resuming the walk. First observation: a corpus-scoped `searchFacts` returned **zero rows** for
`arxiv-nlp` while the true nearest fact sat at similarity **0.732** — `EXPLAIN` said
`Rows Removed by Filter: 40`.

**Measured [M]** on 5,714 embedded facts, 60 deterministic query vectors, target slice `arxiv-nlp`
(≈50% of rows), against exact (seq-scan) ground truth:

| arm | rows returned of 10 | queries returning ZERO | recall@10 vs exact |
|---|---|---|---|
| `iterative_scan = off` (shipped) | mean **7.23** | **6 of 60** | **0.715** |
| `iterative_scan = strict_order` | **10.00** | 0 | **0.975** |

**The failure band is *moderately* selective filters, and this is counter-intuitive enough to be the
main thing to remember.** At 0.8% selectivity (corpus + predicate, 46 of 5,714 rows) the planner
switches to a `BitmapAnd` over the b-tree indexes plus an exact `Sort`, and recall is **1.000 in both
arms**. The defect needs the planner to choose HNSW *and* the filter to eat most of the `ef_search`
neighbourhood. A `corpus_id` filter on this substrate sits exactly there. On the 4-entity production
database the planner never chooses HNSW at all — which is why this never appeared in development.

My own first instinct ("tighter filter must be worse") was wrong and the data corrected it.

**Fix:** migration 058 sets `hnsw.iterative_scan = strict_order` at database level; both bootstrap
paths set it at create time; and `startup-validation` asserts it, because a database-level guarantee
that nothing verifies is how measurements were lost before. `strict_order` not `relaxed_order` because
ranking, and any RRF built on it, needs exact distance order.

**Exposure:** `searchFacts`, `findSimilarEntities` (the production entity-resolution path),
`recallAcrossCorpus`, `searchPredicates`. `merge-scorer`'s two uses are pairwise cosine with no
`ORDER BY`/`LIMIT` and are unaffected.

---

## 4. The description-aligned lever was unavailable, not untested

Two independent defects, either sufficient:

- `promotion-plan.ts` hardcoded `summary: null` — the agents author summaries (1,430 of 1,558 surviving
  proposals, 92%) and the planner discarded every one. **[C][M]**
- `config.ts` used `z.coerce.boolean()`, which applies `Boolean(value)`. `Boolean('false') === true`, so
  the only two values an operator would type to disable the flag both **enabled** it. It was off solely
  because the variable was unset. **[M]**

And a third, found only because an integration test caught it: carrying the summary into
`entitiesToMint` fixes **freshly minted** entities only. Once a name is in the graph the planner binds
straight to its canonical id, the handle never enters `entitiesToMint`, and the summary was still
dropped — the common case on a graph that is already built. The plan now carries
`entityDescriptionFills`, derived from the **final** `byHandle` map rather than collected inside each
bind branch, so anchor pin, exact-name match, word-prefix match and arbiter verdict are covered by
construction.

**Result [M]:** on the first 30 documents of the re-ingest, **392 of 398** entities carry a description
(98.5%), mean 78 characters, and they are genuinely informative rather than restatements of the name:

> `hallucination` → "Phenomenon where LLMs generate plausible but false or unfounded content"
> `rouge-1 metric` → "Automatic evaluation metric for summarization quality based on unigram overlap"

That satisfies the pre-registered kill condition (`coverage < 50%` would have voided the run) and, more
importantly, the informativeness diagnostic: a null result cannot be dismissed as "the descriptions
merely restated the names". The measurement itself is pre-registered in
`02-prereg-description-aligned-retrieval.md` and is **not** reported here.

---

## 5. Apache AGE retired from the read path

AGE cannot be fixed as a read path, only replaced:

1. It **cannot represent expiry**. Facts are bi-temporal (`expired_at`, `invalid_at`); an AGE edge is
   present or absent, so a traversal cannot answer "as of now", let alone "as of then".
2. Edge properties **do not persist via `SET`** in this version, so validity could not be carried even
   in principle.
3. AGE nodes carry **no `corpus_id`**, so every AGE traversal is a cross-corpus read-path leak by
   construction.

`graph.ts`'s four functions are now SQL over `public.facts`, with a new exported primitive
`traverseFromEntities` — a recursive CTE returning the neighbour, its first-reached hop **and** a
connecting fact in one query, expiry-correct and corpus-scopable. `/api/reset` now prunes AGE
(verified 1,071 → 0). The sync triggers stay; nothing reads them.

**`corpusId` deliberately defaults to `null` (every corpus)**, preserving AGE's behaviour exactly.
Defaulting to `'default'` would have silently returned `[]` for every caller on a non-default corpus,
including the retrieval harnesses. Corpus-scoping the traversal is a real improvement and a **separate**
change; it is not something to slip into an AGE-to-SQL swap.

### 5.1 The test suite that should have caught the drift could never run

`knowledge-graph.test.ts` set `ageAvailable` in `beforeAll` and gated every test with
`it.skipIf(!ageAvailable)`. **`skipIf` reads its argument at collection time**, while the describe body
executes — before `beforeAll` — so `ageAvailable` was always still `false` and all **12** substantive
tests (KG-001..KG-007 and the W18 traversal tests) were registered as skipped unconditionally. The
suite reported "4 passed" while skipping its entire subject.

Two of the newly-running tests were themselves unsound, and had to be rewritten rather than merely
un-skipped:

- **KG-004** called the SQL function `get_entity_neighbors()`, whose body ends in
  `EXCEPTION WHEN OTHERS THEN RAISE WARNING ...; RETURN;` — it swallows every error and returns an empty
  set. It has **zero callers**; this never-running test was its only exerciser.
- **KG-005** compared a just-cleared AGE graph against an **unscoped** `SELECT COUNT(*) FROM entities` —
  5 vs 3,750 on the shared test database. It could only ever have passed against an empty database.

Net: 92/92 across the four affected suites with **zero skips** (was 64 passed + 12 skipped).

---

## 6. Latency — measured, then fixed

The Tier 0/1/2 design is motivated entirely by latency and none of it had been quantified. New harness
`src/test/tools/traversal-latency.ts`, on the real 1,230-entity / 2,862-fact `arxiv-nlp` graph,
highest-degree anchors (worst case, reproducible):

**Before [M]** — 10 anchors / 2 hops: traversal **60 ms**, `getEntityFacts` loop **421 ms** across
**434 sequential queries**, total **487 ms**. The loop was **86%** of the cost; the traversal 12%.

**After** batching the loop into one `getFactsForEntities` query:

| anchors | hops | before | after |
|---|---|---|---|
| 1 | 1 | 62 ms | **11 ms** |
| 1 | 2 | 85 ms | **28 ms** |
| 5 | 1 | 158 ms | **22 ms** |
| 5 | 2 | 259 ms | **57 ms** |
| 10 | 1 | 248 ms | **39 ms** |
| 10 | 2 | 487 ms | **91 ms** |

Evidence counts are **identical in every cell** (20 / 20 / 100 / 100 / 199 / 200), so this is the same
output 4.5–6.4x faster, not a smaller answer computed sooner.

Two caveats stated rather than buried. Measured while the 294-document re-ingest was running against
the same database, so absolute numbers are inflated — the before/after comparison and the 86%/12% split
are both from runs under the same load. And the **agent loop is not measured**: subprocess spawn,
per-iteration MCP round-trip and synthesis need LLM invocations. `nmemo-5co.1` is not closed.

---

## 7. Smaller closures

- **Migration runner honesty.** It caught each migration's error, logged it, continued, printed "All
  migrations processed" and exited **0**. Now failures are collected, named, and the process exits 1.
  Verified in both directions on throwaway databases: fresh 58/58 exit 0; immediate re-run 58/58 exit 0
  (was 3 failures at exit 0); injected broken migration → exit 1 naming the file.
  **No journal, deliberately** — `001_consolidated.sql` sets `search_path` at *session* level and every
  later migration's DDL depends on it, so a journal that skipped 001 would land objects in `ag_catalog`.
  That forced fixing the 3 non-idempotent migrations (`nmemo-ved`), because an honest exit code is only
  useful if a routine re-run is clean.
- **`promote()` on a lagging database.** `getCorpusPolicy` sat in a `Promise.all` with no `try/catch`, so
  a database missing migration 055 killed the whole epoch arm with `42P01`. The guard now lives in
  `getCorpusPolicy`, because a missing *table* is indistinguishable to every caller from the missing
  *row* the function already documents as meaning `'assimilating'`. Narrow: only `42P01` is absorbed.
- **Schema presence check.** `startup-validation` checked no arc table at all. The new validator derives
  its expected set from the drizzle schema rather than a hand-maintained list. Scope stated in code: it
  covers the 40 ORM-declared tables — the set the TypeScript actually queries, so it catches the `42P01`
  failure mode — and every arc table is in it. The 10 it does not cover are gardener/topology tables
  reached by raw SQL.

---

## 8. Two traps for the next reader

1. **`src/index.ts` is invisible to ripgrep.** It contains NUL bytes, used deliberately as a
   composite-key delimiter (`` `stg:e:${name}\0${type}` ``), so grep treats the HTTP entry point as
   binary and skips it. `grep -a` is required. Any grep-based audit of this repo has a blind spot there,
   which is plausibly why keep-list finding §0.1 (`handleBatch` takes no `corpusId`) went unnoticed.
2. **`rawQuery` rewrites every result key snake_case → camelCase** (`db/raw.ts`). Reading
   `row.entity_id` from a `rawQuery` result returns `undefined` — the query succeeds, the field is
   empty, and the caller sees a populated array of blank values. This bit the AGE-to-SQL rewrite and was
   caught only by running the code against real data.

---

## 9. Later findings — the Graph C follow-up

Found after §2, while checking that the newly-populating causal layer was sound.

**9.1 The new causal edges are well-formed, not just numerous. [M]** Of the edges created today:
**100% carry non-blank `reasoning`** (mean 336 characters) and **100% carry `source_references`** (2
each), and the reasoning is specific and grounded — e.g. *"BLIP-2 has 54x fewer trainable parameters than
Flamingo80B, achieving this efficiency through its lightweight Query Transformer design."* So the fix
produces traceable content, not volume. It still says **nothing** about whether the layer is useful; that
needs the `plan.md:221` no-memory-baseline comparison, which has never been written.

**9.2 `causal_events.corpus_id` was silently WRONG, not merely absent. [M]** Keep list §7.4 says
`mintCausalEvent` omits the column. The consequence is worse than the omission: the column **default**
took over, so **all 7,004 rows read `corpus_id='default'`** — including every event describing a fact in
`arxiv-nlp`, `arxiv-cv` or `dal-nlp`. Migration 052 gave the table a corpus column, an index *and* an
immutability trigger, all guarding a value no code set, and that trigger means a wrong value **cannot be
corrected in place**. `corpusId` is now a REQUIRED parameter so the compiler forces every call site.
The 7,004 existing rows are **not** backfilled — that needs the trigger dropped or a re-derivation from
`facts.corpus_id` via `fact_id`, which is a data migration and a separate decision.

**9.3 Correction: the dead-embedding-column cost is OVERSTATED. [M]** Keep list §7.4 says
`event_embedding` and `pattern_embedding` are "dead columns carrying live HNSW indexes — so every causal
insert pays write amplification for nothing". The columns are indeed dead (0 of 7,004 populated), but the
cost claim is wrong: **pgvector's HNSW does not index NULLs**, so both indexes are **16 kB** against
**26 MB** for the live `idx_facts_embedding`. Dropping them is not worth a schema change, and they are
left in place.

**9.4 The entity vector index has never been scanned. [M]** `pg_stat_user_indexes` reports
`idx_entities_embedding` `idx_scan = 0` across this database's whole lifetime, against 138 for
`idx_facts_embedding` (this session's `searchFacts` work). Entity vector search is not exercised at
all — worth knowing before anyone concludes anything about entity-vector recall.

---

## 9.5 An incident, recorded because it affects the measurement

While the 294-document re-ingest was running against `cognitive_test`, I ran
`promotion.test.ts` against the same database several times. Its `clean()` contained

```
DELETE FROM staging_proposed_facts      -- no WHERE
DELETE FROM staging_proposed_entities   -- no WHERE
DELETE FROM arbiter_verdicts            -- no WHERE
```

**unscoped, database-wide**, from `beforeEach` and `afterAll`. That deleted the in-flight batch's staging
rows before the ingest harness could snapshot paper-level attribution from them. Staging is transient by
design (`cleanupAbandonedStaging` GCs it), so nothing could reconstruct it.

**Damage, exactly [M]:** ledger positions 60–69 — all 10 documents of one batch — are in the graph with
**no attribution**. 70 of the 80 documents ingested at that point carry it. The only symptom at the time
was a single log line reading `attributed 0 facts / 0 entities` between two batches reporting 152 and
179, which is why it went unnoticed until the artifact was counted.

This is the trap the kickoff goal names explicitly — *"check what a suite's cleanup deletes unscoped
before running it against the shared DB"*. I checked `truncateAllTables`, `deleteFromTables` and the
TAG-scoped deletes, and missed these three inside the suite's own `clean()`.

**Effect on the measurement, stated here rather than discovered in the results.** The loss cannot create
FALSE query pairs — every pair the attribution artifact holds is still a true attribution. But it is
**non-random** (one contiguous batch), it reduces `n`, and it mildly biases which entities reach the
two-attribution threshold the held-out constraint requires. The 10 documents will be re-ingested once
both corpora finish, so the repair is isolated and recorded.

All three suites carrying this pattern (`promotion.test.ts`, `predicate-fold.test.ts`,
`epoch-propose-tools.test.ts`) are now scoped to the epoch ids they stage into. Each fix was verified
both ways: the tests still pass, **and** a concurrent ingest's staging rows survive the run.

---

## 10. What is still open

- **`fact_units` / `facts.source_memory_id`** — §1. Graph-anchored retrieval returns textless evidence
  until promotion records a per-fact source memory link. Write-path feature, unbuilt.
- **Graph C scoping** — delta-scoped per epoch, capped at 200, no global re-sweep. Populating the layer
  does not make cross-batch causality visible.
- **`nmemo-5co.1`** — the agent-loop half.
- **Corpus-scoping the traversal** — deliberately deferred so the AGE swap stayed behaviour-preserving.
- **Hybrid BM25 + retrieved-set RRF** (`nmemo-uhp.18`) and the **predicate scorer recalibration**
  (`nmemo-4g9`).
