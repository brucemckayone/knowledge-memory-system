# Doc 23 — Concept-space convergence gate: pre-registration (DRAFT for review)

**Bead:** nmemo-uhp.27 (to file) · **Status:** PRE-REGISTRATION DRAFT — not yet run, mechanism not yet built
**Date:** 2026-07-21 · **Discipline:** [[verify-empirical-gates]] (19th run). Bars in §5 frozen before any
number; but see §5.0 — this gate is deliberately structured to avoid freezing numeric bars I have no prior
for.

**This is a general cross-corpus test, NOT a code/MISRA test.** The corpus is real non-code prose (research
abstracts). Code was only ever the illustrative fixture ([[feedback_general_design]]); this gate exercises
the actual product claim — a concept space over *any* two/many bodies of text.

---

## 0. The claim under test (the user's north star)

> A concept space that ingests documents incrementally should **conform** (map a new mention to an existing
> concept when it's the same idea in different words) and **grow** (add a node when it's genuinely new),
> **without explosion** (total concept count saturates as coverage grows) and **without over-merge**
> (genuinely "similar but different" concepts stay distinct). And it should be **stable** to ingestion order.

doc-20 is the pathological baseline: free-form per-document extraction → explosion + drift (2/61 overlap).
doc-21 reconciled *after* the fact, in batch. This gate tests the preventive version: **conform-on-ingest.**

## 1. Scope fences

- **NOT recall.** No rules, no oracle-rule matching. This measures the *shape and correctness of the concept
  space itself*, not retrieval.
- **NOT code.** Real prose; the mechanism must be domain-agnostic.
- **NOT the semantic-judgment question** (paused E1). The boundary "same vs similar-but-different" *is* a
  semantic judgment and its hardest cases are reported, but the gate's pass/fail rests on
  construction-grounded probes + a comparative baseline, not on trusting that judgment (§5).

## 2. Corpus (real, non-code, one field so concepts recur)

- **Base:** N ≈ 300 abstracts from a **single** arXiv subfield (a field where the same concepts genuinely
  recur across papers — candidate: one of `cs.CL`, `q-bio.NC`, `cond-mat.supr-con`; final choice frozen at
  fetch time, snapshot committed). One field matters: convergence is only meaningful if the underlying
  concept vocabulary is finite-ish.
- **Snapshot committed** (`convergence-artifacts/corpus.json`) so the run is reproducible offline.

## 3. Injected probes = ground-truth-by-construction ON real text (how we get an oracle without labelling)

The user chose real text (no ground-truth concept count). To keep the gate falsifiable rather than
vibes-based, we inject probe documents whose correct behaviour is known **by construction**:

- **Duplicate probes (conform-recall + anti-explosion):** re-insert K=20 base abstracts **verbatim** later
  in the stream. A verbatim duplicate must add **≈0 new concepts** — every concept already exists. New
  concepts from a verbatim duplicate = a conform failure.
- **Paraphrase probes (conform under drift):** K=20 base abstracts machine-paraphrased (paraphrase
  generation disclosed as Haiku-generated test data, not part of the mechanism). Their concepts should
  *mostly* conform to the originals' nodes.
- **Distinct-field probes (over-merge / precision):** K=20 abstracts from an **unrelated** field injected
  into the stream. Their concepts must **stay separate** — they must not conform into the base field's
  nodes. Over-merge = base-field nodes absorbing unrelated-field concepts.

Probes give hard yes/no answers on real text. The **organic** "similar but different within the field" case
(the genuinely hard one) is **reported qualitatively (spot-checked), explicitly NOT gated** — we have no
oracle for it and inventing one is where laundering starts. Stated as the honest limitation up front.

## 4. The mechanism under test (to be built — reviewed before build)

Incremental `conformOrGrow` on ingest. Per document: Haiku extracts concept labels (the doc-21 extractor).
For each extracted concept:

1. Embed the concept label (nomic-embed-text). Find the nearest existing concept node by cosine, sim `s`.
2. **s ≥ τ_high** → **conform** (attach mention to that node). **s ≤ τ_low** → **grow** (new node).
   **τ_low < s < τ_high** → **Haiku judge** decides conform-vs-grow (the boundary; the only LLM call in the
   loop besides extraction).
3. Node identity = its first mention's label + embedding (frozen choice; a centroid variant is a later
   experiment, not this gate).

`τ_high`, `τ_low` frozen in the harness before the run. All conform/grow decisions + which branch made them
logged to `convergence-artifacts/decisions.json`.

