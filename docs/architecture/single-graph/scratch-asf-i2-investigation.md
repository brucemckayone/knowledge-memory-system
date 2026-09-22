# scratch — I2 "multi-hop" retrieval investigation (next intent after I1)

**READ-ONLY prep, 2026-09-09. Not a design of record — a build brief for the I2 bead(s).** Mirrors
`scratch-asf-i1-investigation.md` and the frozen prereg style of doc 42. Priority order is I3→I1→I2→I4→I5
(doc 34); I3 shipped (`.8`, doc 41) and I1 shipped (`.13`, doc 42 — dense NEAR-SOLVES single-session
point-lookup, recall@10 = 1.000 ceilinged). The user chose **I2 (multi-hop)** as the next intent. All
counts below are parsed directly from `benchmarks/longmemeval/data/longmemeval_s_cleaned.json` (500
instances) and the on-disk I1 cache; where a doc/memory conflicts with the data, the data wins and it is
flagged.

**The one-line headline for the human:** unlike I1, **I2 on LongMemEval multi-session almost certainly
leaves dense real headroom** — because the honest metric is **`recall_all@k`** (retrieve *every* evidence
session, mean **2.61** per question, all ≥2), and the evidence sessions are **not uniformly on-topic**: some
carry **zero** question-token overlap (the "hard hop"). But the make-or-break number (does dense-flat
`recall_all@10` sit well below 1.0?) has NOT been computed — the one-run flat baseline settles it, and it is
cheap (reuses ~90% of the I1 harness). The prior fork returns: **Path B session-as-document is Claude-free
and ready; the architecturally-interesting traversal/bridge treatment is Path A (needs the provenance
backbone + extraction, still an open blocker).**

---

## 1. What I2 "multi-hop" commits to (docs 34, 32)

Doc 34 §I2 (`34-query-intent-set-proposal.md:25-31`) commits I2 to:

- **Capability:** *relational / multi-hop — "how are X and Y connected", "A→B→C".* Example queries: "what
  connects X and Y", "what did X influence that influenced Z".
- **Substrate:** **canonicalized traversable graph, typed edges (or PPR)** (doc 31).
- **Benchmark:** **2WikiMultiHop / HotpotQA / MuSiQue** (what HippoRAG uses); nmemo-bki *partly*
  **GraphRAG-Bench** (`34:28`).
- **Ground truth:** clean (answer + supporting facts) (`34:29`).
- **Current fit (`34:30-31`):** *traversal HAVE (needs corpus scoping + canonicalization); `.6` was negative
  on our fact-finding task — this re-tests it **in its home regime**.*

Doc 32 (`32-intent-adaptive-retrieval-program.md:74`) states the Phase-4 I2 work verbatim: *"multi-hop →
denser typed relations / passage nodes / PPR; gate on 2WikiMultiHop."* Doc 32's Phase-1 foundations that I2
leans on: the **provenance backbone** (§1.1, still an open blocker — CLAUDE.md: `source_memory_id` NULL on
every fact, `fact_units` empty) and **corpus scoping / dedup** (§1.2-1.3).

**A benchmark for I2 must test compositional recall across ≥2 evidence locations** — the answer is not in one
place; it requires *joining/aggregating facts across hops*, at least one of which is **not independently
retrievable from the question** (otherwise it is just two parallel I1 lookups). Ground truth is a clean
relevance set (all supporting evidence), not an LLM judgment.

**Distinction from I1 and I3** (the table the I1 brief froze, `scratch-asf-i1-investigation.md:38-42`):

| | binding operation | substrate exercised | what disqualifies it from the neighbours |
|---|---|---|---|
| **I1 local** | direct similarity lookup, single location | dense name⊕fact + lexical | answer lives in **one** place (now shown EASY for dense: recall@10 1.0, doc 42) |
| **I2 multi-hop** | traverse/compose across ≥2 evidence locations | canonicalized traversable graph / PPR | answer requires **joining** evidence across hops; ≥1 hop not on-topic to the question |
| **I3 temporal** | as-of / valid-time filter, supersede-not-overwrite | bi-temporal facts | answer **changes with the date**; needs time-disambiguation |

