# Results 22 — traversal-augmented retrieval (NEGATIVE)

**Bead:** nmemo-u8j.6 · **Pre-registration:** doc 21 (frozen, committed c429084 before computing)
**Verdict:** **NEGATIVE — traversal does NOT add recall over the confirmed two-signal fusion.** The
pre-registered PRIMARY bar fails on both corpora (arxiv spans 0, dal below 0); the SECONDARY fails; no
grid config demonstrates a gain. This is a valid banked outcome (doc 21 §6), not a HALT.
**Adversary:** **CONFIRMED-NEGATIVE** (blind; re-derived the deltas by hand and tested the suppression
hypothesis — even the maximally-generous wiring cannot cross 0).
**Artifact:** `prereg-artifacts/traversal-augmented-results.json` + `traversal-augmented-run.txt`.
**Harness:** `platform/src/test/tools/traversal-augmented.ts`.

## What was tested

A third retrieval signal: seeds = top-Ks entities by name-vector cosine; spreading-activation BFS over
held-out `public.facts` adjacency (the in-process form of `traverseFromEntities`), node score
`w_seed · 0.5^hop`, max over paths, up to H hops; ranked → TRAV. Fused `RRF-60(NAME, FACT, TRAV)` =
FACTNAMETRAV, compared to the frozen R4 fusion `RRF-60(NAME, FACT)` = FACTNAME. Grid Ks∈{10,25,50} ×
H∈{1,2}; a-priori PRIMARY = (25,1). Integrity anchor: NAME/FACTNAME reproduce R4 bit-for-bit (they do —
all values MATCH).

## Numbers (condensed R@10, byPair cluster bootstrap, seed 20260831)

**PRIMARY — FACTNAMETRAV(25,1) − FACTNAME:**

| substrate | Δcond (byPair) | verdict |
|---|---|---|
| arxiv (n=387) | −0.0078 [−0.0284, 0.0129] | SPANS 0 — no gain |
| dal (n=354)   | −0.0339 [−0.0621, −0.0085] | **BELOW 0 — traversal HURTS** |

**SECONDARY — NAMETRAV(25,1) − NAME:** +0.0000 [0,0] on both corpora. The adversary showed this is
**structurally forced to exactly 0**, not a measured null: seeds keep their full name-cosine as the hop-0
score, so at Ks≥25 the TRAV top-10 is a deterministic clone of NAME's top-10, making RRF(NAME,TRAV) ≡ NAME
in the head. The zero-width CI is the tell. So the SECONDARY bar was **un-winnable by construction** at the
primary config — report it as a definitional no-op. The binding evidence is the PRIMARY bar (below), which
is a real, wiring-robust negative.

**Full grid — FACTNAMETRAV − FACTNAME, condensed byPair (does any config add over fusion?):**

| (Ks,H) | arxiv | dal |
|---|---|---|
| (10,1) | −0.0207 [−0.0543, 0.0129] | +0.0028 [−0.0395, 0.0452] |
| (10,2) | +0.0000 [−0.0310, 0.0310] | +0.0254 [−0.0113, 0.0650] |
| **(25,1) PRIMARY** | −0.0078 [−0.0284, 0.0129] | −0.0339 [−0.0621, −0.0085] |
| (25,2) | −0.0052 [−0.0258, 0.0155] | −0.0339 [−0.0621, −0.0085] |
| (50,1) | −0.0052 [−0.0233, 0.0129] | −0.0367 [−0.0621, −0.0113] |
| (50,2) | −0.0052 [−0.0233, 0.0129] | −0.0367 [−0.0621, −0.0113] |

**No config clears the PRIMARY comparison (FT−FN > 0) with significance on either corpus.** The larger
seed sets (25/50) drift NEGATIVE on dal. The only ABOVE-0 cell anywhere is a SECONDARY (NAMETRAV−NAME) at
(10,2)-dal (+0.0565 [0.0282, 0.0876]) — it is **not** the pre-registered primary, does not replicate on
arxiv, and its sibling FT−FN at (10,2)-dal spans 0. Reporting it, NOT leaning on it (post-hoc config
selection would be HARKing; the primary was frozen at (25,1)).

## Why it fails (mechanism, PRIMARY 25,1)

| | arxiv | dal |
|---|---|---|
| reachedFrac (nodes reached / corpus) | 0.069 | 0.074 |
| targetReached (target within H hops of seeds) | 0.522 | 0.554 |
| targetInSeeds (target already a seed) | 0.302 | 0.299 |
| heldOutSkipped (query-doc edges guarded out) | 3152 | 2508 |
| cond hits ADDED (FT hit, FN miss) | 7 | 6 |
| — of which genuine NON-SEED graph neighbours | **0** | 2 |
| cond hits DISPLACED (FT miss, FN hit) | 10 | 18 |

- **No hub explosion** (reached ~7% of the corpus, far below the 0.8 degeneracy guard) and the held-out
  guard is active (thousands of query-doc edges skipped). So the negative is not a degeneracy artifact.
- **Traversal displaces more real fusion hits than it adds** (arxiv 10 vs 7 → net ≈ −3/387 = −0.0078;
  dal 18 vs 6 → net ≈ −12/354 = −0.0339). Adding a third RRF signal reshuffles the head; the propagated
  neighbour scores push genuine name/fact hits below rank 10.
