# Pre-registration 17 — candidate-breadth sufficiency for the shipped top-N fusion

**Bead:** nmemo-u8j.11 · **Depends on:** nmemo-u8j.1 (shipped read path), nmemo-u8j.2 (eval engine)
**Status:** FROZEN. Append results below the line; do not edit above it.
**Committed before computing:** yes (this is the pre-registration; the harness + numbers come after).

## 1. Question

The shipped read path `recallEntitiesFused` (commit 1679c7f) fuses two **HNSW top-N candidate
lists** — the top `candidateLimit` entities by name-vector cosine and the endpoints of the top
`factLimit` facts by `fact_embedding` cosine — via retrieved-set RRF-60. But the confirmed R4 result
(+0.0724 strict R@10, doc 16) was measured on **full-corpus rankings** (every entity; the max over
*all* of an entity's facts). Code-review of nmemo-u8j.1 flagged the gap: a fact-surfaced target ranked
past the candidate cut is dropped **before** fusion can lift it — the exact win R4 relied on.

**Does the production default (candidateLimit=50, factLimit=200) preserve the fusion lever, and at what
candidate breadth does the lift converge to the full-ranking result?**

This is a characterisation of the production approximation, not a new lever. It proves (or refutes) that
the thing we shipped actually delivers the thing we measured.

## 2. Substrate

Identical to R3/R4 — same query pairs, same held-out fact guard, same cached query vectors, same
`cognitive_test` entities/facts, exact in-process cosine (NOT a live DB round-trip; that is a separate,
second-order check). Reusing the offline harness keeps every config **comparable to the frozen FACTNAME
arm**, held-out and deterministic.

- **Primary substrate:** arxiv-nlp + arxiv-cv (the R4-confirmed independent extraction; n≈387).
- **Secondary substrate:** dal-nlp + dal-cv (n=354).

## 3. Arms

All rankings use the sanctioned primitives (`retrieval-eval/core`, `services/fusion`). Held-out guard:
every fact arm excludes facts sourced from the query document, exactly as R3/R4.

- **NAME** — full name-vector ranking (baseline; unchanged).
- **FACTNAME** = **FACTNAME_LTD(full, full)** — the frozen R4 arm: RRF-60(full name ranking, fact-max
  over ALL held-out facts). This is the integrity anchor.
- **FACTNAME_LTD(Kc, Kf)** — the production-shaped arm:
  - name candidate list = the full name ranking truncated to its top **Kc** entities;
  - fact candidate list = take the top **Kf** held-out facts globally by query cosine, aggregate to
    endpoint entities by **max** over *only those Kf facts*, rank entities by that max (this mirrors
    `searchFactsByVector(limit=Kf)` → `recallEntitiesByFactSimilarity`);
  - fused = `reciprocalRankFusion([nameTopKc, factEntityRanking], { k: 60, tieBreak: byIndex })`.

## 4. Grid (frozen)

`(Kc, Kf)` ∈ **{ (25,100), (50,200), (100,500), (200,1000), (full,full) }**.
`(50,200)` is the shipped default. `(full,full)` ≡ FACTNAME.

## 5. Metric & statistics

- **R@10**, both oracles: **strict** and **condensed** (min-3 Tier-A∪Tier-B, per E0/doc 07).
- **Primary oracle = condensed** (decision nmemo-u8j.10: task = find-the-relevant-set). Strict reported
  alongside; the condensed oracle is not arm-neutral (doc 12 §3), so both are always shown.
- **Deltas** (levels ride the tie-break): `FACTNAME_LTD(Kc,Kf) − NAME` and `FACTNAME_LTD(Kc,Kf) −
  FACTNAME(full,full)`.
- **Cluster bootstrap** by pair AND entity AND document (seed 20260831, 10,000 resamples).

## 6. Pre-registered bars & decision rule

- **PRIMARY (ship-preserving):** `FACTNAME_LTD(50,200) − NAME`, **condensed** R@10, **byPair** CI lower
  bound **> 0** ⇒ the shipped defaults deliver the lever. Strict reported, not gating.
- **Breadth-sufficiency point:** the smallest `(Kc,Kf)` whose `FACTNAME_LTD − FACTNAME(full,full)`
  condensed byPair CI **spans 0** (statistically indistinguishable from full ranking).
- **Decision:**
  - Primary clears at (50,200) → shipped defaults are adequate; record the sufficiency point as guidance.
  - Primary fails at (50,200) but clears at a larger grid point → **raise the shipped defaults** to that
    point (implement-on-proof; follow-up edit to `recallEntitiesFused`).
  - No grid point below full clears → the top-N production approximation cannot realise the full-ranking
    lift at tractable breadth; document honestly as a limitation of the shipped design (not a retraction
    of R4, which stands for full-ranking fusion).

## 7. Kill / VOID conditions

- **VOID (mis-wired):** `FACTNAME_LTD(full,full)` does NOT reproduce the frozen FACTNAME numbers
  bit-for-bit (arxiv-fusion-results.json: armsStrictR10.FACTNAME, primaryStrict, primaryCondensed).
- **VOID (harness broken):** `FACTNAME_LTD(full,full) − NAME` does not reproduce the R4 lift
  (strict byPair +0.0724, condensed byPair +0.0491 on arxiv).
- **Degeneracy guard:** report `FACTNAME_LTD(50,200)` top-10 == NAME top-10 overlap; > 0.95 ⇒ degenerate
  (fusion adding nothing), report and draw no positive conclusion.

## 8. Adversary

Blind adversary before banking: re-derive at least one `(Kc,Kf)` delta from the raw ranks, confirm the
`(full,full)` integrity anchor, and check the fact candidate list truly restricts the max-aggregation to
the top-Kf facts (not all facts) — the whole point of the experiment.

---

<!-- RESULTS APPENDED BELOW THIS LINE -->

## RESULT (2026-09-01) — PASS, see doc 18

Shipped default (50,200) clears the primary condensed bar on BOTH substrates (arxiv +0.0491
[0.0181,0.0801]; dal +0.0395 [0.0085,0.0706], both ABOVE 0); (25,100) fails on both, so (50,200) is the
floor. Integrity anchor reproduces frozen FACTNAME bit-for-bit; 0.0% degeneracy. Blind adversary
CONFIRMED bit-for-bit. Two banked caveats: dal PASS is condensed-oracle-dependent (dal strict spans 0);
"indistinguishable from full" is power-limited on dal, clean on arxiv. Decision: **no default change**.
Full numbers + caveats in `18-results-candidate-breadth.md`.