**Load-bearing nuance (honest, doc-34-vs-data):** doc 34's I2 *definition* is strict **compositional
multi-HOP** ("A→B→C", bridge-entity chaining where hop-2's query depends on hop-1's answer). The
LongMemEval `multi-session` type is **multi-EVIDENCE synthesis** (find N sessions each holding one piece,
then aggregate/count) — see §2/§4/§6. These overlap in *needing recall_all* but differ in *needing
compositional chaining*. This is the benchmark-choice tension the human must resolve (§6, §9).

---

## 2. The benchmark data — LongMemEval multi-session (parsed, n=500)

Parsed `longmemeval_s_cleaned.json` directly. **Question-type distribution (all 500), abstention in
parens:**

| question_type | n | abs (`_abs`) | maps to intent |
|---|---|---|---|
| single-session-user | 70 | 6 | I1 (done, doc 42) |
| single-session-assistant | 56 | 0 | I1 (done) |
| single-session-preference | 30 | 0 | I1 (done) |
| **multi-session** | **133** | **12** | **I2 (this brief)** |
| temporal-reasoning | 133 | 6 | **I3** (doc 34:33-40; NOT I2) |
| knowledge-update | 78 | 6 | **I3-adjacent** (supersession; doc 34:57 knowledge_update) |

*(This confirms the I1 brief's counts exactly; the earlier "133 multi-session" figure is the pre-abstention
total.)* **temporal-reasoning (133) and knowledge-update (78) are I3, not I2** — out of scope here.

**The I2 population = `multi-session`, non-abstention = 121 questions** (133 − 12 `_abs`; retrieval eval
skips abstention per LongMemEval README:206 and `print_retrieval_metrics.py:12`).

**Evidence-session-count distribution — THE multi-hop signal (`len(answer_session_ids)`):**

| # evidence sessions | # questions |
|---|---|
| 2 | 75 |
| 3 | 24 |
| 4 | 16 |
| 5 | 6 |

- **100% of multi-session questions have ≥2 evidence sessions** (min 2, median 2, mean **2.61**, max 5).
  Total gold sessions across the 121 Qs = **316**.
- **This is the decisive difference from I1.** I1 had a single gold session, so `recall_any@k` = `recall_all@k`
  and dense ceilinged at 1.0. Here the answer is genuinely spread across ≥2 sessions, so the honest metric
  must be **`recall_all@k`** (retrieve *every* evidence session), not `recall_any@k` (§3).

**Haystack sizing (the per-question candidate universe):** min 38 / **p50 47** / mean 47.1 / max 54 sessions
per question; 409 / **488** / 488.5 / 567 turns per question. Same order as I1 (~47.7 sessions) — needle(s)
in ~47-session own-history.

**`has_answer` turns per question:** min 2 / **p50 2** / mean 2.7 / max 6; distinct sessions carrying a
`has_answer` turn: min 2 / p50 2 / mean 2.5 / max 5.

**Oracle subtlety (flag for kill-conditions, §8):** **11 gold sessions (across 10 of the 121 questions)
carry NO `has_answer` turn at all** — they are gold by `answer_session_ids` but no individual turn is
labelled. Conversely **0** non-gold sessions carry a `has_answer` turn. So:
- The **authoritative gold set is `answer_session_ids` (session level).** `has_answer` is a strict subset
  signal.
- **Turn-level `recall_all` is structurally unattainable for those 10 questions** (a gold session with no
  labelled turn can never be turn-recalled). Report turn-level as secondary/diagnostic only; gate on
  **session-level `recall_all`.**

---

## 3. The metric shift — reuse LongMemEval's own definitions

LongMemEval's `src/retrieval/eval_utils.py` (submodule IS populated — README + full `src/` tree present)
defines all three metrics we need, `evaluate_retrieval(rankings, correct_docs, corpus_ids, k)`
(`eval_utils.py:24-29`):

```
recalled = {corpus_ids[i] for i in rankings[:k]}
recall_any = any(doc in recalled for doc in correct_docs)   # ≥1 gold in top-k
recall_all = all(doc in recalled for doc in correct_docs)   # EVERY gold in top-k
ndcg       = ndcg(rankings, correct_docs, corpus_ids, k)    # binary-relevance nDCG@k
```

`ndcg` (`eval_utils.py:4-21`) is standard DCG@k / ideal-DCG@k with binary relevance (1 if a doc is in the
gold set), so it already handles **multiple gold docs** (ideal-DCG sums over all gold). There is also a
turn→session roll-up, `evaluate_retrieval_turn2session` (`eval_utils.py:32-46`): strip the `_<turnid>`
suffix, dedupe to session ids, and grow `k` until `k` *unique sessions* are covered.

