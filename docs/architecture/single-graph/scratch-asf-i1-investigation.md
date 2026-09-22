# scratch — I1 "local" retrieval investigation (next intent after I3)

**READ-ONLY prep, 2026-09-08. Not a design of record — a build brief for the I1 bead(s).** Mirrors
`scratch-asf8-investigation.md` (the I3 brief). Priority order is I3→I1→I2→I4→I5 (doc 34); I3 shipped
(`.8`, doc 41, +0.556 lift), so **I1 is next**. All code citations verified against the working tree on
branch `feat/single-graph-retrieval`. Where CLAUDE.md / a memory note conflicts with the code, the code
wins and the drift is flagged.

**The one-line headline for the human:** the R4 fusion lever is an **entity-retrieval** mechanism; every
prior "R@10 ≈ 0.20-0.23" number came from **papers-as-queries**; LongMemEval is a **session/turn-retrieval**
(or end-to-end-QA) benchmark over **chat**. Turning I1 into a runnable experiment forces one architectural
fork up front (Q7/Q9) — *do we test the entity⊕fact lever (needs extraction + provenance) or run the
LongMemEval-native session-as-document path (does not exercise the lever)?* Everything else is downstream of
that choice.

---

## 1. What I1 "local" commits to (docs 34, 32)

Doc 34 §I1 (`34-query-intent-set-proposal.md:17-23`) commits I1 to:

- **Capability:** *point lookup / "what is X" — local, specific.* Example queries: "what is entity X",
  "find the fact where X <predicate> ?", "recall what we know about X".
- **Substrate:** **dense fusion (name⊕fact) + a lexical/BM25 index for exact terms/identifiers** (doc 31).
- **Benchmark:** "BEIR-style IR + our target-finding harness, but on **real queries** (not
  papers-as-queries). nmemo-bki: **LongMemEval / LOCOMO** (recall over memory)."
- **Ground truth:** ranked relevance (clean).
- **Current fit (doc 34:23):** *fusion HAVE (proven, R4); **lexical index MISSING**; real-query eval
  MISSING.*

A benchmark for I1 must therefore test **single-hop, single-location recall**: the answer to the query
lives in one place (one session / one fact / one entity), retrievable directly by lexical + dense
similarity, with **no multi-hop composition and no time-disambiguation**. Ground truth is a clean relevance
label (which memory unit holds the answer), not an LLM judgment.

**Distinction from I2 and I3** (doc 34:25-40):

| | binding operation | substrate it exercises | what disqualifies it from I1 |
|---|---|---|---|
| **I1 local** | direct similarity lookup | dense name⊕fact + lexical | — |
| **I2 multi-hop** | traverse typed edges, compose "A→B→C" | canonicalized traversable graph / PPR | answer requires *joining* facts across hops |
| **I3 temporal** | as-of / valid-time filter, supersede-not-overwrite | bi-temporal facts (valid/transaction time) | answer *changes with the date*; needs time-disambiguation |

Doc 32 (`32-intent-adaptive-retrieval-program.md:79`) states the I1 Phase-4 task verbatim: *"local → add a
BM25/lexical index → real hybrid; gate on a real-query slice (not papers-as-queries)."* The foundations it
assumes (doc 32 Phase 1) are provenance backbone, corpus scoping, dedup, and **the fusion already wired as
an MCP tool** — all of which are done (`.2`-`.4`; doc 37) *except provenance completeness* (Q8, still a
blocker per CLAUDE.md).

---

## 2. The fusion lever — precise current state

**What it fuses today (`platform/src/services/retrieval.ts:94` `recallEntitiesFused`):** retrieved-set
**RRF-60** of exactly **two** signals:

1. **dense-over-names** — `findSimilarEntities(embedding, …)` (`retrieval.ts:115`), cosine of the query
   vector to `entities.embedding`. That column is the embedding of the **entity NAME**, not the
   description, by the shared `entityEmbedTextFor(name, description, 'name')` convention (CLAUDE.md /
   `entities.ts:243`; the eval harness uses the same mode at `harness.ts:168`). So signal 1 = "what the
   entity is called."
