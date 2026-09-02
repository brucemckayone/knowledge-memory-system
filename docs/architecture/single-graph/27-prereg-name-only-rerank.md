# Pre-registration 27 — NAME-ONLY cross-encoder reranking of the fusion pool (confirming the doc-26 lead)

**Bead:** nmemo-u8j.4 · **Depends on:** nmemo-u8j.1 (fusion), nmemo-u8j.2 (eval engine), doc 26 (the lead)
**Status:** FROZEN. Append results below the line; do not edit above it.
**Committed before computing:** yes.

## 1. Why this exists

Doc 26 (prereg-26) tested cross-encoder reranking with a `name + ≤10 held-out fact-sentence` candidate and
found it NEGATIVE (arxiv strict R@10 −0.1059, below 0 all three; qbio tie). But an **exploratory, NOT
pre-registered** name-only slice (n=60 arxiv, seed 20260901) showed the opposite for a bare-name candidate:
RERANK 21/60 = 0.350 vs FACTNAME 13/60 = 0.217 (**+0.133**), while name+facts tied fusion on that same slice.
The candidate representation was decisive — the fact-blob misled the reranker. **That +0.133 is a LEAD, not a
result** (n=60, single point estimate, no bootstrap, not pre-registered). This prereg confirms-or-kills it at
full scale under the same discipline as every other loop result.

## 2. Design (identical to prereg-26 EXCEPT the candidate)

- Same pool: top-**K=50** of the shipped fusion `FACTNAME = RRF-60(dense-names, dense-facts)`, index-asc.
- **candidate_text = the bare entity `canonical_name` ONLY** (no fact sentences). This is the sole change
  from prereg-26. `rerank-dump.ts --candidate=name`.
- Same model `BAAI/bge-reranker-v2-m3`, same query = title+abstract, same two-stage TS→Python→TS pipeline,
  same frozen `retrieval-eval` metric/oracle/bootstrap engine.
- **Substrate:** PRIMARY = arxiv (arxiv-nlp + arxiv-cv, **full n=387** — not the 60-slice). SECONDARY = qbio
  (n=94).
- **Arms:** `FACTNAME` (fusion baseline), `RERANK_name` (cross-encoder over the K=50 pool, name-only cand).

## 3. Metric, statistics, ceiling

- **R@10**, both oracles. **PRIMARY = RERANK_name − FACTNAME, strict R@10.**
- Cluster bootstrap by pair AND entity AND document (seed 20260831, 10,000 resamples).
- Report the pool-recall ceiling (FACTNAME R@50) — unchanged from doc 26 (50.9% arxiv / 57.4% qbio), since
  the pool is identical; only the reranking of it changes.

## 4. Pre-registered bar & decision rule

- **PRIMARY (DEMONSTRATED):** `RERANK_name − FACTNAME`, **strict** R@10, **> 0 on ALL THREE bootstraps**
  (pair/entity/doc) on **arxiv (n=387)** ⇒ a name-only cross-encoder reranker beats the fusion — the FIRST
  lever to beat the fusion since R4. Condensed reported alongside. This would justify a gated production
  reranker (a SEPARATE step).
- **Decision:**
  - strict clears all three on arxiv ⇒ DEMONSTRATED; the doc-26 lead is real; file the gated build.
  - strict positive but not all-three (or condensed-only) ⇒ a lead that did not clear at full scale; report
    honestly, do NOT ship (the doc-12 hybrid precedent).
  - strict ≤ 0 / spans 0 ⇒ the n=60 slice did not hold; the doc-26 negative stands for name-only too; banked.

## 5. Kill / VOID

- **VOID (wiring):** arxiv FACTNAME must reproduce R4 (strict 0.26356589147286824, n=387) in the dump — else
  the harness drifted.
- **VOID (pool mismatch):** the name-only pool must be the SAME K=50 fusion pool as doc 26 (same
  factnameStrictRank per pair, same ceiling) — only pool[].text differs. Verify the ceiling == 50.9% arxiv.
- **Underpowered:** guards the qbio secondary (n=94 > 30 fine; the n=60 slice is explicitly NOT the test).

## 6. Adversary (before banking)

Blind adversary: (a) wiring anchor; (b) confirm the pool is identical to doc 26 (ceiling, factname ranks) and
only the candidate text changed to name-only; (c) re-derive RERANK_name − FACTNAME as integer hits;
(d) confirm the cross-encoder saw ONLY the name (no fact text leaked into candidate_text); (e) confirm the
full n=387 was used (not the 60-slice); (f) spec froze before the full-scale numbers; (g) attack the
direction — is a positive real, or a pool/oracle/tie-break artifact; is a negative genuine or underpowered.

---

<!-- RESULTS APPENDED BELOW THIS LINE -->
