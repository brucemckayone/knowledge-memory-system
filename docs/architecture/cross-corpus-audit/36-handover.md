# Doc 36 — Handover: corpus B ingestion and the investigation as a whole

**Written:** 2026-08-25 · **Branch:** `feat/cross-corpus-audit` · **Base:** `feat/cognitive-platform-v1`
**Purpose:** hand this investigation to a session with zero context. Read §1–§3 before touching anything.

---

## 1. The question, in one paragraph

Two independently-built bodies of knowledge are kept in separate corpora. Above them sits a shared
layer of **concepts**. The bet is that a concept lets you cross from one corpus to the other: land on
a concept, fan out to the things that exhibit it, walk each corpus's own internal structure, and reach
relevant source material. The alternative — plain dense-vector search over the text — has beaten the
concept layer on every measurement for months.

**doc 34 is why that verdict is not final.** Every experiment from doc 20 through doc 33 measured a
degenerate version of the system, for two verified reasons:

1. **The corpora had no internal structure.** `corpus-ingest.ts` wrote entities and **zero facts**, so
   a concept reached one node and traversal stopped dead. Depth was structurally 1.
2. **Concepts matched only on identical labels.** One side named what was present
   (`floating-point-literal`), the other named the hazard (`magic-constant`) — the same situation one
   abstraction level apart, so no merge rule joins them. Of 104 concepts, **4** were touched by both
   sides, which is the entire ceiling doc 33 measured.

So the negatives are **narrower than they looked**. They do *not* show the real design fails — that is
**untested, not vindicated**. Say it that way; the distinction has been laundered on this project
before.

## 2. Non-negotiable discipline

This investigation has ~8 recorded instances of me steering a conclusion toward the answer I wanted,
in **both** directions. The rules exist because of that:

- **Pre-register the metric and the pass/fail bar, and commit it to git, BEFORE computing any number.**
  doc 35 is already frozen this way.
- **A blind adversary reviews before any claim is banked** — a fresh subagent, given the
  pre-registration and raw artifacts, tasked to break it in both directions.
- **Report ties as ties.** A confidence interval touching zero is not a win.
- **Deterministic claims survive; interpretive ones get cut.** Prefer set arithmetic over inference.
- **Never add AI/Co-Authored-By attribution to commits.**
- **Haiku for all LLM work** (verified: 147/147 extraction calls resolved to `claude-haiku-4-5`,
  zero escalations to Sonnet, despite `--fallback-model sonnet` being passed).

**Three adversary debts are outstanding:** doc 32 (skipped by explicit user decision), doc 33, and
doc 35 when it runs. Do not quietly drop them.

## 3. State right now

| | |
|---|---|
| Corpus A `arxiv-nlp` | **147/147 papers**, 1,230 entities, 2,862 facts (1,548 of them entity→entity edges) |
| Corpus B `arxiv-cv` | **147/147 papers**, 1,282 entities, 2,852 facts (**1,544** entity→entity) — ingested 2026-08-25 |
| Paper attribution | **100.00%** — 5,714/5,714 facts, 2,512/2,512 entities, 294/294 papers, 0 ambiguous. Well clear of doc-35 §3's 95% void floor. |
| doc-20 substrate | 104 concepts, 97 `exhibits` + 51 `addresses` — DESTROYED and restored on 2026-08-25, see §7 |
| Reduction anchor | Re-run after the restore: **10 pairs shipped / 10 at hops=0 / zero set difference** (doc-35 §9) |
| Concept links on arXiv | **COMPLETE** 2026-08-27 — corpus A 2,014 `exhibits`, corpus B 2,255 `addresses`, 564 concepts. **Coverage is NOT total:** entities carrying ≥1 concept are **1,161/1,230 (94.4%)** and **1,195/1,282 (93.2%)** — 156 entities have none and cannot participate in S0 at all. Rate is non-uniform (5.6% vs 6.8%). |
| Both-sided concept pivots | **170** of 564 (303 exhibits-side + 431 addresses-side − 170 shared). doc 34 §2's audit found **4 of 104** — doc 34 §6 step 4's cheap kill-check is passed. |
| Concept descriptions | **NONE — see §3.2. Every concept was labelled from a bare entity name.** |

The two corpora came out near-symmetric (1,230/2,862 vs 1,282/2,852, both 54% entity→entity edges),
and corpus B has real internal structure with genuine CV hubs (`segment anything model` degree 98,
`diffusion models` 84). **40 entity names now exist in BOTH corpora as separate nodes** — shared
vocabulary, no fusion, which is the condition §4's bug needed in order to appear at all.

