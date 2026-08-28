# Doc 41 — RESULTS: the predicate fold does not fix predicate fragmentation

**Date:** 2026-08-28 · **Branch:** `feat/cross-corpus-audit`
**Pre-registration:** doc 40, frozen at `4d0ed13`, amended pre-run at `8a9efd2` and `d4ea922`.
**Harness:** `ml-services/tools/predicate_fold_replay.py`, frozen at `eef5c25` **before** the run.
**Artifacts:** `predicate-fold-artifacts/`.

**Adversary: RUN.** Verdict — *"The numbers can be banked. Two of the four §6 'Settles' conclusions
cannot."* It reproduced every primary and secondary figure from the raw artifacts, confirmed the frozen
inputs are byte-identical to the database, and confirmed the FAIL is real and not manufactured. It then
**cut two causal conclusions**, corrected one arithmetic slip and one mechanism sentence, found three
pre-registered items dropped or substituted, and found **three things I missed entirely** — including a
stronger negative than anything I had written and a defect I had not noticed. Everything below is
post-adversary. Findings are labelled with the adversary's IDs so the audit trail is followable, and I
re-verified each counter-claim myself from the artifacts before accepting it.

---

## 1. Verdict on the pre-registered metric

**FAIL.**

| | before | after fold | bar |
|---|---|---|---|
| distinct predicates | 2,240 | **2,157** | PASS ≤ 900 · PARTIAL ≤ 1,600 |
| hapax rate | 68.7% | **65.6%** | PASS ≤ 45% |
| facts on a hapax predicate | 26.9% | 24.8% | — |
| top-100 **head-token** edge coverage | 80.07% | **80.15%** | — |

**Reduction: 3.7%.** PARTIAL needed 30%, PASS needed 60%. The result is **557** predicates clear of the
nearest bar (PARTIAL, 1,600) — my first draft said "1,257 clear", which was the distance to the
*farthest* bar and overstated the margin 2.26x in my own favoured direction (**F6, CUT**).

**Robust to both pre-registered sensitivities:**

- **Order** (§5.4): shuffled `distinct_after` = 2,152, delta **-5**. Not order-dependent.
- **Threshold** (§5.5): at 0.84 — where merge and distinct thresholds coincide and the ambiguous band
  vanishes — `distinct_after` = 1,867, a 16.7% reduction, **still FAIL** (267 clear). At 0.94 it is
  2,236. The fold cannot reach even PARTIAL anywhere in the tested range.
  **Caveat (F17):** `all-merges.json` covers only the primary arm, so the **421** merges behind that
  16.7% cannot be inspected. Since they extend down to 0.84 their precision is almost certainly worse
  than the 0.43 measured in §5. The 16.7% figure is not a safe operating point; it is a ceiling probe.

**Metric substitution, disclosed (F15).** Doc 40 §5.3 pre-registered "top-100 **head** coverage against
the 75% baseline". My first draft silently reported full-*string* top-100 coverage (41.1% → 41.3%) next
to that frozen 75% baseline, which are different quantities. The pre-registered metric is in the table
above: **80.07% → 80.15%**, +0.08 pt. Same story, but the substitution was undisclosed and is corrected.

## 2. The `reused=1810` number is an accounting artifact

Raw fold statistics:

```
by key:  reused 1810   minted 2153   deferred 0
by fact: reused 2968   minted 2746   deferred 0
routes:  fast_path 1722   score_merge 88   score_ambiguous 364   score_distinct 1789
```

`reused = 1810` against 3,963 keys reads as a 46% reuse rate. It is not one.

| route | merge decisions | merged onto **itself** | genuine redirects |
|---|---|---|---|
| `fast_path` | 1,722 | **1,715** | 4 distinct |
| `score_merge` | 88 | 0 | 88 distinct |

**1,715 of 1,722 fast-path "reuses" resolved a predicate onto itself.** The cache key is
`(predicate, subject_type, object_type)`, so the same string under a different type pair is a fresh key;
by then the string is already in `canonical_set`, the fast path fires, and a `reused` is booked while
nothing collapses.

