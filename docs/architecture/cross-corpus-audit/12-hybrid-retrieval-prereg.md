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

# RESULTS (post-run)

_(appended after §1-8 frozen & committed)_
