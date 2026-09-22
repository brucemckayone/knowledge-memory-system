# 43 — I2 "multi-hop" real-query retrieval on LongMemEval_S (Path B) — PRE-REGISTRATION

**FROZEN 2026-09-09. Append results below the line; do not edit the pre-registration.**
Loop discipline (memory `feedback_verify_empirical_gates`): metric + bar fixed here BEFORE any number; the
harness is deterministic + Claude-free (nomic embeds only); a BLIND ADVERSARY sizes any leak and confirms no
launder before banking. A NULL / saturated / underpowered result is a valid banked outcome.

- **Intent:** I2 "multi-hop / relational" — compositional recall across ≥2 evidence locations (doc 34:25-31).
- **Bead:** `nmemo-asf.14` (Phase 4, first I2 experiment). Successor to `.13` (I1, doc 42).
- **Path:** **B (LongMemEval-native, session-as-document).** Same rationale as I1 doc 42: cheap, Claude-free,
  ready. **SCOPE HONESTY:** Path B measures *session* retrieval; it does NOT exercise the R4 entity⊕fact
  lever nor a real graph TRAVERSAL — the architecturally-interesting I2 treatment is **Path A** (entity-graph
  bridge/traversal), which needs the provenance backbone (doc 32 §1.1, still open) + Haiku extraction and is
  DEFERRED. Build brief: `scratch-asf-i2-investigation.md`.

## 1. Why this experiment / what I2 tests that I1 did not
I1 (doc 42) showed dense NEAR-SOLVES single-session point-lookup (recall@10=1.0, single needle). I2's answer
lives in **≥2 evidence sessions** (mean 2.61), so the honest bar is **retrieve them ALL** — `recall_all@k`.
The hypothesis I2 exists to test: with multiple evidence sessions, some of which are NOT independently
on-topic with the question (the "hard hop" — sampled cases carry 0.00 question-token overlap), dense-flat
should sit **materially below the I1 ceiling**, leaving headroom for a fusion/hop treatment. If instead
dense-flat `recall_all@10` ≈ 1.0, the intent is saturated on this benchmark (escalate — §8).

## 2. Data (frozen)
- **File:** `benchmarks/longmemeval/data/longmemeval_s_cleaned.json` (277 MB, 500 instances, on disk).
- **Population (I2 cut):** `question_type == "multi-session"`, **excluding `_abs`** = **121 questions**
  (verified from source; `temporal-reasoning` 133 and `knowledge-update` 78 are I3, excluded). The harness
  asserts the exact post-exclusion n and that every `answer_session_ids` entry resolves in its own haystack.
- **Evidence structure:** `len(answer_session_ids)` distribution 2→75, 3→24, 4→16, 5→6 (all ≥2; mean 2.61,
  max 5; 316 gold sessions total). Per-question haystack ~38-54 sessions (p50 47). Report overall + per
  evidence-count stratum (2 / 3 / 4-5).
- **Oracle wrinkle:** 11 gold sessions across 10 Qs carry no `has_answer` turn → **gate on session-level
  `answer_session_ids`**; turn-level recall is diagnostic only (unattainable for those 10).

## 3. Retrieval convention (frozen — inherited verbatim from doc 42 §3, incl. its two smoke-corrections)
nomic asymmetric prefixes (`search_document:` for stored turns, `search_query:` for the question); DENSE
unit = 256-char / 64-overlap sliding-window chunk (`splitIntoUnits`); a turn's dense score = MAX over its
chunks; **a session's dense score = MAX over its turns**. BM25 (k1=1.2/b=0.75) over WHOLE turns, session =
MAX over turns. Both aggregate to a session score; comparison is at session level. Shared append-only BINARY
embed cache (`i1-vecs.bin` + `i1-keys.jsonl`; ~15% of I2 chunks already present from I1). Concurrent embed.

## 4. Arms (query + candidate set identical across arms)
- **`DENSE-FLAT`** — single-signal dense floor. **This is the make-or-break headroom number.**
- **`BM25-FLAT`** — lexical floor / leg.
- **`DENSE+BM25`** — retrieved-set RRF-60 (`reciprocalRankFusion`, k=60) of the two session rankings.
- *(Path A, DEFERRED — not in this run)* `TRAVERSAL` — entity-graph bridge; only after provenance +
  extraction land. BM25 cannot, by construction, close a zero-overlap hard hop; a real close likely needs this.

