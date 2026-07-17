# Doc 16 — Raw-code adjudication test: pre-registration

**Status:** PRE-REGISTERED (frozen before any number). Bead nmemo-uhp.19, the CORRECTED
experiment after doc-15's blind adversary returned **INFLATED**. Committed before the
harness runs. Shared caveats/discipline: docs 10–15 + [[verify-empirical-gates]].

## 1. Why (what doc-15 got wrong)

doc-15 measured recall 6/7 · precision 7/7 · specificity 10/10 on the composition pilot,
and the blind adversary voided the reading: the adjudicator judged the Haiku-**authored
code description**, and the blind author had pre-stated the defect in the rule's own
vocabulary (V22_8_a desc = "undefined behavior from mismatched deallocation operator"). A
12-line defect-word regex reproduced 7/7 violations + 8/10 controls; a "confirm the #1
recalled rule" stub beat the LLM's recall. The semantic work lived in AUTHORING, not
adjudication. This test removes that leak and bakes the baselines into the bar.

## 2. Question

Given **RAW C++** (not a consequence-laden description) + a rule, can the BUILT adjudicator
(production `invokeAuditAgent` → `/audit-agent` → Claude Code + graph MCP) correctly
classify `violates` / `satisfies` / `not_applicable` — and does it **beat** a defect-word
regex and a code-vs-rule BM25 matcher on the SAME cells, ESPECIALLY on the semantic rules
where no keyword decides the answer?

## 3. Method (frozen)

- **Corpus:** re-ingest the 40 violations + 10 controls into `floor-coderaw` with the entity
  `description` = the **RAW snippet verbatim** (via `upsertCorpusElementEntity`, NO
  authoring step — so nothing pre-diagnoses the defect, and the agent's graph-MCP read
  tools also return only raw code). Rules = the existing `floor-rules` authored rule
  descriptions UNCHANGED — the rule side was never the leak (a rule legitimately describes
  itself); the leak was code-side verdict vocabulary.
- **Candidate set (CONTROLLED — isolates adjudication from the lexical prefilter):** for
  each code element, adjudicate against {its true rule(s)} ∪ {its top-2 FALSE rules from
  the doc-15 embedding recall ranking (`floor-recall-results.json`)}. The distractors are
  the lexically OVER-SEEDED wrong rules, so specificity is a HARD test (reject the
  tempting-but-wrong rule), and prefilter recall is removed as a confound. Violation →
  (n_true + 2) cells; control → its top-2 recalled rules (GT never `violates`).
- **Adjudicator:** the production per-cell path, scope.element.description = raw code,
  element.ref = the `floor-coderaw` entity; promotion + coverage identical to doc-15.
- **PILOT first (cost):** a fixed subset WEIGHTED to the discriminating rules —
  violations `V22_1_a` (22.1 real-time), `V22_3_a` (22.3 ownership), `V22_4_a` (22.4
  ambiguous — the 3 SEMANTIC rules doc-15 excluded), `V22_5_a` (22.5), `V22_7_c` (22.7+8),
  `V22_9_b` (22.9, the doc-15 miss), `V22_2_a` (22.2) + all 10 controls' top-2. ~35–45
  cells. Full run only if the pilot warrants.

## 4. Baselines — PRE-REGISTERED AS THE BAR (rule 42)

On the SAME cells, two non-LLM classifiers predict violates/not-violates:
- **(a) defect-word regex** over raw code (delete/new/free/lock/dangling-shape/etc.) →
  "violates" if its rule-specific token pattern matches.
- **(b) BM25** code-tokens vs each rule description → "violates" for the top-ranked rule.

Report all three confusion matrices (regex, BM25, LLM). **The LLM's contribution is only
real if it BEATS the better baseline.**

## 5. What "pass" means (frozen)

- Per-cell 3-way verdict collapsed to binary (violates vs not) against ground truth.
- Metrics over the controlled set: **recall** (TP over true cells), **specificity** (TN
  over false/distractor + control cells), **balanced accuracy** = (recall+specificity)/2.
- **PASS iff BOTH:** (1) LLM balanced accuracy − max(regex, BM25) balanced accuracy **≥
  +0.10**; (2) LLM specificity on distractor+control cells **≥ 0.70**.
- **DECISIVE analysis (pre-committed):** decompose by rule class. The MECHANICAL rules
  (22.5/22.6/22.7/22.8/22.9/22.10 — a keyword like `delete[]`, `.lock()`, `p++`, `&local`
  largely decides them) are expected to be regex-tractable EVEN on raw code; the LLM's
  value must show on the **SEMANTIC slice (22.1/22.3/22.4)** where no single token decides
  it. Report the LLM−baseline delta SEPARATELY for mechanical vs semantic. A pass carried
  entirely by the mechanical slice does NOT license an adjudication-capability claim (rule
  18: decompose; strip the keyword-spottable class and re-check).
