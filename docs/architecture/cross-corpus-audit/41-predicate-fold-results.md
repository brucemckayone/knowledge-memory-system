# Doc 41 — RESULTS: the predicate fold does not fix predicate fragmentation

**Date:** 2026-08-28 · **Branch:** `feat/cross-corpus-audit`
**Pre-registration:** doc 40, frozen at `4d0ed13`, amended pre-run at `8a9efd2` and `d4ea922`.
**Harness:** `ml-services/tools/predicate_fold_replay.py`, frozen at `eef5c25` **before** the run.
**Artifacts:** `predicate-fold-artifacts/` — frozen inputs, all 88 score merges, the 50-merge sample,
the per-fact resolution map, and the equivalence check.
**Adversary status: NOT YET RUN.** Nothing in this document is banked. §7 is the debt.

---

## 1. Verdict on the pre-registered metric

**FAIL**, and not near the boundary.

| | before | after fold | bar |
|---|---|---|---|
| distinct predicates | 2,240 | **2,157** | PASS needed ≤ 900 |
| hapax rate | 68.7% | **65.6%** | PASS needed ≤ 45% |
| facts on a hapax predicate | 26.9% | 24.8% | — |
| top-100 edge coverage | 41.1% | 41.3% | — |

**Reduction: 3.7%.** The bar for PARTIAL was a 30% reduction; the bar for PASS was 60%. No boundary
straddle — the result is 1,257 predicates clear of the nearest bar.

**Robust to both pre-registered sensitivities:**

- **Order** (§5.4): shuffled `distinct_after` = 2,152, delta **-5**. Not order-dependent.
- **Threshold** (§5.5): at merge threshold 0.84 — where the merge and distinct thresholds coincide and
  the ambiguous band vanishes entirely — `distinct_after` = 1,867, a 16.7% reduction. **Still FAIL.** At
  0.94 it is 2,236, a 0.2% reduction. The fold cannot reach even PARTIAL anywhere in the tested range.

## 2. The `reused=1810` number is an accounting artifact — this is the load-bearing finding

The raw fold statistics look like the fold did substantial work:

```
by key:  reused 1810   minted 2153   deferred 0
by fact: reused 2968   minted 2746   deferred 0
routes:  fast_path 1722   score_merge 88   score_ambiguous 364   score_distinct 1789
```

`reused = 1810` against 3,963 keys reads as a 46% reuse rate. It is not one. Decomposing the merges by
whether the predicate string actually changed:

| route | merge decisions | merged onto **itself** | genuine redirects |
|---|---|---|---|
| `fast_path` | 1,722 | **1,715** | 4 distinct |
| `score_merge` | 88 | 0 | 88 distinct |

**1,715 of the 1,722 fast-path "reuses" resolved a predicate onto itself.** The fold's key is
`(predicate, subject_type, object_type)`, so the same predicate string recurring with a different type
pair is a *new key*; on its second key the string is already in `canonical_set`, the fast path fires,
and the fold books a `reused`. Nothing collapses. The 3,963 → 2,240 mapping that produces most of that
count is just the key-to-string relation, which held before the fold existed.

Total distinct strings actually eliminated: **84** (4 alias redirects + 88 score merges, with overlap).
Exactly one string appears after the fold that was not there before: `skilled_in`, the seed that
`specializes_in` redirected onto.

**Operational consequence:** the epoch log line `predicates: reused=N minted=M deferred=K` is
misleading as written. A high `reused` is compatible with near-zero canonicalisation. It should
distinguish self-resolutions from genuine redirects, or it will read as success on the next run too.
This is the same class of defect as doc 39 §8's "silent no-ops" — a metric reporting work that did not
happen.

## 3. Amendment 2's pre-run prediction: confirmed exactly

Doc 40 §10 predicted, from arithmetic on the frozen input and before the run, that **no arXiv predicate
could score-merge onto any of the 27 seeds**, because `type_pair_overlap` caps at 0.5 against
person/company seed types and 0.5 caps `combined` at 0.85, below the 0.89 threshold.

**Measured: `score_merge onto seed = 0` of 88. All 88 score merges have `type_pair_overlap = 1.0`
exactly.** Every one landed on an arXiv predicate minted earlier in the same run.

The 10 fast-path merges that did touch a seed are:

```
manages -> manages            member_of -> member_of        created -> created      (identical strings)
authored -> created           (x2)   specializes_in -> skilled_in   (x3)
affiliated_with -> member_of         belongs_to -> member_of
```

Four genuine redirects, all through the seeds' hand-written alias tables, none through scoring.

**This resolves doc 40 §1.1's competing mechanisms.** Seed-reuse is structurally closed except by exact
string or alias match. Mint-and-grow is the only working route, and it delivered 88 merges out of 3,963
keys. **The corollary matters for the fix: seeding a domain ontology does not, on its own, unblock the
fold.** A seeded arXiv predicate will be reachable by scoring only for facts whose type pair matches
that seed's type pair exactly — and doc 39 §4 records 338 free-text entity types. **The entity-type
vocabulary is upstream of the predicate ontology, and fixing predicates without fixing types leaves the
merge threshold unreachable.**

## 4. A pre-registered prediction of mine that was WRONG

Doc 40 §5.6 predicted the `type_pair_overlap` signal would be "near zero" on this corpus and would prove
to be "dead weight".

