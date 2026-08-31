# Results — description-aligned embedding, and hybrid BM25 + RRF

**Date:** 2026-08-31 · **Branch:** `feat/single-graph-retrieval`
**Pre-registrations:** `02-prereg-description-aligned-retrieval.md`, `04-prereg-hybrid-bm25-rrf.md` (both
frozen before the harness existed).
**Harnesses:** `platform/src/test/tools/desc-aligned-recall.ts` (pre-registered headline),
`desc-aligned-followups.ts` (secondaries and mechanism checks).
**Artifacts:** `prereg-artifacts/desc-aligned-recall-results.json`, `desc-aligned-followups.json`.
Oracle inputs committed under `cross-corpus-audit/multihop-artifacts/`.

**Substrate: COMPLETE.** Both corpora at 147/147 documents, **n = 354 query pairs**. Deviation 1 (corpus B
truncated by an API spend limit) is **resolved** — the ingest finished and this is the full 294-document
run. Deviation 2 stands: 10 of corpus A's documents lost attribution to my own unscoped test cleanup
(doc 03 §9.5), so 137 of 147 carry it.

**Status:** revised twice — once after blind adversarial review, once after completing the substrate. The
review reproduced the headline bit-exact from an independent implementation and failed to break it with
six attacks; it also confirmed twelve problems with the first draft's surrounding claims. Two of my
claims have since been withdrawn, including one from the revision itself. What changed between runs is
recorded in §7.

---

## 1. The verdict

> At the pre-registered cutoff of 10, a name+description composite entity vector retrieves the target
> **less often** than a bare-name vector. Delta **−0.0621**, 95% CI **[−0.1045, −0.0226]**, n = 354.

| arm | R@1 | R@5 | **R@10** | MRR |
|---|---|---|---|---|
| **ARM-NAME** (bare name) | 0.042 | 0.153 | **0.201** | 0.098 |
| **ARM-DESC** (name + description) | 0.003 | 0.082 | **0.138** | 0.053 |

**Robust to every check run:**

| check | result |
|---|---|
| pre-registered pair bootstrap | [−0.1045, −0.0226] |
| entity-cluster bootstrap (181 clusters) | [−0.1134, −0.0130] |
| document-cluster bootstrap (176 clusters) | [−0.1017, −0.0229] |
| same-epoch guard breach removed (n=332) | −0.0663, [−0.1084, −0.0241] |

All below zero. The guard-breach check makes the effect **larger**, so −0.0621 is a mild understatement.

**Doc 04: fusion is a TIE.** `RRF-60 − max(VEC, BM25)` = **+0.0056**, CI **[−0.0311, +0.0424]**.

## 2. Scope — this is a top-k effect, not lost retrievability

| cutoff | ARM-NAME | ARM-DESC | delta | 95% CI | |
|---|---|---|---|---|---|
| R@1 | 0.0424 | 0.0028 | −0.0395 | [−0.0621, −0.0198] | harms |
| R@5 | 0.1525 | 0.0819 | −0.0706 | [−0.1073, −0.0367] | harms |
| **R@10** | 0.2006 | 0.1384 | **−0.0621** | [−0.1045, −0.0226] | **harms** |
| R@20 | 0.2825 | 0.2260 | −0.0565 | [−0.1017, −0.0113] | harms |
| R@50 | 0.3955 | 0.4040 | +0.0085 | [−0.0424, +0.0593] | tie |
| R@100 | 0.5198 | 0.5254 | +0.0056 | [−0.0452, +0.0565] | tie |
| **R@200** | 0.6328 | 0.7119 | **+0.0791** | **[+0.0254, +0.1299]** | **composite WINS** |

Mean rank **272.7** (NAME) vs **181.0** (DESC); median 87.5 vs 82.0.

The composite loses the head through R@20, ties in the middle, and **significantly wins the tail**. Its
average rank is better. So a pool-then-re-rank read path that pulls 50–200 candidates sees a tie or a
win; a read path that shows the top 10 sees a loss.

## 3. Corpus heterogeneity is real, and is NOT a truncation artifact

The doc 02 pre-registered secondary that the first draft omitted, now at **equal n**:

| corpus | n | ARM-NAME | ARM-DESC | delta | 95% CI | verdict |
|---|---|---|---|---|---|---|
| `dal-nlp` | 177 | 0.1130 | 0.0847 | −0.0282 | [−0.0791, **+0.0169**] | **TIE** |
| `dal-cv` | 177 | 0.2881 | 0.1921 | −0.0960 | [−0.1638, −0.0282] | HARMS |