## 5. Metrics and bars

### 5.0 Why the bars are COMPARATIVE, not absolute (honest handling of no-prior)
I have no prior for what "converged enough" looks like as an absolute growth-rate number on an unseen
corpus + unbuilt mechanism. Freezing an absolute bar would be a guess that either trivially passes or
impossibly fails. So the primary bars are **relative to a free-form (no-conform) baseline run on the same
corpus** — the doc-20 pathology. This is falsifiable without behavioural priors and directly tests the
thesis "conforming beats free-form."

### 5.1 Primary bars (frozen)
1. **Explosion reduced:** conform-on-ingest total concept count ≤ **0.6 ×** the free-form baseline's count
   at full corpus (conforming removes ≥40% of the free-form duplication). AND the growth curve is
   **sublinear** — new-concepts-per-doc in the last quartile ≤ **0.5 ×** the first quartile.
2. **No over-merge (construction-grounded):** ≥ **90%** of distinct-field probe concepts land on **new**
   nodes, not absorbed into base-field nodes.
3. **Conform works (construction-grounded):** verbatim-duplicate probes add ≤ **10%** as many new concepts
   as an equal number of genuinely-new documents would (near-total conforming).

### 5.2 Secondary (reported, not gating)
Stability: run two random ingestion orders; report concept-space size divergence + node-set Jaccard.
(Reported not gated in this first pass — a stability *bar* needs the priors this run produces.) Paraphrase
conform rate. Qualitative spot-check of organic similar-but-different merges.

**PASS = all three §5.1 bars + adversary clears.** Any single failure names the mode (still exploding /
over-merging / not conforming).

## 6. Anti-launder controls
- **Probes are the oracle** (construction-grounded), not my judgment (R2/R31). Distinct-field & duplicate
  probes have objectively correct behaviour.
