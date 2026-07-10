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