**What upstream actually REPORTS** (`src/evaluation/print_retrieval_metrics.py:30,37`): session-level
`recall_all@5, ndcg_any@5, recall_all@10, ndcg_any@10`; turn-level `recall_all@{5,10,50}, ndcg_any@{5,10,50}`.
**Upstream's headline retrieval metric is `recall_all@k`, not `recall_any@k`** — exactly the multi-evidence
bar. (Their `evaluate_qa.py` / `print_qa_metrics.py` is the separate LLM-judged end-to-end metric we do NOT
need.)

**The honest I2 primary = session-level `recall_all@10`.** Rationale:
- With mean 2.61 gold sessions, `recall_any@k` is a **weak lower bound** — it credits finding just one of
  the pieces, which for a "how many X" question is not the task. (`recall_any` would very likely repeat the
  I1 near-ceiling and hide the real difficulty.)
- `recall_all@k` is the retrieval precondition for actually answering the multi-session question, and it is
  what upstream reports — so we inherit their definition verbatim and stay comparable to published numbers.
- Secondaries (reported, not gated): `recall_all@5`, `nDCG@10` (multi-gold), `recall_any@10` (for the
  contrast with I1), turn-level `recall_all@10` (diagnostic only — unattainable for the 10 Qs above).

**Harness delta:** the I1 harness computes only `recallAnyAtK` (`longmemeval-i1-baseline.ts:182`). I2 needs
a one-line `recallAllAtK` (`ranking.slice(0,k) ⊇ gold`). `ndcgAtK` (`:185-191`) already supports multi-gold.
Everything else (cache, chunking, MAX-agg, bootstrap, per-type) is reusable.

---

## 4. Where dense should STRUGGLE — the hypothesis I2 exists to test (make-or-break)

For I1 dense ceilinged because each answer lived in **one on-topic** session. For multi-session, the answer
requires **synthesizing across ≥2 sessions**, and — the crux — **not every evidence session is
independently retrievable from the question.**

**Concrete evidence (6 sampled multi-evidence questions; q-token overlap = fraction of question content
words present in the gold session):**

- `6d550036` — *"How many projects have I led or am currently leading?"* (4 evidence sessions). Gold session
  `answer_ec904b3c_3` = *"I recently presented a poster on my research on the effects of social media
  influencers…"* — **whole-session q-overlap 0.00, has_answer-turn overlap 0.00.** This session *is* a
  project, but shares **zero** question tokens: retrievable only by knowing "presented a poster on my
  research" ≈ "a project." Another gold at 0.20. **A genuine hard hop.**
