# Appendix 5 — Artifact audit: the doc 32 and doc 33 adversary debts, PAID

Independent audit of ~155 raw experiment artifacts against the claims made from them. **This closes the
two blind-adversary debts that had been outstanding since before 2026-08-28** (doc 39 §8).

Scope: `e1-artifacts/` (structural scan only), `convergence-artifacts/`, `recall-gate-artifacts/`,
`concept-join-artifacts/`, `multihop-artifacts/`, `sweep-coverage-artifacts/`. All recomputation done
independently of the original harnesses; doc 37's DB-derived numbers verified directly against
`cognitive_test`, read-only.

## Bottom line

**The disposition is safe.** Every pass/fail bar recomputed lands where the documents say it lands, and
**doc 37 is the most solid document in the set** — 22 of 24 checkable figures reproduce bit-exactly,
including all four bootstrap CIs.

**Doc 32 is different: its numbers reproduce but its confound story is factually wrong, its
neutralisation does not hold, and the pre-registered hub diagnostic it never ran reverses its stated
mechanism.** The doc-32 *verdict* (density is dead on the hard slice) survives; three of its comparative
claims do not.

**Doc 33 HOLDS** — the cleanest run in the set. Two defects, both omissions, neither flipping the grade.

---

## 1. Reproduction

| claim | reported | recomputed | verdict |
|---|---|---|---|
| doc 37 oracle: 1,079 co-cited of 21,609 | 4.99% | 1079 / 21609 / **4.993%** | MATCH (reproduced twice) |
| doc 37: 160 text-dissimilar co-cited | 160 | 160 (band total 11,123) | MATCH |
| doc 37 attribution 5714/5714, 2512/2512 | 100% | identical; DB confirms 2862+2852 | MATCH |
| doc 37 S0 cells/cov/AUC | 9420 / .7424 / .5313 / .6844 | identical | MATCH |
| doc 37 M1 | 15580 / .8610 / .7937 / .6755 | identical | MATCH |
| doc 37 M2 | 19117 / .9518 / .9187 / .6578 | identical | MATCH |
| doc 37 E AUC 0.7943, B AUC 0.6696 | as stated | E 0.7943 | MATCH |
| doc 37 E at S0's budget = 9.44% (1.89×) | as stated | 9.437% / 1.890× | MATCH |
| doc 37 entity pairs 19,400 / 137,922 / 736,882 | as stated | identical (`maxPairs=1e6` > 736,882, so **no truncation this run**) | MATCH |
| doc 37 ΔAUC(M1−S0) CI, median | [−0.0261,+0.0090], −0.0068 | **[−0.0265,+0.0114]**, −0.0072 | MATCH — spans zero as claimed |
| doc 37 ΔAUC(M2−S0) CI | [−0.0565,+0.0066] | **[−0.0595,+0.0088]** | MATCH — spans zero |
| doc 37 M1 truncated to 9,420 cells | 0.6589 / 0.4938 | identical (711 / 79) | MATCH |
| doc 37 p@100 M1 vs S0 | 0.360 / 0.260 | identical | MATCH |
| doc 37 op precision + lift | 8.50→5.96→5.37%; 1.70/1.19/1.08× | 8.503/5.963/5.372%; 1.703/1.194/1.076× | MATCH |
| doc 37 M2 proposes 88.5% of pair space | 88.5% | 19117/21609 = **88.47%** | MATCH |
| doc 37 p@k E vs M1 | 0.660/0.420/0.308 vs 0.360/0.258/0.195 | identical | MATCH — but "roughly 2×" is 1.83×/1.63×/1.58× |
| doc 37 S0 ⊂ M1: S0−M1 | 0 | **0** | MATCH |
| **doc 37 M1 − S0** | **125** | **128** (929 − 801) | **DISCREPANCY** — 125 is arithmetically impossible given S0−M1 = 0 |
| doc 37 hard-slice McNemar | 42–0 | 42 M1-only / 0 S0-only / 85 both | MATCH |
| doc 37 Δcoverage CIs | [+0.0755,+0.1587]; [+0.1117,+0.4153] | [+0.0779,+0.1631]; [+0.1333,+0.3819] | MATCH — both exclude zero |
| doc 37 max concept df 170 vs n 2,512 | 170 | DB: **170** | MATCH |
| doc 37 zero cross-corpus facts | 0 | DB: **0** | MATCH |
| doc 37 truncation 27.5% / 86.4% | as stated | 27.50% / 86.43% | MATCH |
| doc 37 §6.2: 10,486 of 21,609 pairs have cos ≥ τ | 10,486 | **10,486** | MATCH — confirms the circularity exactly: E's dissim coverage at S0's budget is **0** |
| **doc 37 §6.2 within-slice deltas** | S0 +5.0pp / M1 **+1.9pp** / M2 −1.2pp | S0 **+5.00** / M1 **+0.63** / M2 **−1.25** | **DISCREPANCY (M1)** — M1's slice budget is 7,409 cells where E scores 126/160; +1.9pp needs E at 124, which occurs only at budgets 7,150–7,270 |
| doc 37 §6.2 within-slice AUCs | .6126 / .6179 / .5978 / .6171 | S0 **0.6126** / M1 **0.6156** / M2 **0.6032** / E **0.6171** | PARTIAL — S0 and E exact; M1/M2 differ in the 3rd decimal, inside doc 37's own stated ±0.02–0.06 |
| doc 37 §6.3 concept-link rates + 156 concept-less | as stated | DB: **1161**/1230, **1195**/1282; 69+87 = **156** | MATCH |
| doc 37 corpus B entity-to-entity facts | 1,544 | DB: **1,544** | MATCH |
| doc 37 / 39: 170 of 564 both-sided pivots | 170 / 564 | DB: **170** of **564** | MATCH |
| doc 39 §5.1 single-hop beats multi-hop at equal cells | as stated | identical; also true for M2-truncated (0.6543/0.5188) | MATCH |
| doc 39 §5.4 doc-31 ceiling 4.4% | 4.4% | 7/160 = **4.375%** recomputed from raw node sets | MATCH |
| doc 39 §5.3 doc-29 H-B tied at L=2 | tie | CI [−0.065,+0.065], struct 0.21 = text 0.21 | MATCH |
| **doc 39 §5.3 "STRUCT *lost* at L=3"** | a loss | CI **[−0.225, +0.0125] spans zero**, n=16 | **DISCREPANCY — a tie by this project's own rule, published as a loss** |
| **doc 39 §5.5 "co-citation ~79% cosine-predictable"** | 0.79 | **not present in the artifact.** The only such statistic derivable *is* arm E's AUC 0.7943 | **CANNOT-CHECK** — see §3 |
| doc 39 §3.2 all 2,512 entities NULL description | 2,512 | DB: **2,512** | MATCH |
| doc 39 §3.8 `maxPairs` default + stderr-only warning | as stated | `concept-multihop.ts:79/:174` `console.warn` | MATCH (code-verified) |
| doc 39 §4 graph-quality table (2,240 predicates, 338 types, dup rates, inverse pairs, abstract nouns, degree, undated) | — | — | **CANNOT-CHECK** — doc-38 DB profiling with no saved artifact |

