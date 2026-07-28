# Doc 35 — Multi-hop concept-mediated cross-corpus recall (pre-registration)

**Status:** PRE-REGISTRATION — written and committed **before the corpora finished ingesting**, so
before any number of any kind exists. **Date:** 2026-07-28
**Discipline:** [[verify-empirical-gates]] (30th run on this feature family). Nothing in §4–§8 may
change once the first number is computed. **Bead:** nmemo-uhp.19.

---

## 0. Why this is not another re-run of docs 28–33

Every prior experiment measured **single-hop shared-label coincidence over a flat set of
disconnected entities** — doc 34 §3 established that as a fact, not an opinion: `corpus-ingest.ts`
wrote bare entities and **zero facts**, so a concept landed on an entity and traversal stopped.
The arXiv arc (28–32) had no entity graph at all; it was label overlap on abstracts.

What has changed, and only now makes this question askable:

- **Corpus-scoped promotion** (`dcfcfb8`) — each corpus is now its own entity+fact graph, and the
  entity reuse-by-name lookup is corpus-filtered (it was an unscoped fusion path).
- **Real per-corpus graphs** — the production epoch pipeline ingests each paper set, producing
  branching internal structure (pilot: 12 entities / 57 facts from 4 abstracts, degree up to 20,
  chains like `llava --trained_on_data_from--> gpt-4 --built_by--> openai`).
- **A multi-hop recall primitive** (`a300c7a`) — with a reduction anchor proving that at hops=0 it
  returns *exactly* the shipped single-hop candidate set (10 pairs, zero set difference), so any
  difference at hops>0 is attributable to traversal, not to a rewritten JOIN.
- **The shared-vocabulary conform mechanism** wired into concept extraction (`31b10c0`), owed since
  doc-20 §13(d).

So this run tests the architecture the user described and doc 04/19 specify, for the first time:
concepts as a super-graph above mutually-separate corpora, reached *through* each corpus's own
structure.

## 1. The exact question

> Does concept-mediated recall that traverses each corpus's entity+fact graph connect **co-cited
> cross-corpus paper pairs** that single-hop shared-concept matching misses — and does the added
> reach carry **discrimination**, or does it merely reach everything?

The second clause is the whole gate. doc-32 already produced the cautionary case: pushing
extraction density raised coverage slightly while **lowering** discrimination (JOIN AUC 0.579 <
sparse 0.596), because the newly-shared nodes were generic hubs. Multi-hop traversal is a *stronger*
version of the same temptation. Coverage without discrimination is a FAIL here, by construction.

## 2. Scope fences (R8/R11)

- **NOT** an adjudication or LLM-judgment test. No adjudicator runs. This measures candidate
  generation over a symbolic graph.
- **NOT** a field-prevalence or adoption claim. Constructed corpora, one domain pair.
- **NOT** a rehabilitation of docs 28–33. Their negatives stand *for what they measured*
  (single-hop label overlap on factless corpora). A pass here would mean the mechanism needs
  structure, not that the earlier runs were wrong.
- **NOT** a test of the good oracle. doc 34 §7 recorded why: the production prose extractor returns
  **zero** entities from C++ and from Core Guidelines text, so doc-20's external clang-tidy oracle
  is unusable for this. We are on the weaker co-citation oracle by necessity, and §8 carries that.

## 3. Corpora, oracle, and graph

- **Corpora:** `arxiv-nlp` (corpus-A, 147 NLP papers) and `arxiv-cv` (corpus-B, 147 CV papers),
  OpenAlex arXiv source S4306400194, 2023, disjoint. Ingested through the production epoch pipeline
  with `EMBED_DESCRIPTIONS=true`.
- **Oracle:** the FROZEN co-citation substrate `cc-cociters.json`. A pair is co-cited iff
  `|citers(a) ∩ citers(b)| ≥ 1`. **Known limitation, stated here and not later:** doc-30's adversary
  showed this oracle is ~79% cosine-predictable (AUC 0.79), so it only *partially* de-circularises
  the comparison against embedding.
- **Hard subset (the slice that matters):** pairs with doc-embedding cosine **< 0.615** — embedding's
  own blind spot, per doc-31, using the frozen `cc-docemb.json` and the frozen τ.
- **Paper attribution:** via the validated chain in doc 34 §7.2 (`doc-attribution.ts`). The run is
  **void** unless ≥95% of canonical facts attribute to a paper (the harness exits non-zero below
  that) — a degraded attribution map must not be silently scored on.

## 4. Arms (all deterministic; no LLM at scoring time)

| arm | mechanism |
|---|---|
| **S0** single-hop concept | `recallMultiHopConcepts(hops=0)` — provably identical to the shipped `recallConceptCandidates`. The doc-33 baseline. |
| **M1** multi-hop, 1 hop | `recallMultiHopConcepts(hops=1)` |
| **M2** multi-hop, 2 hops | `recallMultiHopConcepts(hops=2)` |
| **E** dense embedding | cosine over the frozen `cc-docemb.json` paper vectors — the incumbent that beat the concept layer on every prior oracle |
| **B** BM25 | textbook k1=1.2, b=0.75 over title+abstract, the committed implementation in `recall-hybrid.ts` (R37: never raw Jaccard) |

