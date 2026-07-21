# Doc 22 — Hybrid (RRF) recall gate: pre-registration

**Bead:** nmemo-uhp.26 · **Status:** PRE-REGISTRATION (committed before any number) · **Date:** 2026-07-21
**Discipline:** [[verify-empirical-gates]] — 18th empirical run on this feature family. Nothing in §4–§7 may
change after the first number (R1). Reuses doc-20's corpus/oracle and doc-21's frozen arms; **no new LLM
calls, no new data** — a purely deterministic fusion + re-score.

**Reads on top of:** doc-20 (three separate arms) and doc-21 (reconciled JOIN). Both showed concept-JOIN and
cosine are **complementary** (each wins guidelines the other loses), but no gate ever scored a **fused**
ranking. This does.

---

## 1. The exact question

> The concept-JOIN and cosine arms win different guidelines (doc-21 §13: JOIN wins ES.42/ES.30/Type.1,
> cosine wins ES.45/F.16). Does a **parameter-free fusion** of the two rankings (Reciprocal Rank Fusion)
> beat the **better single arm** (cosine, macro@5 0.467) — i.e. does the observed complementarity convert
> into a measured recall gain, graded by the external clang-tidy oracle?

The oracle-fusion **ceiling** (pick the right arm per guideline) = **0.648** vs cosine 0.467 and reconciled
JOIN 0.444 — the largest headroom in this arc. RRF fuses per-element *blind* to which arm is right, so it
cannot reach the ceiling; the question is how much of that +0.18 headroom a blind fusion actually captures.

## 2. What this does NOT test (scope fences)

- **NOT** a new extraction/alignment. Both arms are frozen (doc-20 cosine, doc-21 reconciled JOIN). This is
  fusion only.
- **NOT** field prevalence. Constructed-floor recall, n=29 elements / 9 guidelines.
- **NOT** a tuned combiner. RRF has one conventional constant (k=60), frozen; there is no weight to fit, by
  design — a weighted/learned combiner over 9 guidelines would overfit and is explicitly excluded (R26).
- **NOT** a fix for bucket-3. C.48/ES.20/ES.75 score 0 in **both** arms → 0 in the fusion; they cap the
  hybrid at the same pre-declared ceiling (doc-21 §0/§9).

## 3. The two arms (frozen inputs)

- **cosine** — full per-element ranking of all 27 rules by cosine similarity between the frozen code and
  rule embeddings in `cj-extracted.json` (`codeEmbeddings`/`ruleEmbeddings`, nomic-embed-text 768-dim). The
  true-rule rank must reproduce `cj-results.json` `perElement[E].cosRank` (R40 consistency check).
- **reconciled JOIN** — full per-element ranking of all 27 rules by shared-concept-count, using the frozen
  doc-21 relations (`cr-relations.json`) + the 5 baseline lexical merges. Must reproduce doc-21's
  reconciled macro@5 = 0.444 (R40).

Both arms rank **all 27 rules** per element (ranks 1..27), ties broken **against** the true rule
(conservative; the doc-20/21 convention), then by ascending rule id.

## 4. The fusion rule (frozen — R1)

**Reciprocal Rank Fusion**, textbook, k = 60 (the canonical constant; not tuned):

```
RRF(element, rule) = 1/(60 + cosineRank(element, rule)) + 1/(60 + joinRank(element, rule))
```

Rank the 27 rules per element by RRF score descending; ties broken **against** the true rule. recall@k vs
`trueGuideline`. No other combiner is tried; k is not swept.

## 5. Primary metric and the bar (frozen — R1)

- **Primary metric:** **macro** recall@5 (per-guideline mean; the doc-20/21 lens).
- **Primary bar:** **hybrid macro@5 ≥ 0.567** (= cosine 0.467 + 0.10, ≈ 1 guideline-quantum over the best
  single arm). This is the "complementarity converts to a real win" threshold. It exceeds both single arms
  by construction (both < 0.50).
- **Secondary (reported, not gating):** macro@{1,3,8}; **whether @1 regressed** vs cosine 0.259 (doc-21's
  hybrid-style @1 regression is a known hazard — a hybrid that wins @5 but tanks @1 is a *qualified* win);
  per-guideline table; paired bootstrap CI (hybrid − cosine, hybrid − JOIN).

