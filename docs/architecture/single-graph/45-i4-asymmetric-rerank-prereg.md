# 45 — I4 asymmetric re-rank: can a DIRECTION-AWARE signal beat symmetric retrieval? — PRE-REGISTRATION

**Status: PRE-REGISTERED, NOT YET RUN.** Frozen 2026-09-17. Append results below the RESULTS line.
**Cost: ZERO** (SELECT-only, stored embeddings, no LLM calls). Successor to doc 44.

## 1. Why — doc 44's adversary handed us the diagnosis

Doc 44 found no deterministic retriever puts the cause in the top 10 more than ~42% of the time, and its
blind adversary identified **why**: every arm is **direction-blind**. Reversing cause and effect moves
stratum-D recall@10 from 0.3688 to 0.3623, because cosine and BM25 are symmetric. A "hit" therefore never
demonstrates identifying something *as* a cause.

This experiment tests the obvious consequence: **does adding an ASYMMETRIC signal improve retrieval?**

Two candidate asymmetric signals were found in the substrate, both free:

**(a) Predicate role prior (usable).** Predicates carry a strong directional role. Measured over all 1043
edges: `uses_component` +0.67, `has_component` +0.62, `has_limitation` +0.60, `uses_technique` +0.55,
`trained_on` +0.45 sit on the CAUSE side; `outperforms` −0.78, `improves` −0.73, `addresses` −0.70,
`performs_task` −0.69, `enables_capability` −0.42 sit on the EFFECT side
(asym = (as_cause − as_effect)/(as_cause + as_effect), restricted to predicates with n≥12).

**(b) Predicate PAIR prior (DEAD — recorded so it is not retried).** 1002 distinct (cause_pred,
effect_pred) pairs across 1043 edges; **93.2% of edges sit in singleton pairs.** A pair-level prior would
be pure memorisation of the training split and generalise to nothing. **Not an arm.**

**(c) Structural overlap (weak, partial).** Direct entity overlap between cause and effect covers only
**139/461 (30.2%)** of stratum D, so it cannot carry a ranking alone — but it may be complementary.
Directional chaining is weak and does not favour the forward direction: cause.object = effect.subject on
46 edges vs effect.object = cause.subject on 74.

## 2. The headroom is real (measured before designing, from doc 44's per-edge ranks)

Stratum D recall@k. ORACLE = best rank achieved by any of the three doc-44 arms, i.e. what a *perfect*
re-ranker of their union could reach.

| arm | @10 | @25 | @50 | @100 |
|---|---|---|---|---|
| dense | 0.3688 | 0.4490 | 0.5098 | 0.5640 |
| BM25 | 0.4252 | 0.4989 | 0.5727 | 0.6377 |
| RRF-60 | 0.4078 | 0.5271 | 0.6052 | 0.6681 |
| **ORACLE** | 0.5011 | 0.5987 | **0.6529** | **0.7093** |

So re-ranking a K=50 pool has **+0.2277 absolute** of headroom over the best current arm (0.4252 → 0.6529).
This is what the experiment is trying to capture. Noted for honesty: on stratum S, **BM25 alone at K=100
reaches 0.7371**, beating RRF — BM25 is strong at depth on this task.

## 3. Data (frozen) — inherited from doc 44 §2 verbatim
`cognitive_test`, 1043 edges, per-corpus dal-cv 521 / dal-nlp 454 / qbio 51 / arxiv-nlp 17. Pool = same
`corpus_id`, `fact_embedding` non-null, `source_text` non-empty (verified a no-op: 100% coverage). Effect
fact excluded from its own pool. Strata S=582 (shared `subject_entity_id`) / D=461. Claimable corpora
dal-cv + dal-nlp; qbio and arxiv-nlp reported with no claim.

## 4. Design

