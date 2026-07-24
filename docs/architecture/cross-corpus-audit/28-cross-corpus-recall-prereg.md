# Doc 28 — Does the convergent concept layer help CROSS-CORPUS query? (pre-registration)

**Bead:** new (nmemo, cross-corpus-recall) · **Status:** PRE-REGISTRATION — frozen before any recall number
**Date:** 2026-07-24 · **Discipline:** [[verify-empirical-gates]] (24th run). Committed to git BEFORE the run.
Autonomous `/goal`. User-directed pivot: "ask our corpus if these concept mappings actually help cross-graph query."

---

## 0. Why (closing the loop the shape metrics never closed)

doc-23→27 measured the concept space's SHAPE (redundancy, growth). doc-27 showed the convergent (Arm R) space is
low-redundancy (~1.5%, surface-variant). But shape is only worth anything if it makes **cross-corpus query work
better**. doc-20 already ran concept-JOIN recall and it LOST to embedding (0.256 vs 0.467) — root cause was
**extraction non-convergence** (docs that should share a concept didn't), the exact thing doc-23→27 fixed. This
gate tests the payoff question directly: **on a CONVERGENT concept space built across two real corpora, does
concept-JOIN recall genuinely-related cross-corpus documents as well as / better than embedding and BM25?**

## 1. Claim under test
Build one shared concept space over two topically-overlapping real corpora (extraction sees only text, shares one
vocabulary → a concept in corpus A and its restatement in corpus B resolve to the SAME node). Then, querying with
a doc from A, rank docs from B by three retrieval signals. Claim: **the concept-JOIN signal (shared concept nodes)
recovers externally-defined cross-corpus correspondences competitively with dense embeddings and above lexical
BM25.** If it does, the mappings help cross-graph query; if concept-JOIN ≤ BM25, they do not (doc-20 reproduced
even with convergence).

## 2. Corpora + external oracle (frozen)
- **Source:** OpenAlex works whose `primary_location.source.id` = `S4306400194` (arXiv), `publication_year:2023`,
  `type:article`. Abstract text reconstructed from `abstract_inverted_index`. Our pipeline sees **only** the
  abstract text (+ title) — never the OpenAlex concepts.
- **Corpus A (NLP):** `concepts.id:C204321447` (Natural language processing). **Corpus B (CV):**
  `concepts.id:C31972630` (Computer vision). **N = 150 each** (first 150 by OpenAlex default relevance, after
  filters + de-dup). Any work returned in BOTH fetches is DROPPED from both (keep A and B disjoint; avoids
  trivial same-paper bridges).
- **External oracle (ground truth):** each work's OpenAlex `concepts` list (id, level 0–5, score). A cross-pair
  (a∈A, b∈B) is **RELATED** iff a and b share ≥1 OpenAlex concept at **level ≥ L** with **score ≥ 0.3**,
  EXCLUDING the two splitting concepts (C204321447, C31972630) and everything at level ≤1 (too broad, e.g.
  "Computer science", "Artificial intelligence"). **L is selected in §5 from the oracle distribution alone,
  before any arm is scored.** The oracle is entirely external to our extraction/embedding pipeline.

## 3. Our concept space (the mechanism under test — frozen)
The **validated Arm R mechanism** (doc-25/27): sequential controlled-vocabulary extraction with a
relevance-preserving window. One shared vocabulary V across BOTH corpora (interleaved A,B,A,B… by rank so
neither corpus seeds V first). For each doc: embed the abstract, retrieve top-K=100 nearest existing labels by
cosine, Haiku extracts 4–10 concepts reusing an exact shown label or coining a new one; node identity = the
canonical label. Cross-corpus convergence = a concept coined on an A-doc reused on a B-doc → shared node. This is
the SAME mechanism whose low-redundancy was validated in doc-27; no change.

## 4. Retrieval arms + scoring (frozen)
Query set Q = every A-doc with ≥1 RELATED B-doc (recall undefined otherwise); candidate pool = all B-docs.
Symmetrically also B→A. Rank candidates by each arm:
- **concept-JOIN:** score(a,b) = Σ over shared OUR-concept-nodes of IDF(node), IDF = log(N_docs / df(node)) over
  the combined corpus (rarity-weighted overlap — sharing a rare concept counts more; fair vs BM25 which is
  IDF-weighted on words). Report raw shared-count as a secondary.
- **embedding:** cosine( nomic-embed(a.abstract), nomic-embed(b.abstract) ) — the dense baseline (doc-20's winner).
- **BM25:** Okapi BM25 (k1=1.2, b=0.75) over abstract text — the lexical baseline (the canonical form, per
  [[verify-empirical-gates]] rule 37, not raw Jaccard).
- **hybrid:** retrieved-set RRF (K=60, canonical/Cormack form per rule / doc-22) fusing concept-JOIN + embedding.

**Ties** break AGAINST the arm under test (a tied true-hit ranks last among ties) — conservative for concept-JOIN,
which produces integer-ish scores with more ties.

**Metrics** (macro-averaged over Q, both directions pooled unless they diverge): **recall@10 (primary)**,
recall@5, MRR. Paired bootstrap CIs (n = |Q|, 10k resamples) for every arm-vs-arm difference.

## 5. Ground-truth level L selection (pre-registered rule; on the ORACLE only, before scoring any arm)
Compute, for L ∈ {2,3,4}, the distribution of RELATED B-docs per A-query. **Choose the largest L (finest concepts)
whose median related-count per query is ≥ 3 and whose share of queries with ≥1 related B-doc is ≥ 60%.** If no L
satisfies both, fall back to the L maximizing (median ≥3 feasibility). This fixes granularity from the oracle's
own structure — never from any arm's recall. Record the chosen L and the full L-sweep table before §10.

## 6. Bars (FROZEN before any recall number)
Primary metric = macro recall@10.
- **H1 — concept layer beats LEXICAL (floor):** JOIN − BM25 ≥ **+0.05** with paired-bootstrap 95% CI excluding 0.
- **H2 — concept layer competitive with DENSE:** JOIN ≥ embedding − **0.05** (not meaningfully worse than the
  doc-20 winner). Stronger: JOIN ≥ embedding (CI-positive) = the concept layer WINS.
- **Exploratory:** hybrid vs the best single arm.

**"The mappings help cross-graph query" = H1 holds (semantic value over lexical) AND H2 holds (matches dense).**
- H1 ✓ & JOIN ≥ embedding CI-positive → concept layer is the best single recall signal (reverses doc-20). Strong.
- H1 ✓ & H2 ✓ but JOIN≈embedding → concept layer matches dense recall AND adds symbolic/explainable structure at
  no recall cost. Meaningful positive.
- H1 ✗ (JOIN ≤ BM25) → the concept layer does not help recall even convergent; doc-20 reproduced. Honest negative.
- hybrid > both singles → the operational answer is fusion (doc-22 pattern), reported as exploratory.

## 7. Anti-launder controls
- **Oracle is external and unseen by our pipeline** (OpenAlex concepts never enter extraction/embedding); L fixed
  from the oracle distribution before scoring (§5).
- Bars + arms + scoring + tie-rule committed to git BEFORE any recall number.
- **BM25 canonical** (rule 37), **RRF canonical retrieved-set** (doc-22), **ties against concept-JOIN** — every
  discretionary choice set against the mechanism under test.
- Report ALL arms + both directions + bootstrap CIs; a +0.9pt "win" with CI straddling 0 is a TIE (rule 30/50).
- Fetched corpora + oracle + our extractions + all rankings PERSISTED for the adversary (rule 15).
- Both directions (R3/R29): a JOIN win reverses doc-20 (be sceptical — run the lexical + dense baselines honestly,
  which are baked in); a JOIN loss must not be dramatised beyond the pre-registered CI (doc-20 iter-16 lesson).
- No capability claim banked on one corpus pairing; a pass here is exploratory pending a second pairing.

## 8. Blind-adversary protocol
Fresh subagent, raw artifacts only: (1) recompute all arm recalls + CIs independently from the persisted rankings
+ oracle; confirm match. (2) Verify the oracle is external — that OpenAlex concepts never entered our extraction
(diff the extraction input). (3) Verify L was chosen per §5 on the oracle alone, not to favor an arm. (4) Attack
concept-JOIN scoring — is IDF-weighting fair, or does it smuggle in lexical signal? Is the tie-rule really
against JOIN? (5) Attack the ground truth — does "share an OpenAlex concept ≥L" actually mean "related," or is it
so dense/sparse the recall numbers are meaningless? (6) Check the dense/lexical baselines are honestly built
(canonical BM25, real nomic embeddings). (7) Rule whether any positive is real or an artifact of the oracle
construction / corpus overlap. Verdict even if it retracts.

## 9. Disposition
Names the outcome per §6. Answers the user's question — do the concept mappings help cross-graph query — on ONE
real corpus pairing with an external oracle. Does NOT settle multi-pairing generality (a second pairing is the
follow-up if positive) or the semantic-vs-surface question (doc-27).

---

## 10. RESULT

*(added after the run + blind adversary)*
