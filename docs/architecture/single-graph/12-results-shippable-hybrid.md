# Results — the shippable hybrid: dense-over-names + BM25-over-names (retrieval experiment #2)

**Date:** 2026-09-01 · **Branch:** `feat/single-graph-retrieval` · **Bead:** `nmemo-uhp.18`
**Pre-registration:** `11-prereg-shippable-hybrid.md` (frozen and committed before any number — `d4b4242`).
**Harness:** `platform/src/test/tools/hybrid-names.ts`. **Artifact:** `prereg-artifacts/hybrid-names-results.json`,
run log `hybrid-run.txt`. **Status:** banked after blind adversarial review (§5).

---

## 1. The verdict

> **TIE at the pre-registered K = 60.** H = RRF-60(dense-over-names, BM25-over-names) − ARM-NAME =
> **+0.0254**, 95% CI **[−0.0056, +0.0565]** (byPair; byEntity [−0.0085, +0.0600]; byDocument
> [−0.0053, +0.0557]), spans 0. McNemar exact p = 0.15. This reproduces doc 05's post-hoc value exactly.
> Per the frozen bar, the positive point estimate does **not** promote.

The gate passed bit-exact (ARM-NAME strict R@10 = 0.20056497175141244, BM25-over-names =
0.18926553672316385, n = 354). H has the study-best strict R@10 (0.2260) — but "best point estimate" is
not the pre-registered bar, and a CI spanning 0 is a tie.

**`nmemo-uhp.18` disposition:** the shippable hybrid, at the standard RRF K, is a tie on the
target-finding task. It is not "fusion should not be built"; it is "fusion does not beat the best single
arm at the pre-registered configuration." Two live leads below (small-K; the condensed/task question).

## 2. The small-K lead — real, robust to resampling unit, but thin; a lead not a demonstration

K-robustness was a pre-registered secondary. The hybrid **clears** ARM-NAME at small RRF K and **ties** at
the standard K:

| K | H R@10 | H − NAME (byPair) | verdict | robust to entity/doc clusters? |
|---|---|---|---|---|
| 10 | 0.2345 | +0.0339 [+0.0056, +0.0650] | above 0 | yes (entity [+0.0028,+0.0685], doc [+0.0029,+0.0641]) |
| 30 | 0.2345 | +0.0339 [+0.0056, +0.0621] | above 0 | yes |
| **60 (headline)** | **0.2260** | **+0.0254 [−0.0056, +0.0565]** | **spans 0** | — |
| 100 | 0.2203 | +0.0198 [−0.0113, +0.0537] | spans 0 | — |

The K=10 lead survives all three resampling units (adversary-checked) but is **thin**: McNemar p = 0.043
for K=10 vs p = 0.15 for K=60; the whole K=10→K=60 difference is a **~3-pair** effect (K=10 rescues 21 /
breaks 9 vs NAME; K=60 rescues 20 / breaks 11).

**This is a lead, not a demonstration, and must not be promoted from here.** K=60 was the pre-committed,
literature-standard RRF default (Cormack 2009) and the configuration doc 05 measured; K=10 top-weights
aggressively. Re-labeling K=10 as the headline would be HARKing, and **re-running K=10 yields the identical
number already in the sweep — no new information.** Promoting it requires a *fresh* pre-registration
freezing K=10 and, ideally, an independent split, not a re-label of a secondary.

## 3. The condensed oracle: a large "win" that is a different task (mechanism corrected)

| arm | strict R@10 | condensed R@10 | recovered by condensation |
|---|---|---|---|
| ARM-NAME | 0.2006 (71) | 0.2429 (86) | +15 |
| BM25-over-names | 0.1893 (67) | 0.3644 (129) | **+62** |
| H(60) | 0.2260 (80) | 0.3531 (125) | **+45** |

Condensed H(60) − NAME = **+0.1102, CI [+0.0734, +0.1469]**, well above 0. So under the condensed oracle
the hybrid *demonstrably* beats ARM-NAME. **It is not promotable, because it scores a different task than
the pre-registered one:** condensation credits every document-relevant entity ranked above the target, so
condensed R@10 measures "retrieve *a* document-relevant entity in the top 10", while the promotable strict
metric measures "retrieve *the held-out target*". The hybrid is much better at the former and a tie at the
latter.

**Mechanism, corrected from the pre-adversary draft.** The draft attributed the condensed lift to
condensation forgiving BM25's **Tier-B verbatim-name** retrievals. The adversary's tier decomposition of
the above-target mass on strict-missed targets refutes that:

| arm (strict misses) | Tier-A co-attributed (other) | Tier-B verbatim-name | Tier-C |
|---|---|---|---|
| BM25-over-names | **41%** | 15% | 44% |
| H(60) | 24% | 24% | 51% |
| ARM-NAME | 17% | 23% | 61% |

