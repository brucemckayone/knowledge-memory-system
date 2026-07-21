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

## 10. RESULT — PENDING (mechanism not built; pre-reg under review)
