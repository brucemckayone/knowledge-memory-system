# Pre-registration 21 — traversal-augmented retrieval (vector recall → traverse public.facts → re-score)

**Bead:** nmemo-u8j.6 · **Depends on:** nmemo-u8j.1 (fusion read path), nmemo-u8j.2 (eval engine)
**Status:** FROZEN. Append results below the line; do not edit above it.
**Committed before computing:** yes — committed before the traversal harness is run.

## 1. Question

The confirmed lever is a two-signal fusion of dense-over-**names** ⊕ dense-over-**facts** (R4, doc 16).
Both signals are DIRECT query→content matches. Our own graph substrate — the `public.facts` edges,
traversed by the sanctioned `traverseFromEntities` recursive CTE (graph.ts:101) — has never been measured
as a retrieval signal. A target that has **no** query-matching name and **no** query-matching fact, but
that is a graph **neighbour** of a strong name-match, is invisible to both current signals and could only
be surfaced by traversal.

**Does adding a graph-traversal signal (vector recall → traverse held-out facts → propagate score) via
RRF beat the confirmed two-signal fusion?** The bead's own risk: star-shaped hubs can add zero new nodes
(degree distribution: avg 3.42, median 2, **max 89** across the four corpora — hub explosion is real).

This is a MEASURE-FIRST experiment per the epic gate; no build follows unless it clears.

## 2. Substrate & harness

Identical to R4 / candidate-breadth / doc 20: same query pairs, same **held-out fact guard** (every fact
edge sourced from the query document is excluded — traversal obeys the SAME guard as the fact signal, or
it leaks the answer), same cached vectors, exact in-process cosine, the SHIPPED
`services/fusion.reciprocalRankFusion` and `retrieval-eval/core`. Thin config over the eval engine.

- **Primary substrate:** arxiv-nlp + arxiv-cv (R4-confirmed; n≈387 pairs; well-populated — 1230/1230 &
  1282/1282 entities have ≥1 fact).
- **Secondary substrate:** dal-nlp + dal-cv (n=354).

**Traversal = the in-process form of `traverseFromEntities` over `public.facts`.** The eval traverses the
same entity–entity adjacency the primitive walks (endpoints of a shared held-out fact are adjacent),
in-process for determinism and comparability with the frozen arms, not a live DB round-trip. A live
`traverseFromEntities` cross-check on a handful of queries is a secondary sanity check, not the gate.

## 3. Arms

All rankings use index-asc tie-break (the frozen policy; doc 20 showed the deltas are tie-break-robust).

- **NAME** — full name-vector ranking (baseline; integrity anchor).
- **FACT** — fact-max over ALL held-out facts (context only).
- **FACTNAME** — `RRF-60(NAME, FACT)`, the frozen R4 fusion. **This is the baseline to beat** and the
  second integrity anchor (must reproduce R4 bit-for-bit).
- **TRAV(Ks, H)** — the traversal signal:
  1. **Vector recall:** seeds S = the top **Ks** entities by name-vector cosine, each with weight
     `w_s = cos(query, name_s)`.
  2. **Traverse:** breadth-first over held-out `public.facts` adjacency, up to **H** hops. A node reached
     at hop `h` from seed `s` gets candidate score `w_s · decay^h` (decay = **0.5**, frozen); a node's
     traversal score is the **max** over all (seed, path) that reach it. Seeds keep their hop-0 score
     `w_s`.
  3. **Rank** entities by traversal score desc → the TRAV ranking.
- **NAMETRAV** — `RRF-60(NAME, TRAV)`.
- **FACTNAMETRAV** — `RRF-60(NAME, FACT, TRAV)` — **the key arm**: does traversal add recall over the
  confirmed fusion?

## 4. Grid (frozen)

`Ks ∈ {10, 25, 50}` (seed breadth) × `H ∈ {1, 2}` (hop depth). Six TRAV configs; each feeds a NAMETRAV
and a FACTNAMETRAV. Reported for all six; the **primary bar** is evaluated at the a-priori pick
**Ks=25, H=1** (a modest neighbourhood — the config least prone to hub explosion), with the full grid
reported for sensitivity.