### 3.1 Known substrate handicap: entity fragmentation (recorded before any number)

Identical names are split across free-text `entity_type` variants. `chatgpt` exists **21 times** in
corpus A — as `LLM`, `llm_model`, `LLM_Model`, `SoftwareTool`, `artifact`, `tool`, `system`, and 14
more. The cause is exact: `promotion.ts:313` reuses an entity only on `lower(canonical_name)` **AND**
an exact `entityType` match, and the extraction agent invents a fresh free-text type per batch.

| | corpus A | corpus B |
|---|---|---|
| entity rows | 1,230 | 1,282 |
| distinct lowercased names | 1,070 | 1,028 |
| rows that are fragments | 241 (19.6%) | 173 (15.3%) |
| facts touching a fragmented node | 1,062 (37%) | 641 (26%) |

**Direction of the bias, stated before the numbers exist:** splitting a hub gives each fragment fewer
facts and its own concept links, so it **reduces** what the concept arms can reach, while the
paper-text arms (**E**, **B**) are untouched — they never read the entity graph. So this handicaps the
primary metric *against* the hypothesis. The effect on discrimination is genuinely ambiguous rather
than favourable: fragmentation lowers per-node reach but raises the document frequency of concepts
attached to many fragments, which cuts their IDF.

**Decision (user, 2026-08-25): proceed and record, do not fix.** doc 35 §3 specifies ingestion
"through the production epoch pipeline", and this is what that pipeline produces — the run measures
the real system. The two alternatives were an in-place variant merge (walks into `nmemo-9vk`, whose
`mergeEntities` re-points facts before deduping and so trips `uniq_facts_active_triple` exactly on
fragmented hubs) and constraining the type vocabulary plus re-ingesting both corpora (~2h + API,
restarts step 2). Recorded here **before any number is computed**, so if the run fails this is a named
alternative explanation rather than a post-hoc excuse; if it passes, the handicap only strengthens it.

### 3.2 LOAD-BEARING LIMITATION: every concept was labelled from a bare entity NAME

Found 2026-08-27, **after linking completed and before `multihop-score.ts` was ever run.** Recorded
here, and committed, before any number existed.

`planPromotion` builds `entitiesToMint` with **`summary: null` hardcoded**
(`promotion-plan.ts:534`), with no comment justifying it, in a function that otherwise carefully
derives the canonical display name. The plan type declares `summary: string | null` and
`applyPromotion` (`promotion.ts:329`) does `description: e.summary ?? undefined` — it is ready to
consume the value. So the epoch path silently discards every entity description.

