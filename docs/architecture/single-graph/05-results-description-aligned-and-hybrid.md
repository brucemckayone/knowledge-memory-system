# Results — description-aligned embedding, and hybrid BM25 + RRF

**Date:** 2026-08-31 · **Branch:** `feat/single-graph-retrieval`
**Pre-registrations:** `02-prereg-description-aligned-retrieval.md`, `04-prereg-hybrid-bm25-rrf.md` (both
frozen before the harness existed; substrate deviations appended before any number was computed).
**Harnesses:** `platform/src/test/tools/desc-aligned-recall.ts` (pre-registered headline) and
`desc-aligned-followups.ts` (everything added after review).
**Artifacts:** `prereg-artifacts/desc-aligned-recall-results.json`, `desc-aligned-followups.json`
**Status:** REVISED after blind adversarial review. The review reproduced the headline bit-exact from an
independent implementation and failed to break it with six attacks — and confirmed twelve problems with
what the first draft said *about* it. That draft's mechanism section is **withdrawn**. Everything below
is recomputed by this repo's own harness.

---

## 1. The verdict — survives, narrowly scoped

**The claim that holds:**

> On this task, this oracle and this substrate, at the pre-registered cutoff of 10, a name+description
> composite entity vector retrieves the target **less often** than a bare-name vector.
> Delta **−0.0700**, 95% CI **[−0.1200, −0.0233]**, n = 300.

| | R@1 | R@5 | **R@10** | MRR |
|---|---|---|---|---|
| **ARM-NAME** (bare name) | 0.050 | 0.140 | **0.200** | 0.101 |
| **ARM-DESC** (name + description) | 0.003 | 0.077 | **0.130** | 0.054 |

Robust to everything tried: pair, entity-cluster and document-cluster bootstraps all stay below zero;
still negative with the guard-breaching pairs removed; monotone across R@1/R@5/R@10/MRR; negative in both
corpora's point estimates; and conservative with respect to both known leaks.

**Doc 04: fusion is a TIE.** `RRF-60 − max(VEC, BM25)` = **+0.0233**, CI **[−0.0200, +0.0633]**.

## 2. What does NOT hold — the first draft's claims, withdrawn

### 2.1 The mechanism section is withdrawn entirely

The first draft claimed the composite vectors are "less discriminative", evidenced by mean pairwise
cosine rising 0.392 → 0.516 "by an almost identical amount in both corpora (0.5155 / 0.5156)".

**That was wrong four ways, and I found the numbers unreproducible when I recomputed them myself:**

| | first draft | exhaustive, all pairs |
|---|---|---|
| `dal-nlp` name / name+desc | 0.3922 / **0.5155** | 0.3906 / **0.5087** |
| `dal-cv` name / name+desc | 0.3931 / **0.5156** | 0.3959 / **0.5213** |

The draft's figures came from a script that sampled **every 7th entity** and reported four decimal
places as if they were population values. The rhetorical centrepiece — a 0.0001 gap between corpora — was
a sampling coincidence. **The real gap is 0.0126, a hundred times larger.**

And the inference was invalid regardless. Three independent measurements point the *other* way:

| check | ARM-NAME | ARM-DESC | the withdrawn mechanism predicted |
|---|---|---|---|
| target's z-score within its candidate set | 1.341 | **1.448** | DESC lower |
| distinct entities ever in a top-10 | 512 | **705** | DESC fewer |
| top-20 hubs' share of top-10 slots | 24.6% | **18.4%** | DESC higher |
| pairwise sd (`dal-nlp`) | 0.0713 | 0.0719 | DESC tighter |

Mean pairwise cosine is in any case first-order irrelevant to a ranking: cosine ranking is invariant to
a similarity offset shared by all candidates. The composite arm is *more* diverse in its top-10s and lifts
the target *further* above the crowd. It is not less discriminative.

### 2.2 "Harder to retrieve" is false beyond the top ~20

| cutoff | ARM-NAME | ARM-DESC | delta | 95% CI |
|---|---|---|---|---|
| R@1 | 0.0500 | 0.0033 | −0.0467 | [−0.0733, −0.0233] |
| R@5 | 0.1400 | 0.0767 | −0.0633 | [−0.1033, −0.0267] |
| **R@10** | 0.2000 | 0.1300 | **−0.0700** | [−0.1200, −0.0233] |
| R@20 | 0.2733 | 0.2400 | −0.0333 | [−0.0867, +0.0200] |
| R@50 | 0.3933 | 0.4100 | +0.0167 | [−0.0400, +0.0733] |
| R@100 | 0.5200 | 0.5367 | +0.0167 | [−0.0333, +0.0667] |
| **R@200** | 0.6267 | 0.7100 | **+0.0833** | **[+0.0300, +0.1367]** |

