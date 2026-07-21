# Doc 20 — Concept-JOIN recall gate: pre-registration

**Bead:** nmemo-uhp.24 · **Status:** PRE-REGISTRATION (committed before any number) · **Date:** 2026-07-20
**Discipline:** [[verify-empirical-gates]] — this is the 16th empirical run on this feature family; the
prior 15 produced 10+ launder-catches in *both* directions. Every rule cited below (R#) is from that
memory. Nothing in §6–§9 may change after the first number is computed (R1: no HARKing).

---

## 1. The exact question

> On a leak-controlled corpus with an **external** (concept-independent) code↔rule oracle, does
> **concept-JOIN recall** (route code→rule through an independently-extracted shared concept node)
> beat **both** baselines — cosine-kNN over embeddings **and** BM25 over raw text — and does its
> advantage appear specifically on the **sub-lexical slice** (true pairs that share no surface
> tokens)?

The sub-lexical clause is the whole point. Where code and rule share surface tokens, BM25 already
wins for free (R36: if pure surface overlap reproduces the result, the vector/concept layer earned
nothing). The concept layer can *only* justify itself where the two sides use **different
vocabulary** for the same mechanism (`std::vector` in code vs "dynamic memory" in the rule) yet an
independent extractor maps both to `heap-allocation`. That is the architecture's core bet (doc-18/19).

## 2. What this gate does NOT test (scope fences, R8/R11)

- **NOT** LLM judgment / adjudication quality. That is the retired E1 question (doc 09 §27); this is
  a *recall-substrate* measurement, exactly as doc-19 §7 scopes it.
- **NOT** field prevalence. Every number here is a constructed-floor recall number. The real-code
  field-prevalence run remains separately owed (doc-19 §7; the E1 standing item).
- **NOT** "the LLM understands concepts." Convergence via a shared extraction model is a
  shared-prior effect (R33), not comprehension. The licensed claim is narrow: *does routing through
  a shared-model-imposed vocabulary improve cross-corpus recall over direct text matching.*

## 3. Corpus (reused, external oracle, predates the concept layer)

The **doc-10 recall-gate corpus** (`recall-gate-artifacts/`), verbatim:

- **29 code elements** (`gate_code_raw.json`), each with raw C++ `code` and a `trueGuideline` label
  derived from a **clang-tidy / CppCoreGuidelines external oracle** (doc-10 §build_corpus).
- **27 rules** (`gate_rules.json`): id + guideline text. **9 distinct guidelines** have ≥1 true code
  match; the other 18 are distractors present in the candidate set.
- Ground truth = `trueGuideline` per code element. It was produced for the *embedding* recall gate
  months before the concept layer existed, so it **cannot** have been constructed to favour concepts
  (kills the recurring corpus-construction leak, R44/R46).

**Why this corpus:** external oracle, concept-independent labels, an already-established recall@k
convention, and known cosine numbers to sit the new arm beside. **Its limitation (stated as loudly
as any result, R25/R39):** n=29 elements over 9 guidelines → the macro quantum is 1/9 = 0.111; a
one-guideline swing is a singleton. Bars in §6 are set against that quantum, and §8 mandates
bootstrap CIs. If the CIs are uninformative, the honest verdict is "underpowered," not a pass.

## 4. The three arms (all over the SAME raw inputs — apples to apples)

Every arm receives the identical raw text: the code element's raw C++, and each rule's raw guideline
text. No arm gets an authored/enriched description (that would confound concept-mediation with the
doc-10/13 authoring lift — a separate, already-studied effect).

1. **Concept-JOIN (system under test).** Run the *built, shipped* pipeline:
   `extractAndLinkConcepts` on each code element (**side='code', blind: raw code only**) and each
   rule (**side='rule', blind: guideline text only**) → `resolveConcepts` (lexical/trigram + judge)
   → `recallByConcept(codeElement)` returns rules ranked by shared-concept count. recall@k against
   `trueGuideline`.
2. **Cosine-kNN baseline.** Embed the same raw code and raw rule text via the production embed path
   into `element_embeddings`; `recallAcrossCorpus` ranks rules by cosine. recall@k. (This is the
   "direct embedding of the same input" the concept layer must beat.)
3. **BM25 baseline (R37: real IDF retriever, never raw Jaccard).** The committed textbook BM25 in
   `src/test/tools/recall-hybrid.ts` (k1=1.2, b=0.75) over raw code (query) vs raw rule text (docs).
   recall@k.

**Bar is the BETTER of the two baselines (R42/R47):** the JOIN must beat `max(cosine, BM25)` — not a
convenient loser. Pitting it only against whichever baseline it happens to beat is a strawman.

## 5. Anti-leak controls (each maps to a prior catch)

- **Blindness per side (R41/R48).** Code extractor sees only code; rule extractor sees only rule
  text. Neither sees the other side, the candidate set, or the oracle. The shipped prompt already
  forbids rule vocabulary (code side: no "MISRA/CERT/AUTOSAR"/rule-ids; rule side: "solely on the
  guideline text"). **The adversary must verify this on the actual extracted concept names, not
  trust the prompt** — if code-side concept names echo rule vocabulary, the JOIN win is an authoring
  leak (as in docs 15/16/17).
- **External, concept-independent oracle (R6/R31).** `trueGuideline` from clang-tidy, fixed before
  concepts existed; not derivable from the extracted concepts.
- **No concept planting (R43).** Concepts are *extracted live*, never hand-seeded to match. A run
  where I plant the bridges would score ≈1.0 by construction and measure nothing.
- **Plumbing invariant, n-in == n-out (R40).** Assert 29 code entities and 27 rule entities exist
  post-ingest with **no name-fusion** (the exact bug that inflated the doc-14 gate). Verified and
  printed before any recall number.
- **Persist everything (R15).** Corpus snapshot, every extracted concept + bridge, all three arms'
  ranked outputs, the scorer, and the sealed `trueGuideline` key → committed under
  `concept-join-artifacts/` so the run is independently re-scorable.

## 6. Primary metric and the bar (frozen — R1)

- **Primary metric:** **macro** recall@5 (per-guideline mean, the de-biased lens; R35 — one lens
  across primary and all decompositions), over the 9 guidelines with true matches.
- **Primary bar (all three must hold):**
  1. `JOIN_macro@5 − max(cosine, BM25)_macro@5 ≥ +0.15` (≈ 2 guideline-quanta over the better
     baseline — larger than one-singleton noise, R39).
  2. `JOIN_macro@k ≥ max(cosine, BM25)_macro@k` for **every** k ∈ {1,3,5,8} (monotone dominance, no
     cherry-picked k; mirrors the doc-10 bar form).
  3. **Sub-lexical slice:** on true (code,rule) pairs with BM25 score ≈ 0 (no shared non-stopword
     token; threshold frozen in §7), `JOIN` recall > `cosine` recall AND > `BM25` recall. If the
     JOIN's entire advantage sits on lexically-shared pairs, it earned nothing beyond BM25 (R36) →
     **FAIL** regardless of aggregate.
- **Secondary (reported, not gating):** micro recall@k for all arms; extraction quality (concepts/
  element, bridges/element, resolution merges); per-guideline table.

## 7. Frozen operational definitions (no post-hoc tuning — R26)

- **k set:** {1,3,5,8} (doc-10 convention). Primary k = 5.
- **Ranking ties:** every arm breaks ties **against** the true rule (conservative; the doc-10/15
  discipline). For the JOIN, ties in shared-concept count → break by ascending rule id (deterministic,
  oracle-blind).
- **BM25 params:** k1=1.2, b=0.75, untuned (R37). Tokenizer = the harness's existing one; no
  stopword/stemmer changes after seeing results.
- **Sub-lexical threshold:** a true pair is "sub-lexical" iff BM25(code, trueRule) = 0 under the
  frozen tokenizer (i.e. zero shared non-stopword terms). Computed and the slice membership frozen
  **before** looking at JOIN/cosine performance on it.
- **Extraction/resolution:** the shipped services at HEAD, Haiku, default prompts, unmodified. If a
  bug is found mid-run, it is *fixed in implementation and the whole run re-executed* — the
  definition is never swapped (R26).

## 8. Statistics (R25/R30/R33/R39)

- **Paired bootstrap** (resample the 9 guidelines, 10k iterations) for every arm-vs-arm macro@5
  difference; report the point estimate **and** the 95% CI. A difference whose CI includes 0 is a
  tie, reported as such — including if it's the JOIN "winning."
- **Report the quantum** (1/9 = 0.111) beside every macro delta; flag any delta < 2 quanta as
  singleton-fragile.
- **Effective-n note:** all extraction is one model (Haiku) → convergence is a shared-prior effect,
  not independent agreement (R33). State this in the verdict; do not narrate convergence as
  "understanding."
- **Both directions (R29):** the adversary is tasked equally hard whether the result flatters the
  concept layer or damns it. A FAIL is as launderable as a PASS (R7/R17 apply in the negative).

## 9. Pre-committed honest priors (so neither outcome is a surprise-to-be-rationalised)

- **Plausible FAIL path:** doc-18 established lexical resolution can't bridge distant synonyms. If
  the two independent extractors pick *different* vocabulary for the same mechanism and trigram
  resolution can't merge them, the JOIN **misses exactly the sub-lexical pairs** — the only slice
  where it could win. This is a real, expected way to fail, and it will be reported as a fail, not
  explained away.
- **Plausible PASS path:** a shared extraction model imposes a shared vocabulary, so both sides emit
  `heap-allocation` regardless of surface form; the JOIN then connects sub-lexical pairs BM25 cannot.
- **Plausible "hollow PASS":** the JOIN beats the aggregate but only on lexically-shared pairs (the
  §6.3 slice catches this → FAIL).

## 10. Blind-adversary protocol (R2, mandatory before any claim)

After the run, spawn a fresh subagent **not seeded with the verdict**, given: this pre-registration,
the committed artifacts (corpus, extracted concepts/bridges, all three arms' outputs, scorer, sealed
key), and the raw numbers. Tasked to break the claim, specifically to check:

1. **Authoring leak** — do code-side concept names echo rule vocabulary? Sample the actual names.
2. **Sub-lexical integrity** — are the "sub-lexical" true pairs genuinely token-disjoint, or did the
   tokenizer just miss shared stems?
3. **Baseline fairness** — is BM25 the real thing (R37)? Is the cosine arm on the same raw input?
   Was the *winning* baseline used as the bar (R47)?
4. **Plumbing** — n-in == n-out; no fusion (R40).
5. **Quantum/CI** — is any headline a one-guideline singleton (R39)? Do CIs exclude 0?
6. **Direction** — is the leg that "wins" answering the element→rule question actually asked (R4)?

The adversary's verdict is reported **even if it retracts the result** (R3), and the bead/docs/memory
are corrected immediately. Per R49, if the adversary's cut rests on an un-run measurement, that
measurement is run before concluding — the truth often lands between.

## 11. Deliverables of nmemo-uhp.24 (beyond this gate)

- (a) **e2e round-trip test** — ingest 2 corpora → extract+resolve → JOIN connects code↔rule. (The
  unit-level version already exists across the .21/.22/.23 suites; .24 adds the ingest-time wiring:
  the extraction call folded into the ingest path, currently standalone.)
- (b) **This gate**, run with adversary sign-off.
- (c) **Concept provenance in the audit scope** — concept-only candidate cells currently carry
  similarity=0; enrich the agent scope with the shared-concept reasoning (deferred from .23).

## 12. Disposition rule (decided now, before numbers — R32)

- **PASS** (all §6 bars + adversary clears): the concept-JOIN is a validated recall substrate *on
  this constructed floor* — licensed to replace cosine as load-bearing recall, with field prevalence
  still owed before any automation/coverage claim.
- **FAIL:** the concept layer stays **built and shipped** (it is a sound symbolic substrate for
  human-in-the-loop use and the audit-pass union is empty-safe), but it is **not** credited as
  beating direct retrieval; doc-18's "lean symbolic" stands as an engineering choice, not a measured
  recall win. Either outcome leaves the code in place; only the *claim* differs.

Both outcomes are acceptable dispositions. This is stated now precisely so that neither result
tempts a post-hoc bar (R32: "both outcomes → same decision" is only a launder when the discriminating
test is declared optional — here the test is mandatory and the outcomes differ in the *claim*, which
is the thing under test).

---

## 13. RESULT (2026-07-21) — GATE FAIL, adversary-confirmed SOUND

Run: `platform/src/test/tools/concept-join-recall.ts` (real Haiku extraction, provider=claude, on
`cognitive_test`). Artifacts frozen in `concept-join-artifacts/` (`cj-extracted.json`,
`cj-results.json`). Plumbing clean: 29/29 code + 27/27 rule entities, no fusion (R40).

**Macro recall@k (primary):**

| arm | @1 | @3 | @5 | @8 |
|-----|----|----|----|----|
| JOIN | 0.237 | 0.256 | 0.256 | 0.256 |
| cosine | 0.259 | 0.337 | **0.467** | 0.626 |
| BM25 | 0.156 | 0.248 | 0.433 | 0.548 |

- **cond1 FAIL:** JOIN − max(cos,bm25) macro@5 = **−0.211** (bar was +0.15). Wrong direction.
- **cond2 FAIL:** JOIN below the better baseline at every k.
- **cond3 FAIL (decisive):** sub-lexical slice (n=14) — cosine 0.429 **beat** JOIN 0.214. The concept
  layer lost exactly where it was supposed to win (BM25 = 0 there by construction).

**Root cause (the pre-registered §9 FAIL path, not a scoring artifact):** only **8 of 29** code
elements ever get their true rule connected by a shared concept node. Two independent Haiku passes
pick different abstraction levels for the same mechanism (code `reinterpret-cast` vs rule
`unsafe-cast`; code `constexpr-constant`/`floating-point-literal` vs rule `magic-constant`), and
lexical resolution can't bridge them. Resolution merged 5/37 pairs — all correct lexical variants;
even a *perfect* resolver ceilings the JOIN at **0.444 < cosine 0.467**. Convergence, not resolution
or ranking, is the bottleneck.

**Blind adversary verdict: FAIL SOUND**, with one correction it forced on me (a FAIL-direction
overstatement — R7/R17/R29). My first report used a bootstrap CI computed against the per-element
`max(cos,bm25)` union, harsher than the pre-registered §8 arm-vs-arm difference, and I called the
loss "significant." The honest §8 arm-vs-arm CIs:

- **JOIN − cosine macro@5: mean −0.214, 95% CI [−0.537, +0.100] — includes 0**
- **JOIN − BM25 macro@5: mean −0.178, 95% CI [−0.463, +0.081] — includes 0**

So at n=9 the JOIN is a **statistical tie** with cosine (point estimate below, underpowered), **not**
significantly worse. The harness was corrected to report arm-vs-arm CIs. Adversary checks: tie-break
cost the JOIN 0 hits@5; no recall/bridge bug (97 exhibits + 51 addresses edges verified); cosine win
real and concentrated on multi-element buckets (not the 4 singletons); embeddings ran *unprefixed*
(if anything an under-powered cosine); sub-lexical membership verified exact.

**What this licenses (§12 FAIL branch):** on this constructed floor the concept-JOIN does **not** beat
direct cosine/BM25 recall and **loses on the sub-lexical slice** that justified it. The concept layer
stays built + shipped as a symbolic, explainable substrate (the audit-pass union is empty-safe), but
is **NOT** credited as a recall win. doc-18's "lean symbolic" survives as an *engineering* choice,
not a measured recall advantage.

**What it does NOT license:** (a) NOT "concept layer worthless" — where the sides converge on a term
it is high-precision and traceable (ES.42: JOIN 0.80 vs cosine 0.20); it's a precision/explainability
substrate, not a recall lever. (b) NOT "significantly worse than cosine" — the honest CI includes 0
(n=9 underpowered). (c) NOT any field/prevalence claim — n=29 / 9 guidelines, constructed floor;
field-prevalence run still owed. (d) NOT "convergence is impossible" — a convergence-forcing extractor
could raise the ceiling, but even the generous 0.444 ceiling here still fails the bar, and that change
needs its own pre-registration + adversary.