- **Report ALL cells**, both baselines, per-rule-class breakdown. No tuning to pass.

## 6. Adversary (pre-committed, before any claim)

Blind hostile: (1) does raw code still leak the verdict trivially — is the LLM win just the
mechanical/keyword slice, with the semantic slice at/below baseline? (2) is any LLM−baseline
margin real or within the n-small CI? (3) distractor honesty — are the top-2 false rules
genuinely false AND tempting (high recall sim)? (4) does the graph MCP surface anything
beyond raw code (facts/memories) that re-introduces leakage? (5) floor/base-rate creep.

## 7. Pre-committed caveats

- Still a curated **FLOOR**: my rule restatements (not authoritative MISRA), tiny n, single
  sample, ~44% positive by construction (NOT field prevalence). Absolute magnitudes do not
  transfer.
- **A pass licenses only:** "given raw code, the built adjudicator classifies clear Ch.22
  violations against candidate rules, beating lexical baselines including on the semantic
  slice, on this floor." NOT field precision, NOT autonomous audit, NOT the graph-mediated
  recall the real system intends (recall is bypassed here by the controlled set).
- **A FAIL is a legitimate outcome** and the more likely one given the E1 history (the
  semantic slice is where prior tests found the value unproven). Report it and its cause;
  do not rescue.

---

# RESULTS (post-run — appended after §1–7 are frozen + committed)

**Run:** PILOT, 43 controlled cells (7 violations weighted to the semantic slice + all 10
controls, each × {true rule(s)} ∪ {top-2 lexically-recalled false rules}), single sample,
conc 4, 579 s. Artifacts: `floor-rawcode-pilot-results.json`, log
`floor-rawcode-pilot.log`. **Outcome: FAIL against the pre-registered bar — and the blind
adversary (doc §6) then CUT my affirmative reading of the fail. Net: this run adds NOTHING
beyond the E1 terminal finding.**

## Numbers (recall / specificity / balanced-accuracy; T=true cells, F=false cells)

| classifier | slice | rec | spec | BA | matrix |
|---|---|---|---|---|---|
| **LLM**  | ALL (T9/F34) | 0.67 | 0.94 | **0.804** | tp6 fn3 fp2 tn32 |
| regex    | ALL          | 0.78 | 0.82 | 0.801 | tp7 fn2 fp6 tn28 |
| BM25     | ALL          | 0.67 | 0.82 | 0.745 | tp6 fn3 fp6 tn28 |
| **LLM**  | SEMANTIC 22.1/3/4 (T4/F7) | 0.50 | 0.86 | **0.679** | tp2 fn2 fp1 tn6 |
| regex    | SEMANTIC     | 1.00 | 0.86 | 0.929 | tp4 fn0 fp1 tn6 |
| **LLM**  | mechanical (T4/F24) | 0.75 | 0.96 | 0.854 | tp3 fn1 fp1 tn23 |
| regex    | mechanical   | 0.50 | 0.79 | 0.646 | tp2 fn2 fp5 tn19 |

- **Bar (1):** LLM ALL BA − max(baseline) BA = 0.804 − 0.801 = **+0.003** (needs ≥ +0.10) → **MISS**.
- **Bar (2):** LLM specificity 0.94 (needs ≥ 0.70) → clears, but bar (1) governs the verdict.
- **Decisive (semantic) slice:** LLM 0.679 vs regex 0.929 = **−0.25**.
- **VERDICT: FAIL.**

## Blind adversary (doc §6, committed before this section) — verdict = FAIL SOUND, my semantic reading OVERSTATED

The adversary attacked the fail in BOTH directions and I independently verified its
load-bearing empirical claim. Findings:

1. **The overall FAIL is SOUND.** +0.003 ≪ +0.10; "adjudicator value unproven" stands. No dispute.

2. **THE FATAL FINDING — the "raw" corpus re-leaked the verdict through code COMMENTS.** doc §3
   promised "nothing pre-diagnoses the defect." That was **false**. 6 of 7 pilot violation
   snippets carry a verdict-stating comment — `V22_1_a` "the sole issue is heap use in an RT
   path", `V22_2_a` "lock never released on this path", `V22_4_a` "does consume take
   ownership? unclear", `V22_5_a` "address of a local — dangles at return", `V22_7_c` "array
   new, scalar delete", `V22_9_b` "same resource freed via alias". This is the doc-15
   authoring leak reintroduced through a different channel. Both classifiers (and the LLM's
   graph-MCP read) see these comments; the 22.9 regex literally matched the word "delete" in
   `V22_7_c`'s comment. **The one comment-clean cell — `V22_3_a` — is exactly the semantic
   cell the LLM declined.** So the corrected experiment was NOT clean.