**Correction (F8, CUT).** My first draft wrote "4 alias redirects + 88 score merges, with overlap". There
is **zero** overlap — the alias sources `{authored, specializes_in, affiliated_with, belongs_to}` and the
88 score-merge sources are disjoint sets. The arithmetic is 4 + 88 − **8 sources that survive anyway**
(§2.1) = **84** strings eliminated.

The adversary pushed both ways on the interpretation and it stands: a self-resolution saves one duplicate
`ON CONFLICT DO NOTHING` insert and one Ollama embed, and buys nothing semantically. It also checked the
two places real value could have hidden and found none — normalisation is a no-op on this input (all
2,240 predicates are already lowercase/underscore-normal), and `temporal_hint` is computed but never
consumed (`predicate-resolve.ts:145-155` ignores `res.temporal_hint`).

**Operational consequence:** `predicates: reused=N minted=M deferred=K` cannot be read as
canonicalisation. A high `reused` is compatible with near-zero collapse. Same defect class as doc 39
§8's silent no-ops — a metric reporting work that did not happen. Bead filed.

### 2.1 The fold is not a function of the predicate string (F9 — NEW, I missed this)

**8 predicate strings resolve to two different canonicals depending on entity type; 110 facts sit on
one.** Verified independently:

```
addresses_challenge        -> addresses_problem              | addresses_challenge
enables_capability         -> has_capability                 | enables_capability
extends                    -> extends_concept               | extends
code_available_at          -> source_code_available_at      | code_available_at
evaluated_on_dataset_count -> evaluated_dataset_count       | evaluated_on_dataset_count
supports_modality          -> supports_modality_collaboration | supports_modality
improves_upon              -> improves_over                 | improves_upon
suffers_from               -> suffers_from_problem          | suffers_from
```

Cause: the fast path keys on the **string** while the fold keys on the **triple**. Once a string is
minted under one type pair it self-resolves for every other pair, **pre-empting the merge the scorer
would have made**. The mapping is type-dependent, order-dependent and non-confluent, and it splits the
very surface variants §5 counts as *correct* merges. Merges also do not chain — no union-find, so
`assesses_capability → enables_capability → has_capability` leaves both targets standing.

This is a defect, not a no-op, and it was absent from my first draft. Bead filed.

## 3. What blocks the merge: the arithmetic, corrected

Doc 40 §10 predicted pre-run that **no arXiv predicate could score-merge onto any of the 27 seeds**.

**Confirmed: 0 of 88 score merges landed on a seed; all 88 have `type_pair_overlap = 1.0` exactly.**
The adversary strengthened it exhaustively: **0 of 3,963 keys can reach tov = 1.0 against any seed**, and
the maximum reachable `combined` against any seed with cosine pinned at 1.0 is **0.7917** — so no arXiv
key could have reached even `ambiguous` against a seed.

**Framing correction (F10).** This was a *theorem*, not a measurement — the run could not have falsified
it. Doc 40 was honest that it was derived from code; my first draft's "**Measured:** … confirmed exactly"
dressed arithmetic as evidence. It is arithmetic.

The 10 fast-path merges that touched a seed:

```
manages -> manages    member_of -> member_of    created -> created      (identical strings, no collapse)
authored -> created (x2)    specializes_in -> skilled_in (x3)
affiliated_with -> member_of    belongs_to -> member_of
```

Four genuine redirects, all through hand-written alias tables, none through scoring.

### 3.1 CUT: my "entity types are upstream" corollary was wrong

My first draft concluded that since merging needs an exact match on both entity types, **entity-type
fragmentation is upstream of predicate fragmentation** and `nmemo-x4s` therefore blocks `nmemo-ecn`. The
adversary cut it on three grounds, all of which I reproduced:

**(a) The fast path is entirely type-blind.** All four genuine cross-string redirects in the whole run
went through it. `authored` (person/None) merged onto `created` (person/company) at **tov = 0.5**,
because `normalize_tense`'s alias lookup precedes any scoring. So the claim quietly assumed *alias-free*
seeding, and §3's own evidence is the counter-example.