---

## 2. Doc 32 and doc 33 audit

| finding | verdict | evidence |
|---|---|---|
| **doc 32** every headline number reproduces exactly | **HOLDS** | Recomputed independently: dense 10/160 = 0.0625, 210/1079 = 0.1946, AUC 0.5789, among-overlap 0.5753, mean 21.9 / 33.36 populated, vocab 4181, 101 empty; sparse 7/160 = 0.0437, 287/1079 = 0.2660, AUC 0.5960, 0.5396, 5.84 / 7.16, vocab 521, 54 empty. Top-10 shared nodes and df values identical |
| **doc 32** coverage bar FAIL (≥25% not met) | **HOLDS, robustly** | 10/160 = 6.25%, Clopper-Pearson CI [3.04%, 11.19%], p vs 0.25 = **4.9e-10**. Survives every restriction, including the matched set (6/65 = 9.23%, CI [3.5%,19.0%], p = 1.2e-3) |
| **doc 32** discrimination bar FAIL (AUC < 0.63) | **HOLDS** | 0.5789 < 0.63 deterministically, and it stays below under every hub exclusion (0.562/0.554/0.540 at top-10/20/50) |
| **doc 32 §8** *"the aggressive prompt failed extraction on 101/294 docs (more parse-fragile long responses)"* | **CUT — factually wrong** | The 101 dense empties are **contiguous positional tails**: corpus A **97–146** (50 docs), corpus B **96–146** (51). The 54 sparse empties are also contiguous (A 42–68, B 41–67). Mean abstract length of empty vs populated is **1310 vs 1278** chars (dense) — no length signal. **The two runs' empty-doc sets overlap in ZERO documents** (54 and 101 of the same 294; expected ~19 under independence). **This is a truncated/aborted extraction run, not per-document parse failure** |
| **doc 32 §8** *"neutralized by recomputing on both-docs-populated pairs"* | **CUT — the neutralisation does not hold** | The two arms' both-populated sets are **different populations** (dense's is not a subset of sparse's), so 9.1% vs 6.5% compares two different denominators. On the **matched** set (all four documents populated in *both* extractions, n=65): **dense 6/65 = 9.23%, sparse 6/65 = 9.23% — an exact tie.** The published "a hair up" is a denominator artifact |
| **doc 32 §8** truncation is missing-at-random w.r.t. the oracle | **CUT** | `corpus-A/B.json` are ordered by **descending co-citation count** (corpus A mean co-citers by position bin: 186.6 → 135.8 → 91.9 → 69.9 → 58.0 → 48.3 → 40.9). The dense tail truncation removed the least-cited third. Dense-empty docs average **36.27** co-citers vs **85.98** for populated. Both-populated rate among co-cited text-dissimilar pairs is **68.75%** vs **41.76%** for the rest of the band, Fisher **p = 6.3e-12**. Sparse shows no such skew (p = 0.46). **The dense arm was measured on a citation-enriched subsample** |
| **doc 32 §8** *"dense AUC 0.579 **<** sparse 0.596 < bar 0.63"* as a comparative claim | **WEAKEN → tie** | ΔAUC(dense − sparse) = **−0.0171**, paper-clustered bootstrap CI **[−0.0642, +0.0301]**, 27.5% of reps positive. The absolute bar failure is deterministic and stands; **the ordered inequality does not.** Doc 37 §3's contrast — *"not doc-32's pattern, where AUC fell"* — inherits this and is unsupported |
| **doc 32 §8** *"the top shared dense nodes are generic hubs… density adds hub-noise, not discriminative shared concepts — exactly the pre-registered anti-hub failure mode"* | **CUT — contradicted by the diagnostic that was never run** | Doc 32 §6 pre-registered *"recompute AUC excluding the top-N hub nodes"*. It was never computed. Run now: full-oracle AUC by top-N df exclusion — **dense 0.5789 → 0.5622 (10) → 0.5536 (20) → 0.5395 (50)**; **sparse 0.5960 → 0.5450 (10) → 0.5273 (20) → 0.5165 (50)**. **Dense beats sparse at every exclusion level.** Sparse's discrimination is the more hub-dependent of the two. Doc 32's own table already showed `joinAUC_amongOverlap` dense **0.575** > sparse **0.540** — a pre-registered metric pointing the same way, reported and never commented on |
| **doc 32 §8** full-oracle coverage dense 19.5% vs sparse 26.6% ("empty-dragged") | **WEAKEN — direction reverses when matched** | Arm-own both-populated: dense 210/608 = **34.54%**, sparse 287/809 = **35.48%** (a tie). Matched (n=412): **dense 151/412 = 36.65% > sparse 133/412 = 32.28%.** **Density *did* raise full-oracle coverage.** The doc gives neither figure |
| **doc 32** *"5.6× extraction density"* | **WEAKEN — mixed bases** | 33.36 (dense, populated only) ÷ 5.84 (sparse, all docs). Like-for-like: **3.75×** (all vs all) or **4.66×** (populated vs populated) |
| **doc 32 NET** | **verdict HOLDS, three comparative claims CUT** | *"Density does not lift the text-dissimilar coverage ceiling to 25%"* is sound and well-supported. *"Density is worse than sparsity"* and *"density adds hub-noise"* are both unsupported; on the matched comparison and under the hub diagnostic, dense is equal or better. **The doc should read: density changed nothing on the hard slice and nothing detectable on discrimination** |
| **doc 33 §14.1** arms A/B/C cells, pairs, waste | **HOLDS** | Internally exact: 1−24/229 = 0.8952, 1−8/10 = 0.2, 1−25/231 = 0.8918 |
| **doc 33 §14.2** complementarity = 1, element **E020** (`ES.42`), reverse asymmetry 17 | **HOLDS** | B∖A = {E020} exactly; A∖B = 17. Against the sealed oracle, E020's `trueGuideline` = `ES.42`, which has 5 members — so *"not a singleton-guideline artifact"* is correct |
| **doc 33 §14.2** frontier dominance | **HOLDS on the letter** | Recomputed the full 540-point grid staircase: max coverage over all settings with cells ≤ 231 is **0.8276** (k=8, thr=0.5, 229 cells). Only one pair above → `FRAGILE_DOMINANCE` is the correct grade |
| **doc 33 §14.2** the dominance window | **WEAKEN (omission)** | The next cosine operating point is **k=9 / thr=0.5 at 255 cells reaching 26/29 (0.8966)** — it **beats** arm C's 25/29 for +24 cells (+10.4% budget). The doc discloses the adjacent marginal rate but never states that **cosine overtakes C just above C's budget.** The win is confined to a 24-cell window |
| **doc 33 §14.3** striking arm B's `CLEAR_WIN` as a grid artifact | **HOLDS — self-caught correctly** | All 162 grid settings with cells ≤ 10 produce 0 or 1 cells at coverage 0. Minor inaccuracy: the doc says every such setting is thr=0.70; in fact thr=0.70 yields 1 cell and thr ≥ 0.75 yields **0**. Immaterial to the strike |
| **doc 33 §14.3** cosine's cheapest matching setting = 84 cells (~8×) | **HOLDS** | k=3/thr=0.55, 84 cells, 9/29. 84/10 = 8.4× |
| **doc 33 §14.4** B reaches 3 of 9 guidelines; 4 pairs reached by neither leg | **HOLDS** | B's 8 elements map to exactly {`C.12`, `ES.30`, `ES.42`}; the 4 unreached are {E017 `C.48`, E022 `ES.20`, E023 `ES.75`, E025 `ES.30`} — exact match |
| **doc 33 §14.4** 4 of 104 concepts both-sided (59 code / 49 rule) | **CANNOT-CHECK, internally consistent** | Not in any artifact — the doc says *"independently confirmed in raw SQL"* but nothing was saved. Consistency passes: 59 + 49 − 4 = **104** exactly |
| **doc 33 §5** macro-over-9-guidelines *"reported once, labelled"* | **WEAKEN (missing pre-registered metric)** | Never reported in §14. Recomputed: **A 0.6259 / B 0.2556 / C 0.6481** |
| **doc 33** plumbing gate | **HOLDS** | `plumbing.before == plumbing.after`, `stable: true`, `embeddingsBackfilled: 56` = 29+27 as disclosed |
| **doc 33 NET** | **HOLDS** | The cleanest run in the set. Every load-bearing number verifies against a sealed external oracle. The two defects are omissions, not errors |

