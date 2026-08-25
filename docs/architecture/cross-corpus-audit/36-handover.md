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
| Paper attribution | Complete for corpus A — all 2,862 facts mapped, 0 ambiguous |
| Corpus B `arxiv-cv` | **0 — blocked, see §4** |
| doc-20 substrate | Intact: 104 concepts, 97 `exhibits` + 51 `addresses` |
| Concept links on arXiv | None yet — that is step 3 of §5 |

Everything is committed on `feat/cross-corpus-audit`. Nothing is running.

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

**The fix (agreed, not yet started — no code was written):**

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
3. **Concept-link both corpora** — `link-corpus-concepts.ts --corpus=A` then `=B`. **Size this before
   running:** the harness makes **one LLM call per entity**, and there will be ~2,400 entities. That is
   3+ hours and several session-limit interruptions. Cheaper options — link only entities that
   participate in facts, batch several entities per call, or sample — all change what the test
   measures, so this is a **user decision, not an implementer's**.
4. **Reconcile an artifact format mismatch** (~10 min, no API): the ingest writes
   `{paperToEntities, factToPaper}`; `multihop-score.ts` expects the older
   `{stats, entityToPapers}` shape.
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
- **`concept-extraction.test.ts` used to wipe the global `_concepts` corpus** and destroyed doc-20's
  97+51 bridges; its cleanup is now scoped, and `rebuild-doc20-bridges.ts` restores from the committed
  artifact if needed (it re-points 5 merged-away ids through `entity_merges`).
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
