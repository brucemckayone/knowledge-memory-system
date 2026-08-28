# Doc 37 — Multi-hop concept-mediated cross-corpus recall: RESULTS

**Status:** RESULT, adversary-reviewed. **Date:** 2026-08-28 · **Pre-registration:** doc 35 (frozen
2026-07-28, unchanged) · **Bead:** nmemo-uhp.19 · **Substrate:** doc 36 §3

> **Headline: multi-hop concept traversal is NOT a live cross-corpus retrieval mechanism on this
> substrate.** That direction is sound. **But almost none of the support for it is in the
> pre-registered bars** — the cost and base-rate arithmetic decided this run, and doc 35 did not ask
> for either. And the negative bounds to **name-derived concepts** (doc 36 §3.2), not to the
> architecture.

## 1. What was measured

Two independently-ingested arXiv corpora (`arxiv-nlp` 147 papers / `arxiv-cv` 147), each a real
entity+fact graph, with a shared concept super-graph above them. Oracle: co-citation, **1,079 co-cited
cross-corpus pairs of 21,609** (4.99% prevalence), 160 of them text-dissimilar (cos < 0.615).
Attribution **100%** (5,714/5,714 facts; 2,512/2,512 entities), verified against live DB counts.

**This is the first run in the series where the question was askable at all.** doc 34 §3 established
that doc-20 through doc-33 measured single-hop label coincidence over factless, disconnected entities:
**4 of 104 concepts were both-sided**. Here there are **170 of 564**, and the corpora have real
internal structure. doc 34 §6 step 4's cheap kill-check is passed.

## 2. Arms (untruncated — see §6.1)

| arm | entity pairs | cells | cov (full) | cov (dissim) | AUC | precision | lift vs 4.99% base |
|---|---|---|---|---|---|---|---|
| **S0** single-hop | 19,400 | 9,420 | 0.7424 | 0.5313 | 0.6844 | **8.50%** | **1.70x** |
| **M1** 1 hop | 137,922 | 15,580 | 0.8610 | 0.7937 | 0.6755 | 5.96% | 1.19x |
| **M2** 2 hops | 736,882 | 19,117 | 0.9518 | 0.9187 | 0.6578 | 5.37% | **1.08x** |
| **E** dense embedding | — | 21,609 | 1.0 | 1.0 | **0.7943** | — | — |
| **B** BM25 | — | 21,609 | 1.0 | 1.0 | 0.6696 | — | — |

`E` at S0's own 9,420-cell budget: **9.44% precision (1.89x)** — better than every concept arm.

## 3. The three frozen bars

| bar | verdict | why |
|---|---|---|
| §7.1 **reach** | **FAIL** | absolute bar met easily (0.7937 vs 0.25); 3x ratio missed at 1.49x |
| §7.2 **discrimination** | **FAIL by the letter** | M1 AUC 0.6755 >= 0.63 but below S0's 0.6844 |
| §7.3 **not hub-driven** | **PASS** | excluding the top-3 hubs *raised* the gain, 0.2624 to 0.3250 |

§7 requires all three. **Verdict: FAIL.** But each bar turned out to be a poor instrument, and saying
so is the main methodological finding of this run:

- **Bar 1's letter was unsatisfiable.** S0 scored 0.5313, so 3 x 0.5313 = 1.5939 > 1.0. No arm at any
  quality could pass. Still unsatisfiable under top-3 (1.125) and top-5 (1.0125) exclusion.
  **Bar 1's *spirit* does survive testing, and is worth banking:** at top-10 and top-20 exclusion the
  multiplier becomes mathematically reachable, and traversal delivers **1.90x** and **2.55x** — a real
  near miss, not an artifact.
- **Bar 2 fired on noise.** ΔAUC(M1 − S0) paper-clustered bootstrap = **[−0.0261, +0.0090]**, spanning
  zero; median −0.0068. It flips *positive* under two defensible sensitivities (single-paper entities:
  M1 0.6966 > S0 0.6711; fragmentation-stripped: 0.6797 > 0.6351). **Discrimination is FLAT, not
  down.** Coverage rose at unchanged discrimination — which is *not* doc-32's pattern, where AUC fell
  and coverage barely moved. ΔAUC(M2 − S0) = [−0.0565, +0.0066], also spanning zero.