**(b) The type gate was already open for 69% of keys, and merges still did not happen.**
Reconstructing the candidate list's evolution: **1,551 of 2,241 scored keys (69.2%) already had a
tov = 1.0 candidate available at decision time.** Only 88 merged. tov = 1.0 is necessary and nowhere
near sufficient. This is direct counter-evidence to the corollary, and it is the number that decides the
question — against me.

**(c) The constraint that actually binds is the jaro-winkler term (F12c — I missed this).** With
cos = 1.0, tov = 1.0, cn = 0:

```
0.55(1.0) + 0.30(1.0) + 0.10(0) + 0.05(0) = 0.85  <  0.89
```

**The string-edit term is arithmetically necessary for any merge.** Every merge must satisfy
`jw >= 5.9 - 5.5*cos`; observed min jw **0.677**, median 0.896, **zero** merges at jw = 0. ConceptNet
fired **0 of 88** times — it is a 21-entry personal-domain stub. So on this corpus the merge region is
defined by a **weight-0.10 string-edit-distance term**, and the semantic cosine leg **cannot reach the
threshold on its own no matter how good the embedding or the type vocabulary**. This holds at 0.84 too
(the tov = 0.5 ceiling is 0.80 < 0.84).

**This is a better and stronger negative than the one I wrote, and it points somewhere different:** at
reweighting, or at a semantic-only merge route — not at the entity-type bead. The fold as calibrated is
a string-similarity matcher with a semantic gate, not a semantic matcher.

## 4. A pre-registered prediction of mine that was wrong

Doc 40 §5.6 predicted `type_pair_overlap` would be "near zero" on this corpus and prove "dead weight".

**Measured: 2,195 of 2,241 scored resolutions (97.9%) had `type_pair_overlap > 0`.** Wrong by a wide
margin. Cause: mint-and-grow candidates carry arXiv type pairs, so later arXiv keys score against
type-compatible candidates rather than against person/company seeds. I generalised a fact about the
*seeds* into a claim about the *corpus*.

