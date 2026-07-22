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

---

## 10. RESULT (2026-07-22) — all three arms GATE FAIL; adversary QUALIFIED; problem relocated to the vocab window

Arms 0/A/B ran on the frozen corpus. A blind adversary independently replayed every arm from raw per-doc data
(**0/162 mismatches** on Arm B, replaying `seeded-extractions.json`+`corpus.json` through its own conform/grow)
and audited the interpretation both directions. Verdict: **numbers PASS-SOUND, interpretation QUALIFIED** (4
corrections). Artifacts: `convergence-artifacts/cv2-results-arm{0,A,B}.json`, `armB-reuse-diagnostic.txt`.

| arm | reduction (≥40%) | growth Q4/Q1 (≤0.5) | distinct-separate (≥90%) | verbatim (≤0.10) | gate |
|---|---|---|---|---|---|
| 0 control (bare-label embed) | 4.5% | 0.87 | 100% | 0.47 | **FAIL** (c1,c3) |
| A description-embedding | 6.7% | 0.96 | 100% | 0.51 | **FAIL** (c1,c3) |
| B controlled-vocab extraction | **43.2%** ✓ | 0.72 | **96.5%** ✓ | 0.36 | **FAIL** (c1,c3) |

**No arm passes.** Corpus byte-identical across arms (sha256 `d1af6fc4…`, no re-fetch), bars frozen pre-run
(pre-reg `75c741e` 09:52 precedes every result write), denominator 906 clean.

### Arm A — clean negative result
Embedding a one-sentence gloss instead of the bare label moved reduction only 4.5%→6.7% and *worsened* growth
(0.87→0.96) and verbatim (0.47→0.51). Adversary confirmed the glosses were genuinely embedded (0/1237 gloss
keys coincide with a label key; avg 117 vs 21 chars). **The embedding representation is not the bottleneck** —
a much richer text vector barely helps. The problem is not how concepts are *compared*; it is how they are
*named at extraction*.

### Arm B — the strong signal, and the load-bearing correction
Telling the extractor to reuse existing labels gave **43.2% explosion reduction** (10× arms 0/A; base vocab
515 vs free-form 906) with **over-merge controlled at 96.5%** (4/114 distinct-field concepts absorbed, and
those are defensible cross-domain concepts — `bayesian-posterior-sampling`, `thermodynamic-phase-transition`).
Reuse is *mostly* genuine and coherent (`retrieval-augmented-generation` ×16 across real RAG papers,
`multilingual-evaluation`, `instruction-tuning`) — **with a qualifier the adversary required:** a tail of
vague-umbrella / polysemous labels rides along (`generalization-problem`, `model-heterogeneity`,
`trajectory-reasoning` — two senses), i.e. some within-field lumping. That case is *ungated* here (doc-23 §3).

**Adversary's load-bearing correction — why the discipline exists.** My draft headline for Arm B — "even shown
the exact vocab, Haiku coins ~1.3 novel labels per identical re-read (residual extraction non-determinism)" —
is **substantially a harness artifact**, not non-determinism. The MRU-500 vocab cap (pre-reg §2's own knob)
triggered at stream index 118, so only 2/120 base docs were capped **but all 15 verbatim probes were** — and
the verbatim probes' base-twins are the *first 15 base docs* (the oldest labels), which recency-based MRU
eviction drops first: **38 base-twin labels were evicted from the shown window** before their verbatim doc
re-extracted. The extractor cannot reuse a label it was never shown. Of the 20 verbatim new nodes, **9 are
demonstrable cap artifacts** (token-variants of evicted twins: `soft-prefix`~`soft-prefix-bias`,
`3d-spatial-reasoning`~`spatial-reasoning`, `gender-classification`~`speaker-gender-classification`, …); only
~3 are clean non-determinism. Stripping the 9 artifacts drops verbRatio 0.36→0.198; the clean-only residue is
0.054 (a cond3 pass). **So cond3's FAIL is the MRU-cap eviction knob, not an intrinsic property of
controlled-vocabulary extraction, and it is re-runnable with a relevance-preserving window.** (NOT banked as a
cond3 pass — this is a post-hoc re-attribution; the proper test is an uncapped / retrieval-window re-run.)

**What the gate FAIL rests on, artifact-free.** With cond3 discounted as a cap artifact, Arm B still FAILs —
on **cond1 growth-saturation (0.72 > 0.5)**. The reduction sub-bar passes (43.2%, computed on base docs, only
2 capped) and cond2 passes (96.5%). Honest statement: **controlled-vocabulary extraction genuinely cuts
explosion ~43% and controls over-merge, but the concept count still grows near-linearly across 120 same-field
papers.** Whether that is genuine field-vocabulary size or under-conforming is **not distinguishable from 120
docs** — untested speculation, not an observation (frozen bar stands; this is a FAIL).

### Net + next
The doc-23 relocation holds and sharpens: the concept layer's problem was never the graph/JOIN/judge — it is
the **extraction front-end**. doc-24 rules out the embedding representation (Arm A) and shows
controlled-vocabulary extraction (Arm B) is the right direction (10× reduction, over-merge controlled), while
locating **two remaining blockers precisely**:
1. **The vocab window** — naive MRU-500 truncation evicts old canonical labels and breaks conform-on-duplicate.
   Fix: relevance-preserving retrieval (show the extractor the embedding-nearest existing labels, not the
   most-recent). This is the next experiment (its own pre-reg + adversary); it should recover cond3.
2. **Growth saturation** — even with good reuse, a real field keeps introducing new concepts; whether the ≤0.5
   sublinearity bar is fair at 120 docs is a bar-appropriateness question for a larger-corpus gate, not a
   mechanism verdict from this run.

No capability claim; no held-out run (nothing passed). Free-form remains the honest description of the shipped
system; controlled-vocab extraction with a relevance window is the most promising unfinished lever.