3. **My "LLM loses at semantics (−0.25)" reading is a 2-cell artifact — DO NOT record it.**
   The semantic slice is T=4/F=7 (n=11); each true-cell flip moves BA by 0.125, so −0.25 is
   exactly **two cell-flips** wide. Both LLM "misses" are the SAME rule (22.3), both are
   debatable strict-reading cells (`V22_3_a` = a correct hand-rolled RAII owner; `V22_4_a` =
   my own GT double-cites 22.3+22.4 for one ambiguous call), and regex "catches" both only
   via bare `\bnew\b`. Correcting one debatable GT label roughly halves the magnitude to
   ~−0.10. The sign (regex ≥ LLM here) is robust; the magnitude and its interpretation are not.

4. **The semantic regex patterns are keyword/shape matchers, not semantic detectors.** `22.3`
   = literally `/\bnew\b/`; `22.1` = `/new|malloc/`; `22.4` = a raw-pointer-parameter shape.
   They "win" the semantic slice only because every true semantic violation in this corpus
   carries the surface keyword. The corpus **never isolated a keyword-free semantic
   judgment** — for either classifier.

5. **Candidate-set rigging against the keyword baselines.** Controls were adjudicated only
   against their top-2 lexically-recalled false rules, so no benign-`new` snippet
   (`C_ok_arraydelete` has `new int[10]`) was ever tested against the `\bnew\b`-based 22.1/22.3
   rules. The regex's semantic specificity was never stress-tested with the distractor that
   breaks it.

6. **The LLM DID show real value — but pre-excluded and tiny-n.** It correctly rejected
   `C_ok_weaklock`'s benign `.lock()` (correct null-checked `weak_ptr`) that the regex
   false-positived. Its specificity edge (0.94 vs 0.82; FPR 0.06 vs 0.18) → ~2× precision at
   2 % field prevalence (~0.19 vs ~0.08). But this edge is entirely on the **mechanical**
   slice (doc §5 pre-excluded it) and rests on LLM total FP = 2. A footnote, not a rescue.

7. **MCP leakage unverifiable.** The leaky `floor-code` corpus is still in the DB (used for
   the distractor ranking). Whether the graph MCP surfaced leaky descriptions / prior bridges
   to the LLM is not recorded. Risk direction: would have inflated the LLM, which still
   failed — so it can't rescue the fail, but the run is not clean and can't be cited as a
   leak-free adjudication test.

## What this run licenses (stated tightly, resisting launder in BOTH directions)

> On this 43-cell FLOOR pilot, the built LLM adjudicator did **not** clear the pre-registered
> bar (ALL balanced-accuracy delta **+0.003** ≪ +0.10). The adjudicator's value remains
> **unproven** — consistent with, and adding **nothing beyond**, the E1 terminal finding.

Explicitly BARRED (all three were live launder-risks I was steering toward):
- ✗ "The LLM loses at / is bad at semantic judgment." (2-cell artifact; slice never tested semantics; comment-leaked.)
- ✗ "Lexical baselines match the LLM on semantics." (`\bnew\b` coincidence + candidate set that never challenged it.)
- ✗ "The LLM has no value." (Rejected benign-keyword control; real field-prevalence specificity edge — but mechanical, pre-excluded, tiny-n.)
- ✗ Any generalization past "this floor" (44 % construction prevalence, my rule restatements, n=11 on the decisive slice, single sample).

## Disposition

- **9th launder-catch on this feature family** (1st in the anti-LLM direction — I over-read the
  fail exactly as I over-read doc-15's win). The blind adversary + independent verification
  did the work my synthesis could not be trusted to do. New discipline in [[verify-empirical-gates]].
- **Root cause is the CORPUS, not the model.** Twice (doc-15 authored descriptions, doc-16
  comment-laden "raw" snippets) I failed to construct a keyword-free, comment-free semantic
  test cell. Until one exists, **no run — pass or fail — speaks to semantic adjudication
  capability.**
- **The still-owed valid test = the E1 §27 spec:** a genuinely semantic no-shadow rule +
  verdict-free & comment-free snippets + benign-keyword distractors actually adjudicated
  against the keyword rule + ≥2 senior-expert human ground truth (inter-expert agreement
  reported first) + a BUILT deterministic baseline + pre-reg + adversary. Not attempted here.
- **Do NOT run the full doc-16 k=3 sweep** — the corpus cannot answer the question it was
  built for; spawning ~160 more Claude Code instances on a leaked corpus buys nothing.
- **Phase A schema/plumbing remains UNBLOCKED** (this was never a plumbing test); no
  automation/coverage/semantic-capability claim. `nmemo-uhp.6` stays OPEN, specified-and-paused.
