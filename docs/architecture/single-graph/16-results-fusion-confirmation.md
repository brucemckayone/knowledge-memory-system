# Results — entity+fact fusion, confirmed on an independent extraction (experiment R4)

**Date:** 2026-09-01 · **Branch:** `feat/single-graph-retrieval`
**Pre-registration:** `15-prereg-fusion-confirmation.md` (frozen and committed before any number — `52d8b44`).
**Harness:** `platform/src/test/tools/arxiv-fusion.ts`. **Artifact:** `prereg-artifacts/arxiv-fusion-results.json`,
run log `arxiv-run.txt` (arxiv entity-name cache regenerable, gitignored). **Status:** banked after blind
adversarial review (§5).

---

## 1. The verdict

> **CONFIRMED.** On the independently-extracted arxiv graph, fusing entity-name and fact-level retrieval
> beats name-only on the **strict target-finding** oracle: FACTNAME − ARM-NAME R@10 = **+0.0724**, above 0
> on **all three** pre-registered bootstraps — pair [+0.0413, +0.1034], **entity [+0.0213, +0.1259]**,
> document [+0.0410, +0.1058]. This meets the pre-registered DEMONSTRATED bar (all three above 0), the bar
> R3 reached only byPair on dal, and the effect is **larger** here (+0.0724 vs dal's +0.0424).

The R3 fusion lead — a pre-registered secondary that could not be promoted from its own run — **replicates
as a primary on a completely different extraction of the same documents.** Two independent extractions, two
corpora each, now agree: name and fact retrieval are complementary and their fusion wins.

## 2. Numbers

| arm | strict R@10 | condensed R@10 |
|---|---|---|
| ARM-NAME | 0.1912 | 0.2429 |
| FACT-MAX | 0.2222 | 0.2455 |
| **FACTNAME (RRF-60 name⊕fact)** | **0.2636** | **0.2920** |

- **PRIMARY strict FACTNAME − NAME = +0.0724**, all three bootstraps above 0 → **DEMONSTRATED**.
- **CO-PRIMARY condensed = +0.0491**: pair [+0.0155,+0.0801] and document [+0.0180,+0.0812] above 0,
  **entity [−0.0027,+0.1073] spans 0** (see §4 — CI fragility, not instability).
- Per corpus, both above 0: arxiv-nlp +0.0718 [+0.0276,+0.1160], arxiv-cv +0.0728 [+0.0291,+0.1165].
- k-ladder, FACTNAME beats NAME at every k: R@1 0.070/0.026, R@5 0.191/0.124, R@10 0.264/0.191,
  R@20 0.331/0.284 (strict).
- Secondary FACT-MAX − NAME strict = +0.0310, spans 0 (fact-max alone ties name, as on dal — though here
  its point estimate leads).

## 3. The fusion is genuine complementarity (adversary-verified)

FACTNAME 102 hits > FACT-MAX 86 > NAME 74 — fusion exceeds both components. Decomposition (adversary,
reproduced from raw data): FACTNAME **keeps 24 NAME-only hits** FACT-MAX missed (it would keep 0 if it
merely rode FACT-MAX), **rescues 20 FACT-MAX-only hits**, and produces **15 emergent hits** neither
component had in its own top-10. It is a superset of neither and equal to neither (FACT-MAX top-10 = NAME
top-10 on 0.0% of pairs). This is textbook complementary fusion of two signals that disagree — *what an
entity is called* and *what is said about it*.

## 4. Two qualifications (adversary, applied not defended)

1. **The gain is degree-concentrated.** FACT-MAX is degree-biased: targets it finds have mean fact-degree
   **25.8** vs **13.9** for targets it misses (overall median degree 9, max 89), partly a statistical
   "max over many facts" boost. The comparison is still fair — identical query pairs, ARM-NAME uses no
   facts, the guard is clean — so this does not invalidate the win. But the fusion advantage **concentrates
   on well-connected entities and may shrink on sparse / low-degree graphs.** A production read path should
   expect the lift where the graph is dense around the target, less at the periphery.
2. **"Robust" means byPair/byDocument-robust; the entity-cluster CI is the fragile one.** The dal↔arxiv
   oracle flip (dal: condensed-robust/strict-borderline; arxiv: strict-robust/condensed-borderline) is
   **CI fragility, not effect instability.** The entity bootstrap has only ~195 clusters (vs 387 pairs), so
   it is the widest CI; condensing credits more entities as relevant and lifts NAME (+0.052) more than
   FACTNAME (+0.028), shrinking the delta 0.0724→0.0491 so the fragile entity CI just dips below 0. The
   effect itself is byPair/byDocument-above-0 on **both** oracles in **both** extractions, and no k or
   corpus loses. Honest summary: **the win is byPair/byDoc-robust everywhere; the all-three-bootstrap
   "demonstration" migrates between oracles depending on which has the smaller gap.**

## 5. Blind adversarial review

An independent reviewer re-derived every headline from raw DB + artifacts in its own Python (own fact
parse/normalise, own mulberry32, own bootstrap) and — the load-bearing check — **independently re-embedded
30 random arxiv entity names via Ollama: all 30 cosine = 1.000000** vs the cached vectors; cached vectors
unit-norm and mutually distinct (pairwise cos 0.22–0.85); 5/5 freshly-minted query-doc vectors and 3/3
frozen query vectors also matched. **The arxiv embeddings are genuine — not a dal collision, reuse, or
fabrication.** The primary reproduced bit-for-bit (+0.072351, all three above 0); the condensed entity
SPANS 0 reproduced; the guard is an exact `factToPaper`↔active-fact bijection (2862/2862, 2852/2852, zero
unmapped — no leak, cleaner than dal); normalisation is load-bearing and real (raw norm 20.492). The only
discrepancy was one pair at R@5 (float summation order, rank 5↔6) — not at k=10, not a pre-registered
claim, and it actually confirms the harness's `dot()` loop is faithful. Verdict: **HOLDS**, with the two
qualifications in §4. All four conclusions (strict demonstrated / oracle-flip-is-CI-fragility / genuine
complementarity / extraction-only independence) survive.

## 6. What this establishes, and its honest limit

- **The one build-worthy retrieval finding of the loop.** After three single-substrate ties (name,
  description, pool-re-rank, hybrid, fact-max all tie for target-finding), the fusion of entity-vector and
  fact-vector retrieval is the single lever that separates — and it is now confirmed on two independent
  extractions, on the strict target-finding oracle, with the pre-registered all-three-bootstrap bar met on
  arxiv.
- **Build direction:** a **two-signal read path** — dense-over-names ⊕ dense-over-facts, fused by
  retrieved-set RRF — not a single entity vector. `fact_embedding` (populated on the whole substrate,
  previously read by nothing) earns its place as the **second** retrieval signal.
- **The limit, stated plainly:** independence here is in the **extraction** dimension (same 294 papers,
  fully re-extracted graph), **not** new documents or new domains. The gain is **degree-concentrated**.
  A genuine generalisation claim (new corpus, new domain) and a sparse-graph stress test are the honest
  next confirmations before shipping — this result licenses building the two-signal path and measuring it
  in production, not declaring it universal.

## 7. Process notes

1. The one process error this experiment carried in from R3 (cluster bootstraps omitted for secondaries)
   was pre-committed away here: §4/§6 of the prereg required all three bootstraps for the primary and
   co-primary, and the harness computed them — which is exactly what let "DEMONSTRATED (all three)" be a
   real bar rather than a byPair claim.
2. A first run crashed fail-loud on a missing query vector (an arxiv query doc that was never a dal query
   doc, so uncached) — the correct behaviour (no silent `[]`); fixed by embedding the missing query texts
   into the writable arxiv cache and re-running.
