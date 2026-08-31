# Results — description-aligned embedding, and hybrid BM25 + RRF

**Date:** 2026-08-31 · **Branch:** `feat/single-graph-retrieval`
**Pre-registrations:** `02-prereg-description-aligned-retrieval.md` and `04-prereg-hybrid-bm25-rrf.md`,
both frozen before the harness was written. Substrate deviations were appended to both **before** any
number was computed.
**Harness:** `platform/src/test/tools/desc-aligned-recall.ts` ·
**Artifact:** `prereg-artifacts/desc-aligned-recall-results.json`
**Status:** NOT YET ADVERSARIALLY REVIEWED. Both pre-registrations require a blind adversary before
anything is banked. Read this as a reported result, not a banked one.

---

## 1. The headlines

### Doc 02 — the description-aligned lever **HARMS** retrieval

| | R@1 | R@5 | **R@10** | MRR |
|---|---|---|---|---|
| **ARM-NAME** (bare name) | 0.050 | 0.140 | **0.200** | 0.101 |
| **ARM-DESC** (name + description) | 0.003 | 0.077 | **0.130** | 0.054 |

`ARM-DESC − ARM-NAME` on Recall@10 = **−0.0700**, 95% paired bootstrap CI **[−0.1200, −0.0233]**,
n = 300. The CI is entirely below zero, so by the frozen bar this is **HARMS**, not a tie.

This is the lever the whole arc called "the one retrieval lever never tested". It is now tested, and it
is negative — embedding an entity's authored description alongside its name makes that entity **harder**
to retrieve, not easier.

### Doc 04 — fusion is a **TIE**

`RRF-60 − max(VEC, BM25)` on Recall@10 = **+0.0233**, 95% CI **[−0.0200, +0.0633]**, n = 300. The CI
spans zero, so fusion is **not demonstrated**. Per the frozen text: a tie is a tie, and after doc 22
this particular tie must not be narrated as a near-win.

---

## 2. Why the negative is interpretable rather than a shrug

Every diagnostic the pre-registration demanded *before* the number was read came out in the direction
that makes a negative meaningful:

| diagnostic | value | what it rules out |
|---|---|---|
| description coverage | **98.9% / 99.4%** | not "the lever was unavailable again" (VOID below 50%) |
| **vector divergence** | **99.1%** of 2,093 entities at cosine < 0.999 | not "the two arms were the same vectors" (VOID below 90%) |
| description vs name token-Jaccard | **0.067 / 0.071** | not "the descriptions merely restated the names" |
| description mean length | 81 / 87 chars | there was real text to act on |
| query truncation | **0 of 149** exceed the estimated token limit | not silent truncation |
| n | **300** query pairs from 155 multi-attributed entities | not underpowered (threshold 100) |
| max single-pair swing | **0.0034** | not margin-fragile (threshold 0.02) |

So the descriptions were present, informative, and genuinely changed the vectors — and retrieval still
got worse.

## 3. The mechanism, measured

Verified independently of the retrieval task, on the same cached vectors:

| arm | mean pairwise cosine between entities |
|---|---|
| name-only | `dal-nlp` **0.3922** · `dal-cv` **0.3931** |
| name + description | `dal-nlp` **0.5155** · `dal-cv` **0.5156** |

Appending a description raises inter-entity similarity by **~0.12**, and by an almost identical amount in
both corpora. The composite vectors are **less discriminative**: every entity starts to read as a generic
descriptive sentence, so a query separates them less well. That is a property of the vector set, not of
the scoring, and it explains both the R@10 drop and the sharper R@1 collapse (0.050 → 0.003) — the top
rank is where discriminability matters most.

The near-identical figures across two independently ingested corpora also argue this is not a
one-corpus artifact.

## 4. What the fusion run settled as a by-product

**Retrieved-set and full-ranking RRF were IDENTICAL here — both 0.153 at K=60.** Doc 22's whole story
was that the distinction mattered: its pre-registered full-ranking variant scored 0.444 and FAILED while
the post-hoc retrieved-set variant scored 0.648. This run shows *why* that happened there and not here:
the distinction only bites when an arm is **sparse**. Doc 22's JOIN arm was sparse, so full-ranking
forced it to invent tail ranks. BM25 over entity text is **not** sparse — mean retrieved-set size
**1,027.7**, and **0 of 300** queries retrieved fewer than 10 candidates. With both arms dense, the two
RRF forms coincide by construction.

That is a real narrowing of doc 22's claim: retrieved-set RRF is not a general improvement over
full-ranking RRF, it is a fix for fusing a sparse arm.

**K-robustness** (required): R@10 = 0.163 / 0.170 / 0.153 / 0.153 at K = 10 / 30 / 60 / 100. Flat within
noise, no K-sensitivity to explain away.

**Arm overlap** was 0.187 mean Jaccard on the top 10 — the arms genuinely disagree, so the tie is not the
uninformative "both arms are the same" case the pre-registration warned about. Fusion had room to help
and did not, measurably.

## 5. Limits — stated, not buried

1. **The doc-04 comparison used the WEAKER vector arm.** Doc 04 defines VEC as dense cosine over the
   entity vectors as built, i.e. the name+description composite. But ARM-NAME (0.200) beats both VEC
   (0.130) and BM25 (0.130). So `max(VEC, BM25)` = 0.130 is **not** the best single arm available; the
   best is ARM-NAME, and RRF-60's 0.153 loses to it. Read literally the fusion result is a tie against
   the specified baseline; read against the best arm on the board, fusion also fails. The frozen bar is
   reported as written, and this is what an adversary should be handed first.
2. **Substrate deviations**, both recorded in the pre-registrations before running: corpus B is 110 of
   147 documents (an external `429` org spend limit stopped the ingest), and 10 of corpus A's documents
   lost attribution to my own unscoped test cleanup (doc 03 §9.5). Neither can create a false query
   pair; both reduce coverage.
3. **One task, one oracle.** This is entity retrieval from document text with attribution as ground
   truth. It is the read path a single-graph query uses, but it is not every retrieval task, and a
   description-aligned vector could still help a task that queries *for* a description rather than from
   a document.
4. **BM25 and VEC were compared on the same composite text.** BM25 over name-only text was not run, so
   "BM25 ties VEC" is specific to that text choice.
5. **Absolute numbers are low.** R@10 of 0.130–0.200 against ~1,000 candidate entities, versus a random
   baseline of about 0.009. So the arms are ~15–22x random, but none is a strong retriever on this task.

## 6. What this means for the plan

- **Do not turn on `EMBED_DESCRIPTIONS` for entity vectors.** The flag now works, the descriptions are
  now populated, and with both fixed the composite is *worse* than the bare name for this read path. The
  fix was still necessary — it is what made the question answerable, and it is what populates
  `entities.description` for non-vector uses.
- **`nmemo-uhp.18` (hybrid BM25 + RRF) should not be built on this evidence.** It was raised to P1 on
  four supporting results; this clean pre-registered run does not replicate a fusion win, and it
  explains doc 22's headline as a sparse-arm artifact rather than a general effect.
- **The descriptions are not useless — they are useless *inside the entity vector*.** They are authored,
  informative text (token-Jaccard 0.07 against the name), now stored on 98.9%+ of entities. Somewhere
  they are read as text rather than averaged into a 768-dim point is where they may earn their place.
