# Doc 35 adversary brief — written BEFORE any number existed

**Written:** 2026-08-25, while corpus-A concept linking was still running. Nothing in
`multihop-results.json` had been computed or seen. Committed at that point deliberately: a brief
drafted after seeing results is shaped by them, and the one thing this investigation cannot
afford is an adversary whose attention has been pre-steered away from wherever the result
actually is weak.

## Your task

You are a **blind adversary**. You have not been told what the result was, and you should not
assume it was favourable or unfavourable. Read doc 35 (the frozen pre-registration), then the raw
artifacts, and **try to break the conclusion in BOTH directions**:

- if the run PASSED its bars, show why the pass is an artifact;
- if it FAILED, show why the failure is an artifact.

Report what survives, not what you were hoping to find. A tie is a tie. A confidence interval
touching zero is not a win.

## Read these

| what | where |
|---|---|
| the frozen pre-registration | `docs/architecture/cross-corpus-audit/35-multihop-concept-recall-prereg.md` |
| why the old negatives are narrower than they look | `34-concept-layer-construction-audit.md` |
| state, traps, and the recorded handicaps | `36-handover.md` (esp. §3.1, §7) |
| results | `multihop-artifacts/multihop-results.json` |
| raw entity pairs per arm | `multihop-artifacts/multihop-raw-pairs.json` |
| attribution map | `multihop-artifacts/doc-attribution.json` |
| the scorer (bars encoded in code) | `platform/src/test/tools/multihop-score.ts` |
| the recall primitive | `platform/src/services/concept-multihop.ts` |

## Known-weak points — start here, but do not stop here

These are disclosed rather than hidden. Check each is disclosed *honestly*, and check whether its
effect is larger than admitted:

1. **The oracle is co-citation, and doc-30's adversary showed it is ~79% cosine-predictable**
   (AUC 0.79). So it only partially de-circularises the comparison against arm E. Any claim that
   the concept layer beats or loses to embedding inherits this.
2. **Entity fragmentation** (doc 36 §3.1). `chatgpt` exists 21x in corpus A across free-text
   `entity_type` variants; 37% of corpus A facts and 26% of corpus B facts touch a fragmented
   node. Claimed direction: it *reduces* concept-arm reach and leaves arms E and B untouched, so
   it handicaps the hypothesis. **Verify that claimed direction — do not take it on trust.** In
   particular, fragmentation also lowers per-concept document frequency, which RAISES IDF; work
   out whether that could flatter the score rather than depress it.
3. **~8-9% of entities yield no concepts at all** and so cannot participate in any concept arm.
   Check whether this ceiling is reported and whether it is uniform across the two corpora.
4. **Concurrency in the linking pass** means an entity's shared-vocabulary window could not see
   concepts minted by the 5 calls beside it. Claimed direction: marginally LOWER label reuse,
   biasing against the concept layer. Verify.
5. **Three harness bugs were fixed pre-numbers** (commits `850fb9b`, `dac0687`). Bar 3 was not
   implemented at all; bar 1 failed on a divide-by-zero when S0 = 0; arm E scored a missing
   embedding as a perfect 1.0. **Audit those fixes as adversarially as the result** — a bar
   rewritten by the same person who wanted an answer is exactly the failure mode
   [[verify-empirical-gates]] records 11 times. Specifically: is the S0 = 0 handling
   ("multiplier trivially satisfied, absolute bar governs") the honest reading of §7.1, or a
   convenient one?
6. **The causal pass failed on every batch** (WinError 206), so no causal edges exist for either
   corpus. Claimed irrelevant because `concept-multihop.ts` reads no causal edges. Verify by
   reading the primitive, not by trusting this.

## Specific things to attack

- **Recompute the bars yourself** from the raw artifacts. Do not trust the verdict fields.
- **Check the direction of the test.** doc 35 asks whether traversal connects co-cited
  cross-corpus pairs that single-hop misses. Confirm the winning arm answers *that*, not a
  reversed or easier question. (Direction conflation was the first thing an adversary ever caught
  on this project.)
- **Is the S0 baseline the real shipped mechanism, or a straw one?** The reduction anchor is
  supposed to prove it. Note a trap: `multihop-identity-check.ts` reports `0 pairs / 0 pairs /
  PASS` when the doc-20 substrate has been destroyed — a vacuous pass that reads like a real one.
  A genuine anchor is 10/10 with zero set difference. Check which one was reported.
- **Coverage without cells is meaningless.** Every coverage number must come with its cell count
  and its frontier point. If a concept arm's coverage is below what arm E achieves at the same
  cell budget, say so plainly however the three bars landed.
- **Hub-driven reach.** Bar 3 excludes the top-3 concepts. Is 3 enough? Recompute with more
  excluded and see whether the gain survives.
- **Prevalence.** The oracle has 1,079 co-cited pairs of 21,609 (5%). Check whether any reported
  discrimination is robust at that base rate, and whether AUC is the right lens for it.
- **Was anything tuned after the fact?** `decay = 0.5`, `tau = 0.615`, `hops in {0,1,2}` and the
  95% attribution floor are frozen in doc 35 §3/§5. Confirm the code uses exactly those, via
  `git log`, and that no bar moved after the first number.

## What a pass would and would not license

doc 35 §2 fences this: it is NOT an adjudication test, NOT a field-prevalence or adoption claim,
and NOT a rehabilitation of docs 28-33, whose negatives stand for what they measured. A pass means
the mechanism is live on a constructed floor with a weak oracle. Hold the author to that.

## Outstanding debts, so they are not quietly dropped

Adversary debts already owed: **doc 32** (skipped by explicit user decision) and **doc 33**. This
brief is the third. Say plainly if the doc-35 result depends on anything those two would have
checked.