---

## 3. Failure modes found in the artifacts

| artifact | failure mode | changes a published conclusion? |
|---|---|---|
| `cc-seeded-dense.json` | **silent truncation** — the run stopped and wrote empty arrays. Contiguous tails A 97–146, B 96–146; zero overlap with the sparse run's empties; identical abstract lengths | **Yes for the mechanism, no for the verdict** |
| `cc-seeded.json` | same class — the sparse run lost a contiguous 27-doc block per corpus | No, but the doc-31 "4.4% ceiling" baseline was computed with **18.4% of documents silently missing** |
| `cc-density-result.json` | **denominator change presented as a difference** — the numerator is identical (10, 7) in both rows by construction; only the denominator moves, over non-comparable subpopulations | **Yes.** "dense 9.1% vs sparse 6.5% — a hair up" is cut |
| `cc-density-result.json` | **CI spanning zero reported as a loss** — ΔAUC −0.0171, CI [−0.0642,+0.0301], 27.5% of reps > 0 | **Yes.** "0.579 < 0.596" is a tie; doc 37 §3's citation of "the doc-32 pattern" is unsupported |
| `cc-density-result.json` | **pre-registered metric never computed** (§6 hub-excluded AUC); computing it reverses the stated mechanism | **Yes.** "Density adds hub-noise" is cut |
| `cc-citation-result.json` | **stored conclusion contradicts the data** — `embeddingIndependence: {meanCosCoCited 0.687, meanCosRandom 0.615, note: "near-equal => oracle embedding-independent"}`, a difference-of-means with no CI, on data where cosine's AUC against the same labels is **0.7943** | No — later docs adopted the opposite (correct) reading. But a validity check was "passed" on a test with no power |
| `cc-citation-result.json` | **a coincidence that is a tautology** — doc 39 §5.5 and doc 37 §6.6 treat doc-30's "~79% cosine-predictable" and arm E's AUC 0.7943 as two quantities that happen to agree. The 0.79 value is **not in this artifact**, and the only cosine-vs-co-citation discriminability statistic derivable *is* arm E's AUC: same predictor, same labels, same 21,609 pairs | Partly. The *inference* (E's edge is partly oracle circularity) is sound and better supported by §6.2's within-slice null. The *evidence offered* is identity, not corroboration |
| `cc-agent-result.json` | **CI spanning zero reported as a loss** — `L>=3.ci_p5_struct_minus_text = [-0.225, +0.0125]`, n = **16** | **Yes, narrowly.** doc 39 §5.3 should read "tied at both levels" — which supports its own headline at least as well |
| `cc-lowcos-result.json` | **vacuous comparison (0 vs 0)** — `struct_recall_lc 0, emb_recall_lc 0, freenav_recall_lc 0`: both arms recover nothing | No — doc 39 §5.4 cites only the deterministic coverage ceiling, which is the right thing to cite. Any "the agent recovers 0 where embedding does not" reading is unsupported: **neither does** |
| `cc-lowcos-result.json` | CIs spanning zero — `H2 ci_rrf_minus_emb [-0.0786,+0.0109]`; `tau=0.615 ci_p5_join_minus_emb [-0.0353,+0.1412]` at n=17 | No — not cited in doc 39. But "adding the concept leg via RRF hurt" is a **tie** in this artifact, not a harm |
| `cc-recall-result.json` | CI spanning zero — `join-bm [-0.015,+0.017]` (L≥2), `[-0.0456,+0.0343]` (L≥3) | No. **JOIN ties BM25 at both levels**; only join−emb excludes zero |
| `cj-results.json` | CI spanning zero alongside a FAIL — `joinMinusCosine [-0.537,+0.100]`, mean −0.214, n=29 | No — doc 20's FAIL rests on absolute bars, which is legitimate. But the arm-vs-arm comparison is a tie |
| `multihop-results.json` | **void number retained in the artifact** — `embeddingCoverageDissimAtSameCells` and `aboveFrontierDissim: true` are the circular metric doc 37 §6.2 retracts; the corrected values exist in no artifact | No — corrected in prose. **Hygiene: a reader of the JSON alone banks a retracted result** |
| `sweep-results.json` | **struck grade retained** — `primary2_frontierDominance.B.grade = "CLEAR_WIN"`, struck as void in doc 33 §14.3, unmarked in the JSON | Same hygiene issue |
| `multihop-results.json` arms E and B | **a non-selective arm scored as perfect coverage** — `scoreArm` sets `cells = |scores > 0|`; E and B score every pair, so `cells = 21609` and `coverageFull = coverageDissim = 1.0` **by construction** | No — doc 37 pairs it with the 9.44%-at-S0's-budget line. But in the §2 table E's "1.0 / 1.0" sits in the same columns as measured coverage |
| `multihop-identity-check.ts` | **vacuous pass, still unfixed** — `identical = onlyShipped.length === 0 && onlyMultihop.length === 0`; two empty sets print PASS. No `S.size > 0` guard | No (doc 39 §7.13 documents the hazard) — **but the one-line guard was never added, so the trap is live** |
| `concept-multihop.ts:169-179` | silent-truncation mechanism — `LIMIT ${maxPairs+1}`, `console.warn` only, default 100,000 | Already banked. **Verified fixed for the doc-37 run** (`maxPairs = 1e6` > 736,882, so no arm was capped) |

