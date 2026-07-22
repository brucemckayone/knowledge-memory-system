# Doc 24 — Convergence mechanisms: comparative bake-off (pre-registration)

**Bead:** nmemo-uhp.28 (to file) · **Status:** PRE-REGISTRATION — frozen before any number, mechanisms A/B not yet built
**Date:** 2026-07-22 · **Discipline:** [[verify-empirical-gates]] (20th run). This doc + the harness's frozen
arm definitions and bars are committed to git BEFORE the run. Bars are inherited verbatim from doc-23 §5.1
(already frozen there), so they cannot have been tuned to any mechanism.

**Autonomous session directive:** the user set a `/goal` to run autonomously, "try a few different approaches
to see which system prevents the concept explosion and has the best conformity." This doc is the pre-reg for
that bake-off.

---

## 0. Where we are (why this experiment)

doc-23 ran the naive conform-on-ingest mechanism on real non-code prose (120 cs.CL abstracts + probes) and
**FAILED** all conform bars: explosion reduction 4.5% (bar ≥40%), growth ratio 0.87 (bar ≤0.5), verbatim-dup
adds 47% of fresh (bar ≤10%). The blind adversary reproduced every number and **relocated the cause upstream**:
it is **not** the conform/grow logic or the Haiku judge (both behave correctly). The dominant drivers are

1. **Extraction non-determinism** — re-extracting *identical* verbatim text yields **47% novel labels**; those
   novel labels are the entire cond3 FAIL.
2. **Near-unique naming** — across 120 same-field docs only 3.4% of concept labels are exact-string repeats;
   free-form extraction invents a near-unique kebab label per mention, starving any conformer (cond1).
3. **Bare-label embedding is the weakest leg** — true synonyms sit at 0.70–0.84 (in-band), not ≥0.85.

The adversary explicitly forbade concluding "convergent space is unbuildable" — each driver has an **untried
lever**. This gate tests those levers head-to-head against the same oracle.

## 1. Design: same corpus, same oracle, same bars — vary only the mechanism

The **only** thing that varies across arms is the mechanism. Everything else is held identical so the
comparison is fair:

- **Corpus:** the frozen `convergence-artifacts/corpus.json` from doc-23 (120 cs.CL base + 15 astro-ph.GA
  distinct-field + 15 verbatim-duplicate + 12 paraphrase probes). Byte-identical across arms. No re-fetch.