2. **dense-over-facts** — `recallEntitiesByFactSimilarity(embedding, …)` (`retrieval.ts:65`) → calls
   `searchFactsByVector` (`facts.ts:1047`) ranking `facts.fact_embedding` by cosine, then **aggregates
   facts to their endpoint entities by MAX** (`retrieval.ts:74-86`; MAX, not mean, matched the R4 arm). So
   signal 2 = "what is said about the entity."

**Fusion algorithm** (`fusion.ts:31` `reciprocalRankFusion`, `RRF_K_DEFAULT = 60` at `fusion.ts:17`):
retrieved-set RRF, score = Σ `1/(k+rank+1)` over the inputs an item appears in; an item absent from an
input contributes nothing (a short candidate list is not penalised). `retrieval.ts:121` fuses
`[nameHits ids, factRanked ids]` at k=60.

**Knobs / defaults** (`FusedRecallOptions`, `retrieval.ts:45-57`): `candidateLimit = 50` (name candidates),
`factLimit = 200` (facts pulled before endpoint aggregation), `threshold = 0` (keep full lists — RRF only
rewards the head), `k = 60`, `limit = 10` returned. These are **HNSW top-N approximations** of the
full-corpus rankings R4 measured (`retrieval.ts:18-24` says so explicitly) — the candidate widths are the
recall/latency knob. Corpus-scoped on all three internal filters (name leg, fact leg, final hydration:
`retrieval.ts:115,116,129-130`), so it needs `hnsw.iterative_scan = strict_order` (mig 058).

**MCP exposure (`causal-agent.ts`):** tool `recall_entities_fused` defined at `causal-agent.ts:234`
(`mutates:false`, args `query` + optional `limit` 10 / `threshold` 0 — **no `corpus_id` arg**; corpus comes
from the invocation `context.corpusId`), dispatched at `causal-agent.ts:1940-1950` which calls
`recallEntitiesFused(query, { corpusId: context.corpusId, limit, threshold })` and projects each
`FusedEntity` to `{id, canonicalName, entityType, corpusId, nameSimilarity, factSimilarity}`. `candidateLimit`
/`factLimit`/`k` are **not** exposed — pinned at the proven defaults (doc 37:44-46). Wiring proof:
`fused-tool-probe.ts` (12/12, no Claude).

**This matches CLAUDE.md's "THE ONE CONFIRMED LEVER" (doc 16, R4).** Doc 16 (`16-results-fusion-confirmation.md`):
FACTNAME (RRF-60 name⊕fact) strict R@10 **0.2636** vs ARM-NAME **0.1912** = **+0.0724**, above 0 on all
three bootstraps (the DEMONSTRATED bar), reproduced on the independent arxiv extraction, adversary-verified
(re-embedded 30 names, cos 1.0). Genuine complementarity: fusion keeps 24 name-only + 20 fact-only + 15
emergent hits (doc 16 §3). **Two standing caveats (doc 16 §4):** the gain is **degree-concentrated** (may
shrink on sparse graphs), and independence is **extraction-only** (same 294 papers) — a new-domain +
sparse-graph test was named as the honest pre-ship confirmation. **A real-query benchmark is exactly that
test.**

**`fact_embedding` population — the load-bearing subtlety (trust the code):**

- The **write path always populates it**: `createFact` computes `embedForWrite(factEmbedTextFor(...))`
  which **THROWS on ML failure** (`facts.ts:278-282`), so no fact ever commits with a NULL
  `fact_embedding` through the normal pipeline. Doc 16 §6 confirms it is populated on the whole
  arxiv/research substrate.
- But `searchFactsByVector` filters `WHERE f.fact_embedding IS NOT NULL` (`facts.ts:1061`), so **any fact
  loaded with a NULL embedding is invisible to the fact signal, and the fusion silently degrades to
  name-only.**
- The CronQA load (`.8`) deliberately left `fact_embedding` NULL (`cronqa-load.ts:4-5`) because the
  temporal arm is a structured index read. **For I1 the fact signal is half the lever, so however
  LongMemEval is loaded, its facts must carry embeddings** — this is a real ingestion-cost item (Q8).

*Drift flagged:* the memory note `project_temporal_fact_model` / the asf8 doc correctly say `fact_embedding`
CAN be NULL; doc 16 §6 says it is "populated on the whole substrate." Both are true — it depends on the
ingest path. The code (`facts.ts:278-282` vs `cronqa-load.ts`) is the authority: pipeline-ingested ⇒
populated; bulk-loaded ⇒ whatever you set.