**Underpowered-CI honesty (R39/R50):** at n=9 the paired CI is wide (±0.3 in prior gates); a +0.10 lift
will likely **not** reach CI-excludes-0 significance. The bar is therefore the **absolute point estimate**
(0.567), with the CI reported descriptively and **not** spun as significant if it includes 0. If the point
estimate clears 0.567 but the CI includes 0, the honest verdict is "clears the pre-set floor, underpowered
for significance" — not "significantly beats cosine."

## 6. Anti-leak controls

- **Deterministic, no LLM, no new data (R40).** Both rankings recomputed from frozen artifacts; the whole
  gate is a pure function → 100% reproducible.
- **Consistency checks (R40).** cosine true-rule ranks reproduce `cj-results.json` cosRank; JOIN reproduces
  doc-21 0.444. Printed before the hybrid number. If either fails, the fusion is void.
- **No tuning (R26).** k=60 and the RRF form are frozen here. No post-hoc combiner search.
- **Conservative tie-break** carried through both arms and the fused ranking (never favors the true rule).
- **Persist everything (R15).** Per-element per-arm ranks + RRF scores + fused ranks → `cr-hybrid-results.json`.

## 7. Pre-committed honest priors

- **Bucket-3 ceiling.** C.48/ES.20/ES.75 (and F.16 for JOIN) are 0 in ≥1 arm; C.48/ES.20/ES.75 are 0 in
  **both** → the fusion cannot exceed 0.648 and those 3 stay 0.
- **Plausible PASS:** RRF lifts the true rule wherever *either* arm ranks it well → captures ES.42/ES.30/
  Type.1 (JOIN) *and* ES.45/F.16 (cosine); macro@5 lands ~0.55–0.62.
- **Plausible FAIL:** JOIN's sparse, tie-heavy ranking (most rules score 0 → tail ranks) contributes little
  signal and its wrong bridges pull distractors up, diluting cosine's good ranks; hybrid lands ≈ cosine or
  below 0.567.
- **Plausible qualified PASS:** hybrid@5 clears 0.567 but @1 regresses below cosine 0.259 (fusion noise at
  the top) — a real @5 win with a precision-at-1 cost, reported as such.

## 8. Blind-adversary protocol (mandatory before any claim)

Fresh subagent, not seeded with the verdict, given this pre-reg + all artifacts + raw numbers, tasked to
break the claim: (1) recompute both arms' full rankings and the RRF fusion independently — does hybrid@5
match? (2) is k=60 doing the work, or would other k flip the verdict (report hybrid@5 across k∈{10,30,60,100}
as a robustness check — NOT to pick a winner, but to confirm 0.567 isn't a k=60 artifact)? (3) is the win
bucket-3-honest? (4) did @1 regress? (5) are the CIs the pre-registered ones, reported as underpowered? (6)
is the consistency check real (cosine reproduces cosRank, JOIN reproduces 0.444)? (7) DIRECTION: is the
hybrid win smuggling anything, or is it genuinely the fused element→rule ranking graded by the external
oracle? The adversary's verdict is reported even if it retracts (R3).

## 9. Disposition rule (decided now — R32)

- **PASS** (hybrid@5 ≥ 0.567 + adversary clears): the complementarity is **real and convertible** — fusing
  the symbolic concept-JOIN with cosine beats either alone on this floor. This is the first arm in the arc
  to beat plain cosine, and it validates the D-C7 union as a **measured recall gain**, not just empty-safe
  plumbing. The concept layer earns its keep as a recall *contributor* (via fusion), even though it loses
  standalone (doc-20/21). Field prevalence + cross-model generality still owed.
- **FAIL:** complementarity does not convert via blind RRF; the arms are best used separately and cosine
  stays the single-arm choice. doc-21's disposition (concept layer = explainable substrate, not a recall
  lever) stands unchanged, now also shown to not compose into a fused win on this floor.

Both outcomes leave all code shipped; only the claim differs (R32).

---

## 10. RESULT (2026-07-21) — PRE-REGISTERED GATE **FAIL**; adversary = FAIL-IS-ARTIFACT (pessimism retracted)

Run: `platform/src/test/tools/concept-hybrid-recall.ts` (deterministic, no LLM). Consistency verified:
cosine full-ranking reproduces `cj-results.json` cosRank for all 29 elements; JOIN reproduces doc-21's
0.444.

**Macro recall@k:**

| arm | @1 | @3 | @5 | @8 |
|-----|----|----|----|----|
| cosine | 0.259 | 0.337 | **0.467** | 0.626 |
| JOIN (reconciled) | 0.159 | 0.311 | 0.444 | 0.444 |
| **HYBRID full-ranking RRF k=60 (PRE-REGISTERED)** | 0.248 | 0.404 | **0.444** | 0.444 |
| HYBRID retrieved-set RRF k=60 (exploratory, NOT pre-reg) | 0.330 | 0.444 | **0.648** | 0.667 |