- **Oracle:** the same construction-grounded probes (verbatim must add ≈0; distinct-field must stay separate;
  paraphrase reported). No human labelling (the user's standing constraint).
- **Bars:** doc-23 §5.1, inherited verbatim (§3 below).
- **Stream order:** base (submission order) → verbatim → paraphrase → distinct, identical to doc-23.

## 2. The arms (frozen definitions — built to this spec, reviewed before run)

### Arm 0 — control (doc-23 naive) — numbers already known, re-run for reproducibility + baseline
Free-form Haiku label extraction → embed the **bare label** (nomic-embed-text) → nearest existing node by
cosine → τ_high=0.85 auto-conform / τ_low=0.65 auto-grow / band → Haiku pair-judge (top-3 nearest). Node
identity = first mention. Reuses the cached `extractions.json` / `label-embeddings.json` / `judge-cache.json`,
so it must reproduce doc-23 (4.5% / 0.87 / 0.47) exactly. Its free-form base count (906) is the denominator
every arm's explosion-reduction is measured against.

### Arm A — description-embedding (embedding-side lever)
Free-form extraction, but the extractor emits `{label, gloss}` where `gloss` is a one-sentence definition of
the concept **as used in this text**. **Embed the gloss, not the label.** Everything else = Arm 0 (same
thresholds, same band-judge, first-mention identity; the node stores the first mention's gloss-embedding).
Tests: was the weak bare-label embedding the bottleneck? Does a richer text representation push true synonyms
≥τ_high so they auto-conform? Distinguishes "novel *labels* for the same concept" (A should fix) from "novel
*concepts* selected from identical text" (A cannot fix — that needs Arm B or is a deeper problem).

### Arm B — controlled-vocabulary extraction (extraction-side lever; the north-star mechanism)
**Sequential.** Maintain a growing controlled vocabulary V (list of canonical concept labels). For each
document in stream order, one Haiku call receives (a) the document text and (b) the current vocabulary V, with
the instruction: *"Extract the key concepts. For each, if it is ALREADY in the vocabulary, reuse that EXACT
label. Only coin a new kebab label if none fits."* Conform = returned label ∈ V (exact match after
normalisation); grow = new label → appended to V. **No embedding, no thresholds, no separate judge in the
loop** — the LLM maintains the controlled vocabulary directly. This is the "self-conforming as agents use it"
mechanism the product would actually deploy; it attacks the dominant cause (extraction non-determinism) at
source. If V exceeds 500 labels the prompt passes the 500 most-recently-touched labels (logged if it triggers).

**Frozen implementation knobs (all arms):** τ=[0.65,0.85] (arms 0/A); Arm B vocab cap 500 MRU; extraction
prompt temperature = provider default (Haiku via `claude -p`, unchanged); K_* probe counts from corpus.json.
All prompts are frozen in the committed harness before the run.

## 3. Bars (inherited verbatim from doc-23 §5.1 — frozen)

An arm **PASSES** iff all three hold:

1. **cond1 — explosion reduced:** base concept-node count ≤ 0.6 × the free-form baseline (906) — i.e.
   **reduction ≥ 40%** — AND growth curve sublinear: new-nodes-per-doc in the last base quartile ≤ 0.5 × the
   first quartile (**ratio ≤ 0.5**).
2. **cond2 — no over-merge:** ≥ **90%** of distinct-field probe concepts land on **new** nodes (not absorbed
   into base-field nodes).
3. **cond3 — conform works:** verbatim-duplicate probes add ≤ **10%** as many new concepts as an equal number
   of genuinely-new docs (verbatim new/doc ÷ fresh new/doc ≤ 0.10).

cond1/cond3 (conform) and cond2 (don't over-merge) are in **direct tension** — an arm that reuses labels
promiscuously wins cond1/cond3 but fails cond2. Clearing all three is the real test (mirrors doc-21's "recall
without promiscuity").

## 4. Ranking rule (frozen) + what a win licenses

- **Primary comparison metrics:** explosion-reduction % and verbatim-conform ratio (the two doc-23 FAILed),
  reported for every arm alongside the full cond1/2/3 table.
- **Winner = any arm that PASSES all three §3 bars.** If Arm B passes, that is the strongest outcome because it
  is the deployable mechanism; if only Arm A passes, the lever is embedding-side; if none passes, the FAIL is
  named per-arm (still exploding / over-merging / not conforming) and the mechanism family is not yet solved.
- **Anti-forking-paths (iter-18 / R-series):** running three arms and picking the best is a garden of forking
  paths. Therefore **a winning arm is EXPLORATORY, not banked**, until it is **confirmed on a held-out corpus**
  — the SAME mechanism re-run on a *different* arXiv field (astro-ph.GA as base, cs.CL as distinct-field, fresh
  fetch) clears the same bars. Only a held-out PASS is bankable as a capability claim. This is pre-registered
  here so the confirmation run cannot be retrofitted.

## 5. Anti-launder controls
- **Identical frozen corpus across arms** (byte-identical corpus.json) — no per-arm corpus tuning.
- **Bars inherited verbatim from doc-23** — provably not tuned to any mechanism (they predate the mechanisms).
- **All arms reported, including failures** — no silent dropping of an arm that looks bad (R-series).
- **No winner banked without a held-out confirmation run** (§4) — the multi-arm optimism is neutralised by
  pre-committing the confirmation protocol.
- **Probes are the oracle** (construction-grounded), not my judgment; distinct-field disjoint from base.
- **Persist everything per arm** (extractions, embeddings/vocab, per-doc decisions, results) → re-runnable.
- **Report both directions** (R3): if an arm passes, state exactly what it does NOT license (one field, one
  modality, exploratory); if all fail, do NOT over-generalise to "unbuildable" (the arms don't exhaust the
  lever space — centroid identity, hybrid A+B, hierarchical vocab all remain untried).

## 6. Honest priors
- **Arm A:** likely improves cond1 (glosses of synonyms are more similar than bare labels), uncertain on cond3
  — if verbatim non-determinism is at concept-*selection* not just naming, the glosses differ too and A won't
  fix it. Predict: partial improvement, may still FAIL cond1's 40%.
- **Arm B:** the mechanism most likely to move cond1/cond3 hard (told to reuse labels → reuses them), but the
  one most at risk on cond2 — if the LLM lumps distinct-field concepts under existing base labels, over-merge.
  Predict: passes cond3, contested on cond1 (does it actually reuse at scale with a 500-label prompt?) and
  cond2 (over-merge). This is the real experiment.
- **Failure is a real possibility for all three.** doc-23's cause was upstream and deep; a lever moving one
  bar may break another. No arm passing is a fully acceptable, informative outcome.

## 7. Blind-adversary protocol
Fresh subagent, given this pre-reg + all per-arm artifacts + numbers, tasked to break it: (a) independently
recompute each arm's explosion-reduction, growth ratio, and probe rates from the per-doc logs; (b) confirm the
corpus is byte-identical across arms (hash corpus.json; confirm no arm re-fetched or re-sliced); (c) confirm
bars were frozen pre-run (this doc's git commit predates every cv2-results timestamp); (d) check Arm B didn't
win cond1/cond3 by over-merging (does its cond2 hold, and is the reuse genuine — spot-check reused labels are
actually the same concept, not lumping); (e) check Arm A's gloss embeddings weren't silently seeded from the
label; (f) check no bar was swapped and no winner was banked without the held-out run. Verdict reported even if
it retracts a favorable reading (R3). I have laundered favorable conclusions 11+ times on this project in BOTH
directions — this synthesis is untrustworthy without the adversary.

## 8. Disposition
- **An arm passes (exploratory):** names the working lever (extraction-side vs embedding-side). Triggers the
  held-out confirmation run (§4) before any capability claim. First evidence the north-star convergent space is
  buildable with a specific mechanism.
- **No arm passes:** the naive→A→B ladder does not converge same-field prose under these bars; report the
  per-arm failure mode and the still-untried levers (centroid identity, hybrid A+B, hierarchical vocabulary).
  Free-form remains the honest description of what the system does.

Either way: one field, one modality; general-across-fields/modalities is a later, broader gate.
