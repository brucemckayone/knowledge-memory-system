# Doc 26 — Direct semantic-redundancy gate: reframing what "no explosion" means (pre-registration)

**Bead:** nmemo-r0o follow-up (new bead to file) · **Status:** PRE-REGISTRATION — frozen before any redundancy number
**Date:** 2026-07-23 · **Discipline:** [[verify-empirical-gates]] (22nd run). Committed to git BEFORE the run.
Autonomous `/goal` session (nail down the system that prevents concept explosion with best conformity).

---

## 0. Why this doc exists (the metric problem doc-25 exposed)

Five arms (doc-23/24/25) all FAILed the convergence gate. The binding failure was always **cond1 =
growth-ratio Q4/Q1 ≤ 0.5** (Arm B 0.72, Arm R 0.72 — window-independent). But a direct look at the *actual
concepts* the best arm (Arm R) built (in-chat analysis, 2026-07-23) showed the space is **not redundant**:

- Of 589 labels, **0 pairs** exceed 0.90 embedding cosine; only **18 labels (3%)** have any neighbor ≥0.85, and
  most of those are genuinely distinct (`trigonometric-parallax` vs `photometric-parallax`; `star-formation` vs
  `-rate` vs `-histories`).
- A lexical duplicate scan found **6 candidates** across 589 labels; **4 of 6 are genuinely distinct**.
- The late-arriving (Q4) concepts read as **genuine novelty** — `mlir-compilation`, `hemodynamic-response`,
  `parallel-tempering`, `2d-rope`, `machine-unlearning` — not rewordings of Q1 concepts.

**The logical defect in growth-ratio:** a space bloated with redundant labels and a clean space that keeps
encountering genuinely-new ideas *both* produce high growth. Growth-ratio **cannot distinguish redundancy from
novelty** — it conflates the thing we want to prevent (duplication) with the thing we want to allow (real new
concepts). So the gate has been failing on a metric that does not measure "explosion."

**Discipline flag (read this before trusting the reframe):** "the failing bar is the wrong bar, we actually
pass" is exactly the conclusion I have laundered ~5× in this project (see [[verify-empirical-gates]]). This doc
does **not** assert we pass. It (a) states the principled reason growth-ratio is a poor operationalization —
which is true *independent* of whether the new metric passes — and (b) pre-registers a **direct** metric plus a
**frozen bar** and a **blind adversary**, so the reframe is falsifiable, not convenient. If the direct metric
also FAILs, that is the honest outcome and gets reported.

## 1. What we are actually testing (nailed down)

The product needs a cross-corpus concept space with three properties. State them as **direct, measurable
conditions**, not proxies:

1. **No explosion (low REDUNDANCY):** few nodes in the built space are semantic duplicates of another node —
   i.e., the space is close to its true distinct-concept count. *(NEW direct metric — this doc.)*
2. **No over-merge (distinct stays distinct):** genuinely different concepts do not collapse into one node.
   *(Existing cond2 — kept unchanged.)*
3. **Conform-on-repeat (dynamic):** re-ingesting identical content coins ~0 new nodes. *(Existing cond3 — kept,
   but flagged as a window-engineering property, not a mechanism verdict; see doc-25 §8.)*

Growth-ratio (old cond1) is **retired as a PASS/FAIL condition** and demoted to a **descriptive** number still
reported for continuity. It is replaced by the direct redundancy metric (§2).

## 2. The redundancy metric (frozen)

**Object measured:** the set of base-concept nodes built by a mechanism over the frozen corpus. Measured on
**two** spaces with the identical procedure:
- **Arm R space** (relevance-window controlled-vocab, the best mechanism): its base nodes.
- **Free-form baseline space** (naive extraction, no conform): its base labels — the "explosion" reference.

**Redundancy rate** = fraction of nodes removable by merging semantic duplicates:
1. **Candidate pairs** (recall-oriented prefilter): every label pair with embedding cosine **≥ 0.70**, UNION
   every **lexical** candidate (one label substring of the other, OR token-overlap ratio ≥ 0.6 with ≥2 shared
   tokens). Union deliberately over-generates so the LLM does the deciding, not the threshold.