---

## 3. BM25 / lexical index — does a reusable one exist? **No. It must be built.**

**Verdict: there is no lexical/full-text index anywhere on the live read path, and none in the schema.**

- **Migrations 001-060 contain zero `tsvector` / `to_tsvector` / `GIN(... tsvector)` / `ts_rank` /
  `to_tsquery`.** The grep for those tokens hits **only** three files, all under
  `platform/src/test/tools/retrieval-eval/` (`core.ts`, `arms.ts`, `harness.ts`) plus a handful of other
  one-off test harnesses — never `services/`, never `db/`, never a migration.
- **All prior "BM25-names" (docs 04/05/12/15/16/17) was an OFFLINE, in-JS computation**, recomputed per
  run: `buildBm25(docs)` / `bm25Scores(idx, query)` in `retrieval-eval/core.ts:97,111` — a plain
  tokenise→df/idf→BM25 (k1/b) scorer over the **cached entity-name strings held in memory** for that eval
  (`harness.ts:170` `buildBm25(ents.map(e => e.name))`, scored at `harness.ts:184`). It never touched
  Postgres FTS. The `H<K>` arm (`arms.ts:53-54`) is RRF of `(dense-names, in-JS-BM25-names)`.
- **The shipped read path has no lexical leg at all.** `recallEntitiesFused` is dense-names ⊕ dense-facts;
  BM25 appears nowhere in `retrieval.ts` / `fusion.ts` / `causal-agent.ts`.

So doc 34's "lexical index MISSING" is literally true: the BM25 that fed docs 05/12 was a **probe-only
offline computation**, not a reusable index. **I1 must build one.**

**Where to build it (sketch, for the human to weigh in Q9):**
- **Postgres FTS on `entities`** — a `tsvector` generated column over `canonical_name` (and optionally
  `description`), a `GIN` index, queried with `websearch_to_tsquery` and ranked by `ts_rank_cd`. This is
  the natural home for the name-lexical leg and composes as a **3rd RRF input** inside `recallEntitiesFused`
  (RRF already takes N rankings — `fusion.ts:31` is variadic). Note doc 05 §2 found BM25-over-names ties
  dense-over-names on the papers task (+0.0254, CI spans 0); the *point of I1* is that lexical should help
  on **exact terms / identifiers** in real queries, which papers-as-queries could not show.
- **Optionally FTS on `facts`** (over `source_text` / predicate+object) for a lexical fact leg — heavier;
  defer unless the dense-fact leg underperforms lexically.
- Corpus-scope every FTS query (`corpus_id` predicate) exactly as the vector legs do.

---

## 4. The papers-as-queries validity gap

**What the queries were in the prior single-graph experiments (R@10 ≈ 0.20-0.23):** the retrieval task was
**document→entity target-finding**. For each (document, entity) pair, the **query = the document's
`title + abstract`** (`harness.ts:178` `qtext = ${d.title} ${d.abstract}`), and the **target = one entity
attributed to that document** via fact-mediated attribution. "R@10" = did the entity's name/fact vector
rank the target entity in the top 10 for that paper. That is the whole loop's task, docs 05-29.

**Why it is a validity threat (three concrete strands):**
1. **~80% lexical shortcut (doc 27, in the ledger).** ~80% of targets appear **verbatim** in the query
   text (313/387 arxiv, 74/94 qbio), and a trivial `query.includes(canonical_name)` reranker *beat* a
   cross-encoder. The ledger's own meta-diagnostic: *"this eval's target-finding is ~80% name-presence
   detection (papers-as-queries limitation affecting the whole loop)."* So the numbers partly measure
   string overlap, not retrieval quality.
2. **Not a real user query.** No agent or user pastes a full paper abstract to ask "what is X." The query
   distribution is unrepresentative of the I1 capability ("recall what we know about X"), so transfer to
   real usage is unproven — doc 34's own "proxy caveat" (§75-79).