Mean rank **257.4** (NAME) vs **177.9** (DESC); median 84.5 vs 81.0.

So this is a **top-k precision effect, not a loss of retrievability**. R@10 was correctly pre-registered
as the only promotable number, so the verdict stands — but any read path that pulls a pool of 50–200 and
re-ranks sees a tie or a win.

### 2.3 The complete corpus, on its own, is a tie

A doc 02 **pre-registered secondary** that the first draft omitted:

| corpus | n | ARM-NAME | ARM-DESC | delta | 95% CI | verdict |
|---|---|---|---|---|---|---|
| `dal-nlp` (147/147, **complete**) | 177 | 0.1130 | 0.0847 | −0.0282 | [−0.0791, **+0.0169**] | **TIE** |
| `dal-cv` (110/147, **truncated**) | 123 | 0.3252 | 0.1951 | −0.1301 | [−0.2195, −0.0407] | HARMS |

Both point estimates are negative, so this is not a sign flip. But the effect is ~4.6x larger on the
corpus that Deviation 1 truncated, and the two corpora have very different base rates (0.113 vs 0.325),
so they are not two samples of one task. The pre-registrations dismissed the deviations with "neither can
create a false query pair" — true, and beside the point: the deviation sits on the corpus doing the work.

## 3. The mechanism that the evidence actually supports: lexical dilution

**The entity's canonical name appears verbatim in the query text in 251 of 300 pairs (83.7%).** Mean
name-token coverage of the query text is 0.948. Split on it:

| slice | n | ARM-NAME | ARM-DESC | delta | 95% CI |
|---|---|---|---|---|---|
| name **verbatim** in query | 251 | 0.2191 | 0.1394 | −0.0797 | [−0.1355, −0.0239] |
| name **not** verbatim | 49 | 0.1020 | 0.0816 | −0.0204 | [−0.0816, **+0.0408**] |

The measured harm lives where the name is literally a substring of the query, and ARM-NAME's own recall
is 2.1x higher there. The non-verbatim slice is underpowered (n=49), so this is a strong indication, not
a settled decomposition.

**Corroborated with no neural encoder in the loop.** BM25 over name-only entity text beats BM25 over the
composite text by **+0.0533, CI [+0.0033, +0.1033]** — the same dilution, from a pure lexical retriever.

**And the decisive third arm** (`entityEmbedTextFor(..., 'description')`, never run in the first pass):

| arm | R@10 |
|---|---|
| name only | **0.200** |
| name + description | 0.130 |
| **description only** | **0.063** |

The composite lands between a strong signal and a weak one. Descriptions carry real but much weaker
signal for document→entity retrieval, and appending them to the name dilutes the name's exact match.

So the honest statement is: **appending a description dilutes an exact-name match, on a task where 84%
of targets are exact-name matchable.** Not "descriptions harm retrievability".

## 4. Doc 04, corrected

**Two required secondaries the first draft omitted, one of which cuts against its own recommendation:**

- **`BM25 − VEC` = 0.0000 exactly**, CI [−0.0467, +0.0467]. A flat tie. So doc 15's "BM25@3 0.880 ≥
  embedding 0.838" and doc 17's "embedding R@1 39–44% vs BM25 72%" **do not replicate here**. The first
  draft killed `nmemo-uhp.18` on "does not replicate a fusion win" without reporting that the prior
  evidence which raised it to P1 also failed to replicate — an omission that happened to strengthen my
  own recommendation.
- **Per-arm zero-recall:** 0/300 both dense arms, 1/300 BM25.

**The configuration a production hybrid would actually ship was never run.** Doc 04's VEC arm is the
composite, so `max(VEC, BM25)` = 0.130 is not the best arm on the board. Running the missing arms:

| arm | R@10 | vs ARM-NAME (0.2000) |
|---|---|---|
| **RRF-60(name-dense, BM25-over-names)** | **0.2200** — best in the study | +0.0200, CI [−0.0100, +0.0533] |
| RRF-60(composite-dense, BM25-over-composite) | 0.1533 | — |
| BM25 over names alone | 0.1833 | — |
| BM25 over composite alone | 0.1300 | — |

"Fusion is a TIE" is correct. **"Fusion should not be built" over-reads a configuration that was never
tested** — the like-for-like hybrid is the highest absolute R@10 measured, with a positive point estimate.