2. **LLM adjudication (Haiku)**: each candidate pair judged on a **3-way** scale — `same` (one concept, a KG
   should hold a single node), `sibling` (distinct but related concepts — keep separate), `unrelated`. Prompt
   frozen in §3. **Conservative tie-break: when uncertain, judge `same`** — this biases the redundancy number
   *up*, i.e., *against* the clean-space hypothesis I am inclined to believe.
3. **Redundancy** = (N − C)/N, where N = node count and C = connected components of the graph whose edges are the
   `same` pairs. (Isolated non-candidate nodes are their own component.) Report **strict** (edges = `same`) and
   **lenient** (edges = `same` ∪ `sibling`). Report the largest component size to expose any transitive-chaining
   artifact.
4. **Prefilter-recall spot-check (measures the denominator the adversary will ask about):** sample **100 random
   pairs BELOW cosine 0.70** and LLM-judge them with the same prompt. If the `same`-rate there is ≈0, the ≥0.70
   prefilter has high recall and the redundancy number is trustworthy. If not, redundancy is an **undercount** —
   report the estimated correction, do not bank the raw number.

**Known limitation, registered up front:** embedding + lexical candidate generation can miss
abstraction-level / low-surface-similarity duplicates (e.g. `hallucination` vs `confabulation`). The spot-check
(step 4) *bounds* this miss rate; it does not eliminate it. A full O(N²) LLM pass is out of scope (cost) and its
absence is stated, not hidden.

## 3. Frozen LLM judgment prompt (Haiku, via ML `/chat`)

```
You are judging whether two concept labels from a knowledge graph denote THE SAME concept
(such that the graph should hold a single merged node), are SIBLINGS (distinct but related
concepts that should stay as separate nodes), or are UNRELATED.

Label A: "<a>"
Label B: "<b>"

Rules:
- SAME = a knowledge graph modeling this domain would be wrong to keep both as separate nodes;
  they are the same idea in different words (synonyms, trivial rewordings, acronym/expansion).
- SIBLING = genuinely different concepts that share a parent or theme (e.g. two different
  methods, a process vs its rate, a general concept vs a specific variant). Keep separate.
- UNRELATED = different topics.
- If you are genuinely unsure between SAME and SIBLING, answer SAME.

Answer with exactly one word: SAME, SIBLING, or UNRELATED.
```

Cached by `(a,b)` sorted key so the run is deterministic and replayable by the adversary.

## 4. Bars (FROZEN before any redundancy number)

The reframed "no explosion" condition (**cond-R**) PASSES iff **both** hold:
- **(absolute)** Arm R **strict** redundancy ≤ **5%** AND **lenient** redundancy ≤ **10%**. Product rationale:
  at ≤5% node-level duplication, ≤1 in 20 concepts is split, so ≤5% of concept-queries retrieve a fragmented
  neighborhood — a tolerable recall degradation for a usable graph. The lenient bound guards against a pile of
  borderline `sibling`s masking a dirty space.
- **(comparative)** Arm R strict redundancy ≤ **0.5 × free-form** strict redundancy. The mechanism must remove
  at least half the redundancy present in the naive space — proof it *earned* the cleanliness rather than the
  corpus simply never being redundant.

Full gate PASS = **cond-R** AND **cond2** (distinct-field stay-separate ≥90%, unchanged; Arm R already 95%) AND
**cond3** (verbatim new/doc ÷ fresh ≤0.10, unchanged; a window-engineering item per doc-25). The **new result**
this doc adjudicates is **cond-R**; cond2/cond3 carry over from doc-25.

**Integrity disclosure (partial blindness):** I have already seen the *embedding-similarity* distribution
(~3% of labels ≥0.85), so I am **not blind** on the absolute bar — 5% sits above that estimate. I set 5% on the
product rationale above, not to clear the estimate, but the adversary must weigh this. I am **genuinely blind**
on: (a) the LLM `same`-rate (a different measurement from cosine ranking — many ≥0.85 pairs are siblings, and
sames may hide below 0.85), and (b) the free-form redundancy, hence the comparative bar.

