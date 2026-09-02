# Pre-registration 26 — cross-encoder reranking of the two-signal fusion pool

**Bead:** nmemo-u8j.4 · **Depends on:** nmemo-u8j.1 (fusion read path), nmemo-u8j.2 (eval engine)
**Status:** FROZEN. Append results below the line; do not edit above it.
**Committed before computing:** yes.

## 1. Question

R4/doc 16 confirmed the two-signal fusion `FACTNAME = RRF-60(dense-over-names, dense-over-facts)` as the one
lever that beats name-only. doc 10 tested only a **dense** re-rank of a pool (tie — the only re-ranker that
improved the head *was* the head). The field-standard lever we have NOT tested is a **cross-encoder**: a model
that reads the query and a candidate *jointly* (not two independent embeddings), which can capture
interactions a bi-encoder cannot.

**Does reranking the top-K fusion pool with an open cross-encoder beat the fusion baseline (`FACTNAME`) on
R@10 — strict, all three bootstraps > 0 — on a well-populated graph?**

## 2. Design

- **Retrieve** the top-**K=50** candidate entities per query via the shipped two-signal fusion
  `FACTNAME = RRF-60(rName, rFactMax)` (the exact arm the eval engine computes; index-asc tie-break).
  K=50 is the "wide pool" (doc 11 proved 50 preserves the R4 lever). Also report K=100 as a sensitivity.
- **Rerank** the pool with a cross-encoder scoring each `(query_text, candidate_text)` pair jointly, then
  order the pool by descending cross-encoder score (stable tie-break = original fusion order).
- **query_text** = `"{title} {abstract}"` of the query document (identical to the eval's query text).
- **candidate_text** = `"{canonical_name}. "` + up to 10 of the entity's fact `source_text` sentences,
  **held-out** (exclude any fact whose source paper == the query doc, the same guard the fusion uses). This
  gives the cross-encoder the same substrate the fusion had (name + facts), so the test isolates the
  *reranking mechanism*, not an information advantage. If an entity has 0 held-out facts, candidate_text =
  the name alone.
- **Model:** `BAAI/bge-reranker-v2-m3` (open, multilingual, the bead's first pick). Run locally (CPU) in an
  isolated venv; no external API, no Claude. Record the exact model id + revision + device + latency. If the
  model genuinely cannot be provisioned, the fallback is `BAAI/bge-reranker-base`, then
  `cross-encoder/ms-marco-MiniLM-L-6-v2`; the actually-used model is recorded in the results (a fallback does
  NOT change the frozen bar).
- **Substrate:** PRIMARY = arxiv (arxiv-nlp + arxiv-cv, R4-confirmed, n≈387). SECONDARY = qbio (doc 24,
  n≈94) — to see whether reranking helps where the *degree-poor* fusion did not.
- **Arms:** `FACTNAME` (fusion baseline = the thing to beat), `RERANK` (cross-encoder over the K=50 fusion
  pool). `NAME` reported for reference. All scored under BOTH oracles by the same `retrieval-eval` engine
  (core.ts oracle + bootstrap primitives), so the numbers are directly comparable to R4/doc 20/24.

## 3. Pipeline (two-stage, so metric computation stays in the frozen TS engine)

1. **TS dump:** a thin tool over `retrieval-eval/{data,core}` builds the query pairs + fusion pool (top-K
   FACTNAME per pair) and writes, per pair: query_text, and for each of the K pool entities its
   entity_id + candidate_text (name + ≤10 held-out fact source_texts). Also emits the fusion baseline
   rankings so RERANK and FACTNAME are scored on the identical pair set.
2. **Python score:** a standalone script loads the cross-encoder once and scores every (query, candidate)
   pair, writing `{pairIdx: {entityId: score}}`. CPU; batched. Records wall-clock + per-query latency.
3. **TS score:** reads the scores, reorders each pool by cross-encoder score (fusion-order tie-break),
   computes strict + condensed rank of the target, and runs the 3 cluster bootstraps (seed 20260831) — the
   SAME `clusteredBootstrap` R4 used. Emits the arm table + primary delta + pool-recall ceiling.

## 4. Metric, statistics & the ceiling

- **R@10**, both oracles. **PRIMARY = RERANK − FACTNAME, strict R@10.**
- Deltas via cluster bootstrap by pair AND entity AND document (seed 20260831, 10,000 resamples).
- **Pool-recall ceiling (MUST report):** reranking can only surface targets that are IN the K-pool, so the
  achievable RERANK R@10 is bounded by the fusion's R@K. Report `FACTNAME R@K` (the ceiling) and the fraction
  of targets present in the pool. If the ceiling is at/near FACTNAME R@10 (no headroom), the experiment is
  ceiling-bound and a null is expected/uninformative (see kill).
- Report cross-encoder latency (ms/query at K=50) and the model id — the bead requires it.

## 5. Pre-registered bar & decision rule

- **PRIMARY (DEMONSTRATED):** `RERANK − FACTNAME`, **strict** R@10, **> 0 on ALL THREE bootstraps** (pair/
  entity/doc) on **arxiv** ⇒ cross-encoder reranking is a real lever ⇒ a production reranker is worth
  building (as a SEPARATE, gated step). Condensed reported alongside.
- **Decision:**
  - strict clears ⇒ reranking beats fusion; file the gated production reranker; report latency/pool cost.
  - strict fails but condensed clears ⇒ oracle-dependent lift; document honestly (do NOT ship on condensed
    alone; a fresh pre-reg like the hybrid `.18` precedent).
  - fails both ⇒ cross-encoder reranking does NOT beat the two-signal fusion on this task; banked NEGATIVE
    (a valid outcome — consistent with doc 10's dense-rerank tie and the "fusion is already the head" finding).

## 6. Kill / VOID conditions

- **VOID (wiring):** the eval, pointed at arxiv, must reproduce R4's `FACTNAME` numbers bit-for-bit
  (NAME strict `0.19121447028423771`, FACTNAME strict `0.26356589147286824`, n=387) ⇒ else the harness
  drifted; fix before trusting RERANK.
- **VOID (ceiling-bound):** if the K=50 pool-recall ceiling (FACTNAME R@50) is not meaningfully above
  FACTNAME R@10, there is no headroom for reranking to demonstrate anything ⇒ report the ceiling and treat a
  null as uninformative, not as a reranker verdict (raise K or change the pool, don't claim).
- **VOID (model):** the cross-encoder produces degenerate scores (all-equal, or NaN) ⇒ fix the model/tokeniser
  before scoring.
- **Underpowered:** < 30 query pairs ⇒ no pass/fail (arxiv n≈387 is fine; guards the qbio secondary).

## 7. Adversary (before banking)

Blind adversary: (a) confirm the wiring anchor reproduces R4; (b) re-derive RERANK − FACTNAME as an integer
hit-count on the same pairs; (c) confirm the cross-encoder saw held-out candidate_text (no query-doc fact
leak into the candidate); (d) confirm RERANK is scored on the SAME pair set as FACTNAME (no pair added/dropped
by pooling); (e) check the pool-recall ceiling is honestly reported and the verdict respects it; (f) confirm
the spec froze before the numbers; (g) attack the direction of any framing (a null must not be laundered into
"cross-encoders are useless", nor a ceiling-bound null into a real negative).

---

<!-- RESULTS APPENDED BELOW THIS LINE -->
