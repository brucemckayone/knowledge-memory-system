# E1 Proxy Test — Does Deterministic Structure Lift LLM Recall?

**Status:** Test design, pre-run. Supersedes the framing of the E1 gate as originally written (`nmemo-uhp.6`). Companion to `00-design-space.md` (Part I.6 recall pipeline, Part VII #3 the embedding bet), `03-detailed-plan.md` (Part E the empirical gate), and `05-preconditions.md` (Phase 0 substrate). Nothing here is built; this document defines what we run and how we read the result.

**One-line purpose:** measure, cheaply and before any Phase C tooling, whether an LLM given *deterministic code structure* recalls the governing coding rule better than embedding similarity alone — because that, not embedding recall, is the mechanism that actually ships.

---

## 1. Why the original E1 was mis-targeted

E1 was specified as: verbalize code behaviour, embed it, search against embedded rule text, require ≥0.65 recall@5 on ≥50 hand-labelled pairs. The 2026-07-08 spike measured **0.53** and the gate "failed."

The problem is not the 0.53. The problem is what was measured. Embedding search is **one instrument** the audit agent holds, alongside the symbolic construct-join, graph traversal, and the deterministic checker. Testing embedding-*alone* recall measured the weakest single tool in isolation and reported it as the system's ceiling. The recall mechanism that ships is an **LLM reasoning over deterministic structure**, of which embedding is a fallback leg — not the primary path.

The follow-on "cascade = 0.98" rehabilitation was also mis-stated: that number is dominated by decidable rules where the deterministic checker does the recall, which never needed embeddings. It is true but not load-bearing. We should not ratify anything on it.

## 2. The model this test is built on — three tiers, recall separated from adjudication

The design docs route "decidable → checker, undecidable → LLM," which fuses two different things. Pull them apart:

| Tier | Recall mechanism | Verdict mechanism | Example (C++ Core Guidelines) |
|---|---|---|---|
| **1** | deterministic (checker finds the site) | deterministic (checker decides) | anything with an enabled `cppcoreguidelines-*` / `bugprone-*` check |
| **2** | deterministic (a query enumerates candidate sites) | **LLM** | R.3 "a raw pointer is non-owning" → enumerate raw-pointer members; F.15 passing conventions → enumerate signatures |
| **3** | **semantic / LLM only** (nothing can enumerate candidates) | LLM | P.1 "express ideas directly in code"; P.3 "express intent"; ES.1 "prefer the standard library" |

E1 collapsed Tier 2 and Tier 3 into "undecidable → semantic" and measured 0.53 across the blend. **The lever this project pulls is moving rules from Tier 3 to Tier 2** by building deterministic candidate-generation — and every rule so moved is one whose recall stops depending on the weak embedding leg. This test asks whether that lever is real.

## 3. Corpus and the non-gameable boundary

**Standard:** the **C++ Core Guidelines**, evidenced as the standard Maverick actually targets — its `.clang-tidy` enables `cppcoreguidelines-*`, `bugprone-*`, `performance-*`, `readability-*`, `portability-*` with `WarningsAsErrors: '*'`, plus SonarQube CFamily (`sonar-project.properties`). CERT/MISRA-C++ overlap arrives via Sonar.

**Codebase:** `../maverick/ALPHA-2570-base-classes`, branch `dev` @ `b59d5d73` (clean checkout). Components: `alpha_conversion`, `alpha_replayer`, `lib_common`, `lib_positioning_engine`.

**The anti-rig property (the reason this proxy can be believed):** we do **not** restrict the rule sample to the guidelines clang-tidy implements — that would make the corpus all-Tier-1 and rig the outcome, the same error E1 made. Instead, **clang-tidy's coverage of the Core Guidelines *defines* the tier boundary**: a guideline clang-tidy/Sonar implements is Tier 1; one it does not is Tier 2 or Tier 3 depending on whether a deterministic query can enumerate candidates. That line is drawn by the LLVM project, not by us — so it cannot be drawn to flatter the result.

## 4. The sample — 12 pairs, weighted to the load-bearing tier

The bead's smoke bar is ~12 pairs (stop if <0.3). Composition **2 / 6 / 4** across Tier 1 / Tier 2 / Tier 3 — weighted to Tier 2 because that is where the thesis lives.

- Each pair = (a concrete code element in the checkout, the Core Guideline that governs it), hand-labelled from real code.
- Labels are **sealed before** any candidate-gen is written, and held out purely as the scoring oracle.
- Tier 1 pairs are a sanity check (deterministic recall must be ~perfect). Tier 3 pairs **characterize the floor**, not pass/fail.

**Anti-confirmation guard (the linchpin):** candidate-generation queries must be **rule-level and codebase-agnostic in form** — e.g. the R.3 generator is "enumerate every raw-pointer member in the codebase," never "find *this* element." Recall = did the labelled element fall out of the generic query. A rule-shaped query cannot cheat toward the answer key, and this is also exactly how a real checker runs (rule-level, not pair-level). The guard and the fidelity requirement are the same rule.

## 5. Conditions (method (b) — cheap)

All three run on the same 12 pairs; recall@5 = the labelled guideline is in the model's top-5 for that element.

- **A — embedding-alone, prefix-fixed.** Redo E1 honestly, using nomic-embed-text's asymmetric `search_query:` / `search_document:` prefixes (00 V.3 flags this as untested; the memories test moved 0.38→0.75 partly on this). If A comes out materially above 0.53, part of the "crisis" was a measurement bug. **Run this leg first** — it is ~30 minutes, independent of everything else, and reframes the rest.
- **B — deterministic structure + LLM.** The LLM (Haiku-first) is handed the deterministic structure for the sampled element (Tier-1 checker diagnostic; Tier-2 candidate-gen query output; Tier-3 nothing) and asked which guidelines govern it.
- **C — both (real cascade).** Optional; run only if A and B do not already separate cleanly.

**Cheap-method commitments (per the (b) decision):**
- Tiers are classified from clang-tidy's *documented* check↔guideline mapping — **no CMake/Conan build**.
- The deterministic structure is constructed for **only the 12 sampled elements**, by targeted query (tree-sitter / grep / single-file AST) — enough to test the lift without standing up the toolchain. A full live clang-tidy run is what Phase C does; it stays available only if (b)'s result is ambiguous.
- The LLM leg uses a **direct Haiku call**, not the production ml-services/`claude -p` path.
- Throwaway scripts live outside the repo tree (scratch dir); nothing is committed except the recorded numbers.

**Prerequisites:** Ollama `:11434` (nomic-embed-text) for leg A; Haiku API access for legs B/C. Neither the platform nor ml-services need to be up.

## 6. Go / no-go — PROPOSED, to ratify

This replaces "blended embedding ≥0.65." Thresholds below are drafts for sign-off.

- **Sanity (Tier 1):** recall@5 under B ≈ 1.0. If the checker-backed tier does not recall, the integration or labelling is broken — fix before reading anything else.
- **The lever (Tier 2, the decision):** **PASS if Tier-2 recall@5 under B ≥ 0.75 AND (B − A) ≥ 0.25 on Tier 2.** This is the finding that says deterministic structure materially lifts LLM recall over embedding — i.e. the lever is real.
- **Floor (Tier 3):** report recall@5 under A (prefix-fixed embedding). This number — *not* the mis-targeted 0.53 blend — is the honest embedding-recall figure that stands as the recorded risk for oracle-less domains (research/fiction/learning). No pass/fail; a measurement.
- **Hard stop (per bead):** if the best condition across the smoke is <0.3, stop the E1 line entirely and reconsider the premise.

**What a PASS buys:** grounds the user's reserved ratification — accept **deterministic-first for code v1**, on the honest basis that the undecidable rules are a *contained minority with two backstops* (category-routing + mandatory human review in iteration one), so weak embedding recall degrades cost/automation on that minority, not correctness. The embedding weakness is recorded as a **Phase-C / general-domain risk**, quantified by the Tier-3 number from leg A. It then licenses the full ≥50-pair E1 run as the actual gate before committing to Phase C external tooling.

**What an ambiguous/near result buys:** if B ≈ A on Tier 2, the deterministic structure is *not* lifting recall as hoped. That points at the legibility sub-lever (how structure is surfaced to the LLM, not how much of it exists) or, worst case, at the code-v1 premise itself. Cheaper to learn now than after Phase C.

## 7. Downstream decision this feeds

Demoting embeddings from "primary recall path" to "Tier-3-only fallback" directly shapes **Q2** (03 Part A1 / open-questions register): the embedding substrate leans toward *bare `code_elements` catalog rows + a small `behaviour_summaries` embedded table scoped to the Tier-3 residue*, rather than embedding every element. That schema choice is irreversible once Phase A data lands, which is why fixing the recall framing now pays off immediately.

## 8. Honest limits

- 12 pairs is a **smoke**, not the ≥50-pair ship sample. It gives direction, not a shippable recall figure.
- "Blind" is enforced by the **rule-level query form**, not by procedural amnesia — that is the real guard, but it is one person building and scoring, so treat the result as directional.
- One codebase, one domain (code). The whole point of the reframe is that code is the *easy* domain (it has an oracle); the Tier-3 floor number is the only leg that speaks to the hard domains, and only weakly.
- Tier-3 recall is **characterized, not solved**. Guidelines like P.1/P.3 remain LLM+human-review territory by design.

## 9. Run order

1. Seal the 12 labelled pairs (2/6/4), from real elements in the `dev` checkout.
2. Leg A — prefix-fixed embedding baseline (Ollama). Record per-tier recall@5.
3. Build rule-level candidate-gen for the Tier-1 and Tier-2 guidelines in the sample (codebase-agnostic form).
4. Leg B — Haiku over the deterministic structure. Record per-tier recall@5.
5. Leg C only if A/B do not separate.
6. Score against §6; write the numbers into `nmemo-uhp.6` and a results section here; bring the go/no-go to the user for ratification.

---

## 10. Results & revised understanding (2026-07-10)

Running the smoke surfaced two refinements that changed the framing in §2/§5/§6. Where this section conflicts with those, **this section governs** — the earlier text is kept as the design-evolution record.

**Refinement 1 — recall ≠ adjudication, and the AI *drives* recall rather than being a recall path.** For any rule with a deterministic enumerator, retrieval recall is ~1.0 by construction — so the ratified "Tier-2: ≥0.75 recall and B−A≥0.25" was measuring ~1.0 against ~0.5: trivially true, low information. The real unknowns are (a) **coverage** — what share of the standard has a cheap enumerator — and (b) the **floor** — recall on the un-enumerable residue. And the AI is not a fourth recall mechanism: it is an **agent that drives the mechanical ones** (authors queries, chains them, backtracks, synthesises new nets on the fly) and is the **local adjudicator** — the graph assembles the bounded, relevant context per candidate so it never reads the whole codebase. Recall at scale is always mechanical; the AI is the intelligence steering it.

**Refinement 2 — Tier 3 is a spectrum by structural shadow, with a hollow-net trap.** Pure-judgment rules are not uniformly hopeless: recall is bounded by how much structural shadow the property casts, which an agent can exploit by authoring nets. Caution discovered: a net can look precise (few, tidy hits) yet be **semantically hollow** — measuring a coincidental pattern, not the rule. **Net precision ≠ net validity**; the system must verify a net actually correlates with the rule.

**The three legs** (12 pairs · C++ Core Guidelines · maverick `ALPHA-2570` @ `dev` · 55-rule pool):

- **Leg A — embedding baseline (honest):** overall recall@5 **0.50** (Tier 1 1.00, Tier 2 0.67, Tier 3 **0.00**). Prefixed == unprefixed → the original 0.53 was **not** a missing-prefix artifact; the weakness is real. Tier-2 misses: C.131 (governing rule ranked **46th**) and C.132 (20th).
- **Leg B — mechanical nets (Tier 1∪2):** rule-level queries recover **all 8** structure-backed elements with high precision, and specifically recover the two embedding missed — `return m_x;` surfaces the C.131 getter (`GeodeticCoordinates.hpp:58`) in a 38-getter set; `virtual` surfaces C.132 (`ThreadBase.hpp:178`); a raw-pointer-member net surfaces R.3 (`m_stateKeySets`) as a near-singleton; index-loop / out-param / static-member / struct-no-init nets recover ES.71 / F.21 / C.4 / C.48.
- **Agent hunt (Tier 3, agent authoring blind rule-level nets):** recovered **3/4** vs embedding's 0/4. ES.1 (index-loop net → `Uuid.cpp:105` in a ~17-loop set) and P.11 (shift-both-directions net → `EntropyCollector.cpp:59` in a 2-line set) = strong shadow, sweepable. P.3 (short-name net) = lossy — target caught but buried among ~15 mostly-fine short names. P.1 = shadow effectively absent; the authored net was **hollow** (long-arithmetic ≠ indirect idea).

**Decision — the gate is answered for code v1.** "Can the system find the right rule for a code element?" → **yes**, via mechanical enumeration (the bulk) + agent-authored nets over structural shadow (most judgment rules). The weak embedding path was never the shipping mechanism. Deterministic-first is validated for code; Phase A (hand-seeded schema) is unblocked.

**Recorded residual risks (carried forward — not Phase-A blockers):**
1. **Signal-free judgment rules** (P.1-like) have no scalable net → opportunistic coverage + human review only; do not claim systematic coverage of them.
2. **Hollow-net trap** — agent-authored nets need a validity check (does the net track the rule, or return a tidy coincidence?).
3. **General-domain viability is shadow-dependent** — the agent+net approach transfers to oracle-less domains only to the degree the target relations leave structural traces; where they don't, recall collapses. This is the sharpened form of the old "embeddings are weak" risk.

**Still owed at the Phase-C gate (not Phase A):** the full ≥50-pair run; SCIP-symbol stability (Q13); a coverage classification over the full rule list (fraction enumerable vs shadow-only vs signal-free).

---

## 11. Independent verification — VERDICT RETRACTED (2026-07-10)

§10 was single-author (designed, labelled, netted, and scored by one party). Two independent checks were run, neither seeded with the conclusion. **§10's verdict is retracted as OVERCLAIMED** — it stands only as the (flawed) reasoning trail; this section governs.

**Adversarial review — three hits that break it:**
1. **Direction conflation.** The gate asks *element→rule* (given code, which rule governs?). Only the embedding leg tested that → **0.50 / 0.00**. The "winning" legs (nets 8/8, hunt 3/4) tested *rule→sites* (given a rule, find code), which is ~1.0 **by construction** — the sweep's direction, not the gate's, and near-definitional. The headline compared two different tasks.
2. **Adjudication untested.** "Find the right rule" = picking from the enumerated set. Codebase-wide the nets return low-precision bags (**86 getters, 141 index-loops, 38 virtuals; ~1–3% precision** — §10's "high precision" and scoped counts were wrong), and the index-loop net cannot even distinguish ES.1 from ES.71. Choosing/deciding was never measured.
3. **HARKing.** The pre-registered §6 bar (Tier-2 ≥0.75 & B−A≥0.25) was discarded after seeing results and replaced with an un-quantified basis — no new falsifiable gate.

Supporting: jurisdiction-not-violation labels (several targets *comply* — justified pure-virtual, documented non-owning pointer, already-encapsulated rotate); hollow-net skepticism applied only to the failure (P.1), not the wins (P.11's net is a reverse-engineered rotate fingerprint); single author throughout.

**Independent coverage classification (blind, n=86 all sections):**

| Tier | Count | % |
|---|---|---|
| T1 — enabled checker recalls AND decides | 38 | 44% |
| T2 — mechanically enumerable, verdict needs judgment | 31 | 36% |
| T3 — signal-free (needs semantic reading) | 17 | 20% |
| **T1∪T2 — mechanically enumerable** | **69** | **80%** |

It independently reproduced the hollow-net discipline (held F.2/NL.5/R.1 at T3 despite tempting proxies) and confirmed a real ~20% signal-free tail (P/Per/T/A/NR + "express intent"). **Caveat:** this is a *rule→sites enumerability* number — the direction the adversary flags as easy/definitional; it does **not** measure precision or adjudication.

**Corrected position (what we actually know):**
- ~44% of rules: an enabled checker does the whole job (recall + verdict). Solid — "run the linter you already run."
- ~36%: mechanically enumerable but the verdict needs judgment — **adjudication + precision are untested.** This is the real open question, not recall.
- ~20%: signal-free — the honest hard floor.
- Embeddings *alone* are weak for element→rule (0.50/0.00) — survives, though pool/summary-sensitive.
- "The system can find the right rule for code" is **unsupported.** Gate reopened (`nmemo-uhp.6`); Phase A re-blocked.

**The real gate to build (pre-registered, falsifiable, independent):** given a code site, does the system emit the **correct governing rule and verdict** — scoring **precision, not just recall** — on a **randomly sampled** rule set including **compliant and irrelevant** cases, with labels/nets/scoring authored by **different parties** than the test author. Until that passes: deterministic-first is *promising on enumeration (44% fully automated, 80% enumerable)* but *unproven on adjudication*.

---

## 12. The real E1 gate — PRE-REGISTRATION (2026-07-13)

This section is written **before any result exists**, and the thresholds in §12.5 are fixed here. If a result later makes a threshold look wrong, the honest move is to record that and set a *new* pre-registered bar — never to quietly move this one (that was retraction hit #3). This supersedes §6's proposed bar, which §11 correctly killed.

### 12.1 The question, stated so it can only be read one way

Given a **code element** (a declaration or statement region at a real `file:line`), does the system emit the **correct governing C++ Core Guideline AND the correct verdict** (violation / compliant / not-applicable)? Scored by **precision and recall**, on a sample that **includes negatives** (compliant and irrelevant elements), so that over-flagging is punished.

Direction is fixed: **element → rule**. The retracted smoke's "winning" legs measured rule → sites (given a rule, sweep for code), which is ~1.0 by construction. That direction is banned from this gate. Every scored item starts from a code element and asks what governs it.

### 12.2 Why this can be believed — the oracle is nobody in this room

The labels come from **clang-tidy-18** (LLVM's implementation of the Core Guidelines), captured as real diagnostics on the Maverick tree at `../maverick/clang-tidy-coverage/doc/tidy-logs/{conv,rep}-test.log`. The oracle is not me, not the system under test, not the scorer. That independence is the whole point — it is what the single-author smoke lacked.

**Honest limits of this oracle, recorded up front:**
- The tidy run had an incomplete compile environment (`catch2/…` headers not found → `clang-diagnostic-error`), which caused `TEST_CASE` macros to be parsed as global variables. That floods `readability-identifier-naming` and `cppcoreguidelines-avoid-non-const-global-variables` with **artifacts**. Those two checks, plus `misc-include-cleaner`, `readability-identifier-length`, `bugprone-reserved-identifier`, and anything co-tagged `clang-diagnostic-error`, are **excluded** — this exclusion is pre-registered here, on "is it a compile-env artifact?" grounds, not on where the hits land.
- The oracle only covers **checkable** guidelines. So this gate proves adjudication competence on the *checkable slice*, where truth is knowable. It does **not** directly prove adjudication on the non-checkable T2/T3 rules — that is Leg 2 (§12.7), and until Leg 2 runs, T2/T3 adjudication stays *inferred from the checkable slice*, not demonstrated.

### 12.3 Pre-registered check whitelist → guideline map

Only these checks (all structural, none artifact-prone) are in-scope as oracle positives. The map is fixed before scoring:

| clang-tidy check | Core Guideline | ~real sites |
|---|---|---|
| `cppcoreguidelines-pro-type-member-init` | C.48 / Type.6 (initialize members) | 8 |
| `readability-convert-member-functions-to-static` | C.4 (member only if it needs the object) | 5 |
| `cppcoreguidelines-avoid-const-or-ref-data-members` | C.12 (no const/ref data members) | 5 |
| `cppcoreguidelines-avoid-c-arrays` | SL.con / bounds (avoid C arrays) | 2 |
| `cppcoreguidelines-avoid-do-while` | ES.75 (avoid do-while) | 2 |
| `bugprone-implicit-widening-of-multiplication-result` | ES.46 / arithmetic | 3 |
| `cppcoreguidelines-pro-bounds-pointer-arithmetic` | ES.42 / bounds | 2 |
| `cppcoreguidelines-pro-type-reinterpret-cast` | Type.1 / ES.48 (no reinterpret_cast) | 1 |
| `cppcoreguidelines-macro-usage` | ES.30 / Macro (don't use macros) | 3 |
| `modernize-use-using` | (modernize; typedef → using) | 19 |

### 12.4 The sample (mechanical, no cherry-picking)

- **Positives:** every deduped `file:line` site of a whitelisted check (~50). Each carries ground truth `(guideline, verdict = violation)`.
- **Compliant/irrelevant negatives:** functions and declarations drawn from the **same source files** that no whitelisted check flagged, selected by a fixed deterministic rule (sorted-path enumeration, fixed stride — no hand-picking). Target a **~50/50 positive/negative split**, so precision is measurable and over-flagging costs.
- Each element is presented as a code window (the enclosing declaration ± context) extracted from the `clang-tidy-coverage` checkout the logs came from, so `file:line` fidelity holds. Snippets are verified against the diagnostic text before sealing.
- The answer key `element_id → {guideline, verdict}` is sealed separately from the prompts the system sees.

### 12.5 Metrics and the PRE-REGISTERED bar

Per element the system returns either `no finding` or `(guideline_id, verdict)`.

- **Recall** = of oracle positives, the fraction the system flags with the correct (or independently-adjudicated-equivalent) guideline.
- **Precision** = of the system's violation findings, the fraction that match an oracle positive at that element. Flagging a negative, or naming the wrong guideline on a positive, is a false positive.
- **Verdict accuracy** = 3-way (violation / compliant / not-applicable) agreement.

**PASS iff `precision ≥ 0.70` AND `recall ≥ 0.60`** on **≥ 40 elements** (mixed positives + negatives), guideline-equivalence adjudicated by an **independent scorer**.
**HARD FAIL if `precision < 0.50` or `recall < 0.40`.** Between the two is an ambiguous band → report, do not ratify.

Rationale (fixed here): 0.70 precision means fewer than one in three findings is a false alarm — tolerable under the iteration-1 human-review backstop; 0.60 recall means the majority of real issues surface. These are "good enough to build on with a human in the loop," explicitly **not** production numbers. This bar unblocks Phase A only; the full ≥50-pair ship gate stays downstream.

### 12.6 Independence roles (four distinct parties)

- **Oracle** — clang-tidy-18 (LLVM). Labels. Independent by construction.
- **Builder (me)** — parses the oracle, builds the sample mechanically, seals the key, fixes thresholds. Does **not** run the system or hand-label verdicts.
- **System under test** — fresh subagent(s), blind to the key, **forbidden from running clang-tidy** (the point is whether LLM recall+adjudication can stand in for the checker, not whether it can shell out to it). Given an element + the Core Guidelines, it must both recall the candidate rule and decide the verdict. Haiku-first.
- **Scorer** — fresh subagent, blind where feasible, adjudicates guideline-equivalence and computes the metrics; mechanical `file:line` matching backs it up.

### 12.7 Two legs

- **Leg 1 — clang-tidy oracle (this section, run now).** Real code, real independent labels, checkable slice. Strongest evidence; the primary result.
- **Leg 2 — planted violations (follow-on).** For the T2/T3 judgment rules clang-tidy does *not* implement, an independent planter injects known violations into clean production code and keeps the clean original as the compliant control — ground truth by construction, non-circular, extends the gate to the slice Leg 1 can't reach. Pre-registered separately before it runs. Not required to unblock Phase A; required before claiming adjudication works on judgment rules.

### 12.8 What each outcome buys

- **Leg 1 PASS:** the LLM adjudication mechanism reproduces an independent checker on real code with usable precision → the adjudication step is sound where we can grade it, and Phase A (deterministic-first, code v1) is unblocked, with T2/T3 adjudication still owed to Leg 2.
- **Leg 1 FAIL:** the adjudicator can't match a checker even where truth is clean and structural → deterministic-first's premise is in trouble; stop and rethink before Phase A, exactly as the retraction warned.

---

## 13. Leg 1 run — OUTCOME: VOID (2026-07-13)

Leg 1 was built and run per §12. **It is void as a test of the capability** — a harness defect, caught before any claim was recorded, means it measured the harness rather than the system. Reported here in full because the *way* it failed is the useful part.

### 13.1 What was run
- 41 elements sealed: 17 clang-tidy-labelled positives (C.48×7, C.4×5, C.12×5) + 24 compliant near-miss negatives, drawn from `clang-tidy-coverage` at `cec21393c`. 9 further diagnostics were dropped as un-relocatable after drift.
- System under test: Haiku, blind, adjudicating each element over the fixed 10-rule candidate set. No clang-tidy access.
- Raw score vs the clang-tidy labels: **precision 1.00, recall 0.35** (C.12 5/5, C.48 1/7, C.4 0/5, zero false positives on 24 negatives) → **HARD FAIL** on the pre-registered bar.

### 13.2 Why it is void (not a fail, not a pass)
The system was evaluated on a checkout that had **drifted from the commit clang-tidy judged**, and clang-tidy was **never re-run** on the tested checkout (no binary available). Subject and oracle saw *different code*, so the label↔code correspondence the whole design rests on was broken — by my own hand (unpinned commit).

This is **confirmed by non-LLM evidence**: the git history of the drifted files shows later commits titled *"Mechanical clang-tidy fixes in test files"*, *"Complex clang-tidy fixes: NOLINT suppressions, Rule-of-Five"*, *"Drop unnecessary NOLINT wraps"*. The diagnostics used as labels were **remediated after the logs were captured**; `cec21393c` is post-remediation. Directly observed drift agrees: the `do-while` sites are now `while`, the `Constants.hpp` C-array is gone, and the C.4 methods now use instance member `m_testData` (mechanically confirmed: `TestData m_testData;` is a non-static private member used under lock by all five) so they genuinely cannot be made static *at this commit*.

### 13.3 The trap I nearly fell into (and the adversary caught)
On seeing the fail, I reached for "the oracle was contaminated, so the misses aren't system errors" — audited the oracle **only** on the 11 misses that hurt the score, had an LLM adjudicator (blind) side with the system on all 11, and my own mechanical check confirm the C.4 half. That produced a tidy "corrected" precision/recall ≈ 1.00. **A hostile-adversary pass (independent, un-seeded) demolished it:**
- It is the **same HARKing sin as the retraction**, re-skinned: "move the bar after results" → "discredit the oracle after results." Asymmetric (the helpful cases — 5 C.12 hits, 24 negatives — were never adversarially audited).
- **"Symbol exists" ≠ "diagnostic still fires."** For the 11 disputed positives the true label *at the tested commit* is **unknown**, not "negative." Crediting the system for "correctly declining" them assumes the very thing never established.
- **Circularity:** two LLMs (Sonnet adjudicator + Haiku system) agreeing that clang-tidy erred is shared-prior correlation, not independent confirmation. Blindness controls allegiance bias, not shared-model error — and once my own reasoning entered as scorer, scorer-independence was gone too.
- **"Strong precision/specificity" is unbankable:** it rests on ~6 predictions, five of them one rule (C.12); a high-threshold under-caller *automatically* posts few false positives, so specificity and low recall are one conservative behaviour seen from two ends, not an independent virtue. n≈6 on essentially one rule fails §12.5's evaluability precondition outright.
- **Selective validity is the fraud:** declaring the run invalid where it fails and valid where it flatters. If the harness is broken it is broken for the whole run.

**Most defensible single statement:** *this run measured the harness, not the system; the only mechanically-established fact is that post-remediation code was scored against pre-remediation labels.* No capability claim — precision, recall, or specificity — survives.

### 13.4 Consequence and the valid paths forward
`nmemo-uhp.6` stays open; Phase A stays blocked. The gate is **unanswered**. The clang-tidy-log oracle is usable in principle but only with the label↔code correspondence restored. Options, feasibility-assessed:

- **Path A — pin the commit.** Check out the pre-remediation commit in `clang-tidy-coverage` so the code matches the existing log labels exactly (zero drift), then run the system there against the logs. Reuses a real non-LLM oracle without needing the binary. Caveat: inherits the C.48 interpretation question (pro-type-member-init flags class-type members; whether that is a genuine C.48/Type.6 violation must be pre-registered as in-or-out *before* running, not adjudicated after). Disrupts a Maverick working tree temporarily.
- **Path B — planted violations (ground truth by construction).** An independent planter injects known violations into clean production code, keeping the clean original as the compliant control. No linter, no drift, no adjudicator circularity. Must pre-register thresholds, candidate rule set, negative-hardness criterion, and exclusion rules *before* running, and plant a **balanced spread across all covered rules** — never let one rule (C.12) stand in for "recall."
- **Path C — fresh clang-tidy.** Install clang-tidy-18, run it on the current checkout, use its live output as the oracle. Strongest (real oracle, real code, current, zero drift), but requires the toolchain to be stood up.

The recall side of the capability remains **untested**; the drift defeated the attempt. This is iteration two of the same lesson: an oracle named in pre-registration may not be quietly overruled after results, and a single author needs the ground truth nailed *before* the subject is run — which is exactly what Path B guarantees and Paths A/C must be disciplined into.

---

## 14. Leg 2 — PRE-REGISTRATION: natural violations mined from `NOLINT` annotations (2026-07-13)

Written **before the harness runs**. Thresholds fixed here and not to be moved; if a threshold proves ill-posed, the run is declared void and a *new* bar is pre-registered — never silently pivoted. Chosen over re-running Leg 1 because it removes the two defects that voided Leg 1 (drift, and an oracle that could be disputed after the fact).

### 14.1 The corpus and why it is drift-free and non-circular
The Maverick tree carries human-authored `// NOLINTNEXTLINE(<check>)` suppressions: a developer marks that the **next line** trips clang-tidy check `<check>` and chooses to accept it. Each such site is a **natural, known-answer positive**: the code genuinely trips the named rule (that is *why* the suppression is there), the rule is named at the exact line by a **human**, and clang-tidy **agrees** (the suppression exists to silence it) — two non-LLM labels. It is **drift-free by construction**: a live `NOLINT` means a live violation (the "Drop unnecessary NOLINT wraps" commits removed the ones that no longer applied), so the annotated line and its label always correspond — the exact failure that voided Leg 1 cannot recur. Corpus = `../maverick/ALPHA-2570-base-classes` at its pinned `dev` commit (recorded in the harness).

### 14.2 Whitelist (fixed before scoring) → guideline map
In-scope checks (structural, Core-Guideline-mapped): `pro-type-reinterpret-cast`→Type.1, `pro-bounds-pointer-arithmetic`→ES.42, `macro-usage`→ES.30, `readability-magic-numbers`→ES.45, `readability-convert-member-functions-to-static`→C.4, `performance-unnecessary-value-param`→F.16, `pro-type-member-init`→C.48, `init-variables`→ES.20, `avoid-do-while`→ES.75, `avoid-const-or-ref-data-members`→C.12, `avoid-c-arrays`→SL.con.1. Excluded (not guidelines / naming / include-hygiene): `misc-include-cleaner`, `readability-identifier-*`. To stop any one check dominating, positives are **capped per rule** (≤ 6) so the sample stays spread across rules — never one rule standing in for "recall."

### 14.3 Sample, anti-cheat, negatives
- **Positives:** the line after each whitelisted `NOLINTNEXTLINE`, capped per rule. Truth = `(guideline, violation)`.
- **Anti-cheat (critical):** every `NOLINT*` comment is **stripped** from the code window shown to the system — otherwise the window literally contains the answer. No lint marker of any kind survives into the prompt.
- **Negatives:** same-file, same-kind lines with **no** `NOLINT` nearby that do not trip a whitelisted rule (e.g. a `static_cast` as a control for the reinterpret-cast positives; a named constant for magic-numbers; an index access for pointer-arith). Target ≈ 50/50.
- Answer key sealed separately from the prompts.

### 14.4 System, metrics, PRE-REGISTERED bar
- **System under test:** fresh Haiku subagents, blind, adjudicating each element over the whitelisted candidate rule set (element→rule). No linter access, no `NOLINT` visible.
- **Recall** = of positives, fraction the system flags with the correct (or independently-adjudicated-equivalent) guideline. **Precision** = of the system's violation findings, fraction matching a positive at that element.
- **PASS iff `precision ≥ 0.70` AND `recall ≥ 0.60`** on **≥ 40 elements**, equivalence adjudicated by an **independent scorer**. **HARD FAIL if `precision < 0.50` or `recall < 0.40`.** Between = ambiguous, report don't ratify. (Same bar as §12.5 — deliberately unchanged so it cannot be accused of tuning.)

### 14.5 Independence and the honest scope limit
- Labels = human `NOLINT` authors + clang-tidy (non-LLM, independent of builder/system/scorer). Builder (me) = mechanical extraction + strip + seal, no hand-labelling. System = blind Haiku. Scorer = mechanical `file:line`+rule match, backed by an independent subagent for rule-equivalence and for reviewing any system-flag on a negative (oracle-incompleteness guard).
- **Scope limit, stated up front:** `NOLINT` sites exist only for rules clang-tidy *checks*, so this leg — like Paths A/C — tests the **checkable slice**, executed cleanly and naturally across many rules. It is a strong *floor* ("can the model match human+linter judgment element→rule, with precision?"). It does **not** reach the T2/T3 judgment rules that have no checker — that crux still requires **Leg 3** (constructed/human-labelled plants across non-checkable rules; separate pre-registration; carries the synthetic-representativeness caveat that natural mining avoids here).
- **Discipline carried from §13:** a "corrected" result that flips fail→pass triggers the independent adversary, not celebration; the pre-registered oracle (here: human NOLINT + clang-tidy) is not disqualified post-hoc — if it is suspect the whole run is void, not selectively the failing cases.

---

## 15. Leg 2 run — RESULT: PASS on the checkable-slice floor (2026-07-13)

Ran per §14. **Verdict: PASS against the pre-registered bar, but scoped to what it actually tests — the linter-checkable floor, not the crux.** Unlike §13 this run is *not* void (threshold pre-registered and unmoved, corpus pinned, oracle non-LLM, drift-free, leak-checked) — but the bare word "PASS" would overclaim, so it is qualified below on the strength of an independent hostile review.

### 15.1 The numbers (raw, no post-hoc relabelling)
63 elements (29 natural NOLINT-mined positives, capped ≤6/rule + 34 compliant near-miss negatives), blind Haiku, element→rule over the candidate set. **Rule-level precision 0.93, recall 0.90** (TP 26, FP 2, FN 3, TN 33); verdict-level 0.96 / 0.93. Per-rule recall: Type.1 6/6, ES.42 5/5, F.16 2/2, ES.75 1/1, C.12 1/1, ES.30 6/6, ES.45 5/6, C.48 0/1, ES.20 0/1. This clears `precision ≥ 0.70 ∧ recall ≥ 0.60`. It clears even with every one of the 5 disagreements scored *against* the model.

### 15.2 What an independent adversary established it does and does not mean
- **The strongest real signal is specificity on near-misses.** The 34 negatives are matched controls (a `static_cast` for the reinterpret-cast positives, a named constant for the magic-number positives). A naïve keyword-matcher would false-positive on those; blind Haiku correctly declined 33/35. That is genuine discrimination, not token-spotting, and it is worth banking: **the adjudication plumbing produces high precision and does not over-flag compliant code that looks superficially like a violation.**
- **But recall is mostly keyword-spotting, not judgment.** ~24 of 29 positives carry the governing token on the line itself (`reinterpret_cast`, `#define`, `do`, a bare numeric literal, `ptr + offset`). Only ~5 (F.16 ×2, C.48, C.12, ES.20) require reasoning a matcher can't do — each at n=1, and that thin judgment slice is exactly where the misses/rule-naming wobble occurred. "Recall 0.90 across 9 rules" honestly reads as *≈5 token patterns recognised reliably, plus 5 judgment singletons*.
- **It tests only the checkable slice.** By construction NOLINT sites exist only for rules a linter checks — the part where "just run the linter" already works. The run is **silent on the no-checker T2/T3 judgment rules** that are the feature's actual value proposition.
- **Two disclosures against the result's favour.** (1) §14.3 pre-registered extraction from `NOLINTNEXTLINE`; the harness also (legitimately, and coded before results) harvested inline `// NOLINT(...)` — a doc/impl mismatch, recorded here. (2) **C.4** (`convert-member-functions-to-static`) is in the whitelist and is the one genuinely judgment-bound rule present in the tree, but its suppressions are `NOLINTBEGIN/END` regions the single-line extractor did not parse, so C.4 contributes **zero** positives. C.4 scored 0/5 in the void Leg 1; its absence here **flatters** the result. This is a mechanical gap, not a selection, but the effect is real and is disclosed.
- **Oracle discipline held numerically, and the prose is corrected to match.** An independent reviewer judged 2 of the 3 FN (a magic-literal and an inline-initialised var) to be non-violations and 1 model finding (E055) a genuine false positive. Per §14.5, the pre-registered oracle is **not** narrated as "pedantic where it cost us": the headline is the **raw** 0.93/0.90 and it stands there. The equivalence question (C.48 vs ES.20 on the one member-init) is noted, not used to inflate the number.

### 15.3 What it buys, honestly
- **Cleared:** the *necessary* floor — a blind, cheap model reproduces a real checker's rule+verdict at high precision and, importantly, does not over-flag matched compliant near-misses. The adjudication mechanism and its specificity are sound *where truth is knowable by a checker*. Legs 1–2's void/fail did not establish even this; now it is established.
- **Not cleared:** the *sufficient* condition — adjudication of rules with **no** deterministic checker (the T2/T3 judgment majority). Nothing here speaks to it. Recall on genuine-judgment items is n≈5.
- **Phase A stays gated.** This does not unblock Phase A on the crux. It de-risks the plumbing and clears the floor; the load-bearing claim is owed to **Leg 3** (no-checker judgment rules; ground truth by construction or human label; must include a judgment rule like C.4 that keyword-spotting can't shortcut, with a diverse, non-cloned positive set — not six copies of one idiom).

**Single most defensible claim from this run:** *on the linter-checkable slice, blind Haiku given a marker-stripped code element reproduces clang-tidy's rule+verdict at precision 0.93 / recall 0.90 and correctly declines matched compliant near-misses — so the adjudication mechanism and its specificity are sound where a checker already works; adjudication of no-checker judgment rules remains untested.*

---

## 16. Leg 3 — PRE-REGISTRATION: the crux — no-checker judgment rules by construction (2026-07-13)

Written **before the harness runs**; thresholds fixed here, not to be moved (same discipline as §12–15: ill-posed → void + new pre-registration, never a silent pivot). This is the leg Legs 1–2 could not reach: rules with **no deterministic checker**, where the verdict is genuine semantic judgment, not a visible token. There is by definition no linter oracle here — so ground truth must be **constructed** (known by how each example was built), which is the only non-circular option, at the cost of a representativeness caveat handled in §16.4.

### 16.1 The question (unchanged in spirit, now on the hard slice)
Given a code element, does blind Haiku emit the correct governing guideline and verdict — precision *and* recall, including compliant controls — for **judgment rules a linter cannot decide**? This is the feature's load-bearing claim (the T2/T3 majority).

### 16.2 Target rules (no clang-tidy checker; judgment, not keyword)
Chosen because each requires reasoning about *meaning*, not spotting a token, and none has a clang-tidy check that decides it:
- **R.3** — a raw pointer (`T*`) is non-owning (owning raw pointer = violation).
- **C.131** — avoid trivial getters/setters (a getter that only returns a member).
- **F.2** — a function should perform one logical operation (a function doing several = violation).
- **ES.1** — prefer the standard library to hand-crafted loops that reimplement an algorithm.
- **C.4** — a member function that uses no instance state should be static/free — **clean constructed cases only** (no `fmt::formatter`-style API-exception confound; the method plainly does or does not touch members).
- **C.35 / F.mutable** or one more, at the planter's discretion, to reach ≥ 5 rules with diverse sites.

### 16.3 Construction, independence, and anti-caricature (four distinct parties)
- **Planter (subagent, party 1):** produces, per rule, **matched pairs** — a *violating* example and a *compliant* twin — as realistic C++ in the Maverick GNSS/positioning idiom (grounded on real files for style; subtle, not caricatured). Seals which twin violates.
- **Validator (subagent, party 2, independent of planter):** for each pair confirms (a) the "violating" one genuinely violates the named rule per the actual guideline, (b) the "compliant" twin genuinely does not, (c) both are realistic (a competent dev could plausibly write them). Pairs failing any check are **dropped** — this is the guard against caricature and invalid plants.
- **System under test (subagent, party 3):** blind Haiku, adjudicates each element (violating and compliant twins interleaved, unlabelled) over the rule set. element→rule.
- **Scorer (party 4):** mechanical match to the sealed key + an independent subagent for rule-equivalence; plus an independent **hostile adversary** on the result (mandatory, per §13/§15 — a clean pass triggers the adversary, not celebration).
- **Builder (me):** orchestrates + pre-registers; does **not** author plants, labels, or scores.

### 16.4 Metrics and the PRE-REGISTERED bar
- **Recall** = of violating examples, fraction flagged with the correct (or adjudicated-equivalent) guideline. **Precision** = of the system's violation findings, fraction that are genuine (a compliant twin flagged = false positive). **Paired discrimination** = fraction of pairs where the system flags the violating twin and clears its compliant twin (the sharpest test — same rule, minimal contrast).
- **PASS iff `precision ≥ 0.70` AND `recall ≥ 0.60`** on **≥ 40 elements** (≥ 5 rules, ≥ 3 validated pairs each), rule-equivalence by an independent scorer. **HARD FAIL if `precision < 0.50` or `recall < 0.40`.** (Same bar as §12.5/§14.4 — unchanged so it cannot be accused of tuning.)
- **Honest caveat, stated up front:** constructed examples may be cleaner/more separable than violations occurring naturally in real code, which would make this *optimistic*. The validator's realism check and the paired-contrast design mitigate but do not eliminate this; a pass here is "the model can adjudicate constructed no-checker judgment cases," and generalisation to violations in the wild is the remaining risk after this leg. No natural-corpus oracle exists to close it — that gap is inherent to no-checker rules.

### 16.5 What each outcome buys
- **PASS:** the adjudication mechanism handles no-checker judgment rules on constructed, validated, realistic cases → the feature's load-bearing claim has direct (if construction-bounded) support; combined with §15's checkable-slice floor, deterministic-first for code v1 is supported and Phase A can be unblocked, with in-the-wild generalisation recorded as the residual risk.
- **FAIL:** the model cannot adjudicate judgment rules even on clean constructed cases → the T2/T3 majority is not reliably automatable by this mechanism; deterministic-first must lean harder on human review for the non-checkable slice, and that reshapes the Phase-C cost/automation story. Cheaper to learn now.

---

## 17. Leg 3 run — RESULT: PASS on the constructed-case floor for judgment rules (2026-07-13)

Ran per §16 through the four-party pipeline (planter → validator → blind Haiku → scorer + independent adjudicator + hostile adversary). **The bar is cleared, but — exactly as in §15 — the honest verdict is scoped, not a bare "crux PASS."** An independent adversary (un-seeded, verified the process) forced the scoping and surfaced a base-rate reality the raw number hides.

### 17.1 The pipeline and the sample
Planter (Sonnet) wrote matched violating/compliant twin pairs for 6 no-checker judgment rules; an independent validator dropped 8/24 in batch 1 for giveaway tells (on-the-nose names/comments), a top-up batch was added to meet the pre-registered N (11/11 kept). Final: **27 validated pairs = 54 elements** (27 violating + 27 compliant), balanced, ground truth **by construction**, leak-checked (no rule ids/markers in snippets). Blind Haiku adjudicated element→rule over the 6-rule set.

### 17.2 The numbers — and why recall, not precision, is the real signal
- **Raw:** rule-level precision 0.83, recall 0.93; paired discrimination 21/27 (0.78 — flagged the violating twin with the correct rule AND cleared its compliant twin). Per-rule recall: R.3 4/4, C.131 5/5, C.35 4/4, ES.1 4/4, C.4 4/5, F.2 4/5.
- **A harness defect, found and corrected symmetrically.** The validator (§16.3) checked each twin only against *its* target rule, so it missed **cross-rule contamination**. A full re-audit of all 27 compliant twins against all 6 rules found **3 contaminated**: C35-4 and C35-5 own a raw pointer (R.3), C4-6 hand-rolls a checksum (ES.1). Relabelling all three (both directions): the two R.3 cases were Haiku *correctly* catching the contamination (raw counted them as false positives — they were not), and the ES.1 case was a **hidden Haiku miss** that the disagreement-only audit could never have seen (Haiku and the wrong label both said "none"). **Corrected: precision 0.90, recall 0.90** (TP 27, FP 3, FN 3, TN 22; TPR 0.90, FPR 0.12).
- **The base-rate reality (the finding that matters).** All the above is at the test's **50/50 prevalence**. Precision is prevalence-dependent; recall (0.90) is not. Projected to field prevalence from the corrected TPR/FPR:

  | prevalence | field precision |
  |---|---|
  | 50% (the test) | 0.88 |
  | 10% | 0.45 |
  | 5% | 0.28 |
  | 2% | 0.13 |

  At realistic prevalence the adjudicator, run alone over every element, **over-flags** — precision falls below the hard-fail floor. This is not a failure of the model's judgment (recall is genuinely high); it is the structural fact that a decent-but-imperfect classifier at low base rate produces mostly false positives.

### 17.3 What it honestly establishes
- **Real, new signal Legs 1–2 never reached:** on clean, independently-validated, minimal-contrast twins across six *no-linter judgment* rules, blind Haiku attributes the correct guideline and clears the matched compliant twin in 21/27 pairs — **genuine judgment, not keyword-spotting.** The adjudication *capability* on judgment rules is real.
- **Architectural implication (the useful part):** because precision collapses at field prevalence, the LLM adjudicator **cannot** be pointed at every element; it must sit behind a **candidate-generation prefilter** (the mechanical/enumeration + embedding recall layer) that raises effective prevalence before adjudication. Leg 2 showed that enumeration layer works on the checkable slice; Leg 3 shows the adjudicator behind it has real judgment. The two legs compose into the intended architecture — and they relocate the load-bearing risk onto **prefilter quality**, not adjudication capability.

### 17.4 Named, unmet gaps (do not ratify past these)
1. **Field precision is unproven and likely poor** at real prevalence without a strong prefilter (0.13–0.28 at 2–5%). The gate tested the balanced set, not the operating point.
2. **Construction ≠ the field task.** Minimal-contrast, single-issue, ~10-line snippets with a 6-rule candidate set are *easier* than a violation buried in 500 lines with ~100 candidate guidelines. Generalisation to real elements in a real repo is untested — there are still **zero** real-code judgment-rule data points (Leg 2's one judgment rule, C.4, contributed zero positives).
3. **Shared-prior fidelity unknown.** Planter/validator/adjudicator are all Sonnet, system is Haiku (one lab). Ground-truth-by-construction defeats Leg 1's circularity *for recall of positives* (we know the violation was written), and the compliant-twin specificity is real — but difficulty calibration and rule attribution are Sonnet's reading, a proxy of unknown fidelity for how a human reviewer grades in the field.
4. **Negative-set integrity was defective** (3/27 contaminated) and is only trustworthy now because of a full re-audit; the original single-rule validation was insufficient.

### 17.5 Verdict and consequence
**PASS on the constructed-case floor for judgment rules** — not "PASS on the crux." Combined with §15 (checkable-slice floor) the picture is: enumeration works where a checker exists; the LLM adjudicator has genuine judgment on no-checker rules; **but field precision depends on a prefilter that is not yet built or measured.** This **de-risks the adjudication mechanism** (a real milestone after Legs 1–2 established nothing) and clarifies that the remaining bet is **candidate-generation quality at field prevalence** plus **in-the-wild generalisation** — both owed before Phase C. Recommendation: Phase A may proceed on the schema/plumbing (the mechanism is sound), but no automation/coverage claim may be made until a field-prevalence, real-code run closes gaps 1–2.
