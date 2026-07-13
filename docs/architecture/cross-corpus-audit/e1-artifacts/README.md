# E1 gate — run artifacts

Auditable artifacts for the real E1 element→rule adjudication gate. Design, pre-registration, and results are in `../09-e1-proxy-test.md` (§12–§17). These files let the runs be inspected and re-scored. Harness scripts are throwaway Node/ESM (run with `node <file>.mjs`); paths inside them point at the original scratch dir and are for reference, not re-execution in place.

The system-under-test in every leg is **blind Haiku** over a fixed candidate rule set; `*_key.json` (the sealed ground truth) was never shown to it. `*_responses.json` are Haiku's returned findings.

## Leg 1 — clang-tidy-log oracle → VOID (doc §12–§13)
Voided: the checkout had drifted from the commit clang-tidy judged (violations were later fixed), so post-fix code was scored against pre-fix labels. Kept for the record.
- `leg1_build_oracle.mjs` — parse clang-tidy logs → elements+key. `legA_embedding.mjs` — the embedding baseline. `leg1_{elements,key,responses,disagreements}.json`, `leg1_score.mjs`.

## Leg 2 — natural violations from human NOLINT → PASS on the checkable-slice floor (doc §14–§15)
Drift-free (pinned clean checkout ALPHA-2570 @ b59d5d73; live NOLINT = live violation), markers stripped, leak-checked. Raw precision 0.93 / recall 0.90. Downgraded by adversary to a checkable-slice floor (positives largely keyword-cued; silent on no-checker rules).
- `build_leg2.mjs`, `generate_batches_leg2.mjs`, `score_leg2.mjs`
- `leg2_{rule_set,elements,key,responses,disagreements}.json`

## Leg 3 — constructed no-checker judgment rules → PASS on the constructed-case floor (doc §16–§17)
Ground truth by construction; four independent parties (planter/validator/system/scorer+adjudicator). Corrected precision 0.90 / recall 0.90 at the 50/50 test set; **field precision collapses to 0.13–0.28 at 2–5% prevalence** (see §17.2). Real judgment signal (paired discrimination 0.78), but not the field task.
- `leg3_pairs.json`, `leg3_pairs_2.json` — planter output (violating+compliant twins; which twin violates = ground truth).
- `leg3_validation.json`, `leg3_validation_2.json` — independent per-pair validation (8/24 dropped for giveaways in batch 1).
- `leg3_twin_reaudit.json` — full re-audit of all compliant twins vs all 6 rules (found 3 contaminated).
- `build_leg3.mjs`, `generate_batches_leg3.mjs`, `score_leg3.mjs`, `score_leg3_corrected.mjs`
- `leg3_{rule_set,elements,key,responses,disagreements,disagreements_detail,compliant_twins}.json`

## Leg 4 — real-code field-prevalence run → CONFIRMS the base-rate concern (doc §18–§19)
140 random real functions (full context) + NOLINT anchors; blind Haiku over 25 guidelines; every flag independently adjudicated + a non-flagged spot-check. Headline field precision 0.68 is **C.131-padded** (13/15 true positives are trivial getters); stripped to genuine no-checker judgment rules it is **1/7 = 0.14 at ~2% real prevalence** — reproducing §17's projection, not refuting it. The adjudicator is a sound local judge but an unusable global scanner → the candidate-generation prefilter is mandatory.
- `build_leg4.mjs` (brace-matching function extractor + seeded sample), `generate_batches_leg4.mjs`, `score_leg4.mjs`
- `leg4_{rule_set,elements,meta,flags}.json` — sample, blind system flags, in_random/anchor metadata.
- `leg4_flag_adjudication{,_input}.json` — independent real/false verdict on every flag.
- `leg4_spotcheck{,_input}.json` — independent check of non-flagged functions for missed violations.

## Status
`nmemo-uhp.6` open; Phase A schema/plumbing may proceed (adjudication mechanism sound), but **no automation/coverage claim** until (1) a candidate-generation **prefilter** exists and is measured, and (2) a **human-labelled** (not LLM-adjudicated) field sample removes the shared-prior caveat. Next empirical target = the prefilter, not the adjudicator.
