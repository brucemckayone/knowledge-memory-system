# Pre-registration — E0: is the retrieval oracle the binding constraint?

**Status:** FROZEN pre-registration. Written and committed BEFORE any E0 number was computed.
**Date:** 2026-09-01 · **Branch:** `feat/single-graph-retrieval`
**Follows:** `05-results-description-aligned-and-hybrid.md` (the only measured retrieval result) and its
§6 self-critique ("the oracle is incomplete and it penalises ARM-NAME more").
**Kickoff mandate:** `01-kickoff-goal.md` E0 — "build a better oracle before spending iterations on
retrieval… measure the old and new oracle on the same arms so the change in numbers is attributable."

---

## 1. Why E0 comes before any retrieval experiment

Doc 05's absolute recall numbers are ceilinged by **labelling, not retrieval**. Measured before writing
this doc, from the committed artifacts (this is the *premise*, not a result of the pre-registered run —
it is what motivates the design and is stated here so the motivation cannot be back-fitted):

| corpus | labelled entities / attributed doc | entities named verbatim / doc | **named but NOT labelled / doc** |
|---|---|---|---|
| `dal-nlp` | 9.0 | 30.5 | **23.5** |
| `dal-cv` | 9.8 | 18.1 | **10.2** |

So per document, ~10–24 entities are named verbatim in the query text yet scored as non-relevant by the
current oracle. They occupy top-k slots and are unrewarded. ARM-NAME is precisely the arm that retrieves
lexical matches, so the current oracle penalises it more — doc 05 §6 asserted this; the counts quantify
it. And the blind spot is **2.3x larger in `dal-nlp` than `dal-cv`** (23.5 vs 10.2), the same corpus
split as the unexplained 2.5x heterogeneity in the kickoff's retrieval-queue item 3. That makes a chunk
of that heterogeneity a candidate **oracle artifact** rather than a retrieval property — which E0 can
test directly.

E0 does **not** produce a new retrieval verdict. It measures how much the oracle's incompleteness moves
the doc-05 ARM-DESC vs ARM-NAME comparison, so that downstream experiments (first: pool-then-re-rank) can
be read against an instrument whose bias is characterised.

## 2. The question

On the **exact frozen rankings of doc 05** (same entity vectors, same query pairs, same cosine ranking),
does crediting a document's verbatim-named entities as relevant change the size or sign of the
ARM-DESC − ARM-NAME Recall@10 gap — and by how much?

## 3. Design — one instrument change, rankings held fixed

**Nothing about retrieval changes.** The harness reuses the committed embedding cache
(`prereg-artifacts/embed-cache.json`, 114 MB, present locally) and the identical ranking path of
`desc-aligned-followups.ts`: exact cosine in-process over the full corpus entity set, tie-break by index
ascending, `entityEmbedTextFor(name, desc, mode)` for arm text. The query-pair set is reconstructed by
the identical rules (attribution + ingest-ledger order, held-out ≥2 attributions, drop the
first-attributing document). Because the rankings are byte-identical to doc 05, **every number that moves
between the two oracles is attributable to the oracle alone.**

### 3.1 Relevance tiers (frozen)

For a query pair `(target entity t, document d)`:

- **Tier A — attributed.** Entity is in `attribution-{corpus}.json` `paperToEntities[d]` (fact-endpoint
  mediation). This is doc 05's oracle, unchanged. `t` is always Tier A by construction.
- **Tier B — named.** Entity's `canonical_name`, lowercased and trimmed, matches in
  `lower(title + ' ' + abstract)` under the word-boundary regex `(?<![a-z0-9])ESCAPED(?![a-z0-9])`
  (name regex-escaped), for names of **length ≥ 3 characters**. Tier A takes precedence: an entity that
  is Tier A is not also counted as Tier B.
- **Tier C — neither.** Treated as non-relevant.

Tier B is pure deterministic string arithmetic: **no LLM, no embedding**, so it is not
embedding-correlated (the failure that compromised the docs 28–30 oracle per keep-list §5).

`relevant(d) = TierA(d) ∪ TierB(d)`. The target `t ∈ relevant(d)` always.

### 3.2 The two scores, on the same ranking

For each arm and query pair, from the full ranking of corpus entity indices:

- **strict rank** = 1-based position of `t` in the full ranking. *This is doc 05's metric.*
- **condensed rank** = `1 + |{ i : rank(i) < rank(t) AND i ∉ relevant(d) }|`. Equivalently: delete every
  co-relevant entity (`relevant(d) \ {t}`) from the ranking, then take `t`'s position. Co-relevant
  entities crowding above the target are not counted against it. **Applied identically to both arms.**

`R@k` under each = fraction of pairs whose (strict | condensed) rank ≤ k.

## 4. Metrics and the pre-registered quantity of interest

