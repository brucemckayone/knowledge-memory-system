# Results — fact-level retrieval (retrieval experiment #3)

**Date:** 2026-09-01 · **Branch:** `feat/single-graph-retrieval` · **Queue item #4**
**Pre-registration:** `13-prereg-fact-level-retrieval.md` (frozen and committed before any number — `5358aa6`).
**Harness:** `platform/src/test/tools/fact-level.ts`. **Artifact:** `prereg-artifacts/fact-level-results.json`,
run log `fact-run.txt`. **Status:** banked after blind adversarial review (§5), which corrected the
harness (a pre-registered analysis was omitted) before banking.

---

## 1. The verdict

> **PRIMARY: TIE.** Ranking entities by their best-matching fact (FACT-MAX) retrieves the held-out target
> no more often than the name vector: FACT-MAX − ARM-NAME strict R@10 = **−0.0226**, CI **[−0.0678,
> +0.0226]** (byPair; byEntity [−0.0756, +0.0308]; byDocument [−0.0690, +0.0231]) — all span 0. This is
> the **third consecutive primary retrieval tie** (R1 pool-then-re-rank, R2 hybrid, R3 fact-max), so the
> single-substrate retrieval track has reached the convergence rule's stop threshold.

> **SECONDARY, the real signal: entity+fact fusion beats name alone — robustly on the condensed oracle,
> borderline on strict.** FACTNAME = RRF-60(ARM-NAME, FACT-MAX) − ARM-NAME:
> - **condensed** R@10 = **+0.0537**, above 0 on **all three** pre-registered bootstraps (pair
>   [+0.0198,+0.0876], entity [+0.0097,+0.0972], document [+0.0196,+0.0866]).
> - **strict** R@10 = **+0.0424**, above 0 byPair [+0.0056,+0.0791] and byDocument [+0.0063,+0.0776], but
>   **entity-cluster borderline** [**+0.0000**, +0.0831] — spans 0 by the standard rule.
>
> R@10 = 0.2429, the best strict result in the study. As a pre-registered **secondary**, it is a **lead,
> not a demonstration** — promotion needs a fresh pre-registration, ideally on independent data.

Gate passed (ARM-NAME strict R@10 = 0.20056497175141244, n = 354). Integrity clean.

## 2. Numbers

| arm | strict R@10 | condensed R@10 |
|---|---|---|
| ARM-NAME | 0.2006 | 0.2429 |
| FACT-MAX | 0.1780 | 0.2090 |
| FACT-MEAN | 0.1045 | 0.1158 |
| **FACTNAME (RRF name+fact-max)** | **0.2429** | **0.2966** |

- FACT-MEAN is clearly worse (−0.0960 strict, below 0) — mean-over-facts dilutes; max is the right
  aggregation.
- FACT-MAX ties NAME at every k and both corpora (dal-nlp −0.0169, dal-cv −0.0282, both span 0). The
  R@20 flip (+0.0085) is noise (spans 0 on entity/doc clusters).

## 3. The fusion is genuine complementarity, not an artifact