The adversarial review's strongest structural objection was that the headline was carried by the corpus
Deviation 1 had truncated. **Completing the ingest settles that: it was not.** Both corpora now have 147
documents and exactly 177 query pairs each, and the split persists unchanged — `dal-nlp` ties, `dal-cv`
harms.

So the heterogeneity is a property of the corpora, not of the deviation. The base rates differ sharply
(ARM-NAME 0.113 vs 0.288), so these are not two samples of one task, and the pooled headline averages two
genuinely different regimes. **The pooled number is real; it is not uniform.**

## 4. Mechanism — what survives, and what I withdraw

### 4.1 Withdrawn: "the composite vectors are less discriminative"

The first draft's mechanism. Its numbers came from a script sampling **every 7th entity**, quoted to four
decimals as population values, and its centrepiece — a 0.0001 gap between corpora — was a sampling
artifact (exhaustive: 0.3906/0.5087 and 0.3939/0.5222, a gap of **0.0135**). The inference was invalid
regardless: cosine ranking is invariant to a similarity offset shared by all candidates. And three
measurements point the **other** way:

| check | ARM-NAME | ARM-DESC | the withdrawn story predicted |
|---|---|---|---|
| target's z-score within its candidate set | 1.416 | **1.520** | DESC lower |
| distinct entities ever in a top-10 | 572 | **812** | DESC fewer |
| top-20 hubs' share of top-10 slots | 23.1% | **16.3%** | DESC higher |

The composite arm produces **more diverse** candidate sets and lifts the target **further** above the
crowd. It is not less discriminative.

### 4.2 Also withdrawn: "the harm concentrates where the name is verbatim"

This was the *replacement* mechanism in the revision, and it does **not replicate** on the complete
substrate:

| slice | n | partial run (n=300) | **complete run (n=354)** |
|---|---|---|---|
| name **verbatim** in query | 296 | −0.0797 | **−0.0608** [−0.1081, −0.0135] |
| name **not** verbatim | 58 | −0.0204 | **−0.0690** [−0.1552, +0.0000] |

On the partial substrate the verbatim slice looked like the whole story (−0.0797 vs −0.0204). With the
substrate complete the two slices have **essentially the same point estimate**, and the non-verbatim
slice is merely underpowered (n=58, CI upper bound exactly 0.0000). The verbatim rate itself is stable at
**83.6%**, but it no longer explains where the harm lives.

### 4.3 What the dilution reading still rests on

Two independent lines, neither of which uses the verbatim split:

- **A purely lexical control, no neural encoder involved.** BM25 over name-only entity text beats BM25
  over the composite text by **+0.0593, CI [+0.0141, +0.1045]**. Appending a description degrades an
  exact-term match on its own terms.
- **The description-only arm** (`entityEmbedTextFor(..., 'description')`):

| arm | R@10 |
|---|---|
| name only | **0.201** |
| name + description | 0.138 |
| **description only** | **0.065** |

The composite lands between a strong signal and a weak one. Descriptions carry real but much weaker
signal for document→entity retrieval, and mixing them into the name text costs more than they add — at
small k.

**Honest status of the mechanism: partially supported.** Dilution is consistent with all the evidence and
is directly demonstrated in a lexical retriever, but the query-level test that would have localised it
(the verbatim split) does not separate. I am not claiming a settled mechanism.

## 5. Doc 04, complete

- **`BM25 − VEC` = −0.0085**, CI [−0.0537, +0.0367] — a tie. So doc 15's "BM25@3 0.880 ≥ embedding 0.838"
  and doc 17's "embedding R@1 39–44% vs BM25 72%" **do not replicate on this task**. The first draft
  omitted this required secondary, and the omission happened to strengthen my own recommendation.
- **Per-arm zero-recall:** 0/354 both dense arms, 1/354 BM25.
- **The configuration a production hybrid would ship was never in the pre-registered run:**

| arm | R@10 | vs ARM-NAME (0.2006) |
|---|---|---|
| **RRF-60(name-dense, BM25-over-names)** | **0.2260** — best in the study | +0.0254, CI [−0.0056, +0.0565] |
| RRF-60(composite-dense, BM25-over-composite) | 0.1441 | — |
| BM25 over names alone | 0.1893 | — |
| BM25 over composite alone | 0.1299 | — |