## 5. What each outcome means (registered before the run)

- **cond-R PASSES (both bounds + comparative):** direct evidence the space is genuinely non-redundant and the
  mechanism earned it → growth-ratio's failure was measuring corpus novelty, not explosion. Combined with cond2
  PASS, the only open gate item is cond3 (window engineering). Still **exploratory** — triggers the
  pre-registered held-out confirmation (astro-ph.GA base / cs.CL distinct) before any capability claim (doc-24
  §4 rule; no winner banked without held-out).
- **Absolute passes but comparative FAILs (free-form is also clean):** the corpus barely produces redundancy
  regardless of mechanism → the conform mechanism is solving a smaller problem than assumed; reduction from
  906→483 was compressing *near*-duplicates the LLM does not call `same`. Important, deflating, reported.
- **Absolute FAILs (Arm R redundancy > bar):** the space IS meaningfully redundant and growth-ratio, for all its
  flaws, was pointing at something real. The reframe does not rescue the mechanism. Reported plainly; my §0
  hypothesis was wrong.
- **Spot-check finds sames below 0.70:** the prefilter under-counts; the headline redundancy is a floor and the
  corrected estimate governs. Reported, not hidden.

## 6. Anti-launder controls

- Bar + prompt + procedure committed to git **before** any redundancy number is computed.
- **Conservative tie-break** (uncertain → `same`) biases the metric against my own hypothesis.
- **Comparative bar** measured on a space (free-form) whose LLM redundancy I have not seen → genuine blindness.
- **Prefilter-recall spot-check** measures the denominator (the exact gap the adversary caught unmeasured in
  audit legs 5–6).
- Partial-blindness on the absolute bar **disclosed** (§4), not buried.
- Both directions reported (R3): if it passes, do not oversell (cond3 still open, single field, single corpus,
  embedding-invisible dupes unbounded beyond the spot-check); if it fails, state §0 was wrong.
- No winner banked without the held-out run (doc-24 §4).

## 7. Blind-adversary protocol

Fresh subagent, given only raw artifacts (the built spaces, the cached pair judgments, the embeddings):
1. Recompute strict & lenient redundancy for Arm R and free-form from the cached judgments (independent
   connected-components); confirm they match my reported numbers.
2. Audit the **candidate-generation**: is ≥0.70 ∪ lexical a fair prefilter, or gerrymandered? Re-derive the
   candidate set from the embeddings and confirm it matches.
3. Audit the **spot-check**: are the 100 below-0.70 pairs genuinely random? Does the `same`-rate there support
   the "prefilter has high recall" claim, or are dupes hiding below 0.70 (making redundancy an undercount)?
4. Attack the **demotion of growth-ratio**: am I retiring a metric because it is genuinely ill-posed, or because
   it fails? Is the §0 conflation argument sound?
5. Attack the **judge**: spot-read ≥20 `same` and ≥20 `sibling` verdicts — is the 3-way rubric applied
   sensibly, or does it call true dupes `sibling` to deflate redundancy (or vice-versa)? Is the tie-break
   actually conservative in the direction claimed?
6. Attack the **bars**: does the 5% absolute sit suspiciously just above the peeked embedding estimate? Is the
   comparative bar meaningful given free-form's actual number?
7. Check no bar/prompt swapped post-hoc; check the largest `same`-component isn't a transitive-chaining blob
   inflating/deflating the count. Verdict even if it retracts the reframe.

## 8. Disposition

Names the outcome per §5. This settles **what "no explosion" means operationally** (direct redundancy, not
count-plateau) and whether the best mechanism's space is clean by that definition. It does **not** settle
multi-field generality, held-out corpora, or cond3 window engineering — each remains its own gate.

---

## 9. RESULT

*(added after the run + blind adversary)*
