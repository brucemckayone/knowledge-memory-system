# Doc 12 — Hybrid lexical+vector retrieval: pre-registration

**Status:** PRE-REGISTERED (frozen before any hybrid number was computed).
Bead nmemo-uhp.16. Follow-up to doc 11 (the description-formula bake-off), whose
adversary (agent a2cd88a) found the bake-off "winner" (dense concept keywords) was a
**lexical / format artifact** — pure token-Jaccard with the embeddings removed reproduced
macro@5 0.778 exactly, while the embedding earned its keep only on *prose* (lexical 0.085
→ embedding 0.422, ~5×). The bake-off's own recommendation was to test **hybrid
lexical+vector retrieval** before committing an authoring convention. This is that test.

Same distrust-the-author discipline as docs 10-11: freeze the bar first, one consistent
(macro) lens, no hyperparameter tuning to win, and a blind hostile adversary on any claim.
See [[verify-empirical-gates]] — I have laundered a favourable reading of this corpus
before (doc 10 lens-swap, doc 11 semantic-vs-lexical). Assume I will try again.

## 1. Questions

Holding the corpus, oracle labels, embed model, recall query, and conservative rank fixed
(docs 10-11 rig), and holding each entity's composed text fixed at the production form
`name\n<formula>`:

- **Q1 (does fusion help?)** Does combining the vector channel with a lexical channel beat
  either channel alone at ranking the true code→rule match?
- **Q2 (the decision-relevant one)** Can an **honest prose** description (`plain`), fed
  through hybrid retrieval, reach the recall that **dense keyword lists** (`concepts`)
  get — i.e. can we author descriptions as normal prose (where the vector index genuinely
  contributes) and recover keyword-level recall via fusion, *instead of* gaming
  descriptions into keyword lists (where doc 11 showed the vector adds ~nothing)?

## 2. Factors (full grid = 4 × 2 × 4 = 32 cells, all reported)

**Code-side formula (4)** — reused verbatim from doc 11 (already frozen & blind-authored):
`plain`, `facets`, `concepts`, `rawcode`.

**Rule-side formula (2)** — reused verbatim: `oneliner`, `richer`.

**Retrieval method (4)** — all at FIXED, STANDARD, pre-declared settings (no tuning):
- `vector` — cosine similarity on `nomic-embed-text` 768-dim (the production channel; the
  doc-10/11 measure).
- `lexical` — raw token-Jaccard on the identical composed text the vector sees. Tokenizer
  frozen in §3.
- `rrf` — Reciprocal Rank Fusion of the `vector` and `lexical` rankings, **K = 60**
  (Cormack et al. 2009 canonical default; NOT tuned). Fused score
  `1/(K+rank_vec) + 1/(K+rank_lex)`.
- `linear` — min-max normalised equal-weight sum `0.5·cos_norm + 0.5·jac_norm`,
  **α = 0.5 fixed** (neutral; NOT tuned). Per-item min-max over that item's 27 rule scores.

The two fusion methods sit at neutral/default settings on purpose: a tuned α or K would be
exactly the laundering the adversary keeps catching. K/α sensitivity is *reported* (§6) as
robustness, never used to pick the headline.

## 3. Frozen tokenizer (the lexical channel — declared before any run)

`tokens(s)` = lowercase `s`, extract every maximal `[a-z0-9]+` run, keep those of length
≥ 2. No stemming, **no stopword removal** (the least-tunable choice, and what the doc-11
adversary's "pure token-Jaccard" most literally means — so the `lexical` column here should
reproduce that adversary's numbers within tokenizer noise; agreement is a cross-check,
disagreement is a flag to report). `jaccard(a,b) = |T_a ∩ T_b| / |T_a ∪ T_b|`, computed on
the SAME `name\n<formula>` text used to embed each side — apples-to-apples with `vector`.

## 4. Method

