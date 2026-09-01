# Pre-registration — the shippable hybrid: dense-over-names + BM25-over-names (retrieval experiment #2)

**Status:** FROZEN pre-registration. Written and committed BEFORE any number was computed.
**Date:** 2026-09-01 · **Branch:** `feat/single-graph-retrieval` · **Bead:** `nmemo-uhp.18`
**Follows:** `05-results-...md` (measured this configuration post-hoc), `07` (condensed oracle), `10`
(pool-then-re-rank tie — the dense-dense re-rank lever is exhausted; a re-ranker outside the two dense
vectors is what remains).

---

## 1. Why this experiment, and why it is not already answered

Doc 05 §5 measured, **post-hoc and never pre-registered**, the configuration a production hybrid would
actually ship: retrieved-set RRF over **(dense-over-names, BM25-over-names)**. It scored the **best R@10
in the whole study, 0.2260** — above ARM-NAME's 0.2006 by **+0.0254, CI [−0.0056, +0.0565]**. That CI's
lower bound is −0.0056: a near-miss, not a demonstration. Doc 05's own conclusion: *"'fusion should not
be built' is withdrawn — it needs its own pre-registered run."* This is that run.

The pre-registered doc-04 fusion arm was a **different** configuration — RRF over (composite-dense,
BM25-over-composite) — and it tied (0.1441). So no pre-registered result speaks to the shippable
configuration in either direction.

## 2. The question

Does retrieved-set RRF over a dense-over-names ranking and a BM25-over-names ranking retrieve the
held-out target at R@10 **more often** than the best single component (ARM-NAME), on the same graph, same
query pairs, same frozen vectors?

## 3. Design

Rankings reuse the committed embedding cache and the identical cosine / query-pair / oracle machinery of
doc 05 / E0 / R1. No re-embedding.

- **Dense-over-names** = ARM-NAME: entity vector = `embed(entityEmbedTextFor(name, desc, 'name'))`;
  ranking by cosine to the query, tie-break entity index asc.
- **BM25-over-names** = BM25 (k1 = 1.2, b = 0.75, lowercase, split on non-alphanumerics, no stemming, no
  stopwords — the doc-04 tokeniser, frozen) over the **name-only** entity text `e.name` (NOT the
  composite). An entity with BM25 score 0 shares no query term and is **not** retrieved.
- **Arm H (primary)** = `RRF-K(dense-over-names, BM25-over-names)`, retrieved-set RRF (Cormack 2009):
  each arm contributes `1/(K + rank)` only for items it actually retrieved. **Headline K = 60.**
- **Baselines:** ARM-NAME and BM25-over-names, recomputed here (ARM-NAME must reproduce doc 05, §6 gate).

## 4. Metric, oracle, and the null

- **Metric:** Recall@10, under **both** the strict oracle (doc 05) and the condensed oracle (E0, Tier-B
  min-3). Both reported for every arm.
- **The null:** fusion cannot beat its best single component — H R@10 ≤ max(ARM-NAME, BM25-over-names)
  R@10. The interesting alternative is that RRF's rank-fusion lifts targets both components rank
  moderately into the top 10.

## 5. Bars — pre-registered

Paired bootstrap CI, 10,000 resamples, seed **20260831**, resampling query pairs; plus cluster bootstraps
by entity and by document. Verdicts by the standard rule (CI above 0 / spans 0 / below 0).

- **PRIMARY (strict oracle):** `H(K=60) R@10 − ARM-NAME R@10`.
  - CI entirely above 0 → **hybrid DEMONSTRATED** (fusion beats the best single small-k arm).
  - spans 0 → **TIE** (a tie is a tie — even if the point estimate is the +0.0254 doc 05 saw).
  - entirely below 0 → **HARMS**.
- **Secondary, reported unconditionally, NOT promotable over the primary:** the same delta under the
  **condensed** oracle; `H − BM25-over-names` (both oracles); K-robustness at K ∈ {10, 30, 60, 100};
  retrieved-set vs full-ranking RRF (doc 22's distinction — reported to show it is measured, not
  asserted); per-corpus split.

The promotable claim is the **strict primary**. The doc-05 point estimate (+0.0254) is explicitly **not**
sufficient — only a CI entirely above 0 promotes.

## 6. Kill / void conditions

- **Strict regression gate.** Recomputed ARM-NAME strict R@10 MUST reproduce doc 05:
  `0.20056497175141244` (assert `|Δ| < 1e-9`) at **n = 354**. And BM25-over-names R@10 must reproduce doc
  05's `0.18926553672316385`. Mismatch → **VOID** (harness mis-wired).
- **Arm-identity degeneracy.** If H's top-10 equals ARM-NAME's top-10 for **> 95%** of query pairs, RRF
  is not actually fusing → no H-vs-NAME conclusion (report overlap and stop).
- **Component-disagreement sanity.** Report the mean top-10 Jaccard between the two components; if it is
  **> 0.9** the arms barely disagree and any fusion result is the uninformative case (report, do not
  promote). (doc 05 measured dense-vs-BM25 top-10 overlap at 0.184, so this is expected to pass.)
- **n < 100** → UNDERPOWERED, no verdict.
- **Clean-0/clean-1 guard.** Any R@k at exactly 0.0000 or 1.0000 is verified two ways before belief.

## 7. Process commitments

- Committed before the harness exists; not edited once numbers exist except to append results in a marked
  section. Harness audited against this text before numbers are read.
- Deterministic set arithmetic; no LLM in the measurement path; bootstrap seeded (20260831); cluster
  bootstraps by entity and document.
- A **blind adversary** reviews before banking, tasked in **both** directions, and specifically tasked to
  check (a) that a positive H−NAME is genuine rank-fusion and not an artifact of the RRF tie-break or the
  score>0 retrieval cutoff, and (b) whether the strict primary and the condensed secondary disagree in
  verdict (given doc 05's +0.0254 sits right on the strict boundary).
