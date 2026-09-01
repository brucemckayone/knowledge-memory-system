# Pre-registration — fact-level retrieval (retrieval experiment #3)

**Status:** FROZEN pre-registration. Written and committed BEFORE any number was computed.
**Date:** 2026-09-01 · **Branch:** `feat/single-graph-retrieval` · **Queue item #4**
**Follows:** `12` (the entity-vector sub-track is a tie; a different *substrate* is what remains) and `07`
(both oracles reported). Reuses the frozen embed cache for query vectors and the doc-05 query-pair set.

---

## 1. Why this experiment

The entity-vector retrievers (name / description / pool-re-rank / hybrid) all tie for target-finding at
R@10 ≈ 0.20–0.23. Fact-level retrieval is a **genuinely different mechanism**, never exercised: `searchFacts`
has zero callers, `facts.fact_embedding` is populated on the whole substrate (dal-nlp 2612/2612, dal-cv
2565/2565, all active — measured) yet read by nothing, and `idx_entities_embedding` has `idx_scan = 0`. It
tests whether retrieving over **facts (edges)** and aggregating to their endpoint entities beats retrieving
**entities (nodes)** directly. It also decides whether "entity-vector retrieval is saturated" is *local*
(entity vectors) or *global* (retrieval on this substrate). If it too ties, that is the **third**
consecutive retrieval tie and the retrieval track stops.

## 2. The question

For the same held-out query pairs, does ranking entities by their **best-matching fact** retrieve the
target entity at R@10 more often than ranking entities by their **name vector** (ARM-NAME)?

## 3. Design — fact-mediated entity retrieval, held out

Rankings are exact cosine in-process (NOT HNSW — same methodology as doc 05 / E0 / R1 / R2). Query vectors
come from the frozen embed cache (`${title} ${abstract}`). **Fact vectors come from the DB's stored
`fact_embedding`** — the production fact vector — parsed to 768 floats and **L2-normalised** (they are
stored raw / non-unit-norm; forgetting to normalise would silently corrupt cosine — guarded in §6).

- **ARM-NAME (baseline):** entity vector = cached name embedding; rank by cosine(query, name). Reproduces
  doc 05 (gate).
- **FACT-MAX (primary):** entity score = **max** over the entity's active facts (where it is subject OR
  object), of `cosine(query, normalise(fact_embedding))`. Rank entities by this score. An entity with no
  eligible fact is unretrieved.
- **FACT-MEAN (secondary):** same, using the **mean** over the entity's eligible facts (degree-robust
  variant; reported alongside a fact-count/degree diagnostic).
- **FACT+NAME (secondary):** retrieved-set RRF-60 of the ARM-NAME ranking and the FACT-MAX ranking — the
  "both" arm (queue #4 asks entity-level vs fact-level vs both).

### 3.1 Held-out fact guard (non-tautology, frozen)

Facts are extracted from every attributing document, **including the query document d**. A fact extracted
from d embeds text derived from d and would let a fact arm retrieve the target from the very text it is
querying — the fact-analog of doc 02's description guard. So **for query pair (e, d), every fact arm
excludes any fact f with `factToPaper[f] == d`.** `factToPaper` (attribution artifact) covers 93.1% of
facts; the 179 unmapped facts (dal-nlp) are from the 10 attribution-lost documents (doc 03 §9.5), which are
never query documents, so an unmapped fact cannot be from any query d — unmapped facts are therefore
**included** (and their count reported).

## 4. Metric, oracle, and the null

- **Metric:** Recall@10, under **both** the strict oracle (doc 05) and the condensed oracle (E0, Tier-B
  min-3). Both reported for every arm.
- **The null:** fact-level retrieval does not beat entity-level for target-finding — H₀: FACT-MAX R@10 ≤
  ARM-NAME R@10.

## 5. Bars — pre-registered

Paired bootstrap CI, 10,000 resamples, seed **20260831**, resampling query pairs; plus cluster bootstraps
by entity and by document. Verdicts by the standard rule (CI above 0 / spans 0 / below 0).

- **PRIMARY (strict oracle):** `FACT-MAX R@10 − ARM-NAME R@10`.
  - CI entirely above 0 → **fact-level DEMONSTRATED better** (retrieval track continues; a real lever).
  - spans 0 → **TIE** → the **third consecutive retrieval tie**; the retrieval track stops per the
    convergence rule and the binding constraint is declared to be the task/oracle, not the retriever.
  - entirely below 0 → **fact-level is WORSE** (entity-level retrieval is the better substrate).
- **Secondary, reported unconditionally, NOT promotable over the primary:** the same delta under the
  **condensed** oracle; `FACT-MEAN − ARM-NAME`; `FACT+NAME(RRF-60) − ARM-NAME` (both oracles);
  per-corpus split; k-ladder R@1/5/10/20.

## 6. Kill / void conditions

- **Strict regression gate.** ARM-NAME strict R@10 MUST reproduce doc 05: `0.20056497175141244` (assert
  `|Δ| < 1e-9`) at **n = 354**. Mismatch → **VOID**. (Absolute levels ride on the index-asc tie-break per
  doc 12 §6; the gate fixes the convention.)
- **Fact-vector integrity (empty-index trap).** Every fact pulled for a corpus MUST parse to a finite
  768-dim vector; if any fails, → **VOID**. Report per-corpus embedded-fact count (expect 2612 / 2565).
- **Normalisation sanity (silent-no-op trap).** Assert the raw stored fact vectors are **not** already
  unit-norm (mean raw norm ≠ 1, expected), and that after normalisation `dot(v, v) ∈ [1−1e-6, 1+1e-6]`.
  This guards the "forgot to normalise" corruption, which would produce a clean-looking wrong number.
- **Fact-arm retrievability ceiling.** Report the fraction of query pairs whose target entity has **≥ 1
  eligible fact after the held-out exclusion**. A pair whose target loses all facts to the guard is
  unretrievable by the fact arms (the fact analog of a DESC-pool miss); report the count and treat those as
  fact-arm misses (do not drop them — they are honest misses).
- **Arm-identity degeneracy.** If FACT-MAX top-10 equals ARM-NAME top-10 for **> 95%** of pairs → no
  conclusion (report overlap). Expected low (different signal).
- **n < 100** → UNDERPOWERED. **Clean-0/clean-1 guard** on any R@k.

## 7. Process commitments

- Committed before the harness exists; not edited once numbers exist except to append results in a marked
  section. Harness audited against this text before numbers are read.
- Deterministic set arithmetic; no LLM in the measurement path; bootstrap seeded (20260831); cluster
  bootstraps by entity and document.
- A **blind adversary** reviews before banking, tasked in **both** directions, and specifically tasked to
  check (a) the held-out fact guard actually excludes d-sourced facts (no tautology leak), (b) the fact
  vectors are genuinely normalised (no silent cosine corruption), and (c) whether a FACT-MAX result is a
  degree artifact (entities with more facts have more chances at a high max).