Reported per arm (ARM-NAME, ARM-DESC), per corpus and pooled, at k ∈ {1, 5, 10, 20}, under both scores.

**Headline E0 quantity = the SHIFT:** `shift = Δcondensed − Δstrict`, where
`Δ = (ARM-DESC R@10) − (ARM-NAME R@10)`, computed pooled and per corpus. CI by paired bootstrap over
query pairs (10,000 resamples, seed **20260831**, reproducing doc 05's PRNG), plus the two cluster
bootstraps doc 05 used (by entity, by document), because 354 pairs come from 181 entities / 176
documents and pair resampling is anti-conservative.

Also reported unconditionally:

- **Δstrict and Δcondensed** each with their own CIs (so the shift is decomposed, not just differenced).
- **Miss-mass decomposition.** Over pairs whose *strict* rank > 10 (a doc-05 miss at k=10): the mean
  count, per arm per corpus, of top-10 slots that are `TierA(d)\{t}`, `TierB(d)`, and `TierC`. Tests
  whether misses are co-relevant crowding (labelling artifact) or junk (real failure).
- **Recovered-by-condensation count**, per arm per corpus: pairs with strict rank > 10 AND condensed
  rank ≤ 10. The cleanest single number for "doc-05 misses that were the target sitting just behind
  co-relevant entities."
- **Tier-B size** per doc (in-harness, reproducible from the artifact), and the fraction of targets that
  are themselves verbatim-present.

## 5. Interpretation — committed before the number

`shift` is the E0 headline. Because condensation can only improve a target's rank, and ARM-NAME retrieves
more verbatim (Tier-B) entities high, the *a priori* expectation is `shift < 0` (condensation widens
NAME's lead) **if Tier-B entities are genuinely relevant**. The three outcomes and what each licenses:

| `shift` (Δcondensed − Δstrict) pooled CI | reading |
|---|---|
| **entirely below 0** | Confirms doc 05 §6: the oracle understated ARM-NAME's advantage. "Descriptions hurt small-k" **strengthens**; downstream experiments should prefer the condensed oracle and report both. |
| **entirely above 0** | The oracle was penalising ARM-DESC more, not less. Doc 05's harm headline is **partly an oracle artifact**; the description question re-opens. |
| **spans 0** | Oracle incompleteness does **not** materially move the arm comparison. Doc 05's verdict stands, and E0 clears the condensed oracle for downstream use. |

**Heterogeneity sub-question (diagnostic, no formal bar):** report per-corpus Δstrict and Δcondensed and
whether condensation shrinks the `dal-nlp` vs `dal-cv` gap in the description effect. If the per-corpus
deltas converge under the condensed oracle, retrieval-queue item 3's "2.5x mystery" is substantially an
oracle artifact and should not consume a separate retrieval iteration.

This is a measurement study. `shift` does not promote or kill any retrieval recommendation on its own; it
recalibrates the instrument the retrieval experiments will use.

## 6. Kill / void conditions

- **Strict regression gate.** The strict scores MUST reproduce doc 05 bit-exact:
  `ARM-NAME R@10 = 0.20056497175141244` and `ARM-DESC R@10 = 0.13841807909604520` (assert
  `|computed − target| < 1e-9`), at **n = 354** (`multiAttributedTotal = 181`, 176 documents). Any
  mismatch → **VOID**: the harness is mis-wired and no condensed number may be read. (This inverts the
  "disbelieve a clean PASS" rule — an exact reproduction of an independently-frozen number is required as
  proof the pipeline is correct before the new measurement is trusted.)
- **n < 100** query pairs → UNDERPOWERED, no verdict (inherits doc 02 §6).
- **Tier-B degenerate** → report but draw NO condensed conclusion, if either: mean Tier-B per doc < 1, OR
  `mean(|relevant(d)| / |corpus entities|) > 0.90` (condensation would be vacuous because nearly
  everything is "relevant").
- **Clean-0/clean-1 guard.** Any condensed `R@k` landing exactly at 0.0000 or 1.0000 is verified two ways
  before it is believed (the doc-05 §9.5 silent-no-op trap).

## 7. Process commitments

- This document is committed before the harness exists and is not edited once numbers exist, except to
  append results in a clearly marked section.
- The harness is audited against this frozen text before the numbers are read.
- Deterministic set arithmetic throughout; no LLM in the measurement path; bootstrap seeded (20260831);
  cluster-bootstrap by entity and by document alongside the pair bootstrap.
- A **blind adversary** reviews before anything is banked, tasked in **both** directions — that the shift
  is overstated AND that it is understated — and specifically tasked to attack the Tier-B relevance
  assumption (that verbatim-name presence is credited to the arm that produces it).
- Sensitivity reported for the one free parameter: Tier-B min name length ∈ {3, 5, 8} and a
  multi-token-names-only variant.
