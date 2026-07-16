# Doc 15 — End-to-end composition floor: pre-registration

**Status:** PRE-REGISTERED (frozen before any number is produced). Bead nmemo-uhp.19.
The acceptance test for the **built two-stage cross-corpus linker run end-to-end** —
`recallCrossCorpusCandidates` (prefilter) → `runAuditPass` → real `invokeAuditAgent`
(Claude Code + graph MCP) → promoted `bridge_edges`. Committed BEFORE the harness runs,
same distrust-the-author discipline as docs 10–14 (blind authoring, one consistent
lens, hostile adversary before any claim, FLOOR caveats baked in).

## 1. What is new here (vs docs 10–14)

Docs 10–14 all measured ONE leg of ONE stage — the **embedding-leg recall** (pure
cosine over authored descriptions). Doc 14 FAILED: the built authoring convention
produced no robust embedding-recall lift on the constructed floor. Every audit test to
date (`.12.4`, doc-14, the stage-1 recall smoke) measured recall **in isolation with no
adjudicator**, or measured the adjudicator on **hand-constructed pairs** (E1 legs 3–7).

The still-open question doc 15 answers:

> Run the WHOLE built pipeline end-to-end — real vector prefilter feeding the real
> Haiku adjudicator (spawned Claude Code, graph MCP, `propose_bridge_edge` →
> `applyBridgePromotion` → coverage) — on a curated corpus of **clear** MISRA Ch.22
> violations + controls. On this clean FLOOR: (a) does the prefilter surface the true
> rule, (b) does the adjudicator confirm real violations, (c) does it REJECT the
> controls the prefilter over-seeds, and (d) where does recall leak — the prefilter or
> the adjudicator?

This is the **composition** measurement the reframed `.19` calls for. The stage-2
adjudicator smoke (2026-07-16, n=4) proved the chain RUNS here and gave a positive OQ2
signal + surfaced OQ3 (overlapping-rule collapse); doc 15 measures it at n≈50.

## 2. Corpus (frozen) — the CLEAN FLOOR

`platform/src/test/data/cross-corpus-floor/floor-corpus.json`, authored once and frozen.
**50 code elements + the 10 real MISRA C++:2023 Chapter-22 rules.**

- **40 violation snippets** — 4 per rule × 10 rules. Each is a CLEAR, surface-observable
  violation (the floor: no hidden/implicit behaviour). Ground truth = the rule id(s) it
  violates, **by construction**. Most target ONE rule; the naturally multi-rule cases
  (array-new/scalar-delete ⇒ 22.7+22.8; double-free+dangling ⇒ 22.9+22.5) are labelled
  `expected_rule_citations` with >1 id and drive the per-rule (collapse) metric.
- **10 controls**, two kinds, labelled:
  - **5 out-of-chapter** (uninitialised var, naming, magic number, etc.) — touch a
    DIFFERENT MISRA chapter. Ground truth = **no Ch.22 bridge at all** (every cell
    not_applicable). Tests rejection of clearly-unrelated code the prefilter over-seeds.
  - **5 compliant-Ch.22** (correct `make_unique`, matching `delete[]`, `.lock()` before
    weak_ptr use, RAII wrapper, etc.) — correct resource management. Ground truth = **not
    `violates`** (`not_applicable` or `satisfies` both acceptable). A `violates` bridge on
    a compliant control is a FALSE POSITIVE — the sharpest precision signal.
- **Rules** = the 10 Ch.22 ids with **blind topic restatements** (same text as the
  stage-1/2 smokes). DISCLOSED LIMITATION: my restatements, not authoritative MISRA text.
- **Blind authoring**: code descriptions authored by `authorElementDescription` (Haiku,
  sees only the code), rules by `authorRuleDescription` (sees only the rule) — the built
  `corpus-ingest` path. Leaked-reference scan reported (must be ~0).

## 3. Method (frozen)

- **Ingest** all 50 code elements into `floor-code`* and 10 rules into `floor-rules` via
  the production `ingestCodeElement` / `ingestRuleElement` (blind). Authored descriptions
  + embeddings frozen for the run.
- **Leg 1 — prefilter recall (DETERMINISTIC, cheap):** `recallCrossCorpusCandidates`
  over all 50 elements, full ranking (threshold 0), score recall@k for k∈{1,3,5,8}.
  Deterministic given the frozen embeddings (one-shot Haiku authoring — disclosed).
- **Leg 2 — adjudication (LLM, expensive, one-shot):** `runAuditPass` with the REAL
  invoker, recall **k=3, threshold=0.5** (bounds the sweep to top-3 rules per element;
  DISCLOSED: cells beyond rank 3 are not adjudicated). Every seeded cell is swept — no
  cherry-picking within the k=3 budget. For wall-clock, the code side is partitioned into
  N sub-corpora run as N concurrent `runAuditPass` calls (measurement-equivalent: recall
  is per-element, the rule corpus is whole); coverage is aggregated across runs.
