# 42 — I1 "local" real-query retrieval on LongMemEval_S (Path B) — PRE-REGISTRATION

**FROZEN 2026-09-08. Append results below the line; do not edit the pre-registration.**
Loop discipline (memory `feedback_verify_empirical_gates`): the metric + bar are fixed here BEFORE any
number is computed; the harness is deterministic and Claude-free (nomic embeds via Ollama only); a BLIND
ADVERSARY pass sizes any leak and confirms no launder before the result is banked. A NULL / underpowered
result is a valid banked outcome.

- **Intent:** I1 "local" — point lookup / "what is X", single-hop single-location recall (doc 34:17-23).
- **Bead:** `nmemo-asf.13` (Phase 4, first I1 experiment). Successor pattern to `.7`/`.8` (docs 40/41).
- **Path:** **B (LongMemEval-native, session-as-document).** Chosen at the 2026-09-08 architectural fork
  (handover 006). Path B is cheap, Claude-free, ready today, and establishes the honest real-query floor
  that fixes the papers-as-queries validity gap. **SCOPE HONESTY:** Path B measures *session* retrieval on
  real chat queries and whether a *lexical* leg helps; it does **NOT** exercise the R4 entity⊕fact fusion
  lever — that is Path A (deferred; needs the provenance backbone doc 32 §1.1 + Haiku chat-extraction).
  See `scratch-asf-i1-investigation.md` §7/§9 for the fork.

## 1. Why this experiment (the validity gap it closes)

Every prior single-graph retrieval number (R@10 ≈ 0.20-0.23, docs 05-32) used **papers-as-queries**: query =
a document's title+abstract, target = an entity attributed to it. Three validity threats (brief §4):
(1) ~80% of targets appear **verbatim** in the query (doc 27) — the task is largely name-presence
detection, not retrieval; (2) no real user pastes an abstract to ask "what is X" — the query distribution
is unrepresentative of I1; (3) the oracle is extraction-labelling-bounded.

LongMemEval_S removes all three: queries are **natural human questions**, the corpus is **real chat
history** (not the target's own source text), and ground truth is the **evidence session/turn**
(`answer_session_ids` / `has_answer`), independent of whether the answer string appears in the query. This
is exactly doc 34:22's "real queries (not papers-as-queries)".

## 2. Data (frozen)

- **File:** `benchmarks/longmemeval/data/longmemeval_s_cleaned.json` (277 MB, 500 instances, on disk).
- **Instance shape:** `{question_id, question_type, question, question_date, answer, answer_session_ids,
  haystack_dates, haystack_session_ids, haystack_sessions}`; a session = list of turns `{role, content}`;
  evidence turns carry `has_answer: true`; `_abs` question_ids are abstention questions.
- **Population (the I1 "local" cut):** the three single-session question_types only —
  `single-session-user` (70) + `single-session-assistant` (56) + `single-session-preference` (30) = **156**,
  **minus** their `_abs` abstention members (excluded — retrieval eval skips abstention, LongMemEval
  README:206). The exact post-exclusion n is asserted by the harness and reported. `multi-session` → I2;
  `temporal-reasoning` + `knowledge-update` → I3 — **out of scope here.**
- **Retrieval setup:** **per-question haystack** (LongMemEval-standard needle-in-own-history). For each
  question the candidate universe = the sessions/turns in **its own** `haystack_sessions` (~47.7 sessions /
  ~493 turns per question). Retrieval is scored independently per question; there is no merged corpus.

## 3. Retrieval units, arms, and fusion (frozen)

**Unit = TURN.** We embed each turn (not whole sessions) to stay clear of the nomic token cap
(`reference_nmemo_silent_data_traps`) and to align with LongMemEval's turn-level `has_answer` labels. A
turn longer than the embedder's cap is truncated by the ml service (recorded as a known limitation, not
corrected). Content-keyed embed cache (`VectorStore`) dedupes turns shared across haystacks; the cache is
persistent and resumable across runs.