"Fusion is a TIE" is correct as specified. **"Fusion should not be built" is withdrawn** — the like-for-like
hybrid scores the highest absolute R@10 measured, with a positive point estimate and a CI whose lower
bound is −0.0056. That is a near-miss worth its own pre-registered run, not a verdict from here.
- **Retrieved-set vs full-ranking RRF:** equal at R@10 (both 0.1441), but BM25 retrieves 96.8% of the
  universe, not 100%, so they coincide because the remainder is deep tail — **not "by construction"** as
  the first draft said. Doc 22's distinction bites only for a **sparse** arm; BM25 over entity text is not
  sparse (mean retrieved set 1,161.6, 0 of 354 queries under 10 candidates).
- **K-robustness:** 0.150 / 0.158 / 0.144 / 0.144 at K = 10/30/60/100. Flat within noise.

## 6. Diagnostics — including two that were vacuous

Carrying weight: description coverage **98.9% / 99.4%**; description-vs-name token-Jaccard **0.067 /
0.075** (so not restatements); **0 of 176** queries near the embedding token limit; n = 354; arm top-10
overlap 0.184 (the arms genuinely disagree, so the fusion tie is not the uninformative case).

Withdrawn as evidence:

- **Vector divergence (99.2%)** is algebraically the description-coverage number, so its VOID threshold
  can never fire unless the coverage threshold already has. It ruled out nothing.
- **Max single-pair swing (0.0028)** cannot exceed ~1/353 for a binary metric at n=354, so its 0.02
  threshold is structurally untrippable.

**The oracle is incomplete and it penalises ARM-NAME more.** Attribution is fact-mediated, so a document
carries ~10 labelled entities while ~34 corpus entities have their name verbatim in it. A larger share of
ARM-NAME's top-10 slots are unlabelled-but-plausible retrievals than ARM-DESC's, so a complete oracle
would likely **widen** the gap — and absolute R@10 has a ceiling set by labelling, not by retrieval.

## 7. What changed between the partial and complete runs

Recorded so the revision history is auditable rather than tidied away.

| | partial (n=300) | complete (n=354) | effect |
|---|---|---|---|
| headline delta | −0.0700 [−0.1200, −0.0233] | **−0.0621 [−0.1045, −0.0226]** | holds |
| R@20 | −0.0333, spans 0 | **−0.0565, BELOW 0** | harmful range widens to R@20 |
| per-corpus split | complete corpus tie / truncated corpus harms | **still tie / harms, at equal n** | heterogeneity is real, not truncation |
| verbatim split | −0.0797 vs −0.0204 (separates) | **−0.0608 vs −0.0690 (does not)** | replacement mechanism weakened |
| BM25 − VEC | 0.0000 | −0.0085 | tie either way |
| shippable fusion vs NAME | +0.0200 [−0.0100, +0.0533] | **+0.0254 [−0.0056, +0.0565]** | near-miss, both runs |

## 8. Conclusions

- **Do not put descriptions inside the entity vector for a small-k read path.** Supported at k ≲ 20 on
  document-shaped queries, and consistent across two independently ingested corpora in sign.
- **Descriptions are not a failed idea.** They win the tail (R@200 +0.0791, CI excludes zero), improve
  mean rank, and give more diverse candidate sets. Pool-then-re-rank is where they may pay.
- **`nmemo-uhp.18` is not settled here.** The measured configuration ties; the shippable one scores the
  best R@10 in the study with a CI lower bound of −0.0056. It needs its own pre-registered run.
- **Docs 15 and 17's BM25-over-dense evidence does not replicate on this task.** Worth carrying forward.
- **The fixes were necessary regardless.** `EMBED_DESCRIPTIONS`, the summary carry-through and the
  fact-vector work are what made the question answerable, and they populate `entities.description` on
  99%+ of entities for every non-vector use.

## 9. Process notes, against myself

1. The first mechanism was a **sampled statistic quoted as a population value to four decimals**, whose
   most persuasive feature was the sampling artifact. I called it "verified independently".
2. **Three pre-registered secondaries were omitted** from the first draft (per-corpus split, per-arm
   zero-recall, `BM25 − VEC`); the two that mattered both cut against my recommendation.
3. I presented two structurally-untrippable checks as if they ruled something out.
4. My **replacement** mechanism (verbatim concentration) failed to replicate once the substrate was
   complete. Both of my mechanism stories have now been withdrawn; only the lexical-control and
   description-only evidence survives.
5. The follow-up harness first reported the description-only arm at exactly **0.0000** — a silent no-op
   from an unembedded text set collapsing the arm to an empty ranking. Caught by disbelieving a clean zero.
6. I committed a **66MB `embed-cache.json`** by blanket-adding a directory. Now untracked and gitignored;
   the blob remains in this branch's history.