Entity-level pairs are lifted to paper-level via the attribution map: a paper pair is *linked* by an
arm iff any of paper A's entities is linked to any of paper B's entities by that arm.

## 5. Frozen path-cost parameters (R26 — set now, never tuned to results)

`decay = 0.5`, IDF over concept document-frequency as implemented in `concept-multihop.ts`,
`minScore = 0`, `hops ∈ {0,1,2}` only. **These are frozen.** If traversal proves computationally
infeasible at hops=2 the arm is reported as *not run*, never silently re-parameterised.

## 6. Metrics (element-level lens held throughout, R35)

- **Coverage (primary):** fraction of co-cited cross-corpus paper pairs an arm links at all.
  Reported on the full oracle **and** on the text-dissimilar slice.
- **Cells:** number of paper pairs the arm proposes — the cost term. Coverage without cells is
  meaningless (doc 33 §13.1).
- **Discrimination (co-primary):** AUC of the arm's score as a co-citation classifier over all
  147×147 pairs, tie-corrected Mann-Whitney.
- **Frontier:** each arm as a (cells, coverage) point; `frontier_at(c)` = best coverage any arm-E
  setting achieves for ≤c cells, per doc 33 §13.2.
- **Hub diagnostic:** top-10 most-linking concepts with their document frequency, and AUC recomputed
  with the top-3 excluded. This is the doc-32 failure detector.

## 7. Bars (FROZEN — must be able to fail, and §8 names the likely failure)

Multi-hop traversal is a **live mechanism** iff **all three** hold for M1 or M2 versus S0:

1. **Reach** — text-dissimilar coverage rises by ≥ **3×** over S0 *and* reaches ≥ **25%** absolute
   (the same absolute bar doc-32 was held to, unchanged, so this run is not graded on an easier
   curve than the one that failed).
2. **Discrimination holds** — full-oracle AUC ≥ **0.63** (the doc-32 bar) **and** ≥ S0's AUC. A
   coverage rise with AUC at or below S0 is the doc-32 hub failure repeating → **FAIL**.
3. **Not hub-driven** — after excluding the top-3 highest-degree concepts, coverage retains ≥ **half**
   its gain over S0. If the gain evaporates, it was three hub nodes, not structure.

**Additionally reported, not gating:** how multi-hop compares with **E** and **B**. Beating S0 while
losing to plain embedding would be an honest, publishable-internally negative for the *product*
question, and it must be reported as such rather than buried.

**Outcomes:** all three → traversal is a live mechanism on this floor; write the disposition and
proceed to the adjudication half. Reach without discrimination → **hub noise, dead** (doc-32
precedent). Reach < 10% → **dead**: even with real structure the corpora do not meet, which would
make the disjoint-concept wall a property of the domain rather than of extraction.

## 8. Pre-committed honest priors (so neither result gets rationalised afterwards)

- **Plausible FAIL (and my genuine expectation for at least M2):** traversal reaches too much. With
  ~1000s of entities and ~14 facts/paper, 2 hops from a paper's entities may touch a large fraction
  of the corpus, so nearly every pair shares *some* reachable concept — coverage near 1.0, AUC near
  0.5. That is the hub failure, it is what §7.2/§7.3 exist to catch, and it will be reported as a
  fail.
- **Plausible PASS:** the IDF+decay cost concentrates score on *specific* shared concepts reached in
  1 hop, connecting co-cited pairs whose surface text diverges — exactly the 62.5%-disjoint-concept
  misses doc-31 identified — while hub concepts are damped to near-zero contribution.
- **Plausible partial:** M1 passes and M2 fails, i.e. one hop of structure helps and two is noise.
  That is a clean, informative result and needs no re-parameterisation to report.
- **A negative here is genuinely decisive.** If real per-corpus structure plus a conformed shared
  vocabulary plus path costs still cannot connect these papers, then the concept layer is not a
  cross-corpus retrieval mechanism in any configuration we can construct — and doc 34's
  "narrows the negatives" caveat closes in the negative direction.

## 9. Anti-launder commitments

- Bars and path-cost parameters frozen in this commit, before ingest completed.
- The hops=0 reduction anchor (`multihop-identity-check.ts`) is re-run and reported, so S0 is
  verifiably the shipped mechanism and not a weakened straw baseline (R42/R47).
- Attribution ≥95% or the run is void (§3).
- Coverage is never reported without cells; AUC is never reported without the hub diagnostic.
- **Blind adversary before any claim** (R2), tasked in both directions, given this pre-registration,
  the artifacts, and the raw numbers. Two adversary debts are already outstanding (doc-32 by user
  decision, doc-33) and are recorded rather than quietly dropped.
- I have laundered a favourable reading ~7× on this project, in both directions. The deterministic
  claims here (coverage, cells, set differences) are the trustworthy part; every interpretive claim
  is provisional until the adversary runs.
