# Doc 27 — Corrected redundancy metric: a non-chaining, noise-modelled redefinition (pre-registration)

**Bead:** follow-up to nmemo-kxs (new bead to file) · **Status:** PRE-REGISTRATION — frozen before any recompute
**Date:** 2026-07-24 · **Discipline:** [[verify-empirical-gates]] (23rd run). Committed to git BEFORE numbers.
Autonomous `/goal` session. This fixes the metric-design defect the doc-26 blind adversary named.

---

## 0. Why (the defect being corrected)

doc-26 pre-registered TWO redundancy bounds. The **strict** one (redundancy = Σ(s−1)/N over connected
components of SAME-only edges) is sound and non-chaining — SAME is rare, its largest component was 2 (Arm R) /
4 (free-form). The **lenient** one (components over SAME **∪ SIBLING** edges) is **ill-posed** (adversary-
confirmed, doc-26 §9): SIBLING is defined "keep separate," and transitive closure over a common relation chains
genuinely-distinct concepts into giant blobs (Arm R's 23-node blob = 2 SAME + 36 SIBLING edges; free-form's
148-node blob = 23 SAME of 266). It measures relatedness density, not duplication, and explodes by construction.
cond-R FAILED on that broken bound. This doc replaces the lenient guard with a **bounded, non-chaining** one and
models the judge's false-positive floor.

**No re-litigation of the strict result:** the doc-26 SAME/SIBLING/UNRELATED verdicts are frozen and were
reproduced 0-mismatch. This doc only changes how they are AGGREGATED (plus a small order-swap confirmation pass).

## 1. Corrected metrics (frozen) — all WITHOUT sibling transitive closure

Let SAME-edges be candidate pairs judged SAME (from the frozen doc-26 caches). For a space of N base nodes:

- **R_strict (raw)** = Σ(sᵢ−1)/Nᵢ over connected components of SAME-only edges. *(= doc-26 strict; the redundancy
  number. No chaining: SAME largest component ≤4.)*
- **R_confirmed (headline, noise-modelled)** = R_strict recomputed keeping only SAME edges that survive an
  **order-swap confirmation**: re-judge each SAME-verdict pair with labels swapped (judge `(b,a)`); keep the edge
  only if it is SAME **both** orderings. A robust duplicate is order-invariant; a judge false-SAME (the adversary
  found one at cos 0.36) is likely order-fragile. This suppresses the ~2% false-SAME floor. *(~60 new Haiku
  calls total — 7 Arm-R + 53 free-form SAME pairs — the ONLY new model calls in this doc.)*
- **R_upper (bounded missed-dup guard — replaces the broken lenient bound)** = R_strict recomputed after
  promoting to SAME every SIBLING pair with **cosine ≥ 0.85** (the band where true duplicates concentrate). This
  is the worst case "what if the judge under-called high-similarity dupes as siblings." It is **bounded** (only
  high-cos siblings, a small set) so it **cannot** chain the way full-sibling closure did.
- **Report the noise floor** from the doc-26 spot-check (below-0.70 SAME-rate: Arm R 0/100, free-form 2/100) as
  the reference for "≤ floor" language.

The truth is bracketed by **[R_confirmed, R_upper]**.

## 2. Bars (FROZEN before any recompute)

cond-R′ PASSES iff **all three**:
- **(absolute)** R_confirmed ≤ **5%** — product ceiling: ≤1 in 20 nodes is a true duplicate.
- **(bounded guard)** R_upper ≤ **10%** — even assuming every high-similarity sibling is secretly a dup, the
  space is ≤10% redundant. (Replaces the broken ≤10% lenient bound with a non-chaining quantity.)
- **(comparative)** R_strict ≤ **0.5 × free-form R_strict** — the mechanism removes ≥half the raw redundancy.

Full gate still also needs cond2 (distinct stay-separate ≥90%; Arm R 95%, prior) and cond3 (verbatim conform
≤0.10; a window-engineering item, prior).

**Integrity disclosure:** I have seen R_strict (Arm R 1.45%, free-form 5.63%) from doc-26, so I am NOT blind on
the absolute/comparative bars (unchanged from doc-26, where the 5% was already disclosed as above the peeked
estimate; R_strict landed below it regardless). I am **blind on R_confirmed and R_upper** — both are new
quantities computed for the first time here; the 10% guard bar is set on the same product principle, not to
clear a seen value.

## 3. What each outcome means (registered before recompute)

- **All three pass:** the space is genuinely non-redundant under a sound, non-chaining, noise-modelled metric,
  and the mechanism earns it → cond-R′ PASSES. Still EXPLORATORY (single field/corpus); triggers the
  pre-registered held-out confirmation before any capability claim (doc-24 §4). And still only **surface-variant**
  dedup (doc-26 §9 adversary correction) — claim that scope, not semantic dedup.
- **R_confirmed passes but R_upper > 10%:** high-similarity siblings are numerous enough that, if any are misjudged,
  redundancy could exceed the ceiling → the judge's SAME/SIBLING boundary at high cosine needs auditing, not a pass.
- **R_confirmed collapses toward 0 after order-swap:** the doc-26 strict number was largely judge noise; report
  that the space's redundancy is at/below the noise floor (a stronger "clean" result, but state it as "≤ floor").
- **Comparative fails (free-form also clean after confirmation):** the conform mechanism is solving a smaller
  problem than assumed; deflating, reported.

## 4. Anti-launder controls
- Metric + bars committed to git BEFORE the recompute and BEFORE the order-swap calls.
- The **only** thing changed vs doc-26 is aggregation of frozen verdicts + a bounded guard + an order-swap
  confirmation; the SAME/SIBLING/UNRELATED judgments themselves are NOT re-run or re-prompted.
- Order-swap confirmation biases the headline DOWN only by removing order-fragile (noisy) SAMEs — it cannot
  invent redundancy; a real dup survives.
- R_upper is deliberately pessimistic (worst-case sibling promotion) so the guard cannot flatter.
- Partial-blindness disclosed (§2). Both directions reported. No winner banked without held-out (doc-24 §4).
- This does NOT re-open the doc-26 ruling that cond-R FAILED as originally written; doc-27 is the corrected
  re-registration the adversary required, reported on its own terms.

## 5. Blind-adversary protocol
Fresh subagent, raw artifacts only: (1) recompute R_strict, R_confirmed, R_upper for both spaces independently
from the caches + the new order-swap cache; confirm they match. (2) Verify the order-swap pass is genuine
independent re-judgment (not a copy of the forward verdict) and that it only removed order-fragile SAMEs.
(3) Rule whether the corrected metric is now sound and non-gameable, or whether R_upper/R_confirmed introduce a
NEW artifact (e.g., order-swap suppressing a genuine dup; ≥0.85 promotion arbitrary). (4) Attack the reframe once
more: is adopting the strict node-redundancy as THE metric legitimate, or is it the previously-failing gate
relabelled to pass? (5) Verdict even if it retracts.

## 6. Disposition
Names the outcome per §3. Settles whether, under a sound redundancy metric, the best mechanism's concept space is
clean — the question doc-26 got right on strict but could not bank because of a self-inflicted lenient defect. Does
NOT settle multi-field generality, held-out corpora, or cond3 — each its own gate.

---

## 7. RESULT

*(added after the recompute + order-swap pass + blind adversary)*