**Retrieved-set vs full-ranking RRF.** Equal at R@10 (both 0.1533), but the target's rank differs on
**16 of 300** queries and the two MRRs differ in the artifact. BM25 retrieves 96.8% of the universe, not
100%, so they coincide because the remainder is deep tail — **not "by construction"**, as the first draft
said. The narrowing of doc 22 is still directionally right: the retrieved-set/full-ranking distinction
bites only for a **sparse** arm, and BM25 over entity text is not sparse (mean retrieved set 1,027.7).

**K-robustness:** 0.1633 / 0.1700 / 0.1533 / 0.1533 at K = 10/30/60/100. Flat within noise.

## 5. Two of the first draft's "diagnostics" were vacuous

Withdrawn as evidence:

- **Vector divergence 99.1%** is algebraically the description-coverage number: 19 of 2,093 entities have
  a blank description, and (2093−19)/2093 = 0.9909. Any non-blank description produces divergence by
  construction, so `divergence < 90% → VOID` can never fire unless `coverage < 50% → VOID` already has.
  It ruled out nothing coverage had not already ruled out.
- **Max single-pair swing 0.0034** cannot exceed ~1/299 = 0.0033 for a binary metric at n=300, so the
  0.02 threshold is structurally untrippable. It was also doc 04's kill condition reported inside doc
  02's diagnostics table.

The diagnostics that **do** carry weight: description coverage (98.9% / 99.4%), description-vs-name
token-Jaccard (0.067 / 0.071, so not restatements), 0 of 149 queries truncated, and n = 300.

## 6. Robustness checks that held

- **Cluster bootstraps.** The pre-registered pair resampling is anti-conservative here (300 pairs from
  155 entities and 149 documents). By entity: **[−0.1284, −0.0147]**. By document: **[−0.1158, −0.0261]**.
  Both still entirely below zero.
- **Held-out guard breach.** The guard drops the first-attributing *document*, but descriptions are
  authored per 10-document *epoch*, so **21 of 300 pairs (7.0%)** share an epoch with the mint. Removing
  them makes the effect **larger**: −0.0753, CI [−0.1254, −0.0251]. So −0.0700 is a mild
  **understatement**. This is what the "audit the harness against the frozen text" commitment exists to
  catch, and it went uncaught until review.
- **The oracle is incomplete, and it penalises ARM-NAME more.** Attribution is fact-mediated, so a
  document carries ~9.9 labelled entities while ~34.0 corpus entities have their name verbatim in it.
  26.2% of ARM-NAME's top-10 slots are unlabelled verbatim-present entities, versus 20.6% for ARM-DESC.
  A complete oracle would likely **widen** the gap. It also means absolute R@10 has a ceiling set by
  labelling, not by retrieval — so §1's absolute numbers understate both arms.

## 7. Revised conclusions

- **Do not put descriptions inside the entity vector for a top-k read path.** That is the supported
  claim, at k ≲ 20, on document-shaped queries where the entity name is usually present literally.
- **Descriptions are not a failed idea.** They help at deeper cutoffs (R@200 +0.0833, CI excludes zero),
  improve mean rank, and produce more diverse candidate sets. A pool-then-re-rank architecture is where
  they may pay.
- **`nmemo-uhp.18` is not settled by this run.** The measured configuration ties; the shippable
  configuration (dense-over-names + BM25-over-names) scores the highest R@10 in the study with a positive
  point estimate and a CI spanning zero. It needs its own pre-registered run, not a verdict from here.
- **The prior evidence for BM25 over dense does not replicate on this task** (BM25 − VEC = 0.0000). That
  is a finding about docs 15 and 17 worth carrying forward.
- **The fixes remain necessary regardless.** `EMBED_DESCRIPTIONS`, the summary carry-through and the
  fact-vector work are what made this question answerable at all, and they populate
  `entities.description` on 98.9%+ of entities for every non-vector use.

## 8. Process notes, recorded against myself

1. The withdrawn mechanism was a **sampled statistic quoted as a population value to four decimals**, and
   its most persuasive feature (near-identity across corpora) was the sampling artifact. I described it as
   "verified independently".
2. **Three pre-registered secondaries were omitted** from the first draft (per-corpus split, per-arm
   zero-recall, `BM25 − VEC`), and the two that mattered both cut against my recommendation.
3. I presented two structurally-untrippable checks as though they ruled something out.
4. The follow-up harness initially reported a description-only arm at **exactly 0.0000** — a silent no-op,
   because the original run never embedded those texts and a `.every(Boolean)` guard collapsed the arm to
   an empty ranking. I caught that one myself, by disbelieving a clean zero. The corrected value is 0.063.
5. The oracle artifacts (`attribution-dal-*.json`, `ingest-ledger-dal-*.json`) were untracked, so the
   result was not reproducible by anyone else. Now committed.