- **The additions are not graph-earned.** On arxiv, **0 of 7** added targets were non-seed graph
  neighbours — every "gain" was a name-match already in the seed set, merely re-ranked. The graph
  structure surfaced nothing the vector signals didn't already have. On dal only 2 of 6 were genuine
  neighbours, swamped by 18 displacements.

**Root cause:** the traversal seeds ARE the name-cosine head, so TRAV is largely redundant with the NAME
signal already in the fusion; the marginal non-seed neighbours it surfaces (decay-discounted) are too weak
and too few to offset the RRF reshuffling that demotes real hits. The graph is well-populated (avg degree
3.42), so this is not a sparsity artifact — it is genuine redundancy + displacement.

**Not a decay/wiring artifact (adversary's decay sweep).** The negative holds across the whole
seed-dominance family. Sweeping decay ∈ {0.5 frozen, 0.9, 1.0=none}, net cond hits (added / non-seed /
displaced):

| decay | arxiv net | dal net |
|---|---|---|
| 0.5 (frozen) | −3 (7 / 0 / 10) | −12 (6 / 2 / 18) |
| 0.9 | −5 (6 / 1 / 11) | −10 (8 / 4 / 18) |
| 1.0 (none) | −1 (12 / 8 / 13) | 0 (18 / 16 / 18) |

At decay=1.0 (a hop-1 neighbour scores EQUAL to its seed — the strongest candidate-expansion form) the
graph DOES surface genuine non-seed neighbours (8 arxiv, 16 dal), but **every true addition costs a
roughly-equal displacement** — the RRF rank budget is zero-sum. The best achievable across the entire
decay family is a **TIE** (dal net 0, arxiv net −1); no wiring reaches a positive. So the frozen decay=0.5
did not straw-man the signal — a gentler decay moves the estimate toward 0 but never past it. The
"candidate-expansion + fact re-score" alternative is additionally subsumed by the FACT arm, which already
scores every entity by its best held-out fact and needs no traversal to reach them.

## Decision (per doc 21 §6)

**Both bars fail ⇒ traversal does not add recall over the shipped fusion on this substrate.** Do NOT build
a traversal signal into the read path. The confirmed two-signal fusion (name ⊕ fact) remains the lever.
This closes queue item #5 (our own graph substrate) as measured-and-negative; it does not touch the R4
result, which stands.

## Caveats (banked plainly)

1. **Negative is for THIS traversal design** — spreading activation from name-cosine seeds with decay 0.5,
   fused by RRF-60. A fundamentally different graph mechanism (e.g. learned edge weights, path-constrained
   traversal, or Graph C causal edges — queue #6, out of scope here) is not ruled out; only the natural
   `public.facts` spreading-activation form is.
2. **Same-extraction substrate** (arxiv + dal, cached vectors) — the same generalization caveat as R4.
   But a negative here needs no new-domain confirmation to be actionable (we are declining to build).
3. **PRIMARY config (25,1) frozen a priori** in doc 21; the negative holds across the whole grid, so it
   is not a config-choice artifact. The one favorable secondary cell ((10,2)-dal NT−N) is disclosed and
   explicitly not relied upon.

## Adversary (blind, before banking) — CONFIRMED-NEGATIVE

Independent re-derivation, blind to this write-up. Verdict: **bank the NEGATIVE.**

- **Integrity:** prereg working tree byte-identical to commit c429084 (committed before compute); NAME/
  FACTNAME reproduce the frozen R4 anchor bit-for-bit (5/5); harness re-run SHA1-identical to the
  committed artifact; tsc 69; adjacency matches the sanctioned `traverseFromEntities` (undirected
  subj↔object over `public.facts`, a conservative embedded-active subset — not a leak).
- **PRIMARY re-derived by hand:** arxiv added 7 / displaced 10 → net −3/387 = −0.00775 (matches −0.0078,
  SPANS 0 → FAILS); dal added 6 / displaced 18 → net −12/354 = −0.03390 (matches −0.0339, BELOW 0). Of the
  7 arxiv additions, 0 were non-seed graph neighbours — confirmed.
- **The negative is REAL, not a suppressed-signal bug (the crux, attacked hard):** the BFS is not inert
  (reachedFrac 0.069 ≈ 25 seeds × degree 3.42 / 1256, as predicted; 60 arxiv / 70 dal targets are reached
  via a genuine non-seed path AND buried past rank 10 by both name and fact — so the graph really does
  connect to otherwise-invisible targets). But the decay sweep (above) shows the ceiling is a TIE: every
  true add trades a displacement in the zero-sum RRF budget. RRF genuinely includes all three arms
  (non-seed adds rise 0→8 under decay=1.0, only possible if rTrav contributes).
- **Held-out guard active and load-bearing:** removing it spikes non-seed target reachability
  0.3023→0.5685 (arxiv) / 0.3503→0.5734 (dal) — ~1 in 4 targets is reachable ONLY via a query-doc edge;
  the guard prevents exactly that leak.
- **No HARKing:** PRIMARY (25,1) fixed a priori in the committed prereg; the one ABOVE-0 cell
  ((10,2)-dal SECONDARY) is disclosed and not leaned on anywhere in the tree.
- **Correction (folded in above):** the SECONDARY at Ks=25 is a definitional no-op (structurally 0), not
  a measured null; the PRIMARY is the binding evidence.

Housekeeping: adversary created + deleted a temp diagnostic; results JSON unchanged (SHA1 6c752b4f).