- **Variance disclosure:** a fixed 10-cell subset (all 10 controls' top cell) is
  re-adjudicated a 2nd time; self-agreement reported. Adjudication is non-deterministic;
  the primary numbers are a SINGLE sample and labelled as such.
- **BUDGET AMENDMENT (2026-07-16, before any adjudication number):** the built pipeline
  spawns ONE Claude Code (Haiku) agent per (element, rule) cell — 50×3 = 150 + variance
  is ~160 spawns for the full sweep. That per-cell fan-out is itself a scaling finding
  (an agent per candidate pair does not scale to field corpora). To spend that cost
  incrementally, Leg 2 runs a **PILOT first**: adjudicate a fixed subset — 7 violations
  across distinct rules (`V22_5_a, V22_6_a, V22_9_b, V22_10_a, V22_2_a` clean single-rule
  + `V22_7_c, V22_8_a` multi-rule for the OQ3 collapse test), TOP-3 cells each (21), plus
  each of the 10 controls' TOP-1 (most over-seeded) cell (10) = **~31 cells**. Pilot
  metrics are computed over this adjudicated subset and LABELLED pilot-scope (recall over
  the 7, specificity over the 10 controls' top cell). The full k=3 sweep is run only if
  the pilot warrants it. No variance pass in the pilot (n too small).

## 4. What "pass" means (frozen) — FLOOR bars (clear cases ⇒ high)

Point-estimate bars. n is small and the adjudicator leg is single-sample, so these are
**margins on point estimates, NOT powered CIs** (unlike doc 14's bootstrap — the
adjudicator's non-determinism + per-cell LLM cost preclude a bootstrap here; disclosed).

- **Primary metrics (MACRO = per-rule mean, the honest lens):**
  1. **Prefilter MACRO recall@3 ≥ 0.80** — clear violations should surface a true rule.
  2. **Composition recall ≥ 0.70** — fraction of the 40 violations that get ≥1 CORRECT
     `violates` bridge (whole pipeline finds the violation).
  3. **Composition precision ≥ 0.80** — of all `violates` bridges laid, fraction whose
     rule is a true citation for that snippet.
  4. **Control specificity ≥ 0.80** — ≥8/10 controls get ZERO `violates` bridges
     (out-of-chapter: also zero `satisfies`; compliant: `satisfies` allowed).
- **PASS iff all four hold.** A miss on any is a reportable FAIL — no tuning to pass.
- **Report ALL cells** — every k, micro + macro, per-rule recall, full per-cell verdict
  table, all reasoning excerpts. No cherry-picking.

## 5. Mandatory disclosures (context, not pass conditions)

- **Lexical baseline (doc rule 36):** token-Jaccard + BM25 recall@k with the embedding
  removed, both to quantify how much prefilter recall is lexical (doc 11/14 found the
  MISRA-vocabulary lift is largely lexical).
- **OQ1 miss classification:** for every prefilter recall MISS, classify implicit-
  behaviour (violation hidden in library/type usage, never surface-named) vs other.
  Reports what fraction of the residual is the OQ1 class — feeds the separate implicit-
  behaviour tranche (NOT mixed into this floor).
- **OQ3 collapse:** on the multi-rule snippets, per-rule recall — did the adjudicator
  confirm ALL true rules or collapse near-duplicates to one (the n=4 smoke saw
  Q2→R22.8 dropped)?
- **Which leg earns/loses:** for every composition-recall miss, attribute it to the
  prefilter (true rule never in top-3) vs the adjudicator (surfaced but stamped
  not_applicable). Recall is graph-mediated in the full design; here it is embedding-
  only (the weakest leg, doc 09 §1).
- **Flat corpus:** `corpus-ingest` stores the Haiku-AUTHORED description, not raw C++,
  and a flat corpus has no facts/memories — so the adjudicator judges the description +
  its read tools. This is the built system's behaviour on a flat corpus; state it.

## 6. Adversary (pre-committed, before any claim)

A blind hostile subagent, given the frozen corpus + harness + results:
1. **Leakage battery:** did the code-authoring Haiku leak a rule id / standard name /
   paraphrase into any of the 50 descriptions (circular match)? Per-item token overlap
   with the true rule vs other rules; `detectRuleReferences` scan.
2. **Keyword-triviality:** are the "clear violations" so keyword-loaded (`delete[]`,
   `weak_ptr`, `new`) that recall is lexical trivia, not semantic? Re-derive with the
   embedding removed; state which leg the recall lives on.
3. **Precision-for-the-right-reason:** sample confirmed `violates` bridges — is the
   reasoning grounded in what the code DOES, or in surface name-match? A right-verdict-
   wrong-reason bridge does not count as real precision.
4. **Collapse / per-rule honesty (OQ3):** count dropped true rules on multi-rule cases.
5. **Base-rate / floor honesty:** confirm the doc does not creep from "clean floor" to a
   field claim; the corpus is ~44% violations by construction — NOT field prevalence
   (~2–14%, doc 09 §18–21). Flag any laundering (the 8th such check on this family).

## 7. Pre-committed caveats — what a pass/fail does and does NOT license

- **Curated clean FLOOR:** my rule restatements (not authoritative MISRA), constructed
  clear violations, flat corpus (description-judged), single-sample adjudication, no
  powered CI. Absolute magnitudes do NOT transfer to field code.
- **A PASS licenses:** "the built composition runs end-to-end and, on a curated clean-
  violation floor, surfaces + confirms clear Ch.22 violations at the measured rate and
  rejects controls at the measured rate." It is the FLOOR the architecture must clear to
  be worth a field test.
- **Does NOT license:** any field-prevalence precision/recall number, an implicit-
  behaviour recall claim (OQ1 — deliberately excluded, separate tranche), an
  authoritative-MISRA-text claim, a graph-mediated-recall claim (this is embedding-only),
  per-rule completeness if collapse is observed, or autonomous-auditor adoption. The
  disposition remains human-in-the-loop assist (doc 09 §27) until a field run.
- **A FAIL is a legitimate, reportable outcome.** If the prefilter floors recall (doc 14
  precedent) or the adjudicator over-flags the controls, report it and its cause. No
  tuning to pass.

---

# RESULTS (post-run — appended after §1–7 are frozen + committed)

_(pending)_