---

## 4. Sample sizes per headline claim

| headline | n | assessment |
|---|---|---|
| doc 37 coverage, full oracle | **1,079 positives** in 21,609 | adequate; CIs exclude zero |
| doc 37 coverage, text-dissimilar slice | **160 positives** in 11,123 | thin but usable; Δcoverage CI excludes zero; McNemar 42–0 is p≈1e-11 |
| doc 37 cell-normalised reversal | 9,420 cells | adequate on full, thin on dissim (79 vs 85 pairs) |
| doc 37 p@100 tie | **100** | doc 37 correctly calls it a tie |
| doc 37 within-slice AUCs | 160 positives | doc 37 correctly calls this *"uninformative at this n, for or against"* |
| doc 37 within-slice frontier deltas | deltas of **8, 1, −2 pairs** | M1's corrected +0.63pp is **one pair**. Noise. Do not quote it either way |
| doc 32 primary coverage | **160** band pairs, 10 hits | bar failure significant (p = 4.9e-10) despite small n |
| **doc 32 both-populated comparison** | dense 110, sparse 107, **matched 65 (6 hits each)** | **at n=65 with 6 positives, dense-vs-sparse is pure noise. Any directional claim is unsupportable** |
| doc 32 AUC comparison | 1,079 positives | adequate n; the delta is still a tie |
| doc 33 all primary bars | **29** elements, 9 guidelines | pre-registered as underpowered; complementarity = **1 pair**, dominance = **1 pair**. Graded correctly as FRAGILE |
| doc 33 secondary bootstrap | 29 | structurally uninformative: `coverage(C) − coverage(A)` ≥ 0 by construction (C ⊇ A), so `lo = 0` is guaranteed. **Doc 33 predicted this and refuses to cite it — correct handling** |
| doc 31 low-cosine retrieval | **17 queries** | all CIs span zero. Only the deterministic 7/160 ceiling is quotable — which is what doc 39 quotes |
| doc 29 H-B | **40** (L≥2), **16** (L≥3) | n=16 cannot distinguish a loss from a tie |
| doc 30 free-nav "parity" | **18** | the known noise case. Not cited by doc 39 |
| doc 29 free-nav | **20** / **9**, no CIs at all | unusable |
| doc 28 mechanical recall | **287** (L≥2) | adequate; join−emb CI excludes zero |