3. **Oracle is labelling-bounded.** Absolute R@10 has a ceiling set by extraction-labelling, not
   retrieval (doc 05 §6: a document carries ~10 labelled entities while ~34 have their name verbatim in
   it), and the whole loop's absolute levels ride on the index-asc tie-break (CLAUDE.md). Deltas are
   robust; absolute levels are not.

**How a real-query benchmark fixes it:** LongMemEval's queries are **natural human questions** ("What
degree did I graduate with?", record `e47becba`), the corpus is **real chat history** (not the target's own
source text), and the ground truth is the **evidence session/turn** (`answer_session_ids` / `has_answer`),
which is *independent of whether the answer string appears in the query*. It removes the name-presence
shortcut, makes the query distribution realistic, and gives a clean recall oracle that is not
extraction-label-bounded. This is precisely what doc 34:22 means by "real queries (not papers-as-queries)."

---

## 5. Benchmark survey — LongMemEval

**Submodule** `benchmarks/longmemeval/upstream` (populated; `.gitmodules` → xiaowu0162/LongMemEval). The
`upstream/data/` dir holds **only `custom_history/sample_haystack_and_timestamp.py`** — the actual dataset
JSONs are **not** in the submodule. **But the S split IS on disk**, downloaded outside the submodule at
`benchmarks/longmemeval/data/longmemeval_s_cleaned.json` (**277 MB**). `longmemeval_m` and
`longmemeval_oracle` are **not present** (would need the HuggingFace download per README:36-43).

**Dataset (parsed directly, n=500):** each instance is a dict (README:79-88 + verified):
`question_id, question_type, question, question_date, answer, answer_session_ids, haystack_dates,
haystack_session_ids, haystack_sessions`. A haystack session is a list of turns
`{role: user/assistant, content}`; **evidence turns carry `has_answer: true`**; `_abs`-suffixed
`question_id`s are abstention questions (README:81).

**Question-type distribution (the 500):**

| question_type | n | maps to intent |
|---|---|---|
| **single-session-user** | 70 | **I1 (info extraction, single needle)** |
| **single-session-assistant** | 56 | **I1** |
| **single-session-preference** | 30 | **I1 (preference recall)** |
| multi-session | 133 | I2 (multi-hop / synthesis) |
| temporal-reasoning | 133 | I3 |
| knowledge-update | 78 | I3-adjacent (supersession) |
| — of which abstention (`_abs`) | 30 | skip for retrieval eval (README:206) |

**The I1 "local" subset = the three single-session types = 156 questions** (minus their abstention
members). multi-session → I2; temporal-reasoning + knowledge-update → I3.

**Haystack sizing (the corpus we would ingest):** avg **47.7 sessions / 493.5 turns per question**; across
all 500 Qs, **23,867 sessions / 246,750 turns** total (heavily overlapping filler sessions per README:118).
Evidence is small: `answer_session_ids` length is 1 for 176 Qs, 2 for 250, up to 6 — i.e. the answer lives
in **1-2 sessions** for most questions (the single-needle property that makes it an I1 test).

**Clean retrieval metric — NO LLM judge needed** (`src/retrieval/eval_utils.py`,
`src/evaluation/print_retrieval_metrics.py`): session-level and turn-level **recall_any@k / recall_all@k
and nDCG@k** (k=5,10,50), where the relevant docs are the evidence sessions / `has_answer` turns. This is a
clean ranked-relevance oracle — exactly I1's ground-truth type — and lets an I1 retrieval experiment run
**free of Claude** (embeds only). End-to-end QA correctness (`evaluate_qa.py`) is a separate, LLM-judged
metric we do **not** need for a retrieval gate.

---

## 6. LOCOMO

**Not present.** Only two submodules exist (`.gitmodules`): `benchmarks/longmemeval/upstream` and
`benchmarks/cronqa/upstream`. No LOCOMO dir, no LOCOMO data. It is referenced only in docs: doc 34:20/60,
doc 32:11, and `docs/benchmarks/landscape.md:39-50` + `plan.md`. `landscape.md` flags LOCOMO as the
**methodology-disputed** one (Zep 84→75, Mem0 58.44; §17, §49-50) and recommends running it *only alongside*
LongMemEval to triangulate. **If chosen, LOCOMO must be added as a new submodule (snap-research/locomo) +
data download** — it is net-new setup, whereas LongMemEval_S is ready on disk. Recommendation: LongMemEval_S
first; treat LOCOMO as an optional second corpus, not a blocker.