The two substrates disagree completely — **FACT-MAX and ARM-NAME share 0.0% of their top-10** — which is
exactly the condition under which fusion helps. Decomposition (strict, n=354): NAME 71 hits, FACT-MAX 63,
**FACTNAME 86** — the fusion **exceeds both components**, the signature of complementary signals, not one
arm dominating. FACTNAME rescues 29 targets NAME missed (23 of which FACT-MAX independently ranked in its
top-20 — real fact signal, not degree noise) and loses 14 NAME had (deep FACT-MAX ranks diluting a good
NAME rank); net +15. The mild degree bias in FACT-MAX (hits' mean eligible fact-count 12.7 vs misses 10.9)
does not carry the fusion: if it did, FACTNAME would track FACT-MAX's 63, not beat NAME's 71.

## 4. Integrity — the guard, normalisation, retrievability

- **Held-out fact guard is honest, leak bounded to ~zero.** The guard excludes facts sourced from the
  query doc d (via `factToPaper`). dal-cv: 100% fact coverage, no leak possible. dal-nlp: 179 unmapped
  facts (from the 10 attribution-lost docs), 41 touching a target; but **0 query docs are
  attribution-lost docs** and lost docs appear 0 times as fact sources. Decisive test (adversary): a
  *stricter* guard dropping all 179 unmapped facts changes FACTNAME on 1/354 pairs and **strengthens** the
  win (strict +0.0424→+0.0452). Not tautological.
- **Normalisation real** (silent-no-op guard): mean raw fact-vector norm **20.479** (≠ 1), 0 dim/finite
  violations, 0 post-normalise self-dot violations.
- **Retrievability ceiling 100%:** every target keeps ≥1 eligible fact after the guard; 0 unretrievable.
- **Non-degenerate:** FACT-MAX top-10 = ARM-NAME top-10 on 0.0% of pairs.

## 5. Blind adversarial review — and the harness fix it forced

An independent reviewer re-derived every number from a fresh DB dump in its own numpy script — **all
reproduced to the digit**. Verdict: **HOLDS**, with one correction that I applied *before* banking:

- **The harness omitted a pre-registered analysis.** Prereg §5 commits to cluster bootstraps by entity
  **and** document for the pre-registered analyses; the harness computed those for the *primary* only and
  ran byPair alone for every secondary. §7 had flagged the FACTNAME cluster bootstrap as adversary-critical
  — and it was the one not computed. I patched the harness to run all three for the load-bearing
  secondaries and re-ran; the entity-cluster result is what downgrades the strict FACTNAME lead from "above
  0" to "borderline (spans 0 on entity clusters)". The condensed lead survives all three. The correction
  **strengthens** the disposition (lead, not demonstration); it does not create the lead.

The reviewer confirmed the guard has no tautology leak (§4), the fusion is genuine complementarity (§3),
normalisation is real, and the "lead, needs fresh pre-registration" call is the correct disciplinary
disposition for a pre-registered secondary whose primary tied — not under-claiming.

## 6. Disposition

- **Retrieval-track consecutive primary ties = 3** → the single-substrate entity-retrieval track is
  **concluded**. Name, description, pool-re-rank, hybrid, and fact-max all tie for target-finding at
  R@10 ≈ 0.20–0.23.
- **The one lever that separates is cross-substrate fusion** (entity-name ⊕ fact-level). It is a genuine,
  reproduced, leak-free, complementary signal. On the target-finding (strict) task it is a **borderline**
  lead (entity-cluster CI touches 0); on the relevance-set (condensed) task it is a **robust** win.
- **The promotable next step is R4:** a fresh pre-registration with FACTNAME as the *primary*, confirmed on
  the **independent `arxiv-nlp` / `arxiv-cv` corpora** (a different extraction of the substrate, also fully
  fact-embedded). Re-running FACTNAME on the same 354 pairs would be circular (identical numbers); the
  independent corpora are genuine out-of-sample evidence and would settle whether the fusion advantage
  generalises. This is the decision now put to the user.
- **`searchFacts` / `fact_embedding` are no longer "unexercised":** fact-level retrieval works, ties NAME
  alone, and its value is as the *second* signal in a fusion, not as a standalone retriever.

## 7. Process notes, against myself

1. I audited the harness against the frozen prereg before running (the discipline step) and still missed
   that the secondaries got byPair-only bootstraps while §5 committed to entity+document clusters. I
   checked the primary's cluster bootstraps and did not extend the check to the secondaries. The adversary
   caught it; the fix is in the harness and the strict FACTNAME lead is correctly downgraded to borderline.
2. My pre-adversary commit said the fusion "clears the strict AND condensed bar." Accurate for byPair;
   imprecise once the pre-registered entity-cluster bootstrap is run. Corrected to "robust on condensed,
   borderline on strict."