---

## 5. Unreported signal in the primary data

**1. The `hops` parameter is per-side, so the arm labels understate traversal depth by 2×.**
`concept-multihop.ts` documents `hops` as "max fact hops on **EACH** side". The `minHops` distributions:

- `hops0`: `{0: 19400}`
- `hops1` ("M1 1 hop"): `{0: 19400, 1: 65379, **2: 53143**}` — 38.5% at total path length 2
- `hops2` ("M2 2 hops"): `{0: 19400, 1: 65379, 2: 220308, **3: 216433, 4: 215362**}` — **431,795 of
  736,882 pairs (58.6%) at total path length 3 or 4**

Doc 37 §7 fences the result as *"not hops >= 3"*. Its own artifact contains 431,795 pairs at 3–4 hops.
Two consequences in opposite directions: the fence claims *less* than was measured, and the label makes
the flooding result look worse for the mechanism than it is — *"even 2 hops proposes 88.5% of the space"*
is really *"up to 4 hops does"*. Doc 39 §5.1 inherits the label.

**2. Attribution fan-out is a second coverage amplifier, distinct from the name-duplication caveat.**
195 of 2,512 entities are attributed to more than one paper, up to **19 papers** for one entity, and
`liftToPapers` propagates a single entity pair's score to every paper-pair combination. Share of covered
co-cited pairs reachable **only** through a multi-paper entity:

| arm | full oracle | hard slice |
|---|---|---|
| S0 | 154/801 = 19.2% | **23/85 = 27.1%** |
| M1 | 135/929 = 14.5% | **44/127 = 34.6%** |
| M2 | 101/1027 = 9.8% | 21/147 = 14.3% |

**Roughly a third of M1's hard-slice coverage — the coverage that produced the 42–0 McNemar — exists
because one entity was attributed to several papers, not because traversal connected two graphs.** This
is on top of the 41%/29% name-duplication figure doc 37 §7 already reports, and points the same way.

**3. `extractor-probe.json`: the entity/fact extractor returns nothing at all on code and rule text.**
All 4 code samples and all 4 rule samples: `entities: [], facts: []`. The 4 abstract controls return
3–10 entities. This is direct, dated evidence (2026-07-28 12:39, **before** `sweep-results.json` at
13:04) for doc 34 §3's later diagnosis that docs 20–33 measured label coincidence over a factless
substrate. **Doc 33 never mentions it despite the probe running in the same session as the sweep.**

**4. S0's score ranking is anti-correlated with truth at the head.** Recomputed precision@k for S0:
**p@100 = 0.260, p@500 = 0.286**, p@1000 = 0.184 — **non-monotone**; the top 100 cells are *worse* than
the top 500. M2 is worse at the head (p@100 = 0.200, p@500 = 0.112). The IDF+decay score is close to
useless as a ranker at small k — a sharper statement than the AUC framing gives.