---

## 7. Experiment shape (mirror `.7` flat baseline + `.8` treatment)

**The fork that must be settled first (see Q9):** the R4 lever is an **entity⊕fact** mechanism, but
LongMemEval scores **session/turn** retrieval. Two ways to reconcile:

- **Path A — entity-centric (faithful to the R4 lever).** Ingest each haystack's sessions through the
  extraction pipeline → entities + facts (**with `fact_embedding`**) in a `_longmemeval` corpus; query =
  the LongMemEval question; `recallEntitiesFused` returns entities; **map each returned entity/fact back to
  its source session via provenance** and score session-level recall@k against `answer_session_ids`. This
  actually tests the lever — but requires (i) LLM extraction of chat (Claude/Haiku spend) and (ii) the
  **provenance backbone** (`source_memory_id` / `fact_units`), which is a **known open blocker** (CLAUDE.md:
  "`facts.source_memory_id` is NULL on every fact, and `fact_units` is empty"; doc 32 Phase 1.1). Without
  provenance you cannot map an entity hit to a session, so the LongMemEval oracle can't score Path A.
- **Path B — session-as-document (LongMemEval-native).** Treat each session (or turn) as a retrieval unit,
  embed its text, retrieve top-k by dense similarity (± lexical). This is the benchmark's own `flat-*`
  baseline and needs **no extraction, no Claude, no provenance** — but it **does not exercise the entity⊕fact
  fusion lever at all**; its "fusion" would be dense-sessions ⊕ BM25-sessions, which is doc 05/12's shippable
  hybrid (a TIE), not R4.