- **Comparative baseline** neutralises no-prior bar-guessing (§5.0).
- **Organic hard case explicitly ungated** — no soft-oracle pass/fail; reported qualitatively only.
- **Thresholds + probe sets frozen** before the run; probe field disjoint from base field.
- **Persist everything** (corpus snapshot, decisions log, both order runs, baseline run) → re-runnable.
- **Exploratory honesty:** if a §5.1 bar's threshold turns out mis-set (e.g. baseline barely differs),
  the run is reported as **exploratory / characterising**, NOT banked as a PASS (iter-18 lesson: don't bank
  a number the design couldn't fairly test).

## 7. Honest priors
- **PASS path:** conform-on-ingest collapses free-form's duplication (fewer nodes), duplicate probes add ~0,
  distinct-field probes stay separate → convergence works, over-merge controlled.
- **FAIL (still explodes):** τ_high too strict / embeddings too noisy at the concept-label level →
  everything grows, count ≈ free-form.
- **FAIL (over-merge):** τ_high too loose / judge too eager → distinct-field probes absorbed, count
  artificially low. The count-reduction bar and the over-merge bar are in **direct tension** — passing both
  is the real test (mirrors doc-21's "recall without promiscuity").
- **The organic boundary may be unresolvable** — probes can pass while genuine similar-but-different within
  the field is handled badly; the qualitative spot-check will show it, and it stays an open question.

## 8. Blind-adversary protocol
Fresh subagent, given this pre-reg + all artifacts + numbers, tasked to break it: recompute the growth curve
and probe rates independently; check the baseline is a fair free-form run (not crippled); check thresholds
were frozen pre-run; check over-merge isn't hidden by the count-reduction bar (are the two in real tension or
did one arm cheat the other?); check the distinct-field probes are genuinely disjoint; check no absolute bar
was quietly swapped for a comparative one to dodge a FAIL; check paraphrase/organic claims aren't overstated.
Verdict reported even if it retracts (R3).

## 9. Disposition
- **PASS:** conform-on-ingest is a real, general, measured mechanism for a convergent concept space —
  reduces free-form explosion ≥40% while keeping distinct concepts distinct, on real non-code prose. The
  first evidence the north-star space is buildable. Organic similar-but-different + a stability *bar* +
  field-generality (>1 field) remain owed.
- **FAIL:** names the mode. Free-form stays the honest description of what the system does; the convergent
  space is aspirational, not yet achieved.

Either way: no claim about the organic hard case (ungated), and this is one field on one modality — general
across fields/modalities is a later, broader gate.

---

## 10. RESULT (2026-07-21) — GATE FAIL, adversary QUALIFIED (sound FAIL, cause is upstream)

Run: `platform/src/test/tools/concept-convergence.ts` on 120 cs.CL abstracts + 15 astro-ph.GA distinct-field
probes + 15 verbatim + 12 paraphrase. Artifacts in `convergence-artifacts/` (corpus, extractions,
label-embeddings, judge-cache, cv-results). Thresholds τ=[0.65,0.85]; band→Haiku judge (batched).

| bar (§5.1) | result | verdict |
|---|---|---|
| explosion reduced ≥40% AND growth ratio ≤0.5 | free-form 906 → conform **865** nodes = **4.5%**; Q1 221→Q4 192 = **0.87** | **FAIL** |
| distinct-field stay separate ≥90% | 0/126 absorbed = **100%** | pass (low-power — see below) |
| verbatim dup adds ≤10% of fresh | 3.0 vs 6.4 new/doc = **0.47** | **FAIL** |

**GATE FAIL.** Of 938 base concepts only ~73 conformed (7.8%) — the mechanism is **near-pure-grow**; the
concept space exploded almost as much as free-form.

**Blind adversary verdict: QUALIFIED** (agent a08cecfb). It re-implemented `conformOrGrow` line-for-line
and reproduced every number to full float precision (906/865/4.5%, 0.869, 100%, 0.469, 7.8%) with
`missingEmb=0 / missingJudgeKeys=0` — no scoring bug, no off-by-one. Bars confirmed frozen in git
(e392745, 16:13) ~68 min before the numbers (cv-results 17:21). Probes clean (distinct-field: 0
exact-overlap + 0 embedding ≥0.85 to base; verbatim identical text; paraphrases genuine, len ratio 1.19).
No recall smuggled. **The FAIL is SOUND and holds.**

But it forced two corrections on the *interpretation* (both directions of the launder risk):

1. **Cause is UPSTREAM, not the conformer.** The conform arithmetic and the Haiku judge both behave
   correctly on what they're handed (judge said "same" 6/1485, all 6 correct merges; declined near-misses
   sensibly). The dominant drivers are:
   - **Extraction non-determinism** — re-extracting the *identical* verbatim text yields **47% novel
     labels** (55/117); those novel labels produce **every one** of the 45 verbatim new nodes. This alone
     is the entire cond3 FAIL. (The 62 exact-string-match labels all conformed correctly — cosine 1.0.)
   - **Near-unique naming** — across 120 same-field docs only **3.4%** (32/938) of concepts are exact-string
     repeats; the extractor invents a near-unique kebab label per mention, starving *any* conformer. This is
     the cond1 near-linear growth.
   - **Bare-label embedding is the weakest leg** — true synonyms sit at 0.70–0.84 (in-band), not ≥0.85, so
     75% of decisions fall to the judge. (This is exactly the lever noted long ago: embed the concept
     *description*, not the bare NAME.)
2. **cond2's PASS is low-power / characterising, NOT strong discrimination.** Only ~19 genuine near-miss
   decline opportunities; the 100% survives *only because τ_high is high*, and it is in direct, confirmed
   tension with cond1 — a threshold sweep shows **no single global threshold clears both** (T≈0.65 hits 50%
   reduction but drops distinct-separation to ~85% < 90%). Reported as characterising per §6, not banked.

**What this licenses (§9 FAIL branch, narrowed):** THIS naive conform-on-ingest pipeline (free-form Haiku
re-extraction → bare-label nomic embedding → fixed 0.85/0.65 thresholds → top-3 band judge → first-mention
node identity) **does not converge** on real same-field prose — it stays in grow mode and explodes nearly as
much as free-form. Free-form remains the honest description of what the system does today; the convergent
space is aspirational, not achieved.

**What it does NOT license (adversary's explicit cut):** NOT "a convergent concept space is
unbuildable/impossible." The bottleneck is upstream (extraction non-determinism + near-unique naming +
bare-label embedding), and each has an **untried lever**: deterministic/normalized/controlled-vocabulary
extraction, embedding the concept *description* not the label, centroid (not first-mention) node identity.
None of these was tested; the result does not speak to them. NOT any claim from cond2 that the space
discriminates well (low-power, threshold-conditional).

**Net:** the first honest data point on the north-star convergence claim is a clean FAIL that **relocates
the problem**: it is not the conform/grow logic or the judge that fails, it is that free-form LLM extraction
produces a near-unique label per mention (even for identical text), so there is almost nothing to conform.
The next experiment must attack **extraction stability / controlled vocabulary** (and description-embedding),
not the conformer — each its own pre-registration + adversary.