The adversary checked whether this figure was inflated by the harness measuring tov on the argmax winner
(tov carries 0.30 weight, so the winner's tov is selected upward). Unbiased version — max *available*
tov — is **98.1%**. Selection effect ≈ 0.2 pt. The number is robust, and the miss is not rescued by it.

## 5. Merge precision: adjudicated by the adversary

Doc 40 §6 committed that I would not measure or claim precision and that a blind adversary would rule.
It ruled, on all 88 distinct score merges, under a rule it stated **before** opening the list: a merge
loses information if a graph query distinguishing the two predicates would afterwards return a wrong or
unanswerable result — truth-conditional (negation, polarity, direction), referential (different dataset,
task, metric, modality, edge type) or relation-typal (assess vs enable, delta vs absolute level).

| ruling | count |
|---|---|
| **LOSS** | **42** |
| SAFE | 32 |
| genuinely ambiguous | 14 |

- **Precision on the decidable subset: 32/74 = 0.43.** Ambiguous counted against: 0.36. For: 0.52.
- Fact-weighted (119 facts ride a score-merged key = 2.08% of the corpus): 37 safe / 61 loss / 21 ambiguous.
- **Indefensible floor, robust to any rule: 25 of 88 (28.4%)** — 2 negation, 3 polarity, 1 direction,
  1 inverse-relation, 6 ordinal, 12 different dataset/task/modality/metric/resource/edge-type/dimension.
- Uncertainty band if every disputable call flipped adversely: decidable-subset precision **[0.32, 0.55]**.
  The 25-merge floor does not move.

Examples from the floor:

```
requires_fine_tuning        -> requires_no_fine_tuning       (0.931, jw 0.92)   negation
performs_worse_at           -> performs_better_at            (0.913, jw 0.89)   polarity
can_solve_task_with         -> can_solve_task_without        (0.919, jw 0.97)   negation
produces_more_of            -> produces_less_of              (0.918, jw 0.91)   polarity
evaluated_on_external_tasks -> evaluated_on_internal_tasks   (0.929, jw 0.96)   polarity
adapts_from_domain          -> adapts_to_domain              (0.934, jw 0.93)   direction
has_lightweight_variant     -> is_lightweight_variant_of     (0.929, jw 0.87)   INVERSE
learning_stage_2            -> learning_stage_1              (0.928, jw 0.97)   ordinal
pipeline_step_2             -> pipeline_step_1               (0.937, jw 0.97)   ordinal
metric_fid_score_on_coco    -> metric_fid_score_on_cc3m      (0.919, jw 0.97)   different dataset
performance_on_{pancreas,colon,liver}_… -> performance_on_kidney_tumor_segmentation
```

Two corrections to my own §5 list. I had `source_code_available_at → code_available_at` **backwards**
(the actual merge is the reverse), and I **missed the most damaging merge in the set**:
`has_lightweight_variant → is_lightweight_variant_of`, which merges a relation with its own inverse
across two `method` endpoints — in a directed graph that reverses edges, and it is exactly the class the
inverse guard exists to prevent.

The adversary also grounded its two highest-fact-weight calls in the fact *content* rather than the
label, and both got stronger:

- `achieves_auc_improvement → achieves_auroc` (8 facts): sources are **deltas** ("3.4% on MVTec AD",
  "22.0% on MPDD"), target is **absolute** ("99.8%", "98.9%"). The merge puts 3.4% and 99.8% on one edge
  label. Categorical measurement error.
- `achieves_baseline_f1_score` + `achieves_optimized_f1_score → achieves_f1_score` (8 facts): **the same
  subject carries both** — gpt-4 has baseline 0.593 and optimized 0.736/0.861. After the merge gpt-4 has
  four unlabelled F1 values with no way to recover the experimental condition.

**Mechanism: supported, and I hedged too much (F14).** I filed it as a hypothesis; it is a derivation.
At tov = 1.0 and cn = 0 the merge region *is* "near-identical surface string AND high cosine", by the §3.1
arithmetic. One-token negation and ordinal edits maximise jw while barely moving cosine, exactly as
predicted: `can_solve_task_with/without` jw 0.973 / cos 0.949; `pipeline_step_2/_1` jw 0.973 / cos 0.981.
And the inverse guard genuinely cannot help — it fires only when the query base equals one of the 9
registered seed inverse names, and only **2 of 2,240** corpus predicate strings (`created_by`, `employs`)
are within its reach at all. Its firing rate is not instrumented; its *reachability* is 2/2,240.

## 6. Harness fidelity

**Mirror: faithful (F1, HOLDS).** The adversary audited all seven pre-registered requirements line by
line against `resolve_predicate.py:94-190` and `predicate-resolve.ts:113-165` — fast-path early return,
threshold logic, inverse guard, distinct-and-ambiguous-both-mint, mint-and-grow, the triple cache key,
and mints passing no description. All identical, tie-breaking included. Three deviations found, all
inert: the omitted `scorable` filter (every replay candidate has an embedding), a `if base not in
canonical_set` mint guard that cannot fire (the fast path returns first), and 0 string-key collisions on
the frozen input despite 56 entity types containing spaces.

**But my equivalence check did not license the claim I made from it (F2, WEAKEN).** With only the 27
seeds as candidates, the upper bound on `combined` is ≤ 0.7621 for **28 of the 30 keys** — they were
*provably* `distinct` and could not have exercised anything else; the other 2 were the same alias
fast-pathing. So 30/30 covered: `distinct` (28) and one alias fast path (2). It covered **zero** score
merges, **zero** ambiguous decisions, **zero** mint-and-grow, and **zero** scoring against a label-only
minted candidate — which is the configuration in which all 88 merges were made.
`equivalence-check.json` discards the keys and decisions, so no reader can see this.

**The adversary closed the gap and the mirror passes (F3).** It shipped label-only minted-style
candidates to the live endpoint on 4 real merge cases x 3 threshold settings: mirror and endpoint agree
**bit-exactly (score delta 0.00e+00)** on merge, ambiguous, distinct, and fast-path-onto-a-minted
candidate, and artifact scores reproduce to 10 decimals against fresh embeddings. So the mirror *is*
equivalent — my published check just did not show it.

**Two unclosable gaps, both pointing away from the FAIL (F4).** `pgvector` stores `float4`, so
production's seed embeddings are float32-rounded where the replay used float64 — immaterial, the closest
score to any threshold is 0.8905, 5.1e-4 clear. And the replay reads **promoted** `entities.entity_type`
while `predicate-resolve.ts:138-139` reads **staged** types; promoted types are if anything more
consistent, so this can only *overstate* tov = 1.0 opportunities, never manufacture a FAIL. Separately,
the TS fold loop has **no automated test** — only the endpoint mirror does.

## 7. What this settles

**Settles:**

- Running `backfill-predicate-embeddings.ts` alone does **not** fix predicate fragmentation. Doc 39
  §3.1 was right about the *cause of the no-op*; removing the no-op buys **3.7%**.
- **At precision 0.43 on the decidable subset with a 28.4% indefensible floor, turning the fold on as
  calibrated is net-harmful.** `predicate_scoring.py:44-52` states the asymmetry itself: a merge is
  lossy and unrecoverable, over-minting is gardener-recoverable.
- The merge region is defined by a weight-0.10 string-edit term (§3.1c). The semantic leg cannot reach
  the threshold alone at any type vocabulary or embedding quality.
- `reused` in the epoch log is not readable as canonicalisation (§2).
- The fold is not a function of the predicate string — 8 strings, 110 facts, two canonicals each (§2.1).
- Doc 39's `~100 heads cover 75% of edges` sizing is unaffected; those are input properties.

**Does not settle:**

- Whether a seeded arXiv ontology *plus* a controlled entity-type vocabulary *plus* a reweighted score
  would pass. Untested; needs its own pre-registration.
- **The description-enriched embedding was never exercised (F16 — pre-registered as §5.7 and dropped from
  my first draft).** All 88 merges and 3,953 of 3,963 queries compared a **description-less label against
  a description-less label**, because mints pass no description. The entire premise of
  `enrichedPredicateText` is untested on this corpus. This is a bigger limitation than the "asymmetry"
  my pre-registration called it.
- The `deferred` down-mode. `deferred = 0` is structural — the offline replay makes no HTTP call that can
  fail, so the ml-down path is **not exercised**.
- The live wired path. Doc 40 §8's plumbing confirmation has not been run, and given §7 bullet 2 it
  should not be run against a graph anyone cares about until the score is recalibrated.
- Merge precision below 0.89. The 0.84 arm's 421 merges are not in the artifacts (F17).

**Under-claimed (F18).** The mint-on-ambiguous policy (`predicate-resolve.ts:148`, "distinct OR
ambiguous → mint") accounts for most of the 3.7% → 16.7% gap and is a one-line design choice. My first
draft left it as a sensitivity row.

## 8. Erratum against the frozen pre-registration

**Doc 40 §10 contains a false premise (F11).** It states "No arXiv fact in the frozen input has `person`
or `company` as a subject type". **Five facts do** — `associated_with`, `maintains_repository`,
`associated_with_project`, `authored`, `author_of`, all `person`. The conclusion survives because none of
their object types matches any seed's, capping tov at 0.5, which is the reason doc 41 §3 actually gives.
Doc 40 is frozen and is not edited; this erratum is the correction of record.

## 9. Outstanding debt

1. Beads filed from this run: the misleading `reused` statistic (§2), the type-split defect (§2.1), the
   score recalibration implied by §3.1c and §5.
2. Doc 40 §8 plumbing confirmation — **deliberately not run**, see §7.
3. Pre-existing, unchanged: adversary on doc 32 and doc 33 (doc 39 §8).
4. The adversary noted a positive deviation worth keeping (F19): doc 40 §6 booked a 50-merge uniform
   sample, which turned out to be 46 fast-path self-merges and 4 score merges — near-useless for
   precision. Dumping all 1,810 merges to `all-merges.json` instead is the only reason §5 was possible.
   **Pre-register the artifact that makes adjudication possible, not a sample of the wrong population.**