The dominant forgiven tier is **Tier-A co-attributed** entities — the attribution ground truth itself —
not Tier-B name-matches (of BM25's 62 recoveries, only 1 is purely Tier-B-driven). So the condensed signal
is **partly a genuine relevance-surfacing advantage**: the hybrid's above-target "noise" is far more often
a truly document-relevant entity (Tier-A 41% vs dense's 17%), while ARM-NAME's above-target mass is
dominated by off-topic Tier-C neighbours (61%). "Largely an artifact" slightly under-credits it; the
accurate statement is: **the condensed win measures relevance-set retrieval, which the hybrid genuinely
does better, and which is a different and unpromoted task.** The E0 §6 Tier-B worry is real but small here.

## 4. Non-degeneracy and inert machinery

H genuinely fuses: top-10 equals ARM-NAME on only 1.1% of pairs; component (dense-names vs BM25-names)
top-10 Jaccard 0.129 — far inside the §6 thresholds. The adversary confirmed two pieces of machinery are
provably inert, refuting pre-registered attack (a): the RRF index-asc tie-break changes the target's top-10
hit on **0/354** pairs (0 exact RRF-score ties at the target), and the `score>0` retrieval cutoff never
truncates H (dense ranks all entities, so H retrieves the full universe on 354/354; the cutoff only bites
the standalone BM25 arm, as intended). Retrieved-set and full-ranking RRF differ in full ranking on 94/354
pairs but coincide on target top-10 membership on all 354 — two different computations that provably agree
on R@10 here.

## 5. Blind adversarial review

An independent reviewer re-dumped `public.entities` and re-derived **every** number bit-for-bit in its own
script (including both gate values from scratch, and the mulberry32/cluster-bootstrap CIs to the digit).
**No number failed to reproduce.** Verdict: **HOLDS**, with the two qualifications applied above (§3
mechanism correction; §6 tie-break caveat below). It judged the process clean in both directions — the
strict TIE is honestly called (no leaning on +0.0254), the HARKing handling on K is correct, and the
pre-registration provably predates the numbers (separate earlier commit).

### 6. Inherited caveat the pre-adversary draft did not state (moderate)

**The absolute R@10 levels — including the frozen gate value 0.20056 — ride on the index-ascending
tie-break**, because entity resolution left **14–18% of entities sharing a `canonical_name`**
(`'chatgpt'`×19, `'large language models'`×12, `'segment anything model'`×9), so identical names produce
identical vectors and **exact cosine ties at the target on 250/354 pairs**. Under an equally-arbitrary
index-descending tie-break, ARM-NAME R@10 swings 0.2006 → **0.1836** and the gate would *void*.
**Crucially the H − NAME delta is robust** (H10−NAME +0.0339 → +0.0367; H60−NAME +0.0254 → +0.0198, both
verdicts unchanged), because H inherits the same dense tie structure. So the **comparative** conclusions
stand; the **absolute** levels (doc 05's included) rest on a tie-break convention over a duplicate-heavy
substrate. This is the retrieval-side consequence of the E0 substrate finding (70.6% of targets have a
same-name duplicate) and it is a property of every absolute number in this study.

## 7. Disposition and what it changes

- **Retrieval-track consecutive ties = 2** (R1 pool-then-re-rank, R2 hybrid at K=60).
- **`nmemo-uhp.18`: tie at the standard config.** Do not ship the hybrid as a demonstrated win. If it is
  pursued, the promotable path is a fresh pre-registration at small K on an independent split.
- **The binding constraint is shifting from the retriever to the task/oracle** (the loop's *second* stop
  clause). Across name / description / pool-re-rank / hybrid, the target-finding metric is saturated at
  R@10 ≈ 0.20–0.23 and is itself tie-break-sensitive; the one place a retriever clearly separates
  (condensed / relevance-set retrieval, +0.11 for the hybrid) is a **different task**. Which task matters
  is a product decision, not an empirical one — see the ledger's next-step fork.
- **Two untested retrieval *substrates* remain** (queue #4–6: fact-level `fact_embedding`, traversal-
  augmented, Graph C). These are genuinely different from entity-vector re-rankings and are the retrieval
  track's remaining live mechanisms if the target-finding task is kept.

## 8. Process notes, against myself

1. I misattributed the condensed lift to Tier-B verbatim names; it is Tier-A co-attribution. The adversary's
   decomposition corrected it. My instinct reached for the E0 Tier-B worry and over-fit the story to it.
2. I did not state the tie-break/duplicate caveat in the pre-adversary draft, though E0 had already found
   the 70.6% duplicate rate. The delta is robust; the absolute levels are not, and that belonged in the
   first write-up.
