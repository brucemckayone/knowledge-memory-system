# Kickoff goal — single-graph retrieval and synthesis

```
git checkout -b feat/single-graph-retrieval
```

**Goal:** optimise retrieval and knowledge synthesis on one graph. Close the silent breakages, then
measure. Learn what works and what does not, and write it down.

**Read first:** `single-graph/00-consolidated-keep-list.md` in full — it supersedes every earlier
synthesis. Detail in `appendices/01`–`07`.

**Decided, do not relitigate:** single graph is the design; the concept super-graph is not a retrieval
mechanism (settled on every config and oracle); iOS is stripped; LongMemEval is parked; do not turn on
the predicate fold (3.7% collapse at 0.43 merge precision, and merges are unrecoverable).

**Why this order:** the write path starves the read path. Every Tier 0 primitive is built and its inputs
are empty, so no retrieval measurement is currently meaningful.

1. `nmemo-vga` (P0) — fact vectors broken at both ends: `fact_embedding` NULL on the epoch path
   (`promotion.ts:250`), and `searchFacts` (`facts.ts:896`) is its only reader with **zero callers**.
2. `nmemo-9b4` — `EMBED_DESCRIPTIONS=false` turns the flag **on** (`z.coerce.boolean()`;
   `Boolean("false") === true`).
3. `nmemo-86z` (P0) — `promotion-plan.ts:534` hardcodes `summary: null`, so every entity vector embeds
   a bare name.
4. `nmemo-ajm` + `nmemo-31k` — `migrate.ts` swallows failures and exits 0; `promote()` dies with `42P01`
   if migration 055 is absent.
5. `nmemo-8rm` (P0) — Graph C: 9 edges from 147 papers because `llm.py:349` passes the prompt as an argv
   element (Windows caps it at 32,767). **The fix exists 14 lines below, applied to the system prompt.**
   Passes at batch=1, fails silently on every real run.
6. Re-measure the **description-aligned retrieval lever** on the 294-document substrate, name-only graph
   as control, new corpus ids. The one untested lever — items 2–3 are why it was silently unavailable.
7. AGE prune-or-retire (~1,071 nodes against 4 entities; `/api/reset` skips it). Until then use SQL
   recursion over `public.facts` — the only expiry-correct traversal path.
8. **Hybrid BM25 + retrieved-set RRF** (`nmemo-uhp.18`, P1) with a pre-registered bar. Four independent
   results back it; the 0.648-vs-0.467 figure is post-hoc and needs the clean run.
9. `nmemo-5co.1` — measure `/api/reason/query` latency; the tiered design is motivated by it and none is
   quantified. Then `.2`/`.3` (fact-query API, constraint extractor) — the real greenfield.
10. `nmemo-4g9` (P0) — predicate scorer recalibration before any predicate backfill.

Also: strip iOS, extracting the ~80-line UTF-16 span-attribution pattern from `voice-c-composer.ts`
first. Ask before dropping migration 049's tables — they are applied to the live DB.

**Traps.** Doc numbers collide across trees ("doc 39" has three candidates) — cite full paths. Verify any
branch attribution with `git merge-base`; CLAUDE.md's is stale. `NODE_ENV=test` skips dotenv (pass
`QDRANT_URL`, `ML_SERVICES_URL`) and does not isolate Qdrant (set `QDRANT_COLLECTION`). Never pipe `tsx`
through `grep`. Check what a suite's cleanup deletes unscoped before running it against the shared DB —
the symptom is a vacuous `0 pairs / PASS`.

**Discipline.** Pre-register the metric and bar and commit before computing any number; audit the harness
against the frozen pre-reg first; blind adversary before banking, tasked both directions; ties are ties;
prefer deterministic set arithmetic; watch for silent no-ops — every largest finding here was a feature
reporting success while doing nothing.

**Calibration.** `cross-corpus-audit/39-known-truths.md` drifts **pessimistic** — do not inherit its
framing. Its basis is "docs 20–38" so it omits the decision register; it claims six over-statements where
the primaries show 12–13; and readings are wrong unfavourably ("embedding wins inside its own blind spot"
is backwards — it equals random there; "STRUCT lost at L=3" is a tie). The LongMemEval `0.524` is a
**dry run** (`idx % 2`).

Read the keep list, then confirm the plan before writing code.