- **Bar 3 is close to unfailable by construction.** It tests whether the *gain* survives hub removal.
  Removing hubs costs S0 more than M1 — single-hop can only use an entity's own labels, and hubs are
  the labels most likely to match directly — so the measured gain mechanically *grows* under
  exclusion, at every level tested (top-5 1.26x, top-10 1.05x, top-20 1.14x of baseline).

## 4. What actually convicts the mechanism (none of it pre-registered)

**4.1 Cell-normalised reversal.** Truncate M1 to S0's own 9,420-cell budget by its own score rank:
**0.6589 full / 0.4938 dissim**, against S0's **0.7424 / 0.5313**. In the region where both arms can
operate, **single-hop beats multi-hop on both metrics.** M1's entire coverage gain is bought with 62%
more cells. (Fairly: M1's extreme head is better — p@100 0.360 vs 0.260, a tie at n=100 — and it
crosses over around k around 500.)

**4.2 Base rate makes AUC the wrong lens.** At 4.99% prevalence, operating-point precision falls
monotonically with hops: **8.50% to 5.96% to 5.37%**. Untruncated M2 proposes **88.5% of the entire
pair space** at **1.08x chance** — doc 35 §8's pre-registered "reaches everything" failure, on
schedule. precision@k: **E is roughly 2x every concept arm at every budget** (E 0.660/0.420/0.308 at
k=100/500/1000 vs M1 0.360/0.258/0.195). Nothing here is a usable filter at this prevalence; the whole
comparison is between mechanisms running at 1.1x to 1.9x chance, which AUC 0.68-vs-0.79 conceals.

**4.3 Absolute discrimination IS hub-driven, and bar 3 cannot see it.** Strip generic labels and both
arms collapse below bar 2's own 0.63 threshold: S0 0.6844 to 0.6348 (top-5) to 0.6157 (top-10) to
**0.5881** (top-20); M1 0.6755 to 0.6373 to 0.6140 to **0.5954**. So the reach *increment* is genuine
structure, but the *discrimination* rests on about 20 generic hub labels (`large-language-models`,
`computer-vision`, `foundation-models`, `multimodal-learning`, `prompting`, and similar).

## 5. What survives, positively

- **Traversal genuinely connects pairs single-hop misses.** S0's covered set is an exact **subset** of
  M1's (S0 minus M1 = **0**, M1 minus S0 = **125**). Hard-slice McNemar 42–0 discordant, p about
  1e-11. Bootstrap Δcoverage_full [+0.0755, +0.1587] and Δcoverage_dissim [+0.1117, +0.4153], both
  excluding zero. The mechanism does something real; it is the *cost and precision* that condemn it.
- **S0 is verifiably the shipped mechanism.** Reduction anchor on the doc-20 substrate: 10/10, zero set
  difference. And on the **actual experimental substrate** (not previously run):
  **19,400 / 19,400 pairs, zero set difference**, max concept df 170 against n 2,512 so no pair is
  dropped by the `HAVING >= 0` guard. Not a straw baseline.
- Frozen parameters verified in code and **unmoved** since `bc2018c`: `TAU = 0.615`, `DECAY = 0.5`,
  `ATTRIBUTION_FLOOR = 0.95`, `hops` in {0,1,2}.
- Corpus separation held: **zero** facts have endpoints in different corpora.

## 6. Corrections forced by the adversary

**6.1 Undisclosed truncation (found by the adversary, missed by me).** `maxPairs` defaults to 100,000
(`concept-multihop.ts:79`) and the scorer never overrode it, so both M arms were capped. 27.5% of
hops=1 and **86.4% of hops=2** pairs were dropped, which **hid** §4.2's reach-everything result.
`maxPairs` was absent from §5's frozen list though `minScore` was in it — a second pre-registration
defect. Now set explicitly and recorded in the artifact with per-arm pair counts. Fixed in `a4ea2ee`.

**6.2 The favourable frontier number was circular.** 10,486 of 21,609 pairs have cos >= tau, so arm
E's first 10,486 cells are *definitionally incapable* of touching a slice defined as cos < tau. Letting
E spend its budget **inside** the slice: S0 +5.0pp, M1 **+1.9pp**, M2 **−1.2pp** — against a published
+18.8pp. **About 90% of the apparent advantage was definitional**, and the largest fair margin belongs
to **S0**, not to any multi-hop arm. Within-slice AUC: S0 0.6126, M1 0.6179, M2 0.5978, **E 0.6171** —
every pairwise CI spans zero. *The harness implemented doc 35 §6 literally; the pre-registration's own
frontier definition is what is circular.*