- `gpt4_59c863d7` — *"How many model kits have I worked on or bought?"* (4 sessions). Gold overlaps
  0.40 / 0.40 / **0.20 / 0.20** — each session names a *specific* kit ("Tamiya 1/48 Spitfire", "Tiger I
  tank") without the query word "kit."
- `b5ef892d` — *"How many days did I spend on camping trips…?"* (3 sessions): gold overlaps 0.62 / **0.25** /
  (one gold with no has_answer turn).
- Contrast — some are easy: `0a995998` (clothing, overlaps 0.71/0.86/0.71), `3a704032` (plants,
  0.40/0.40/0.80), `e831120c` (movies, 0.62/0.85).

**Read of the evidence:**
1. **Real headroom is likely.** Because the metric is `recall_all@k`, a question is only fully recalled if
   *even its lowest-overlap gold session* lands in top-k against ~47 competitors. The sample shows a clear
   **low/zero-overlap tail** (0.00, 0.20 sessions). Dense-flat will plausibly miss those, so
   `recall_all@10` should sit **materially below 1.0** — in sharp contrast to I1. **This is the intent's
   reason to exist.**
2. **But it is NOT proven — one number settles it.** Caveat from I1: nomic dense is *stronger than lexical
   overlap suggests* — in doc 42 it recovered all 5 inferential-preference sessions that BM25 (zero shared
   content) missed. So a "0.00 token overlap" session may still be dense-reachable if nomic knows
   poster≈project. **I cannot assert headroom without running DENSE-FLAT `recall_all@10`.** If it comes back
   ≈1.0, I2-on-LongMemEval is as saturated as I1 and we escalate to a true compositional benchmark (§6).
3. **The nature of the hop is mixed (weigh for treatment choice, §7/§9):**
   - *Entity co-reference hops* ("boots I got from Zara" across sessions) — the kind a **traversal / shared-entity
     bridge** (Path A) is built to close.
   - *Semantic-categorization hops* ("poster presentation" = "a project"; "Tiger I tank" = "a model kit") —
     a **conceptual generalization**, not a graph edge. Traversal only helps if extraction canonicalized the
     instance under the category; otherwise this needs a stronger embedder or query expansion, not a hop.
   So even a perfect entity graph may not close every LongMemEval multi-session hop — an honest scope caveat.

**Question form:** almost all 121 are **counting/aggregation** ("How many X have I…"). This makes them a
clean multi-EVIDENCE recall test (find all instances, then count) but *not strict compositional chaining*
(you don't need session A's answer to find session B). See §6.

---

## 5. Reuse from I1 — cost (embed-cache hit rate)

The I1 harness (`platform/src/test/tools/longmemeval-i1-baseline.ts`) and its **append-only binary cache**
(`benchmarks/longmemeval/i1-vecs.bin` = 1.115 GB, `i1-keys.jsonl` = 362,967 keys / 93.9 MB) already exist.
Of the 362,967 cached keys, **362,817 are `search_document:` chunk-docs and 150 are `search_query:` I1
question keys**.

**Multi-session cache-hit rate (256/64 chunks, `search_document:` prefix — computed exactly as
`splitUnits`/`docKey`):**

- Multi-session unique chunk docKeys: **299,778** (321,309 total chunk instances across the 121 haystacks).
- **Already in the I1 cache: 45,622 / 299,778 = 15.2%** (LongMemEval does share some filler sessions across
  haystacks, but multi-session haystacks are mostly disjoint from the single-session ones).
- **NEEDING embed: 254,156 new chunk-docs** + **121 question keys** (0/121 already cached — different
  questions).

**Cost:** ~254k new nomic embeds. At the I1-observed ~11-27/s with `EMBED_CONCURRENCY=8`, that is roughly
**2.6-6.4 h wall-clock**, **free/local** (Ollama :11434), resumable, no Claude. **Recommendation: point the
I2 harness at the SAME `i1-vecs.bin` / `i1-keys.jsonl`** — `VecCache.load()` rebuilds the index and
`embedConcurrent` skips the 45,622 hits automatically, so the 15.2% is reused for free and the shared cache
grows to ~617k vectors (~1.9 GB). The `--max-old-space-size=6144` heap bump already in the harness header
covers the larger key index. (Keys are plain prefixed text, corpus-agnostic — sharing the cache across I1/I2
is safe.)

---

## 6. Alternatives if LongMemEval multi-session is too easy or not truly multi-hop

**2WikiMultiHop / HotpotQA / MuSiQue are NOT present anywhere.** `.gitmodules` has exactly two submodules
(`benchmarks/longmemeval/upstream`, `benchmarks/cronqa/upstream`). The only "multihop" hits in the tree are
`platform/src/services/concept-multihop.ts` + `docs/architecture/cross-corpus-audit/35/37-multihop-*` —
that is the **concept-layer co-citation multi-hop from the earlier cross-corpus arc** (a different task on
`feat/cross-corpus-audit`), **not** a standard multi-hop QA benchmark. So HotpotQA/2WikiMultiHop would be
**net-new setup**: a new submodule/download + a new harness + a Wikipedia (not chat/memory) corpus.

**Is LongMemEval multi-session a genuine multi-HOP test?** Honestly: it is **multi-EVIDENCE synthesis**, not
strict **compositional multi-HOP.**
- *For it:* every question needs ≥2 evidence sessions (recall_all is a real bar); some evidence is not
  on-topic to the question (the hard hop, §4); it is real chat-memory (the system's actual domain); ready on
  disk; clean session-level oracle; reuses ~90% of the I1 harness; free/Claude-free.
- *Against it as "multi-hop":* the questions are aggregation/counting ("how many X"), not bridge-entity
  chaining ("what did X influence that influenced Z") — you don't use one session's answer to locate the
  next. That is exactly doc 34's I2 *definition*, which LongMemEval multi-session does NOT fully instantiate.

**Recommendation:** run **LongMemEval multi-session `recall_all@k` FIRST** as the cheap headroom probe
(reuses the I1 harness; one flat-baseline run answers make-or-break). Two outcomes:
1. **Headroom present** (dense-flat `recall_all@10` well below 1.0) → that IS a real I2 finding on the
   memory domain; proceed to treatments (§7), and honestly scope it as *multi-evidence synthesis*, not
   *compositional chaining*.
2. **Saturated** (≈1.0 like I1) → LongMemEval cannot test I2; **escalate to HotpotQA / 2WikiMultiHop** (the
   textbook compositional benchmark HippoRAG uses) as net-new work, accepting the domain shift off chat/memory.

Either way, name the scope precisely in the prereg so we don't over-claim "multi-hop" from a multi-evidence
result.

---

## 7. Experiment shape (mirror I1's doc 42)

**The fork returns (same as I1, §9).** Path B is Claude-free and ready; the R4 entity⊕fact lever and the
true traversal are Path A (need provenance + extraction).

**(a) The flat baseline — `DENSE-FLAT`, session `recall_all@k`** (the `.7`/doc-42 analog, Path B). Identical
convention to doc 42: nomic **asymmetric prefixes** (`search_document:` / `search_query:`, nmemo-1cp),
**256/64 char chunks** of each turn (`splitUnits`), **session dense score = MAX over its chunks**, rank
sessions, score `recall_all@10` against `answer_session_ids`. The ONLY change from the I1 harness is the
metric (`recall_all` alongside `recall_any`). **This one run is the make-or-break number (§4).**

**(b) Treatments — what can beat dense on `recall_all`:**

| treatment | mechanism | Claude-free? | notes |
|---|---|---|---|
| **`BM25-FLAT`** | in-JS BM25 over whole turns, MAX-agg (`core.ts:82-124`) | yes | floor/leg; **won't help the hard hop** (zero lexical overlap by construction) |
| **`DENSE+BM25` (RRF-60)** | retrieved-set RRF of the two rankings (`fusion.ts`) | yes | the doc-34 I1 hybrid, carried over; tests if lexical adds on multi-evidence |
| **`DENSE+PRF` / query-expansion** | retrieve top seeds, mine their salient terms, re-query and fuse | yes (no LLM if term-mined) | a Path-B *proxy* for a hop; can reach a co-reference gold the raw question can't — but it is pseudo-relevance feedback, **not** a graph traversal |
| **`TRAVERSAL / bridge`** (the architecturally-interesting one) | retrieve one evidence session → hop to co-referenced sessions via shared canonical entities | **NO — Path A** | the real doc-34 I2 substrate; needs extraction (Haiku spend) **and** the provenance backbone (doc 32 §1.1, open blocker) to map entity→session |
| ~~learned rerank~~ | cross-encoder re-scoring | — | **no reranker model exists** — `rerank()` in `core.ts:56` is only a *pool re-sort by an existing score vector*, and there is no ml `/rerank` endpoint. A learned reranker is net-new (and an LLM reranker is not Claude-free). Not proposed for the first cut. |

**Testable Claude-free in Path B:** `DENSE-FLAT`, `BM25-FLAT`, `DENSE+BM25`, and (if we want a hop proxy)
`DENSE+PRF`. **Needs Path A (Claude + provenance):** the true entity-graph `TRAVERSAL` bridge and the R4
`recallEntitiesFused` entity⊕fact lever — same deferral as I1. State the path explicitly in the prereg.

**Metric:** session `recall_all@10` primary; `recall_all@5`, `nDCG@10`, `recall_any@10`, turn-level
`recall_all@10` (diagnostic) secondary. No LLM judge.

**Pre-registered bar (mirror doc 42 DEMONSTRATED):** for a treatment T, **T − DENSE-FLAT `recall_all@10` >
0 with by-question clustered-bootstrap CI lower bound > 0, AND a positive point estimate in each evidence-count
stratum (2 / 3 / 4-5 gold sessions)** — the "CI>0 + per-condition direction" bar. Report McNemar's exact p
on discordant pairs. The FLOOR (`DENSE-FLAT` / `BM25-FLAT` `recall_all@10` with CIs) is the primary
deliverable regardless of any treatment — it is the honest I2 headroom number.

**Kill / invalid conditions (fix the harness, not a finding):**
- `DENSE-FLAT` `recall_all@10` ≈ 1.0 ⇒ **the intent is saturated on this benchmark** (like I1) — do NOT run
  treatments; escalate to §6 (HotpotQA). (Note: this "≈1" condition here means *saturated intent*, unlike
  I1's doc-42 §6 where it meant *investigate for defect*; the difference is that recall_all over mean-2.61
  gold at ≈1.0 would itself be the surprising finding.)
- `DENSE-FLAT` `recall_all@10` ≈ 0 ⇒ embed/oracle-mapping defect.
- Any `answer_session_ids` entry not present in its own `haystack_session_ids` ⇒ parse/mapping bug (the I1
  harness already asserts 0 unresolved, `longmemeval-i1-baseline.ts:198-204`; the prep script asserts the
  same, `prep_i1_local.py:53-56`).
- Turn-level `recall_all` reported only as diagnostic (10 questions have a gold session with no `has_answer`
  turn ⇒ structurally < 1.0; not a defect).

---

## 8. Substrate & gotchas (carried from I1 + I2-specific)

Carried from doc 42 / `reference_nmemo_silent_data_traps`, all still binding:
- **Append-only BINARY cache is mandatory.** A single `JSON.stringify` of ~600k×768 vectors overflows V8's
  ~512 MB max string length; the `VecCache` (`longmemeval-i1-baseline.ts:61-124`) appends only new
  vectors/keys. Reuse it (§5).
- **nomic asymmetric prefixes + 256/64 chunking.** Whole-turn embedding 500s on nomic's ~2048-token context
  (doc 42 smoke-correction #2; turn lengths p50 434 / p90 2526 / max ~42k chars). BM25 stays at whole-turn
  granularity (no token cap).
- **Concurrent embed** (`EMBED_CONCURRENCY=8`, ~11-27/s). nomic runs cold when bge-m3 is resident — expect
  the slow end if another model is loaded in Ollama.
- **NO DB writes — Path B is a standalone offline harness.** `cognitive_test` (294-doc substrate) and
  `_cronqa` (I3) are untouched by construction; do NOT wipe them. `NODE_OPTIONS=--max-old-space-size=6144`.
- **Known traps:** `rawQuery` rewrites snake→camel silently; `platform/src/index.ts` has NUL bytes
  (`grep -a`). (Neither is on the Path-B offline path, but flagged for any Path-A extension.)

**I2-specific:**
- **Embed volume ~5.6× the *new* I1 work** (254k new chunk-docs vs I1's ~363k total, of which 15.2% reused).
  Budget the wall-clock; it is resumable so it can run in the background across turns.
- **Metric is `recall_all`, not `recall_any`.** Add `recallAllAtK`; keep `recall_any` for the I1 contrast.
- **Session-level oracle is authoritative** (`answer_session_ids`); turn-level is unreliable for 10 questions
  (§2). Gate on session-level.
- **Per-question strata for the bar** = evidence-count buckets (2 / 3 / 4-5), which the data fixes (75 / 24 /
  22). n=121 is small; a per-stratum direction check at these counts is directional, not powered — state that.
- **Path A only:** the provenance backbone (doc 32 §1.1) is still unbuilt (CLAUDE.md), so an entity/fact hit
  cannot be mapped to its source session — Path A's traversal treatment cannot be scored against the session
  oracle until provenance lands. Path B is unaffected (the session id is the retrieval unit).

---

## 9. Open decisions for the human (the forks before build)

1. **Make-or-break FIRST: does dense-flat leave headroom?** The single most important question — run
   `DENSE-FLAT recall_all@10` on the 121 multi-session Qs before committing to any treatment. §4 predicts
   headroom (hard-hop tail), but I1 warns nomic may absorb it. **If ≈1.0, the intent needs a harder
   benchmark (decision 2); if < ~0.9, I2-on-LongMemEval is live.**
2. **Benchmark choice.** LongMemEval multi-session (ready, cheap, chat-domain, *multi-evidence*) FIRST, vs
   add HotpotQA / 2WikiMultiHop (net-new submodule + Wikipedia corpus, but *true compositional multi-hop* =
   doc 34's actual I2 definition). Recommend LongMemEval-first as the probe; escalate only if saturated.
3. **Path B vs Path A.** Path B (session-as-document, Claude-free, ready) establishes the honest floor and
   tests BM25/PRF; the **traversal/bridge** treatment — the whole architectural point of I2 (doc 34: "re-test
   `.6` in its home regime") — is **Path A**, needing the provenance backbone + Haiku chat-extraction. Decide
   whether to (a) run Path B floor now and defer Path A, or (b) build provenance + extraction first so the
   traversal treatment is actually testable. Recommend (a) then decide.
4. **Metric = `recall_all@k`** (session level, primary). Confirm — it is upstream's own headline
   (`print_retrieval_metrics.py`) and the only honest bar for mean-2.61-evidence questions.
5. **Claude spend (consent).** The Path-B retrieval-recall metric needs **NO Claude** (embeds only). Path A
   extraction = Haiku spend (per Haiku-first-dev); end-to-end QA = LLM reader + judge = Claude spend — not
   needed for a retrieval gate. Flag any Claude use for approval.
6. **Scope honesty in the prereg:** name it *multi-evidence synthesis* retrieval unless/until HotpotQA is
   added; do not claim *compositional multi-hop* from a LongMemEval-multi-session result.

---

## Recommended pre-registration skeleton (I2 multi-hop)

- **Bead / doc:** new `single-graph/` prereg doc (next free number, e.g. `43-longmemeval-i2-*`) + an I2 bead
  under `nmemo-asf` Phase 4; **freeze before any number** (loop rule).
- **Population / cut:** LongMemEval_S, **`multi-session`, non-abstention = 121 questions** (derive with a
  `prep_i2_multi.py` mirroring `prep_i1_local.py`, asserting every `answer_session_id` resolves in its own
  haystack). Report overall and per evidence-count stratum (2 / 3 / 4-5).
- **Corpus / setup:** per-question haystack (~47 sessions), Path B session-as-document. State Path A vs B
  explicitly (decision 3). No DB writes; `cognitive_test` / `_cronqa` untouched. Reuse the shared binary
  embed cache (§5).
- **Retrieval convention (frozen, inherited from doc 42 §3):** nomic asymmetric prefixes, 256/64 chunks,
  session score = MAX over chunks; BM25 over whole turns; both aggregate to session level.
- **Arms (query + candidate set identical across arms):**
  - `DENSE-FLAT` — single-signal dense floor (the make-or-break, decision 1).
  - `BM25-FLAT` — lexical floor / leg.
  - `DENSE+BM25` — retrieved-set RRF-60 (the carried-over hybrid).
  - *(optional Path B)* `DENSE+PRF` — pseudo-relevance-feedback hop proxy, if we want a Claude-free bridge test.
  - *(Path A, deferred)* `TRAVERSAL` — entity-graph bridge; **only after** provenance + extraction land.
- **Metric:** session-level **`recall_all@10`** (primary) + `recall_all@5`, `nDCG@10`, `recall_any@10`
  (I1 contrast), turn-level `recall_all@10` (diagnostic). LongMemEval `eval_utils.py` definitions verbatim.
  No LLM judge.
- **Bootstrap + bar (DEMONSTRATED):** by-question clustered bootstrap (each question a cluster, 10,000
  resamples, fixed seed). **T − DENSE-FLAT `recall_all@10` > 0 with CI lower bound > 0 AND a positive point
  estimate in each evidence-count stratum.** McNemar exact p reported. FLOOR (`DENSE-FLAT` / `BM25-FLAT`
  with CIs) is the deliverable regardless of any treatment.
- **Pre-registered expectation:** unlike I1's ceiling, dense-flat `recall_all@10` is predicted to sit
  **materially below 1.0** (low/zero-overlap evidence tail, §4) — real headroom is the honest expectation,
  but if nomic already absorbs the categorization hops the floor may still be high; pre-commit to banking
  whichever way it lands. Whether BM25/PRF *closes* the hard hop is genuinely open (BM25 cannot, by
  construction; a real close likely needs the Path-A traversal).
- **Kill / invalid:** `DENSE-FLAT recall_all@10` ≈ 1.0 ⇒ intent saturated, escalate to §6 (do not run
  treatments); ≈ 0 ⇒ embed/oracle defect; any unresolved gold id ⇒ parse bug (assert 0); turn-level
  `recall_all` < 1 expected (10 gold-no-`has_answer` sessions) — diagnostic only.
- **Discipline:** freeze the doc → build harness (extend `longmemeval-i1-baseline.ts`: add `recallAllAtK`,
  new cut, per-stratum reporting) → run → **blind adversary** (re-derive the headline from source, re-embed a
  sample, re-check the session-oracle mapping and the hard-hop cases) → only then bank + update memory.
  Deterministic + Claude-free for the retrieval metric; get consent before any extraction / QA-judge spend.
