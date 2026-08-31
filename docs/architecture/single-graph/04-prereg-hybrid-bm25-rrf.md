# Pre-registration — hybrid BM25 + retrieved-set RRF

**Status:** FROZEN pre-registration. Written and committed BEFORE the harness exists and before any
number was computed. **The measurement has NOT been run.**
**Date:** 2026-08-31 · **Branch:** `feat/single-graph-retrieval` · **Bead:** `nmemo-uhp.18` (raised to P1)

---

## 1. Why this is the best-supported retrieval change, and why it is still unproven

Four independent results point the same way, and none of them is cited on the bead:

| result | finding |
|---|---|
| `nmemo-uhp.15` | token-Jaccard reproduced a "semantic" win **exactly** — the win was lexical |
| doc 15 | BM25@3 **0.880** ≥ embedding 0.838 |
| doc 17 | embedding R@1 **39–44%** vs BM25 **72%** (prefix tricks did not rescue it) |
| doc 22 | blind, un-tuned, k-robust **retrieved-set** RRF **0.648** vs cosine 0.467 and JOIN 0.444 |

But the doc-22 headline is **not bankable**, for reasons its own author recorded:

- **Retrieved-set RRF was not pre-registered.** The pre-registered variant was *full-ranking* RRF, which
  scored 0.444 and FAILED. Retrieved-set was tried afterwards, and post-hoc is post-hoc.
- **n = 29.** The retrieved-set − cosine delta was +0.182 with a CI whose lower bound was **exactly
  0.000**. That is not a result; that is a boundary.
- **The clearance was carried by 2 elements.** Strip `F.16` and retrieved-set is 0.537, below the 0.567
  bar. "Beats both arms" survived; "clears the bar" did not.

So the qualitative claim (blind fusion beats both single arms) has support, and the quantity does not.
This document fixes a clean run of the quantity.

## 2. Do not reuse the doc-22 oracle, and do not reuse doc 30's either

Two oracles are available from the arc and **both are rejected here**:

- **The doc-12/21/22 code↔guideline fixture (n=29).** Too small — it is what produced a CI touching zero.
- **The co-citation oracle (doc 30).** Rejected as *biased toward the arm under test*: doc 30's own
  adversary established that **cosine predicts co-citation at AUC 0.79**, so the oracle is
  embedding-correlated. Using it to adjudicate lexical-vs-vector would hand the vector arm a structural
  advantage, and that is exactly the confound that compromised docs 28–30.

## 3. Task and oracle — reused from `02-prereg-description-aligned-retrieval.md`

Deliberately the **same** task, so the two pre-registrations share one substrate, one query set and one
ground truth, and their results are directly comparable. This is a **separate** pre-registration with its
own arms and its own bar; `02` is frozen and is not edited by this document.

- **Substrate:** `dal-nlp` + `dal-cv` — the 294-document arXiv corpora re-ingested with the fixed
  pipeline.
- **Query pair:** (entity `e`, document `d`) where `e` is attributed to `d`, `e` is attributed to **at
  least 2** documents, and `d` is **not** `e`'s first-attributing document.
- **Query text:** the document's title and abstract.
- **Candidate set:** all entities in `d`'s corpus.
- **Ground truth by construction** from per-document attribution. No LLM, no external oracle, and no
  embedding-correlated oracle.

Why this task suits the question: BM25 and dense retrieval are being compared on **entity retrieval from
document text**, which is the actual read path a single-graph query uses. And the oracle is an identity
relation, so it cannot favour either arm.

## 4. Arms

Four arms over the identical query set and candidate set. Every arm returns a ranked list of entities.

| arm | definition |
|---|---|
| **VEC** | dense cosine over entity vectors. Exact, in-process — not through the HNSW index, for the reason in `02` §3 (post-filtered HNSW recall is itself a variable on this branch; see migration 058) |
| **BM25** | Okapi BM25 over entity text, `k1 = 1.2`, `b = 0.75` — the standard defaults, **fixed, not tuned**. Tokenisation: lowercase, split on non-alphanumerics, no stemming, no stopword list |
| **RRF** | **retrieved-set** Reciprocal Rank Fusion of VEC and BM25, `K = 60`. Canonical Cormack (2009) form: each arm contributes `1/(K + rank)` for the items **it actually retrieved**, and contributes nothing for items it did not. This is the variant doc 22 found and failed to pre-register |
| **RRF-FULL** | full-ranking RRF, `K = 60` — every arm assigns a rank to every candidate. Included **because it was doc 22's pre-registered variant and it failed**, so running both settles whether retrieved-set-vs-full-ranking is the real effect rather than leaving it a post-hoc story |

Both arms see the **same entity text**, so this measures the retrieval function and not a text
difference.

## 5. Metric and bar — pre-registered

**Headline metric: Recall@10** — the fraction of query pairs whose target entity is in the top 10.

**Primary bar.** `RRF − max(VEC, BM25)` on Recall@10, paired per query pair, with a **95% bootstrap CI
(10,000 resamples over query pairs)**:

| CI | verdict |
|---|---|
| entirely above 0 | **fusion DEMONSTRATED** — it beats the better single arm |
| spans 0 | **TIE.** Fusion is not demonstrated. A tie is a tie, and after doc 22 this specific tie must not be narrated as a near-win |
| entirely below 0 | fusion **HARMS** |

Note this bar is **harder** than doc 22's. Doc 22 required beating cosine by an arbitrary +0.10
("≈ 1 guideline-quantum"), which is where the margin-fragility came from. Here the comparator is the
*better arm chosen after the fact*, and the margin required is only "CI excludes zero" — a bar that is
about evidence rather than about a hand-picked quantum.

**Secondary, reported and explicitly NOT promotable:** Recall@1, Recall@5, MRR; the per-corpus split;
`BM25 − VEC` (which of the four prior results replicates); and `RRF − RRF-FULL`.

**K-robustness (required, not optional).** Report RRF at `K ∈ {10, 30, 60, 100}`. Doc 22's result was
k-robust and that was load-bearing evidence it was not an artifact. If the headline holds only at one K,
say so and treat it as fragile.

## 6. Diagnostics reported unconditionally

1. **n** — query pairs, and the number of distinct multi-attributed entities behind them.
2. **Arm overlap** — mean Jaccard of the two arms' top-10 sets. Fusion can only help where the arms
   disagree; if overlap is very high, a tie is uninformative rather than evidence against fusion.
3. **Per-arm zero-recall rate** — fraction of queries where an arm returns nothing useful.
4. **Retrieved-set sizes** — how often BM25 retrieves fewer than 10 candidates, since that is precisely
   where retrieved-set and full-ranking RRF diverge.
5. **Whether any query text exceeded the embedding model's token limit** (nomic truncates silently).

## 7. Kill conditions

- **n < 100 query pairs** → UNDERPOWERED, no verdict. This is the doc-22 failure (n=29, CI lower bound
  0.000) and repeating it would be worse than not running.
- **Arm top-10 overlap > 0.90** → the arms are near-identical on this task; report the overlap and draw
  no conclusion about fusion.
- **A single query pair moving the headline by more than 0.02** → report as margin-fragile and name the
  pair, the way doc 22's `F.16` dependence should have been reported up front.

## 8. Process commitments

- Committed before the harness is written. Not edited once numbers exist, except to append results in a
  clearly marked section.
- The harness is audited against this frozen text before the numbers are read.
- BM25 parameters and the RRF `K` are **fixed at standard values before running**. No tuning; a swept
  parameter would make the headline post-hoc, which is the whole reason this re-run exists.
- **Blind adversary** before banking, tasked in **both** directions.
- Deterministic set arithmetic; no LLM in the measurement path.
- Production build (`nmemo-uhp.18`) happens only **after** a result, not alongside it.

---

## APPENDED BEFORE ANY NUMBER WAS COMPUTED — substrate deviations

Recorded here, in the frozen document, **before the harness was run**, so that neither deviation can be
presented as a footnote after the fact. Both reduce coverage; neither can create a false query pair,
because every pair still comes from a true attribution.

**Deviation 1 — corpus B is 110 of 147 documents (74.8%).** The re-ingest stopped on an external
blocker: the Claude API returned `429` with *"You've hit your org's monthly spend limit"*. The harness is
resumable and did not mark the batch done, so the remaining 37 documents can be ingested whenever credit
is available. Documents are processed in corpus-file order (OpenAlex work ids, effectively arbitrary with
respect to topic), so a 74.8% prefix is not systematically biased by subject — but it is a prefix, not a
random sample, and that is the honest characterisation.

**Deviation 2 — 10 of corpus A's 147 documents have no attribution.** Self-inflicted: while the ingest
was running I ran `promotion.test.ts` against the same database, and its cleanup contained three
unscoped `DELETE FROM staging_proposed_*` statements. That removed the in-flight batch's staging rows
before the harness could snapshot paper-level attribution from them, and staging is transient by design
so it could not be reconstructed. Ledger positions 60–69. All three suites carrying that pattern are now
scoped. Details in `03-blocker-closeout-findings.md` §9.5.

**Not repaired, deliberately.** Re-ingesting those 10 documents would extract them a second time, making
10 of 294 documents non-uniform in a substrate whose whole purpose is a controlled comparison. With
n = 300 the power is not the binding constraint, so the loss is left in place rather than traded for
an inhomogeneity.

**State at run time [M]:**

| | corpus A (`dal-nlp`) | corpus B (`dal-cv`) |
|---|---|---|
| documents ingested | 147 / 147 | **110 / 147** |
| documents with attribution | 137 | 110 |
| multi-attributed entities | 87 | 68 |
| query pairs contributed | 177 | 123 |
| entities | 1,133 | 960 |
| description coverage | **98.9%** | **99.4%** |

**n = 300 query pairs**, against the pre-registered kill threshold of 100. Description coverage is far
above the 50% VOID threshold in both corpora. So the run proceeds, and its headline is reported for the
substrate described above rather than for a complete 294-document one.