**(a) The flat baseline (analog of `.7`'s time-blind dense floor).** A **single-signal dense flat-vector**
control:
- Path B: dense (nomic) over **session text** (or turn text), session-level recall_any@10 over evidence
  sessions. Exact control name: **`DENSE-FLAT` (nomic cosine, session granularity)**. This is the direct
  `.7` analog — one signal, no fusion — and reuses `cronqa-flat-baseline.ts`'s structure almost verbatim
  (seeded sample, `VectorStore` content-keyed cache, `rankByScore` index-asc tie-break, index-desc
  tie-break control, `clusteredBootstrap`).
- Path A: **`ARM-NAME`** (dense-over-names only) mapped to sessions via provenance — the same floor the
  whole loop used, now on real queries.

**(b) The treatment.** The **fusion read path** = `recallEntitiesFused` (dense-names ⊕ dense-facts, RRF-60).
The I1-specific question is whether **BM25 becomes a 3rd RRF leg**:
- Minimal treatment: `FACTNAME` (name⊕fact) vs the flat baseline — re-confirms R4 on real queries + a new
  domain (chat), the honest generalisation test doc 16 §6 asked for.
- Full I1 treatment: `FACTNAME + BM25` (3-way RRF, the doc-34 "real hybrid") — this is where the lexical
  index earns its keep on exact terms/identifiers.

**Metric:** session-level `recall_any@5/@10` + `nDCG@10` (LongMemEval's own, `eval_utils.py`), reported
**on the I1 single-session subset** (and per-type). Optionally turn-level recall as a secondary. **No LLM
judge.**

**Candidate pre-registered bar (mirror R4 / `.8`):** on the I1 subset, **fusion recall@10 − dense-flat
recall@10 > 0, above 0 on all three bootstraps** (byPair / byQuestion / by-question-type), i.e. the same
"DEMONSTRATED (all three above 0)" bar R4 used (doc 16 §1), not merely a positive point estimate. If BM25 is
included, register `FACTNAME+BM25 − FACTNAME > 0` as the co-primary (does lexical add over the proven
fusion). A kill/invalid condition analogous to `.8`: a dense-flat recall@10 near 0 or near 1 ⇒ ingest/embed
defect, fix the harness, don't report as a finding.

**Existing harness patterns to reuse** (all no-Claude, deterministic): `cronqa-flat-baseline.ts` (the flat
floor + bootstrap + tie-break control + JSON artifact under `benchmarks/results/`), `cronqa-load.ts` (bulk
load), `fused-tool-probe.ts` (drive the real `recall_entities_fused` MCP dispatch through the env carrier),
`retrieval-eval/{harness,core,arms}.ts` (the shared RRF/oracle/bootstrap engine — but note its arms are
built for the papers-as-queries substrate; a LongMemEval harness is closer to `cronqa-flat-baseline.ts`'s
shape), `candidate-breadth.ts` (how candidateLimit/factLimit sweeps are done).

---

## 8. Substrate & gotchas

- **Corpus id: a NEW `_longmemeval`.** Register it first in `corpus_policies`
  (`INSERT INTO public.corpus_policies (corpus_id, recurring_facts) VALUES ('_longmemeval', false)`) — the
  only registration point (there is no `corpora` table; corpus_id is a TEXT tag — asf8 doc §C).
  `recurring_facts = false` (LongMemEval is not a recurring-truth corpus; the knowledge-update Qs test
  supersession but that is an I3 concern, out of I1 scope).
- **Must NOT wipe** `cognitive_test`'s 294-doc research substrate (CLAUDE.md: the substrate lives in
  `cognitive_test`) or `_cronqa` (the I3 corpus). Everything scopes by `corpus_id`; the load and all reads
  stay inside `_longmemeval`.
- **Bulk-load pattern** (`cronqa-load.ts:1-18`): direct `INSERT` bypassing `createFact`, **user triggers on
  entities+facts DISABLED inside the tx** (AGE sync + freshness bump) and re-enabled before commit
  (all-or-nothing, rolls back on failure), deterministic `uuidv5` ids, composite-FK requires entities
  loaded before facts in the same corpus (mig 052).
- **The `fact_embedding` cost — the real I1 ingestion decision.** The fusion's 2nd signal is dead unless
  facts carry embeddings (`facts.ts:1061` `WHERE fact_embedding IS NOT NULL`). So a bypass-`createFact`
  bulk load (like CronQA) is **not** sufficient for I1 as it was for I3 — the facts need embeddings.
  Options: (i) ingest via the real pipeline (extract → `createFact` embeds each fact, throws on failure);
  (ii) bulk-INSERT facts then batch-embed with a follow-up `UPDATE ... SET fact_embedding` pass. Cost order
  of magnitude: **embedding is ~1 nomic call per fact via Ollama :11434 (free, local, ~tens-to-hundreds of
  ms each)**; the **expensive** step is the **LLM entity/fact EXTRACTION from chat** (Path A) — that is
  Claude/Haiku spend and must get consent (Q9). Path B (session-as-document) needs only embeds (one per
  session/turn — order 24k sessions or 247k turns if all 500 haystacks; far fewer if the I1 subset).
- **Provenance blocker (Path A only).** `source_memory_id` NULL on every fact and empty `fact_units`
  (CLAUDE.md; doc 32 Phase 1.1 is the fix) means an entity/fact hit currently **cannot** be mapped to its
  source session — so Path A cannot be scored against LongMemEval's session oracle until the provenance
  backbone is built. Path B is unaffected (the session id is the retrieval unit).
- **Service deps:** Ollama :11434 (nomic-embed-text embeds), ml :8000 (only if extraction/Path A),
  Postgres :5433 `cognitive_test`. Filtered vector search needs `hnsw.iterative_scan = strict_order`
  (mig 058) or a corpus-scoped search silently returns zero rows (CLAUDE.md).
- **Known traps carried from asf8:** `rawQuery` rewrites snake→camel silently; `platform/src/index.ts` has
  NUL bytes (use `grep -a`); the 277 MB S file must be streamed/parsed carefully (a naive full-JSON load is
  ~fine at 277 MB but budget the memory).

---

## 9. Open decisions for the human (the forks before build)

1. **THE architectural fork (Path A vs Path B).** Do we (A) test the actual R4 entity⊕fact lever — which
   needs LLM chat-extraction **and** the unbuilt provenance backbone — or (B) run the LongMemEval-native
   session-as-document retrieval, which is cheap and Claude-free but **does not exercise the proven lever**?
   A hybrid: run B first as the honest flat baseline + a fast real-query number, then decide if A is worth
   the extraction+provenance investment. *This decision gates everything below.*
2. **Benchmark choice.** LongMemEval_S (ready on disk, 277 MB) alone, vs add LOCOMO (net-new submodule +
   download, methodology-disputed), vs both. Recommend **LongMemEval_S first**.
3. **BM25 now or later.** Build the Postgres FTS lexical index as a 3rd RRF leg **now** (it is the defining
   I1 addition, doc 34/32) — or measure dense⊕fact on real queries first and add BM25 only if the dense
   legs leave lexical headroom. Recommend building it, since "add a lexical index" *is* the I1 work item.
4. **Corpus scope.** All 500 haystacks (heavy: ~24k sessions / ~247k turns, and each Q owns its own
   haystack) vs the **I1 single-session subset only (156 Qs)** — still each carrying a full ~47-session
   haystack, so the ingest cost is set by haystacks, not question count. Decide whether to ingest per-question
   haystacks (LongMemEval-standard, isolates the needle) or one merged corpus.
5. **Claude spend (needs consent).** Path A extraction = Claude/Haiku spend (per the Haiku-first-dev rule,
   use Haiku). End-to-end QA scoring = LLM reader + LLM judge = Claude spend. The **retrieval-only recall@k
   metric needs NO Claude** (embeds only) — recommend starting there. Flag any Claude use for approval
   before running.
6. **Provenance sequencing.** If Path A is chosen, does doc 32 Phase 1.1 (provenance backbone) need to be
   built first? It does, for a session-level score — decide whether to build it now or defer Path A until it
   lands.

---

## Recommended pre-registration skeleton (I1 local)

- **Bead / doc:** new `single-graph/` prereg doc (next free number) + an I1 bead under `nmemo-asf` Phase 4;
  freeze before any number (the loop rule).
- **Population / cut:** LongMemEval_S, **I1 single-session subset** (single-session-user 70 +
  single-session-assistant 56 + single-session-preference 30 = 156), **excluding the `_abs` abstention
  members** (retrieval eval skips them). Report overall and per-type.
- **Corpus:** `_longmemeval` (new; `corpus_policies.recurring_facts = false`), loaded without touching
  `cognitive_test` or `_cronqa`. State Path A or Path B explicitly (Q9.1).
- **Arms (hold the query + corpus constant across arms):**
  - `DENSE-FLAT` — single-signal dense floor (the `.7` analog; Path B: dense over session text; Path A:
    dense-over-names).
  - `FACTNAME` — the shipped fusion (`recallEntitiesFused`, RRF-60 name⊕fact).
  - `FACTNAME+BM25` — 3-way RRF adding the new Postgres FTS lexical leg (only if Q9.3 = build now).
- **Metric:** session-level `recall_any@10` (primary) + `recall_any@5`, `nDCG@10` (LongMemEval
  `eval_utils.py`); turn-level recall secondary. No LLM judge.
- **Comparison + bar (DEMONSTRATED):** `FACTNAME − DENSE-FLAT recall@10 > 0, above 0 on all three
  bootstraps` (byPair / byQuestion / by-type) — the R4/`.8` all-three bar, not a bare point estimate.
  Co-primary if BM25 included: `FACTNAME+BM25 − FACTNAME > 0` (does lexical add over the proven fusion on
  real queries).
- **Pre-registered expectation:** name-only-shortcut removed (real queries), so the flat floor should be
  materially below the papers-as-queries 0.20; fusion expected to lead (R4 generalisation), with the
  degree-concentration caveat (doc 16 §4) predicting a **smaller** lift on sparse chat graphs than the
  arxiv +0.0724.
- **Kill / invalid conditions:** `DENSE-FLAT` recall@10 ≈ 0 or ≈ 1 ⇒ ingest/embed/oracle-mapping defect
  (fix the harness, not a finding); any fact with NULL `fact_embedding` in `_longmemeval` ⇒ fusion fact leg
  is silently dead (assert 0 NULL before scoring); Path A only — assert every scored entity hit resolves to
  a source session (provenance present) or the session oracle is invalid.
- **Discipline:** freeze the doc before computing; blind adversary before banking (re-derive the headline +
  re-embed a sample, per the R4 pattern); regression-gate the other intents' corpora untouched; deterministic
  + Claude-free for the retrieval metric (get consent before any extraction/QA-judge spend).