Reuse doc-11's rig (`recall-bakeoff.ts` machinery): embed each of the 4 code-formula
corpora and 2 rule-formula corpora once via production `entityEmbedTextFor` + `ml.embed`;
`recallCrossCorpusCandidates` for the full cosine ranking. For each of the 8 formula
combos, for each code item, produce three rankings of the 27 rules — vector (cosine),
lexical (Jaccard), and the two fusions — then apply the **same conservative deterministic
rank** as docs 10-11: the true rule's rank = count of rules whose fused score ≥ the true
rule's fused score (ties count AGAINST the true rule). For fusion inputs, `rank_channel(r)`
uses the same stingy definition (count with channel score ≥ r's), so RRF is deterministic.
Score MACRO (per-guideline mean, 9 guidelines) and MICRO (per-item, n=29) recall@k for
k∈{1,3,5,8}. Harness + inputs + full grid committed for reproducibility.

## 5. What the answers mean (frozen decision rules)

- **Primary metric: MACRO recall@5** (the honest lens; docs 10-11).
- **Report ALL 32 cells** — the full grid is the result; no cherry-picking.
- **H1 (fusion helps / doesn't hurt):** SUPPORTED iff, for the majority of the 8 formula
  combos, `rrf.macro@5 ≥ max(vector, lexical).macro@5 − 0.03`; STRONG iff for the
  prose combos (`plain/*`) `rrf.macro@5 ≥ vector.macro@5 + 0.03` (fusion adds real lift on
  prose, where the two channels are most complementary — vector strong, lexical weak).
- **H2 (honest prose + hybrid reaches the keyword ceiling):** SUPPORTED iff
  `rrf(plain, r).macro@5 ≥ vector(concepts, r).macro@5 − 0.05` for at least one rule side r.
  - TRUE ⇒ licenses "author prose descriptions + retrieve with hybrid" as the convention;
    no need to author keyword lists.
  - FALSE ⇒ keyword *content* in the description helps beyond what fusion of a prose
    description recovers; the authoring formula still matters. (Either way is a real finding.)
- This is EXPLORATORY for the absolute magnitudes; the **ranking of methods** is the
  transferable result (docs 10-11 §7). No production default changes on this alone (§7).

## 6. Robustness (pre-committed, reported regardless of outcome)

- RRF **K ∈ {10, 30, 60, 100}** — report the primary contrasts at each K to show the
  ranking is stable; K=60 remains the frozen headline.
- MACRO bootstrap CI (resample the 9 guidelines, fixed seed) on: `rrf(plain)` vs
  `vector(plain)` (H1-strong) and `rrf(plain)` vs `vector(concepts)` (H2).
- Cross-check: `lexical` macro@5 for `plain/oneliner`, `concepts/oneliner`,
  `concepts/richer` vs the doc-11 adversary's throwaway (0.085 / 0.611 / 0.778).

## 7. Adversary (pre-committed, before any claim)

Blind hostile subagent, given the grid + harness + this pre-reg:
1. Is any hybrid "win" just the lexical channel doing the work on dense formulas (rrf ≈
   lexical ≈ vector on `concepts`), with the only genuine complementarity on `plain`?
2. Is the RRF result an artifact of K=60 / the min-max linear an artifact of per-item
   normalisation? Re-derive at other settings.
3. Are H1 / H2 verdicts within macro noise (n=9 bootstrap)? Report spreads, not point wins.
4. Any leakage / construction artifact carried from docs 10-11 that this inherits.

## 8. Pre-committed caveats / what a result does + does NOT license

- **Constructed-corpus FLOOR** (docs 10 §7, 11 §7 carry): opaque dotted-ID rule names,
  checker-decidable slice, n=29 / ~9 situations / 4 singleton guidelines. Absolute recall
  is a floor, not a field magnitude.
- `lexical` here is a **simple token-Jaccard proxy**, not production BM25/tantivy; a real
  hybrid retriever would differ in absolute numbers (ranking should transfer).
- **Licenses:** picking a retrieval method (single vs hybrid) + an authoring style (prose
  vs keyword) as the cross-corpus-ingestion convention on this corpus; the claim "method X
  beats Y by Δ here."
- **Does NOT license:** a field magnitude, that these settings are globally optimal, or any
  adjudication / precision / autonomous-auditor claim (that is docs 4-6's separate story).

---

# RESULTS (post-run, 2026-07-16)

Produced after §1-8 were frozen (commit `3dfe89d`). Harness:
`platform/src/test/tools/recall-hybrid.ts`; full grid + bootstrap + K-sweep + BM25
robustness in `./recall-gate-artifacts/hybrid_results.json`. Deterministic (two runs
byte-identical). Adversary: agent a5f1133 — it re-implemented the whole pipeline from
scratch, matched every base cell to 3 decimals, and ran the BM25 probe below.

## The grid (MACRO recall@5 = primary; higher = better)

| code | rule | vector | lexical(Jaccard) | rrf | linear |
|---|---|---|---|---|---|
| plain | oneliner | **0.422** | 0.130 | 0.285 | 0.359 |
| plain | richer | **0.459** | 0.263 | 0.367 | 0.385 |
| facets | oneliner | **0.570** | 0.430 | 0.493 | 0.489 |
| facets | richer | **0.589** | 0.452 | 0.585 | 0.548 |
| concepts | oneliner | **0.637** | 0.607 | 0.478 | 0.478 |
| concepts | richer | 0.778 | 0.681 | **0.889** | **0.889** |
| rawcode | oneliner | **0.522** | 0.378 | 0.474 | 0.437 |
| rawcode | richer | 0.600 | 0.544 | 0.581 | **0.604** |

As-pre-registered verdicts on the frozen raw-Jaccard channel: **H1 NOT SUPPORTED**
(rrf ≥ best−0.03 in only 3/8 cells), **H1-strong NOT** (on prose, rrf < vector), **H2 NOT**
(rrf(plain) 0.285/0.367 vs vector(concepts) 0.637/0.778). Micro corroborates macro in
direction on all 8 cells (no lens-swap). K-sweep {10,30,60,100} does not rescue H1.

## The adversary's decisive correction: the H1 ranking is a TOY-CHANNEL ARTIFACT

The pre-registered `lexical` channel is **raw token-Jaccard — no IDF**. So stopwords count
equally, and (with the tie-against rank) a prose code item whose true rule shares only
common words scores ~0 Jaccard, ties with ~15 zero-overlap rules, and gets rank ~20 — which
mechanically drags RRF down. The adversary re-ran the fusion with a **textbook Okapi BM25**
lexical channel (k1=1.2, b=0.75 — the SAME "canonical, untuned" discipline as RRF K=60 /
linear α=0.5; same frozen tokenizer). I reproduced BM25 in-harness (`bm25Robustness` in the
JSON):

| code/rule | vector | BM25-lexical | rrf(vec+BM25) | fusion vs vector |
|---|---|---|---|---|
| plain/oneliner | 0.422 | 0.170 | 0.396 | −0.026 (≈tie) |
| plain/richer | 0.459 | 0.348 | 0.293 | below |
| facets/oneliner | 0.570 | 0.489 | **0.641** | **+0.071 BEATS** |
| facets/richer | 0.589 | 0.456 | 0.511 | below |
| concepts/oneliner | 0.637 | 0.500 | 0.478 | below |
| concepts/richer | 0.778 | 0.700 | **0.889** | **+0.111 BEATS** |
| rawcode/oneliner | 0.522 | 0.378 | 0.474 | below |
| rawcode/richer | 0.600 | 0.622 | 0.600 | ≈tie |

Under BM25, fusion is on-par-or-better in **4/8** cells (raw-Jaccard: 3/8) and **beats
vector-alone outright** on facets/oneliner and concepts/richer. So the H1 method-ranking
does **not transfer** past the toy channel — exactly the leg doc 12 §8 predicted "should
transfer" and the one that doesn't.

## What is LICENSED vs VOID

**LICENSED (survives BM25 + the n=9 bootstrap):**
- **H2 negative — the strongest result:** honest prose + hybrid does NOT reach the recall of
  keyword-dense descriptions. rrf(plain) 0.285/0.367 vs vector(concepts) 0.637/0.778; stays
  −0.27…−0.43 under raw Jaccard, stopword-stripped, AND BM25. Bootstrap Δ CI
  **[−0.648, −0.074] excludes 0, P(Δ≤0)=0.997.**
- **Authoring formula ≫ retrieval fusion.** The formula effect (vector: plain 0.42 →
  concepts 0.64–0.78, Δ≈+0.35) dwarfs any fusion effect (±0.1). This is the practical lever.
- **You cannot escape authoring keyword-informative descriptions by hoping hybrid rescues
  plain prose** — prose has too little lexical signal for the lexical channel to add, under
  any lexical variant tried.
- **H1-strong negative "fusion does not HELP prose reach vector level"** (robust to BM25:
  plain/oneliner bm25rrf 0.396 still < vector 0.422).

**VOID / OVER-CLAIMED (do NOT state):**
- ✗ "Hybrid fusion doesn't help" as a general/transferable claim — flips under BM25 (3/8→4/8;
  beats vector on 2 cells). Only "NOT on the frozen raw-Jaccard channel" is licensed.
- ✗ "The vector channel on a keyword-dense description is the strongest single approach" —
  **false**: BM25 fusion 0.889 and (stopword-stripped) lexical-alone both beat vector 0.778
  on concepts/richer.
- ✗ "concepts/richer is a genuine fusion win (+0.111)" as a headline — it is **one singleton
  guideline** (ES.75 / item E023: vector rank 6, lexical rank 1, RRF rank 2). macro
  0.778→0.889 = exactly 7/9→8/9; micro 0.931→0.966 = 27/29→28/29. 4 of 9 guidelines are
  singletons, so macro@5 moves in 0.111 quanta; the contrast's bootstrap CI **[0.000, 0.333]
  touches 0** (the win vanishes in 35% of resamples). Real complementarity on that one item,
  but n=1 — not a headline.
- ✗ "fusion HURTS / drags down prose" (causal) — only "does not clearly help prose" is
  licensed. Raw-Jaccard drag −0.137 shrinks to −0.026 under BM25, and the bootstrap CI
  **[−0.515, 0.259] includes 0, P(Δ≤0)=0.76.**

## Lexical cross-check vs doc 11 (attack #4)

Predicted doc-11 anchors 0.085 / 0.611 / 0.778 → observed **0.130 / 0.607 / 0.681**. Only
concepts/oneliner matches. Notably **concepts/richer raw-Jaccard = 0.681 here, 0.097 BELOW
doc-11's claimed 0.778 (which is exactly this cell's *vector* score).** Under the frozen
tokenizer, raw Jaccard is *below* the vector on concepts/richer — so doc-11's "pure
token-Jaccard reproduces the winner (0.778) exactly" does NOT reproduce here; that
"exact reproduction" was tokenizer-dependent (it needs stopword removal). Doc-12's 0.681 is
the reproducible number. Doc 11's central "the concepts win is fully lexical" claim is
retrospectively **weakened to "largely lexical, tokenizer-sensitive"** — the vector still
contributes on concepts/richer (0.778 > 0.681 raw lexical).

## Practical takeaway (the useful, honest answer)

1. **Spend the effort on the description, not the retrieval trick.** Moving from plain prose
   to keyword-informative descriptions (facets/concepts) is worth ~+0.2–0.35 macro@5;
   fusion is worth at most ~+0.1, and only once the description already carries signal.
2. **A proper hybrid (BM25 + vector) is worth having** — it matches or beats vector-alone in
   half the cells and wins outright on keyword-rich descriptions — but as a **complement to
   good descriptions, not a rescue for plain prose.** (Raw-Jaccard fusion is not worth
   having; use a real IDF-weighted lexical channel.)
3. **Prose can't be rescued to keyword-level recall by fusion** (H2). If descriptions must
   be prose, the vector index is doing the work and you live with lower recall.
4. Caveats from docs 10-11 carry: constructed FLOOR, opaque dotted-ID rule names, n=29 / 9
   guidelines / 4 singletons, checker-decidable slice. Absolute recall is a floor; the
   *rankings* are what transfer — and the one ranking that did NOT transfer (single vs
   hybrid) is called out above. No production default changes on this alone.

## Disposition for nmemo-uhp.16

Experiment DONE, adversarially verified, headline corrected. I again drifted toward a
favourable-to-me framing ("hybrid doesn't help / vector-alone is best / one clean fusion
win") and the blind adversary cut it via a BM25 re-derivation I had not run — the 6th
launder-catch on this corpus family (see [[verify-empirical-gates]]). The decision-relevant
conclusions (H2; formula ≫ fusion; author keywords not prose) are solid and survive. The
method-ranking claims are restricted to "not on the toy channel." Recommend a real
BM25+vector hybrid as the retrieval default *if* cross-corpus recall is later productionised,
paired with keyword-informative description authoring — but that is a Phase-B/field decision,
not licensed by this constructed floor alone.