**5. S0 is almost entirely a one-shared-label mechanism.** `sharedConcepts` in `hops0`: **18,873 of
19,400 pairs share exactly one concept** (511 share 2, 16 share 3). The single-hop shared-pivot JOIN that
beats multi-hop at equal cells is, 97% of the time, one label in common.

**6. On the matched doc-32 comparison, density *did* raise full-oracle coverage** (36.65% vs 32.28%,
n=412). The failure is specific to the text-dissimilar slice — a more precise and more defensible finding
than "dead on coverage", and consistent with doc 39 §6's still-open question about extraction density.

**7. Within its own blind spot, dense embedding matches M1 at exactly the same cost.** E needs **7,442**
slice cells to match M1's 127 hits; M1 spends **7,409**. Ratio 1.00×. For S0, E needs 3,988 against
S0's 3,591 (1.11×). For M2, E needs 9,169 against M2's 9,504 (**0.96× — E is cheaper**). A cleaner way
to state doc 37 §6.2 than the pp deltas, and it does not depend on the disputed M1 figure.

---

## 6. What could not be checked

- **Doc 39 §4's entire measured-graph-quality table** and §2.3's median 18 facts/paper — doc-38 DB
  profiling with no saved artifact.
- **Doc 37 §4.3's hub-stripped AUCs at top-5/10/20** — `excludeConceptIds` is applied inside the SQL, so
  these need a DB re-run. Only the top-3 variant is in the artifact, and it matches.
- **Doc 37 §3's two sensitivity flips.** Neither the subsetting rule nor the resulting scores are
  recorded. The load-bearing claim they support — *"discrimination is FLAT, not down"* — is independently
  sound: both ΔAUC CIs reproduce and both span zero.
- **Doc 37 §5's reduction anchors.** The artifact explicitly records that the doc-20 anchor *"was absent
  from this artifact"*. The 19,400 count matches `raw.hops0.length`, which corroborates but does not
  verify set identity.
- **Doc 33 §14.4's 4-of-104 intersection** — internally consistent, no artifact holds it, and the doc-20
  substrate would need re-querying (which two suites destroy unscoped).
- **Doc 30's "79% cosine-predictable" figure** — not present in the artifact. Either it is arm E's own
  AUC under another name (making doc 39 §5.5's "numerically indistinguishable" a tautology) or it has no
  surviving artifact.
- **Doc 32's parse-failure mechanism** beyond what positional structure reveals. No per-document
  extraction log exists, so the audit can show *that* it was a contiguous run truncation and *not* a
  length or content effect, but not what stopped the run. Doc 39 §7.8's note about session/spend limits
  surfacing as HTTP 429 wrapped in a 500 is the obvious candidate.
- `e1-artifacts/` (65 files) — structural scan only (small-n, zero-value and CI-spanning-zero patterns),
  not a claim-by-claim audit. Doc 39 §5 does not rest on the E1 legs, and all 7 legs already went through
  blind adversaries. The scan surfaced nothing new.

---

## 7. Artifact hygiene recommendations

1. **Stamp retracted values in the JSON**, not only in prose. Two artifacts currently hand a reader a
   struck grade (`CLEAR_WIN`) and a retracted circular metric with no marking.
2. **Never write an empty array where a run aborted.** Both `cc-seeded*.json` files record silent
   truncation as legitimate empty extractions, which is what made doc 32's confound story wrong.
3. **Record `n` beside every CI.** Three published "losses" in this set are CIs spanning zero at n ≤ 18.
4. **Add the `S.size > 0` guard to `multihop-identity-check.ts`** — the vacuous-pass trap is documented
   and still live.
5. **Save the DB-derived numbers.** Doc 39 §4's whole quality table and doc 33's 4-of-104 intersection
   are unverifiable because nothing was written down.