## 5. Metric (frozen — LongMemEval `eval_utils.py` definitions verbatim)
- **Primary:** session-level **`recall_all@10`** — 1 iff EVERY gold session (`answer_session_ids`) is in the
  top-10 ranked sessions. (Upstream's own headline metric, `print_retrieval_metrics.py`.)
- **Secondary (reported, not gated):** `recall_all@5`, `nDCG@10` (binary-relevance, multi-gold), `recall_any@10`
  (the I1 contrast), turn-level `recall_all@10` (diagnostic only).
- **Tie-break:** `rankByScore` index-ascending (frozen); index-descending re-rank computed as the
  sensitivity control (`|asc−desc|` on recall_all@10; >0.02 flags fragility).

## 6. Bootstrap + bar (frozen)
- **Bootstrap:** by-question clustered bootstrap (each question its own cluster, 10,000 resamples, seed
  `20260909`), 95% CI on the paired delta.
- **H1 — treatment bar (DEMONSTRATED):** `DENSE+BM25 − DENSE-FLAT` `recall_all@10` **> 0 with CI lower bound
  > 0 AND a positive point estimate in each evidence-count stratum (2 / 3 / 4-5)**. McNemar exact p reported.
  CI spans 0 ⇒ banked NULL.
- **The FLOOR (descriptive, the deliverable regardless of H1):** `DENSE-FLAT` and `BM25-FLAT` `recall_all@10`
  with CIs, overall + per stratum. This answers the make-or-break headroom question.

## 7. Pre-registered expectation (before computing)
Unlike I1, dense-flat `recall_all@10` is predicted **materially below 1.0** (the low/zero-overlap evidence
tail forces at least one hard hop per multi-evidence question). Real headroom is the honest expectation — but
if nomic already absorbs the categorization hops (as it surprised us on I1's inferential preference cases),
the floor may still be high; **pre-commit to banking whichever way it lands.** Whether BM25 *closes* the hard
hop is genuinely open and doubtful (BM25 cannot bridge a zero-lexical-overlap hop by construction).

## 8. Kill / invalid conditions (fix the harness / escalate, do not report as a finding)
- `DENSE-FLAT recall_all@10` **≈ 1.0** ⇒ intent SATURATED on this benchmark — do NOT treat the treatment
  comparison as meaningful; escalate to a genuine compositional-multi-hop benchmark (2WikiMultiHop / HotpotQA
  / MuSiQue, all net-new setup) rather than fishing on a saturated task. (This is the I1 lesson applied up front.)
- `DENSE-FLAT recall_all@10` ≈ 0 ⇒ embed/harness/oracle-mapping defect.
- Any question whose `answer_session_ids` don't all resolve in its own haystack ⇒ parse bug (assert 0 before scoring).
- Turn-level `recall_all` < 1 is EXPECTED (10 gold-no-`has_answer` sessions) — diagnostic only, never a gate.

## 9. Discipline / anchors
- Deterministic + Claude-free: nomic via Ollama :11434 (through ml :8000); no LLM judge, no extraction, no DB
  writes — standalone offline harness, `cognitive_test` (294-doc) and `_cronqa` (I3) untouched by construction.
- Freeze this doc (done) → build harness (`longmemeval-i2-baseline.ts`: extend I1 with `recallAllAtK`,
  multi-gold, per-stratum, the 121-Q multi-session cut) → run → **blind adversary** (re-derive the headline
  from source, re-embed a sample, re-check the session-oracle mapping + the hard-hop cases) → only then bank +
  update memory. Get consent before any extraction / QA-judge / Path-A spend.
- Harness reuses `retrieval-eval/core.ts`, `services/fusion.ts`, `services/ml-client.ts`, and the I1 binary
  cache. Result JSON under `benchmarks/results/longmemeval/runs/`. Cut derived by
  `benchmarks/longmemeval/prep_i2_multisession.py` (gitignored, like the I1 cut).

---

## RESULTS (append below; do not edit above this line)

**Run 2026-09-09, n=121, shared binary cache. Result JSON:
`benchmarks/results/longmemeval/runs/2026-09-09-i2-multihop.json`.**

### Headline
- **Dense-flat is STRONG on multi-evidence recall_all@10 = 0.9504** (CI [0.9091, 0.9835]) — but **NOT
  ceilinged** (< the 0.98 kill line), so I2 is a live task. recall_all@5 = 0.8347, recall_any@10 = 1.0000,
  frac_gold@10 = 0.9780, nDCG@10 = 0.9381. **Headroom concentrates with evidence count** (per-stratum
  recall_all@10: 2→0.9733, 3→0.9583, **4-5→0.8636**). So finding *one* evidence session is trivial (any@10
  = 1.0, cf. I1); finding *all* is not, and gets harder as more are required.
- **H1 (does BM25 add) = NULL and DIRECTIONALLY NEGATIVE — a CLEAN negative, not ceiling-confounded.**
  DENSE+BM25 − DENSE-FLAT recall_all@10 = **−0.0413, CI [−0.0909, 0.0083], SPANS 0** (McNemar fused-only 2,
  dense-only 7; per-stratum delta 2 −0.013 / 3 −0.042 / 4-5 −0.136). Mechanism (adversary-verified): on the 7
  losses dense held every gold at ranks 1-8 and RRF demoted one to ranks 14-19 — BM25's noisy ranking on
  generic "how many X" tokens injects distractors ahead, RRF averages the clean dense hit down, and
  recall_ALL's conjunction flips the whole question. **BM25 fusion does not help multi-evidence recall.**

| arm | recall_all@10 | recall_all@5 | recall_any@10 | frac_gold@10 | nDCG@10 |
|---|---|---|---|---|---|
| DENSE-FLAT | 0.9504 [0.909,0.984] | 0.8347 | 1.0000 | 0.9780 | 0.9381 |
| BM25-FLAT | 0.7851 [0.711,0.860] | 0.5950 | 0.9917 | 0.9062 | 0.8388 |
| DENSE+BM25 | 0.9091 [0.851,0.959] | 0.7686 | 0.9917 | 0.9613 | 0.9206 |

Tie-break sensitivity (asc vs desc) = 0.0000.

### Blind adversary (independent, from SOURCE; `scratch-asf-i2-adversary.md`) — VERDICT: VALID-BUT-MISFRAMED
- **Floor + BM25-negative reproduced bit-for-bit** from a from-source parse + independent scoring (recall_all@10
  0.9504, per-stratum match, BM25 0.7851 from a scratch python BM25, H1 −0.0413 negative). Cache genuine (30
  fresh nomic embeds cos = 1.00000). Oracle clean: 0 unresolved gold, all ≥2 gold, the 11-no-`has_answer`
  sessions (10 Qs) confirmed + session-id gating confirmed, 3 duplicate-session haystacks all non-gold.
  (Immaterial nit: JS UTF-16 vs python code-point chunk boundaries differ on 589 emoji-containing chunks;
  fresh-embedding all 589 left the headline 0.9504 unchanged — no effect.)
- **The BM25-negative is REAL, not a fusion bug** (the 7 dense-only losses each show dense holding all gold at
  1-8, RRF demoting to 14-19).
- **CORRECTION the adversary forced (I had over-claimed the Path-A traversal motivation):** of the 6 questions
  where DENSE recall_all@10 = 0 — **3 near-miss/ranking** (2 gold at rank 11/12; 1 dense-ranking-failure where
  BM25 had the gold at rank 2) and **3 aggregation-over-buried-mention hops** (e.g. National Geographic→magazine,
  cake→baking, age-in-skincare). The hard hops' only shared entity is the **non-discriminative user-self**, or a
  **concept-type link that ALREADY FAILED for retrieval in this project (docs 28-32)**. And **BM25 surfaces those
  buried mentions at ranks 2-13** — so "lexical cannot close it" is FALSE. **Traversal-worth-it: mostly NO** —
  the residual needs buried-fact extraction + aggregation (a QA-level task), or a better embedder for the
  ranking cases, NOT an entity-bridge traversal.

### Banked disposition (honest, misframe corrected)
1. **BANKED: dense-flat is a strong multi-evidence floor** (recall_all@10 0.95, adversary-verified genuine),
   with headroom that grows with evidence count (4-5 stratum 0.864). Not ceilinged, but not far from it.
2. **BANKED NEGATIVE: naive BM25 fusion HURTS recall_all** (−0.041, clean RRF-displacement) — do NOT ship a
   BM25 leg for multi-evidence retrieval.
3. **BANKED (correction): Path A entity-traversal is NOT motivated by this residual.** The dense-misses are a
   heterogeneous long tail (near-misses + aggregation-over-buried-facts), not entity-bridge-closable; the
   candidate bridges are non-discriminative (user-self) or the already-failed concept link (docs 28-32).
4. **META across I1+I2 (LongMemEval real-query session retrieval): dense embedding (nomic, asymmetric prefix +
   256/64 chunks + MAX-agg) is the retrieval engine; the cheap graph/lexical levers (BM25, entity-traversal)
   do NOT add** — consistent with the concept-layer arc's meta (docs 28-32). The residual frontier is
   extraction+aggregation (QA-level, Claude) and embedder quality (bge-m3 untested here), not a retrieval-graph lever.
5. **Caveats:** 256/64 chunk convention (cost choice); n=121; LongMemEval multi-session is multi-EVIDENCE, not
   strict compositional multi-HOP (2WikiMultiHop/HotpotQA net-new) — a genuine multi-hop benchmark is the honest
   place to give traversal its best chance if pursued.