Measured: **all 2,512 canonical entities have `description` NULL**, while **1,430 of 1,558 surviving
staged proposals (92%) carry a real summary** (`2D diffusion models` → "Diffusion models trained on
2D image data"). The agents produce the content; the planner throws it away. Nothing else fills it on
this arm — `update_entity_summary` is a canonical write and E2 removed all canonical writes from
`extraction_proposer`.

**Why this is more than a missing column.** `link-corpus-concepts.ts` does
`text = description ? name + '. ' + description : name`. With `description` always empty, **every
concept label in this substrate was extracted from the bare entity NAME with zero context** — an
entity named `uhdfour` was labelled from the string `uhdfour`. Entity embeddings already embed the
name rather than the description (`entities.ts:243`). Together: the **description-aligned nodes**
variant, recorded across this investigation as the *one untested retrieval lever*, was not merely
untested here — it was **silently unavailable**.

**Direction of the bias:** labelling from a bare name yields shallower, noisier concepts than
name+description would, so it handicaps the concept arms while leaving arms **E** and **B** untouched
(neither reads the entity graph). Same direction as §3.1, and larger in kind.

**CORRECTION (blind adversary, 2026-08-28): "all handicaps point against the hypothesis" was WRONG as
a blanket claim.** The 156 concept-less entities above contribute nothing at hops=0 but *can* be
reached through a neighbour at hops≥1, so they **flatter the multi-hop gain** — measured at ~1.2pp of
hard-slice coverage (M1 restricted to concept-linked roots gives 0.7813 vs the reported 0.7937). Small,
but it runs opposite to the framing, and the framing was mine. On the IDF worry raised in the
adversary brief: `concept_df` counts distinct **roots** (`concept-multihop.ts:150-154`), so
fragmentation *inflates* df and *cuts* idf — §3.1's stated direction is right there, but it was right
by luck rather than by having been checked.

**Backfill is ruled out, with numbers.** Only the last batches' staging survives
(`cleanupAbandonedStaging` past `STAGING_TTL_MS`), so a backfill would cover **corpus A 120/1,230
(9.8%)** against **corpus B 1,278/1,282 (99.7%)** — it would give one corpus descriptions and not the
other. That asymmetry is worse than the gap. Do not backfill.

**Decision (user, 2026-08-27): score this substrate, record the limit, then fix the bug and re-run
description-aligned — and do NOT discard this substrate.** So the re-run must write to **new corpus
ids**, leaving `arxiv-nlp`/`arxiv-cv` intact, which turns the bug into a controlled
name-only-vs-description-aligned comparison rather than lost work.

**What this run therefore licenses, and what it does not.** It measures traversal over real
entity+fact graphs with a conformed shared vocabulary — strictly less degenerate than docs 20-33,
which had **zero facts** and **4 pivots** against this substrate's **170**. It does **not** measure
the description-aligned architecture. A negative here bounds to *name-derived concepts*, not to the
design; the rejoinder "you never gave it descriptions" would be **correct**, which is exactly why
this is recorded before the numbers rather than after. Bead: `nmemo-` (description-drop, P1).

Everything is committed on `feat/cross-corpus-audit`.

## 4. Why corpus B is blocked — the bug to fix first

Corpus B died on its first batch with:

```
insert or update on table "facts" violates foreign key constraint "facts_object_corpus_fk"
```

**The chain:** the agent extracting a CV paper saw "GPT-4" and called `resolve_anchor` to ask whether
it already existed. That lookup is

```sql
WHERE canonical_name ILIKE 'gpt-4'    -- and nothing else
```

— **no corpus filter**. Corpus A had already created `gpt-4`, so it matched, and the agent registered
its corpus-B entity as *anchored* to corpus A's node. Promotion then tried to write an `arxiv-cv` fact
whose object lives in `arxiv-nlp`, and migration 052's composite key
`FOREIGN KEY (object_entity_id, corpus_id) REFERENCES entities(id, corpus_id)` refused it. 36 of
corpus B's staged entities were anchored across the boundary: `gpt-4`, `bert`, `llama`,
`gpt-3.5-turbo`, `gpt-neo`.

**Why corpus A passed:** the only pre-existing entities then were the C++ experiment's (`E001`,
`C.12`, `pointer-arithmetic`). An NLP abstract collides with none of those names. Corpus B is CV
papers against corpus A's NLP papers — they share vocabulary heavily. **The bug only appears once two
corpora that discuss the same things coexist**, which is the whole point of the feature. Corpus A was
not a passing test; it was a test that could not fail.

**Root cause:** corpus separation is enforced on the *write* path (fixed in `dcfcfb8`) but not on the
*read* path the agent uses to decide identity. This is the **fifth** unscoped path found.

**The fix — LANDED `c1da213` (2026-08-25).** All five parts below are in, and corpus B ingests.
The deterministic confirmation is not "the batch passed" but the anchor count: of the first
batch's 106 staged corpus-B entities, **0 were anchored to any entity**, where previously 36
anchored across into corpus A. `resolve_anchor` now answers `matched:false` for a corpus-B
mention of a corpus-A name, so the agent proposes its own node. Four regression tests; three
of them fail if either name filter is removed, the fourth pins the legacy default-corpus
behaviour.

**The fix as specified:**

1. `ToolCallContext` (causal-agent.ts:1412) += `corpusId?: string | null`
2. `resolveContext` (causal-agent.ts:1616) += `corpusId: process.env.MNEMO_CORPUS_ID || null` — same
   env-carrier pattern as `epochId`/`sourceId`/`chunkIndex`
3. `EpochContext` (causal-agent.ts:3625) += `corpusId`, and `getMcpEnv` (≈3643) sets
   `MNEMO_CORPUS_ID`; thread it from `runEpochBatch` → `propose()` in pipeline.ts (≈929)
4. `resolve_anchor` (causal-agent.ts:3159) — filter the **exact-name** and **alias** branches by
   corpus. The third branch uses `findSimilarEntities`, which is *already* corpus-scoped from Phase A;
   it just needs the corpus passed.