**Session score = MAX over its turns' per-unit scores** (mirrors the production fact→entity MAX
aggregation, `retrieval.ts:74-86`). We then rank sessions by that aggregated score.

**Arms (query + candidate set held identical across arms):**

- **`DENSE-FLAT`** — the floor. cosine(nomic(question), nomic(turn)), MAX-agg to session. Single signal.
  This is the `.7` analog: one signal, no fusion.

  > **PRE-RUN CORRECTION (2026-09-08, before any number was computed).** §3 originally froze "query and
  > turn embedded with the same **raw**-text convention." That is wrong for this task. nomic-embed-text is
  > an **asymmetric** retrieval model (`ml-client.ts:55-74`, bead nmemo-1cp): stored passages must carry the
  > `search_document: ` prefix and queries the `search_query: ` prefix, and a side-test **on the LongMemEval
  > needle set itself** lifted recall@1 **0.38 → 0.75** with that scheme. Path B is precisely a passage
  > (chat-turn) retrieval task — the same regime for which the platform adopted the prefixes on its memories
  > path — not the symmetric name↔name similarity for which entity/fact embeddings stay raw. So DENSE embeds
  > **turns via `embedDocument`** (`search_document: `+content) and the **question via `embedQuery`**
  > (`search_query: `+question). This is the platform-adopted convention (nmemo-1cp), not an arm variable;
  > raw symmetric embedding is rejected as a known-defective convention for this task. (Implementation:
  > prefix the cache keys, so `VectorStore.ensureEmbedded`'s raw `ml.embed` produces the identical vectors.)
  > **SMOKE-SURFACED CORRECTION #2 (2026-09-08, still before any banked number).** The 5-question smoke
  > run FAILED HARD: Ollama returns HTTP 500 `input length exceeds the context length` on a long turn — it
  > does NOT silently truncate (the original §3 assumption was wrong). Turn lengths (measured on the cut):
  > p50 434 / p90 2526 / max 41,855 chars; 23% exceed ~1800 chars, and the tail exceeds nomic's ~2048-token
  > context. So whole-turn embedding is not viable. **Adopted fix — the platform's own chunker.** The
  > DOCUMENT (turn) side is split by the production sliding window (`splitIntoUnits`, `pipeline.ts:268`)
  > into **256-char / 64-overlap units** — the exact focused-unit regime the nmemo-1cp comment records as
  > validated on the LongMemEval needle set with the prefix scheme (recall@1 0.75). (The config default is
  > 128/64, the yxj.1 sweep winner at 0.771; 128/64 would be ~1.01M units for this subset vs ~340k at
  > 256/64 — 256/64 is chosen as the cost/fidelity balance for a one-shot floor, and 128/64 is flagged as
  > the fidelity-max follow-up if the floor looks weak.) The DENSE retrieval unit is therefore a
  > **256-char chunk**; **session dense score = MAX over all its chunks** (and turn dense score = MAX over
  > the turn's chunks, for turn-level recall). **BM25 stays at whole-turn granularity** (lexical has no
  > token cap; a turn is the natural lexical document), session = MAX over turns. Both legs aggregate to a
  > session score, so the session-level H1 comparison is consistent. Embedding is run **concurrently**
  > (pool of `EMBED_CONCURRENCY` requests) since serial nomic is ~10/s; the cache is content-keyed and
  > resumable. None of this is an arm variable — it is the fixed, platform-canonical retrieval convention,
  > frozen here before any number is computed.
- **`BM25-FLAT`** — lexical floor. `bm25Scores(buildBm25(turns), question)` (in-JS, k1=1.2 / b=0.75,
  `retrieval-eval/core.ts:82-124`), MAX-agg to session. Reported for completeness / as the lexical leg's
  standalone strength.
- **`DENSE+BM25`** — the treatment (the doc-34 "add a lexical index → real hybrid"). Retrieved-set
  **RRF-60** (`reciprocalRankFusion`, `fusion.ts`, `RRF_K_DEFAULT=60`) of the DENSE session-ranking ⊕ the
  BM25 session-ranking. Both legs cover the full haystack, so retrieved-set vs full-ranking RRF is
  equivalent here.

**Note on lexical (honest):** the shipped read path has **no** lexical index; all prior "BM25-names" was an
offline in-JS computation (brief §3). This experiment measures the lexical *lever* with the same in-JS BM25
the loop has always used. **Productionizing it as a Postgres FTS index (tsvector + GIN on the read path) is
a separate build item, filed only if the lever clears here.** On papers-as-queries lexical TIED dense
(doc 05/12: +0.0254, CI spans 0); the point of the real-query benchmark is to see whether that tie holds or
breaks when queries carry specific terms/identifiers.

## 4. Metric (frozen)

- **Primary:** session-level **`recall_any@10`** — for each question, 1 if ≥1 relevant session
  (`answer_session_ids`) is in the top-10 ranked sessions, else 0.
- **Secondary:** session-level `recall_any@5`, `nDCG@10`; turn-level `recall_any@10` (relevant turns =
  `has_answer:true`). Reported, not gated.
- **Tie-break:** `rankByScore` index-ascending (frozen, `core.ts:49`). A **index-descending** re-rank is
  computed as the tie-break-sensitivity control (doc 40 §4 pattern): report `|asc − desc|` on recall@10;
  `> 0.02` flags the level as tie-break-fragile (deltas can still be robust).

## 5. Bootstrap + bar (frozen)

- **Bootstrap:** by-question clustered bootstrap (`clusteredBootstrap`, each question its own cluster,
  10,000 resamples, seed `20260908`), 95% CI on the paired delta. (We use by-question as the single natural
  clustering; we deliberately do **not** manufacture doc-16's three-cluster "all-three-above-0" structure,
  which required byPair/byDoc/byEntity granularities this per-question data does not have.)
- **H1 — the I1 hypothesis (the pre-registered bar):** `DENSE+BM25 − DENSE-FLAT` session recall@10 delta
  **> 0 with by-question bootstrap CI lower bound > 0** (the standard "ABOVE 0"), **AND** a positive point
  estimate in **each** of the 3 single-session types (directional consistency across the subtypes). Both
  conditions ⇒ **DEMONSTRATED**. CI spans 0 ⇒ lexical does not add on this benchmark at this power (a valid
  banked NULL). Also report McNemar's exact p on the discordant pairs.
- **The FLOOR (descriptive, not gated):** report `DENSE-FLAT` and `BM25-FLAT` recall@10 with CIs. This is
  the honest real-query I1 floor — the deliverable that fixes the papers-as-queries gap regardless of H1.

## 6. Kill / invalid conditions (fix the harness, do not report as a finding)

- `DENSE-FLAT` recall@10 ≈ 0 or ≈ 1 ⇒ embed/harness/oracle-mapping defect.
- Any sampled question whose `answer_session_ids` do not all resolve to sessions present in its own
  `haystack_session_ids` ⇒ parse/mapping bug — assert **0 unresolved** before scoring.
- Any embed unit returned with a zero / wrong-dimension vector ⇒ embed defect — assert clean before scoring.
- Post-exclusion n falls below **120** ⇒ flag underpowered (report anyway; the subtype counts are fixed by
  the dataset, so a small-lift null may simply be power-bound — that is itself the honest finding).

## 7. Pre-registered expectation (stated before computing)

With the name-presence shortcut removed, the floor should be an honest number (no reason to expect the
papers 0.20). Whether **lexical adds** is genuinely open: papers-as-queries said TIE, but real questions
with named entities / dates / identifiers are the regime where BM25 could finally help — or the dense
nomic embedding may already absorb the lexical signal (the more likely null given n≈150 and a single
short-question query). We predict a **plausible small positive lift that may not clear CI>0 at this n** —
and we pre-commit to banking that null honestly rather than fishing for a favorable cut.

## 8. Discipline / anchors

- Deterministic + Claude-free: nomic-embed-text via Ollama :11434 (through ml :8000). No LLM judge, no
  extraction, no DB writes — Path B is a standalone offline harness, so `cognitive_test` (294-doc
  substrate) and `_cronqa` (I3) are untouched by construction.
- Freeze this doc (done) → build harness → run → **blind adversary** (independently re-derive the headline
  from source, re-embed a sample to confirm the cache, independently re-check the session-oracle mapping)
  → only then bank + update memory.
- Harness: new `platform/src/test/tools/longmemeval-i1-baseline.ts`, reusing `retrieval-eval/core.ts`
  (`mulberry32`, `dot`, `normalise`, `rankByScore`, `buildBm25`, `bm25Scores`, `mean`,
  `clusteredBootstrap`), `retrieval-eval/vector-store.ts` (`VectorStore`), and `services/fusion.ts`
  (`reciprocalRankFusion`). Result JSON under `benchmarks/results/longmemeval/runs/`.
- A python prep step (`benchmarks/longmemeval/prep_i1_local.py`) may derive the frozen I1 cut
  (single-session, non-abstention) from the 277 MB S file to keep the tsx harness light; gitignore the
  derived cut + embed cache.

---

## RESULTS (append below; do not edit above this line)

**Run 2026-09-08/09, n=150 (full I1 subset), binary embed cache, EMBED_CONCURRENCY=8. Result JSON:
`benchmarks/results/longmemeval/runs/2026-09-08-i1-local.json`.**

### Headline
- **The floor is HIGH and GENUINE — but read it as "the TASK is easy," not "retrieval is solved"**
  (adversary framing nit). DENSE-FLAT session **recall@10 = 1.000** (CI [1,1]) is CEILINGED, so the
  discriminating floor is the headroom metrics: **recall@5 = 0.9467, nDCG@10 = 0.9140, turn-level
  recall@10 = 0.8667**. Random baseline (uniform, 1 gold, ~48-session haystacks) ≈ **0.207** — so dense is
  a ~5× lift and reliably surfaces the on-topic session. This is dramatically above the papers-as-queries
  ~0.20 and directly closes the validity gap doc 42 §1/§4 set out to close: real single-session
  point-lookup is easy for dense with the right convention (asymmetric prefix + 256/64 chunks + MAX-agg).
- **H1 (does BM25 add) is a NULL — and UNINFORMATIVE, not a clean null.** DENSE+BM25 − DENSE-FLAT
  recall@10 = **−0.0133, CI [−0.0333, 0.000], SPANS 0** (McNemar fused-only 0, dense-only 2; per-type
  delta user 0 / assistant 0 / preference −0.0667). Because recall@10 is at the **1.000 ceiling**, BM25
  can only hold level or drag — it cannot show a lift. The prereg's own §6 "≈1 ⇒ investigate" condition
  fired; the investigation (below + adversary) confirms the ceiling is **genuine task-easiness, not a
  defect**. So the pre-registered lexical-lift test is uninformative on this metric.

### All arms (session-level)
| arm | recall@10 | recall@5 | nDCG@10 |
|---|---|---|---|
| DENSE-FLAT | 1.0000 [1,1] | 0.9467 | 0.9140 |
| BM25-FLAT | 0.9667 [0.933,0.993] | 0.9333 | 0.9015 |
| DENSE+BM25 (RRF-60) | 0.9867 [0.967,1.0] | 0.9667 | 0.9278 |

Turn-level DENSE recall@10 = 0.8667. Tie-break sensitivity (asc vs desc) = 0.0000. Haystacks 41–62
sessions (median 48). Gold DENSE rank buckets: **rank1 124 / 2-5 18 / 6-10 8 / >10 0 / miss 0** (a spread,
discriminating distribution — not a degenerate all-rank-1). Gold FUSED buckets: rank1 **129** / 2-5 16 /
6-10 3 / 11-20 **2** / miss 0 — fusion improves the head (+5 at rank 1; recall@5 0.9667>0.9467; nDCG
0.9278>0.9140) but pushes 2 gold sessions past rank 10 (the 2 McNemar losses). Classic RRF head/tail
trade — no net win at k=10.

### Blind adversary (independent, from SOURCE; `scratch-asf-i1-adversary.md`)
Steps 1–3 (source-only, decisive) all **PASS**:
- **Positional artifact — PASS.** Gold session mean fractional position 0.562 (near-uniform; only 1/150 at
  index 0). The zero tie-break delta is a benign consequence of the ceiling, not a positional cue.
- **Oracle mapping — PASS.** 0/150 unresolved gold ids; 0/150 gold sessions lacking a `has_answer` turn;
  id-string mapping (no off-by-one possible); 132/132 answers with ≥50% key tokens present in the gold
  session. The label is anchored to real evidence.
- **Leakage / is-it-really-retrieval — PASS.** A from-scratch python BM25-of-question reproduced BM25-FLAT
  **bit-exactly (0.9667)** — independently validating the whole scoring/oracle/aggregation pipeline the
  dense arm shares. The task is legitimate on-topic single-session lookup (not a copied-phrase leak). The 5
  BM25 misses are all **inferential single-session-preference** questions (no distinctive shared content);
  DENSE recovers all of them (per-type DENSE preference recall@10 = 1.000), which is exactly what carries
  the 1.000 headline.
- Framing confirmed: (a) recall@10=1.0 is a **genuine ceiling, not an artifact**; (b) "H1 uninformative
  because ceilinged" is **correct** (the null is structural, not a power finding).
- **Step 4 (independent fresh-embed dense reproduction) — MATCHES.** The adversary re-embedded from SOURCE
  with its own cache + the correct 256/64 + asymmetric-prefix convention: random-8 sample recall@10 =
  1.000 (rank-1 7/8); and decisively **dense recovered 5/5 of the exact BM25-miss inferential preference
  cases into the top-10 (ranks 4/1/9/7/9)** — the cases the 1.000 headline hinges on. 13/13 audited
  questions place gold in top-10.
- **ADVERSARY OVERALL VERDICT: VALID-AS-FRAMED.** The clean recall@10 = 1.000 is a genuine, independently
  reproduced task ceiling, not an artifact; the "H1 uninformative because ceilinged" and "fusion helps
  head, hurts tail" reads are correct and internally consistent; no launder in either direction. The one
  framing correction (applied to the headline above): recall@10 = 1.0 means the TASK is easy, not that
  retrieval is solved — lead with the headroom metrics, and keep the scope caveat (session retrieval only;
  does NOT exercise the R4 entity⊕fact lever; no generalization to I2/I3).

### Banked disposition (honest)
1. **BANKED: dense-alone near-solves I1 single-session recall on LongMemEval_S** (recall@10 1.0 / recall@5
   0.947 / rank-1 83%, vs random 0.207), with the nomic asymmetric-prefix + 256/64-chunk + MAX-agg
   convention. Adversary-confirmed genuine (no positional/oracle/leakage artifact).
2. **BANKED NULL: adding a BM25 lexical leg does not improve recall@10** (−0.0133, CI spans 0) — but this
   metric is **ceilinged**, so it is NOT evidence that lexical can't help; it is evidence the task is too
   easy at k=10 to test the question.
3. **NOT a result, a LEAD:** fusion beats dense at the unsaturated points (rank-1 +5, recall@5 +0.020,
   nDCG +0.014). This was observed AFTER the fact — it CANNOT be re-pre-registered on this same, now-peeked
   data (HARKing). Testing "does anything beat dense" honestly requires an **unsaturated operating point on
   unpeeked data** (recall@1/MRR, or a harder cut — multi-session/I2). Filed as the next fork.
4. **Caveats:** 256/64 chunking was a cost choice (128/64 = the config default / yxj.1 sweep winner, ~1.01M
   units, untested here — the fidelity-max variant). n=150 (the full subset; cannot be enlarged). The floor
   is for the SINGLE-session cut only; multi-session/temporal are I2/I3.
