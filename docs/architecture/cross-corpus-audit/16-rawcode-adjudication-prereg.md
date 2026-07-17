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

_(pending)_