5. A regression test: two corpora sharing an entity name must mint separate nodes and must not anchor
   across the boundary.

**Worth recording:** the database constraint saved the experiment. Without that composite key `gpt-4`
would have become one shared node bridging both corpora, the graphs would have silently fused, and
every later "cross-corpus" number would have been measured on a single merged graph — no error, no
warning, entirely plausible-looking results.

## 5. Remaining steps, in order

1. **Fix `resolve_anchor` scoping** (§4). No API budget needed.
2. **Ingest corpus B** — 147 papers, ~1h at ~27s/paper, needs API budget. Command in §6.
3. **Concept-link both corpora** — `link-corpus-concepts.ts --corpus=A` then `=B`. One LLM call per
   entity over ~2,680 entities. **Decided 2026-08-25 (user): run the FULL population with bounded
   concurrency** (`--concurrency=6`, matching the ML service's LLM worker pool; `095edf7`). Population,
   per-entity prompt and one-call-per-entity accounting are unchanged; the only difference is that an
   entity's shared-vocabulary window cannot see concepts minted by the 5 calls beside it, so label
   reuse comes out marginally **lower** than strictly serial. That biases the run **against** the
   concept layer, which is the safe direction for the quantity under test.

   The three cheaper variants, and why they were not taken:
   - *Link only entities that participate in facts* — **saves nothing, measured:** 1230/1230 corpus-A
     and 99/99 corpus-B entities already participate in at least one live fact. Dead variant; do not
     re-propose it.
   - *Batch N entities per call* — **rejected as a launder risk.** Showing the extractor several
     entities at once lets it reuse labels across the batch, inflating cross-corpus concept
     convergence, which is the exact quantity doc 35 measures.
   - *Sample a subset* — changes the population the frozen doc-35 coverage denominators describe, so
     the run would no longer be the pre-registered test.
4. **Reconcile an artifact format mismatch** — DONE `0def393`. `attribution-merge.ts` inverts the
   per-batch ingest capture into the `{stats, entityToPapers}` shape the scorer reads, and nothing
   else. `multihop-score.ts` is deliberately untouched: it encodes the frozen doc-35 bars, and the
   95% attribution floor stays where the pre-registration put it. Denominators come from the DB, not
   the artifacts, so the floor is computed against every canonical row. `doc-attribution.ts` is
   superseded and now refuses to run without `--force` — it reads consumed staging, which is
   garbage-collected within the hour, so run after the fact it under-attributes **silently**.
5. **Run `multihop-score.ts`** — deterministic, minutes, no API.
6. **Blind adversary** on doc 35, then bank or retract.

## 6. Infrastructure

Docker gives Postgres (5433) + Qdrant (6335) — start Docker Desktop if `docker ps` fails.
Ollama and the ML service run on the host and **die between sessions**:

```
# Ollama
"/c/Users/bruce.mckay/AppData/Local/Programs/Ollama/ollama.exe" serve
# ML service (from ml-services/)
PYTHONIOENCODING=utf-8 LLM_PROVIDER=claude ./.venv/Scripts/uvicorn.exe app.main:app \
  --host 0.0.0.0 --port 8000 --http h11
```

Ingest (resumable by ledger; **never pipe it through `grep`** — that makes `&&` read grep's exit code,
which is how corpus B once launched after corpus A had already failed):

```
cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
  QDRANT_URL=http://localhost:6335 ML_SERVICES_URL=http://localhost:8000 \
  NODE_ENV=test EMBED_DESCRIPTIONS=true STAGING_TTL_MS=86400000 \
  npx tsx src/test/tools/corpus-graph-ingest.ts --corpus=B --batch=10 --concurrency=8
```

`NODE_ENV=test` **skips dotenv**, so `QDRANT_URL`/`ML_SERVICES_URL` must be passed explicitly or they
fall back to the wrong ports. `STAGING_TTL_MS` matters — see §7.

Viz (read-only, safe alongside anything): `npm run dev` in platform with the same DATABASE_URL plus
`LLM_PROVIDER=claude`, then http://127.0.0.1:3001/viz. A separate `/goal` may be optimizing its render
performance; that work is read-only on the database and must not touch the pipeline.

## 7. Traps already paid for — do not rediscover these

- **Staging is garbage-collected within the hour.** `runEpochBatch` calls
  `cleanupAbandonedStaging()` every batch, deleting rows older than `STAGING_TTL_MS` (default **1
  hour**). My original attribution design read consumed staging *after the fact* and I validated it at
  587/587 **during a live run** — inside the transient window. It measured something that does not
  persist, and corpus A's provenance was destroyed. Attribution is now captured **per batch, at ingest
  time**, before the batch is marked done.
- **`runEpochBatch` returns ONE aggregated result per epoch** — the pipeline says so itself
  ("Per-chunk attribution is gone (promotion is epoch-wide)"). So `batch=10` gives batch-level, not
  paper-level, attribution. Do not try to read per-chunk results from `ExtractResult`.
- **The epoch path writes no `memory_entities` and no `fact_sources`** (both 0). The attribution
  artifact is the only paper-level provenance that exists.
- **Do not attribute papers by matching entity names against abstract text.** It is the lexical
  confound this whole investigation keeps tripping over; contaminating the substrate is worse than
  paying for a re-ingest.
- **Two test suites have now destroyed doc-20's 97+51 bridges, for the same reason.**
  `concept-extraction.test.ts` wiped the global `_concepts` corpus (scoped since), and on
  2026-08-25 `cross-corpus.test.ts` did it again with an unscoped `DELETE FROM
  public.bridge_edges` in `cleanCrossCorpus`, under the comment "these tables are exclusive to
  this suite, so a full wipe is safe" — true when written, false once anything else laid down
  bridges. Both are scoped now (`7a4c5e9`). **The loss is SILENT:** the 104 concept nodes
  survive, so nothing errors; the only symptom is `multihop-identity-check.ts` reporting
  `0 pairs / 0 pairs / PASS`, a vacuous 0==0 that reads like the anchor holding. **Treat a
  0-pair anchor as a destroyed substrate, never as a pass** — the real result is 10/10 with
  zero set difference. `rebuild-doc20-bridges.ts` restores from the committed artifact (it
  re-points 5 merged-away ids through `entity_merges`). Case 6 of `cross-corpus.test.ts` also
  had the bug in its *assertion*, counting every live bridge in the database and expecting
  one, so it silently depended on the global wipe to pass. **Before running any suite against
  this database, check what its cleanup deletes unscoped.**
- **The causal pass fails on every arXiv batch** with `Causal agent failed: [WinError 206] The
  filename or extension is too long` when the ML service spawns the agent — the epoch scope
  (~195 promoted facts at `batch=10`) overflows the Windows command-line limit. Pre-existing
  and symmetric across both corpora: corpus A's full 147-paper ingest produced 9 causal edges
  in total. It is best-effort and non-fatal by design, and `concept-multihop.ts` references no
  causal edges at all, so the doc-35 arms are unaffected. Recorded, not fixed — fixing it would
  change the substrate mid-experiment (user decision, 2026-08-25).
- **Both API interruptions were the session limit**, not bugs. The ledger makes a re-run a no-op over
  finished work.

## 8. Key files

| file | role |
|---|---|
| `docs/.../34-concept-layer-construction-audit.md` | the load-bearing audit — read first |
| `docs/.../35-multihop-concept-recall-prereg.md` | the frozen test: arms, metrics, bars, honest priors |
| `platform/src/services/concept-multihop.ts` | multi-hop recall; IDF + decay path cost |
| `platform/src/test/tools/multihop-identity-check.ts` | proves hops=0 == the shipped single-hop JOIN |
| `platform/src/test/tools/corpus-graph-ingest.ts` | resumable ingest + per-batch attribution capture |
| `platform/src/test/tools/link-corpus-concepts.ts` | concept linking with the shared-vocabulary window |
| `platform/src/test/tools/multihop-score.ts` | doc-35 scoring, bars encoded in code |
| `docs/.../multihop-artifacts/` | ledger + paper attribution for corpus A |

## 9. What a result will and will not license

doc 35 §7 fixes this in advance. **Coverage rising while discrimination falls is a FAIL**, declared up
front — that is exactly doc 32's hub failure, and multi-hop traversal is a stronger version of the same
temptation. My recorded prior: **two hops may fail by reaching everything** (coverage near 1.0, AUC near
0.5). The IDF/decay cost and the top-3-hub exclusion check exist to catch it.

Also carried: the oracle here is co-citation, which doc 30's adversary showed is ~79%
cosine-predictable — weaker than doc-20's external clang-tidy oracle, which is unusable because the
prose extractor returns **zero** entities from C++ and from guideline text. Any result must carry that
caveat.