**6.3 Numbers I got wrong.** Concept-link coverage is **1,161/1,230 (94.4%)** and **1,195/1,282
(93.2%)**, not the "1230/1230 / 1282/1282" doc 36 claimed — **156 entities carry no concept** and
cannot participate in S0, at a non-uniform rate (5.6% vs 6.8%). The harness printed this and I lost it
in transcription. Corpus B has **1,544** entity-to-entity facts, not 1,350 (a mid-ingest figure carried
forward). Both fixed in `a4ea2ee`.

**6.4 "All handicaps point against the hypothesis" was wrong as a blanket claim.** The 156
concept-less entities contribute nothing at hops=0 but *can* be reached via a neighbour at hops >= 1,
so they **flatter** the multi-hop gain by about 1.2pp of hard-slice coverage. doc 36 §3.1's
fragmentation direction does hold (`concept_df` counts distinct roots, so fragmentation inflates df and
cuts idf) — but it held by luck, not because I checked it.

**6.5 I drifted into PESSIMISM.** I published "discrimination down — the doc-32 pattern" as the
load-bearing claim. It does not survive: the CI spans zero and flips under two sensitivities. Quoting
AUCs to four decimals against a bootstrap half-width of ±0.02 to 0.06 was false precision. This is the
**fifth** over-statement on this feature family and the **third** in the pessimistic direction. My
synthesis remains untrustworthy without the adversary.

**6.6 Embedding's dominance is over-stated by the oracle.** Arm E's AUC **0.7943** is numerically
indistinguishable from doc-30's **0.79** cosine-predictability figure for this oracle. "E beats the
concept layer" therefore partly restates "the oracle is 79% cosine-predictable". The E minus M1 CI
[+0.037, +0.196] excludes zero but is measured on an oracle sharing most of its variance with E's own
score. The de-circularised comparison is the within-slice one — and there **nothing separates any
arm**.

## 7. What this does NOT license

- **Not a verdict on the architecture.** Every concept label came from a bare entity **name** —
  `promotion-plan.ts:534` discards all descriptions (doc 36 §3.2, verified: 0 of 2,512 entities has
  one). "You never gave it descriptions" is a **correct** rejoinder. The description-aligned re-run is
  owed and will use **new corpus ids** so this substrate survives as the name-only control.
- **Not a fragmentation counterfactual.** 41% of S0's and 29% of M1's hard-slice coverage rides on
  name-duplicated entities, and the M1 minus S0 AUC gap flips to **+0.045** without them. What a
  *merged* graph would do is untested.
- **Not a claim the hard slice separates anything.** 160 positives in 11,123 pairs; every within-slice
  CI spans zero. Uninformative at this n, for or against.
- Not adjudication (fenced by §2), not hops >= 3, not an embedding-independent oracle, not field
  prevalence, not the concept layer's non-retrieval value.
- **Inherited debt:** this run imports doc-33's frontier metric (shown circular in §6.2) and doc-32's
  0.63 AUC threshold, both from runs whose adversaries were never run. Both M arms clear 0.63 anyway,
  so the threshold is not load-bearing — but "the same absolute bar doc-32 was held to" borrows
  credibility from two unreviewed runs. **doc-32 and doc-33 adversary debts remain outstanding.**

## 8. Disposition

Multi-hop concept traversal over per-corpus entity+fact graphs **adds real reach and costs
proportionally more than it returns**: at equal cells single-hop wins, precision falls monotonically
with hops toward chance, and dense embedding is roughly 2x better at every budget. The concept layer's
demonstrated value remains **non-retrieval** — structural audit, navigation, rare-bridge explanation —
consistent with docs 28 through 32.

**Two things this run changes.** (1) The doc-34 §2 register-mismatch deficit is **repaired**: 4 to 170
both-sided pivots via the conformed shared vocabulary. (2) The negatives of docs 20 through 33 no
longer rest on a degenerate substrate — but they are now **replaced** by a cost-and-precision negative
on a real one, which is a stronger and more specific result than what it supersedes.

**Still owed:** the description-aligned re-run (the one lever never tested), on new corpus ids.