**Candidate pool per edge:** union of dense top-50 and BM25 top-50 (≤100 candidates). Recall ceiling of
this pool is measured and reported as the arm's own oracle; an edge whose gold is outside the pool is a
**guaranteed miss** and is counted in the denominator (no silent dropping — doc 44's C1 bug).

**Features (all free, all deterministic):**

| # | feature | asymmetric? |
|---|---|---|
| f1 | dense cosine, z-scored within pool | no |
| f2 | BM25 score, z-scored within pool | no |
| f3 | candidate predicate's learned CAUSE-likeness | **yes** |
| f4 | f3 × the effect fact's learned EFFECT-likeness (interaction) | **yes** |
| f5 | candidate shares any entity endpoint with the effect fact | no |
| f6 | candidate.object_entity_id = effect.subject_entity_id (forward chain) | **yes** |

**Model:** logistic regression over the pool candidates (label = is-gold), 6 features. Deliberately simple
and interpretable; 6 features against ~800 training edges is low overfit risk. No hyperparameter search.

**Leakage control (load-bearing):** 5-fold cross-validation, folds split by **EFFECT FACT**, not by edge,
so the same effect never appears in train and test. The predicate role prior (f3/f4) is computed **only
from training-fold edges**, with unseen predicates scored 0. Folds are corpus-stratified.

**Ablations — this is the actual scientific question, not the headline:**

| arm | features | what it isolates |
|---|---|---|
| **B-SYM** | f1, f2 | symmetric baseline (learned fusion) |
| **B-SYM+STRUCT** | f1, f2, f5 | does non-directional structure add? |
| **A-ASYM** | f1, f2, f3, f4, f6 | does the DIRECTIONAL signal add? |
| **A-FULL** | all six | everything |

If **A-ASYM ≈ B-SYM**, the asymmetric signal adds nothing and that is the finding.

## 5. Metric + bar (frozen)

- **Primary: held-out recall@10 of the gold cause on stratum D**, pooled across the 5 folds.
- **The bar: A-FULL (or A-ASYM) must beat the best doc-44 single arm, BM25 at 0.4252 on stratum D, with a
  clustered-bootstrap CI on the delta strictly above 0.** Clustering by effect fact, 10k resamples, seed
  20260917 — AND the delta must also survive clustering by **corpus** (doc 44's C4 correction: the BM25
  lead died under corpus clustering, so corpus robustness is now mandatory, not optional).
- **Secondary, reported always:** recall@{1,5,20}; the pool's own oracle recall; per-corpus and per-stratum
  breakdown including qbio and arxiv-nlp; **and the learned LR coefficients**, because a large f3/f4 weight
  with no recall gain is itself informative.
- **The direction-blindness check is mandatory:** re-run the winning arm with cause and effect SWAPPED. A
  genuinely direction-aware model must degrade materially under swap. If it does not, any gain is not
  causal identification and must be reported as such (this is the specific failure doc 44 exposed).
- **Deliver all pre-registered outputs.** Doc 44 silently dropped four (C6): A4-random, p90, MRR,
  recall@{1,5} on non-primary arms. Here: report recall@{1,5,10,20}, median and p90 rank, MRR, a RANDOM
  arm, and the pool oracle, for every arm and every cut. No conditional/survivorship medians — all rank
  statistics are unconditional with out-of-pool counted as a miss (doc 44 C1).

## 6. Pre-registered expectation

I expect **B-SYM to beat the unlearned RRF** (a learned fusion should beat a fixed one), and I am genuinely
uncertain whether **A-ASYM beats B-SYM**. The predicate role prior is a *query-independent candidate prior*
— it can reorder a pool but cannot surface a gold the pool missed — so its ceiling is the pool oracle
(0.6529 on D at K=50).

Risk I am carrying: three of doc 44's eight corrections were overclaims in the direction of my own
conclusion, and one was a code bug in the number carrying my interpretation. Guards here: the bar is fixed
before computing, ablations are pre-specified so a null is legible, the swap check can falsify a gain, and
all rank statistics are unconditional by construction.

## 7. Kill / invalid conditions (fix the harness; do NOT report as a finding)

1. Any predicate role value computed from a test-fold edge → leakage; void.
2. An effect fact appearing in both train and test of the same fold → void.
3. Gold silently excluded from a denominator anywhere → void (doc 44 C1).
4. A conditional median or any survivorship-filtered statistic in the output → void.
5. Any database write. SELECT-only.
6. LR failing to converge, or perfect separation on a fold → report, do not paper over.
7. Claiming a CI for a cut that was not actually bootstrapped (doc 44 C2) → void.

## 8. Discipline
Deterministic, no Claude in the measurement path. Pre-register → measure → **blind adversary** → bank.
NULL/negative pre-committed as valid. Frozen above the RESULTS line.

---

## RESULTS (append below; do not edit above this line)

**Run 2026-09-17. Cost ZERO.** Artifact `prereg-artifacts/i4-asymmetric-rerank-results.json`;
harness `platform/src/test/tools/i4-asymmetric-rerank.ts`.

### HEADLINE — the bar FAILS, and the pre-registered scientific question is a clean NULL

Held-out recall@10, stratum D (the honest stratum — see the S confound below):

| arm | dal-cv | dal-nlp | ALL/D | vs B-SYM |
|---|---|---|---|---|
| B-SYM (f1,f2) | 0.4735 | 0.3777 | 0.4295 | — |
| B-SYM+STRUCT (+f5) | 0.4980 | 0.3989 | 0.4534 | **+0.0239** |
| A-ASYM (+f3,f4,f6) | 0.4694 | 0.3777 | 0.4273 | **−0.0022** |
| A-FULL (all six) | 0.5020 | 0.3989 | 0.4555 | +0.0260 |
| pool ORACLE (K=50 union) | — | — | 0.6508 | ceiling |
| RANDOM | — | — | 0.0087 | floor |

**The bar (beat doc-44 BM25 0.4252 on stratum D with CI above 0 under BOTH clusterings): FAILED.**
A-FULL pooled delta +0.0303, byEffect [−0.0139, 0.0759], byCorpus [−0.0252, 0.0748] — **spans zero both
ways.** dal-nlp actively *degrades* versus doc-44's BM25 (0.3989 vs 0.4252), so the apparent dal-cv gain
is corpus-dependent, not a system improvement.

**§4's actual question — does the ASYMMETRIC signal add? — answers NO.** A-ASYM (0.4273) ≈ B-SYM (0.4295),
a delta of **−0.0022**; A-FULL (0.4555) ≈ B-SYM+STRUCT (0.4534), +0.0021. The predicate role features are
**inert**. Notably they are inert *despite* a learned coefficient of ~0.56 on `cause_role` — non-zero
weight, no ranking change, i.e. the role signal is **redundant** with dense+BM25 rather than absent. This
is a genuine, pre-registered null on the doc-44 adversary's direction-blindness hypothesis: making the
ranker direction-aware does not fix the retrieval.

### TWO FLAWS IN MY OWN DESIGN — both disclosed, one invalidates a headline number

**F1 — the stratum-S entity-overlap gain is CIRCULAR. Discard it.** On stratum S the apparent gain is
huge (B-SYM 0.4227 → B-SYM+STRUCT 0.6546, **+0.232**) — but stratum S is *defined* as cause and effect
sharing `subject_entity_id`, and f5 tests exactly that. Verified: **the gold's f5 = 1 on 582/582 (100%) of
stratum-S edges, versus 139/461 (30.2%) on D.** The feature is tautological for the gold on S by the
stratifier's own definition, and it is highly selective (matching only ~11-13 of ~2565 pool facts, 0.43%),
so it hands the model the answer set. **Every stratum-S number involving f5 (B-SYM+STRUCT, A-FULL) is
void.** The pre-registered bar was set on D, so the primary outcome is unaffected — but this is exactly
the kind of confound that would have become the headline had the bar been set on the pooled cut.

**F2 — the direction-blindness check (§5) is VACUOUS as implemented.** It reported degradation of exactly
**0.0000** on both strata, which is the tell. The swap negated `cause_role` and flipped the sign of the
effect-likeness term, but `role_interact` = cause_role × effect_like is then **algebraically identical**
(both factors flip), and a pure sign flip on the remaining feature is absorbed by the learned LR
coefficient. So the swap produced a mathematically equivalent model. **The check tested nothing.** A valid
version must reverse the *task* (query = cause, gold = effect), not the feature signs. Not re-run here.
The A-ASYM ≈ B-SYM ablation already answers the underlying question without it, so the conclusion does not
depend on this check — but the check must not be cited.

**F3 — a labelling error in my own output.** Single-corpus scopes print "CLEARS (both clusterings)" with a
**degenerate** by-corpus CI (e.g. dal-cv [0.0728, 0.0728]) because clustering by corpus within one corpus
yields one cluster. Corpus robustness is only meaningful on the ALL cut, **where it fails.** dal-cv's
"clears both" is really "clears effect-clustering only."

### What the run does establish
1. **Direction-awareness is not the fix.** The doc-44 adversary's diagnosis was correct as a description
   (all arms are symmetric) but the implied remedy does not work: an explicit asymmetric prior is
   redundant with what dense+BM25 already capture.
2. **The predicate-PAIR prior is dead on arrival** (93.2% singleton pairs, §1b) and the **role marginal is
   redundant** (this run). The predicate substrate offers no retrieval lever.
3. **The bottleneck is the RANKER, not the pool.** Pool oracle on D is 0.6508 against a best model of
   0.4555 — the gold is *in* the K=50 pool two-thirds of the time and the ranker fails to surface it.
   Every free feature available (dense, BM25, role, overlap, chaining) is now exhausted against that gap.
4. **The strongest lead here is about the DENSE VECTOR, not causality.** The learned fusion weights are
   `bm25_z = 0.693` vs `dense_z = 0.129` — **BM25 gets ~5x the weight of dense**, consistently across
   folds and arms. On fact-level retrieval in this system the lexical signal dominates the dense signal.
   That is a statement about `fact_embedding`, not about Graph C, and it is the thread worth pulling: the
   production read path is dense-first. **Requires its own pre-registration on the production task** —
   not claimable from this run.

### Banked disposition
I4 asymmetric re-rank: **NULL.** The bar failed, the asymmetric hypothesis is refuted on the clean
stratum, and two of my own design flaws (one invalidating, one vacuous) are recorded above. Combined with
doc 44: **no free deterministic signal — symmetric, asymmetric, structural, or fused — beats BM25 robustly
on causal cause-retrieval.** I4-as-retrieval remains open and unresolved, now with the additional finding
that the direction-blindness route is closed.

**Blind adversary: NOT YET RUN.** Required before banking (§8).