**Measured: 2,195 of 2,241 scored resolutions (97.9%) had `type_pair_overlap > 0.`** The prediction was
wrong, and wrong by a wide margin. The reason is mint-and-grow: minted candidates carry arXiv type
pairs, so later arXiv keys score against type-compatible candidates rather than against person/company
seeds. I generalised a fact about the *seeds* into a claim about the *corpus*.

The mechanism claim in §3 survives the miss, and the two are consistent: `> 0` is common, `= 1.0` is
what the threshold requires, and all 88 merges sit at exactly 1.0.

## 5. Merge precision: an observation, explicitly NOT a measurement

Doc 40 §6 committed in advance that precision would not be measured or claimed here, and that a blind
adversary would rule. That still stands. What follows is an observation on the artifact, recorded
because it would be dishonest to publish a reduction number while sitting on it.

All 88 score merges are in `predicate-fold-artifacts/all-merges.json`. Reading them, a number appear to
merge predicates that mean **opposite or materially different things**:

```
performs_worse_at            -> performs_better_at              (0.913, jw 0.89)
requires_fine_tuning         -> requires_no_fine_tuning         (0.931, jw 0.92)
produces_more_of             -> produces_less_of                (0.918, jw 0.91)
can_solve_task_with          -> can_solve_task_without          (0.919, jw 0.97)
evaluated_on_external_tasks  -> evaluated_on_internal_tasks     (0.929, jw 0.96)
can_be_created_manually      -> can_be_generated_automatically  (0.908, jw 0.89)
adapts_from_domain           -> adapts_to_domain                (0.934, jw 0.93)
handles_image_modality       -> handles_text_modality           (0.897, jw 0.89)
stage_one / stage_two / stage_three -> stage_four               (~0.895, jw ~0.89)
learning_stage_2             -> learning_stage_1                (0.928, jw 0.97)
pipeline_step_2              -> pipeline_step_1                 (0.937, jw 0.97)
metric_fid_score_on_coco     -> metric_fid_score_on_cc3m        (0.919, jw 0.97)
performance_on_{pancreas,colon,liver}_… -> performance_on_kidney_tumor_segmentation
has_citation_edge_count      -> has_authorship_edge_count       (0.905, jw 0.91)
evaluation_scope_tasks       -> evaluation_scope_languages      (0.904, jw 0.92)
```

Others in the same list look correct — genuine surface variants: `is_caused_by → caused_by`,
`is_sub_task_of → is_subtask_of`, `is_finetuned_from → fine_tuned_from`, `improves_upon →
improves_over`, `sourced_from → sources_from`, `is_end_to_end_trained → trained_end_to_end`,
`source_code_available_at → code_available_at`, `has_repository_url → repository_url`.

**A mechanism worth testing, stated as a hypothesis and not as a result:** negation and ordinal
distinctions are carried by a single token, so the enriched embedding puts the pair at cosine > 0.9
*and* jaro-winkler rewards them for differing by one token. At `type_pair_overlap = 1.0` both surviving
signals push antonyms together, and the inverse-predicate guard cannot help because it only knows the
registered inverses of the 27 seeds. If that holds, the failure is not threshold calibration — raising
the threshold to 0.94 cut merges to 1 while leaving the fragmentation untouched.

**I am deliberately not converting the list above into a precision rate.** Choosing the token rules
that separate "antonym" from "surface variant" after having seen the data is the exact move a blind
adversary cut on doc 33's baseline definition. The full list goes to the adversary; the rate is theirs
to set, in either direction.

## 6. What this does and does not settle

**Settles:**

- Running `backfill-predicate-embeddings.ts` alone does **not** fix predicate fragmentation. Doc 39
  §3.1's "built, shipped and inert for want of a setup step" was accurate about the *cause of the
  no-op*; it is now measured that removing the no-op buys 3.7%.
- Doc 39's `~100 heads cover 75% of edges` sizing is unaffected — those are input properties — but
  seeding that ontology will not be enough on its own (§3).
- Entity-type fragmentation is **upstream** of predicate fragmentation via the
  `type_pair_overlap = 1.0` requirement. Bead `nmemo-x4s` therefore blocks `nmemo-ecn` in practice, not
  the other way round.
- The `reused` statistic in the epoch log cannot be read as canonicalisation (§2).

**Does not settle:**

- Merge precision (§5). Adversary-owned.
- Whether a *seeded arXiv ontology plus a controlled entity-type vocabulary* would pass. Untested, and
  it is the natural next experiment — but it needs its own pre-registration, not an extension of this
  one.
- Whether the fold's `deferred` down-mode behaves correctly. `deferred = 0` here is structural: the
  offline replay makes no HTTP call that can fail, so the ml-down path is **not exercised** and no claim
  is made about it.
- Anything about the live wired path. The doc 40 §8 plumbing confirmation has not been run.

## 7. Outstanding debt

1. **Blind adversary on this document** — fresh context, given doc 40 frozen, this doc, and the raw
   artifacts; tasked in both directions; told to audit the harness as hard as the result. Not yet run.
   Nothing here is banked until it has.
2. Doc 40 §8 plumbing confirmation on the live `cognitive` DB.
3. Pre-existing debts, unchanged: adversary on doc 32 and doc 33 (doc 39 §8).