## 5. Metric & statistics

- **R@10**, both oracles: **strict** and **condensed** (min-3 Tier-A∪Tier-B). Primary = **condensed**
  (nmemo-u8j.10). Both always shown (condensed not arm-neutral, doc 12 §3).
- **Deltas:** `FACTNAMETRAV − FACTNAME` (the key: does traversal add over fusion) and `NAMETRAV − NAME`
  (does traversal add over name alone).
- **Cluster bootstrap** by pair AND entity AND document (seed 20260831, 10,000 resamples).
- **Mechanism reporting (descriptive):** avg #nodes reached per query at each (Ks,H) (neighbourhood
  size / hub-explosion check); the fraction of query targets that TRAV reaches at all; the fraction of
  targets that FACTNAMETRAV puts in top-10 but FACTNAME does NOT (the added-recall mechanism), and vice
  versa (displaced hits).

## 6. Pre-registered bars & decision rule

- **PRIMARY (does traversal add over the confirmed fusion):** `FACTNAMETRAV(25,1) − FACTNAME`,
  **condensed** R@10, **byPair** CI lower bound **> 0** on the arxiv primary substrate ⇒ traversal is a
  real third lever; report the grid sensitivity and take it to nmemo-u8j.3-style generalization before
  any build.
- **SECONDARY (weaker evidence of a graph signal):** `NAMETRAV(25,1) − NAME` condensed byPair > 0.
- **Decision:**
  - Primary clears (byPair > 0, and ideally all-three-bootstraps > 0 for a DEMONSTRATED result) ⇒
    traversal is a candidate third signal; do NOT ship on this alone (same-extraction caveat as R4) —
    queue a generalization test.
  - Primary fails but SECONDARY clears ⇒ traversal adds over name but is subsumed by the fact signal
    (redundant with fusion); document as "no marginal value over the shipped fusion."
  - Both fail / negative ⇒ traversal does not add recall on this substrate; document honestly with the
    mechanism numbers (reached-fraction, hub explosion) explaining why. A NEGATIVE result is a valid
    banked outcome, not a HALT.

## 7. Kill / VOID conditions

- **VOID (mis-wired):** NAME and FACTNAME do NOT reproduce the frozen R4 numbers bit-for-bit on arxiv
  (NAME strict `0.19121447028423771`, cond `0.24289405684754523`; FACTNAME strict `0.26356589147286824`,
  cond `0.29198966408268734`; `FACTNAME−NAME` strict byPair `0.07235142118863053`, cond
  `0.049095607235142114`).
- **VOID (held-out leak):** TRAV traverses a fact sourced from the query document — assert every edge
  used has `paper != queryDocId`; a target reached ONLY via a query-doc edge would be a leak.
- **Degeneracy guard:** if TRAV(25,1) reaches > 80% of the corpus (hub explosion → signal is ~uniform) or
  < 5% of targets (traversal surfaces almost nothing), the signal is degenerate — report and draw no
  positive conclusion from a delta that rides on it.

## 8. Adversary

Blind adversary before banking: (a) confirm the NAME/FACTNAME integrity anchors reproduce R4 live; (b)
re-derive the primary `FACTNAMETRAV(25,1) − FACTNAME` condensed delta as an integer hit-count from raw
ranks; (c) verify the held-out guard on traversal edges (no query-doc fact is ever traversed); (d) verify
TRAV is a genuinely DIFFERENT signal, not a re-scoring of NAME — check the mechanism numbers (targets
FACTNAMETRAV hits that FACTNAME misses are reached via graph, not already in the name head); (e) check the
hub-explosion / reached-fraction degeneracy guard; (f) confirm the spec froze before compute and Ks/H/
decay were fixed a priori, not tuned to the outcome.

---

<!-- RESULTS APPENDED BELOW THIS LINE -->