- **Pre-registered gate = FAIL.** Full-ranking RRF macro@5 = **0.444 < 0.567**. @1 regressed (0.248 <
  cosine 0.259). k-sweep confirms no k rescues it (max 0.556 at k=1–5, still < 0.567). Full-hybrid − cosine
  = −0.021, CI [−0.389, +0.319] → a **tie**, not "significantly worse" (must not be spun as worse).

**Blind adversary verdict: FAIL-IS-ARTIFACT-RETRACT** (agent a5d1a05e) — of the *interpretive claim*, not
the arithmetic. It reproduced 0.444 exactly, then tested the textbook **retrieved-set RRF** (Cormack 2009:
a sparse ranker contributes only for items it actually returns — JOIN only where shared-concept score > 0;
cosine for all). That variant — **blind** (score>0 is oracle-free), **un-tuned**, **k-robust** (0.648 flat
at k=10/30/60/100), tie-break-invariant — scores **0.648**, hits the oracle-fusion ceiling, keeps JOIN's
wins (ES.30/ES.42/Type.1) *and* cosine's wins (ES.45/F.16), and beats **both** single arms at **every** k.
I independently reproduced 0.648 in the committed harness. Retrieved-set − cosine = +0.182, CI [0.000,
+0.378] (point clears the bar; lower bound touches 0 → underpowered for strict significance).

**Root cause of the pre-registered FAIL (my operationalization error, not the method):** the frozen
full-ranking variant (§3/§4) forces the *sparse* JOIN arm to assign fabricated tail-ranks (1..27) to the
~24 rules it has **zero** signal about — each injecting ~1/(60+rank) ≈ 0.013 of RRF noise. For F.16
(cosine rank 1, JOIN score 0) and ES.45 (cosine 4–7, JOIN 0), that tail-noise — amplified by the correct
conservative tie-break handing the true rule the *worst* zero-score rank — sank cosine's correct picks
below distractors. Retrieved-set gives JOIN zero contribution where it has no signal, so cosine's correct
single-arm ranks survive. **The complementarity converts; my pre-registered RRF form was the wrong tool
for a sparse arm.**

**What is honestly licensed:**
- **The pre-registered gate FAILED** — that stands as the frozen result.
- **The pessimistic reading is RETRACTED.** "Complementarity does not convert via blind RRF / the arms are
  best used separately" (the §9 FAIL disposition) is **false**: a blind, parameter-free, canonical fusion
  converts it, beating both single arms.
- **ROBUST qualitative finding:** blind retrieved-set fusion of the symbolic + embedding arms **beats both
  single arms** (0.648 > cosine 0.467 > JOIN 0.444; even F.16-stripped it is 0.537 > both). This is the
  first thing in the whole arc to beat plain cosine.

**What is NOT licensed (the optimistic-mirror trap, explicitly refused):**
- **The 0.648 is NOT banked as a validated PASS.** Retrieved-set RRF was **not** pre-registered, and its
  number is now known — treating it as a confirmed gate would be the exact post-hoc-variant laundering the
  adversary has cut 5× before, just in the optimistic direction. It is **exploratory/confirmatory**.
- **Clean confirmation on THIS corpus is no longer possible** (the number is known → any doc-23 pre-reg
  here isn't blind). A banked PASS needs held-out / different-corpus data.
- **The 0.567-clearance is thin and F.16-carried** (2 elements at n=29): without F.16, retrieved-set =
  0.537 < bar. The "beats both arms" finding is robust; "clears 0.567 / hits 0.648" is margin-fragile.
- Constructed floor (n=29/9); no field-prevalence or cross-model claim.

**Process slip (disclosed, R-honesty):** doc-22 was written but **not committed to git before the run** —
file mtimes (prereg 14:58 → results 15:00) and the blank §10 support pre-reg-then-run, but the
"committed-before-any-number" proof was skipped in haste. Committing now; noted as a discipline miss.

**Net:** the pre-registered gate is a FAIL, but a *false* FAIL — an artifact of choosing full-ranking RRF
over the canonical retrieved-set form for a sparse arm. The real finding is the opposite of the FAIL's
surface: **blind fusion converts the complementarity and beats both single arms.** Banking that as a gate
PASS requires a clean confirmation on data whose number isn't yet known.
