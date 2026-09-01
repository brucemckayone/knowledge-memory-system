# Results — pool-then-re-rank (retrieval experiment #1)

**Date:** 2026-09-01 · **Branch:** `feat/single-graph-retrieval`
**Pre-registration:** `08-prereg-pool-then-rerank.md` (frozen and committed before any number — `28499bf`).
**Harness:** `platform/src/test/tools/pool-rerank.ts`. **Artifact:** `prereg-artifacts/pool-rerank-results.json`,
run log `pool-run.txt`. **Status:** banked after blind adversarial review (§4).

---

## 1. The verdict

> **TIE.** At the pre-registered pool P = 100, DESC-pool → NAME-rerank retrieves the held-out target at
> R@10 **no more often** than ARM-NAME. Primary (strict): B − ARM-NAME = **−0.0056**, 95% CI
> **[−0.0169, +0.0056]**, spans 0 (identical on pair / entity / document bootstraps). Condensed oracle:
> **−0.0085**, CI **[−0.0254, +0.0085]**, also spans 0.

The regression gate passed bit-exact (ARM-NAME strict R@10 = 0.20056497175141244, ARM-DESC =
0.13841807909604520, n = 354), so B is scored on the same frozen rankings as doc 05.

doc 05's head/tail asymmetry is real, but it is **not exploitable by pooling with one dense representation
and re-ranking with the other.** The shippable-hybrid lever — a re-ranker *outside* the two dense vectors
(BM25) — is untouched by this result and is the next experiment.

## 2. Numbers

| arm | strict R@10 | condensed R@10 |
|---|---|---|
| ARM-NAME | 0.2006 | 0.2429 |
| ARM-DESC | 0.1384 | 0.1977 |
| **B = DESC-pool → NAME-rerank** (P=50/100/200) | **0.1949 / 0.1949 / 0.1949** | 0.2316 / 0.2345 / 0.2316 |
| B′ = NAME-pool → DESC-rerank (control) | 0.1525 / 0.1497 / 0.1497 | — |

- **PRIMARY B(100) − NAME (strict):** −0.0056, spans 0 → tie.
- **B − DESC (strict):** +0.0565, CI [+0.0169, +0.0960], **above 0** — B clearly beats the pool's own
  representation.
- **Control B′ − NAME (strict):** −0.0508, CI [−0.0876, −0.0141], **below 0** — the mirror order is
  clearly worse, so the pooling **order matters** and NAME is the better re-ranker. It just does not
  exceed NAME alone.
- **Ceilings** (ARM-DESC R@P, the null's "recall into the pool"): 0.4040 / 0.5254 / 0.7119. B keeps only
  ~0.195 of that, i.e. re-ranking discards nearly all of the pool's deep recall (§3).
- **Condensed at P=200:** B − NAME = −0.0113, CI [−0.0226, −0.0028], **below 0** — at a large pool the
  extra co-relevant entities cost B slightly under the condensed oracle. Minor, reported for completeness.

## 3. Mechanism — decomposed from the raw data (corrected per §4)

At P = 100, every target sorts into exactly one channel:

- **Loss channel = 3.** NAME-hit@10 targets that fall **outside** the DESC-top-100 pool. Their global
  NAME ranks are **1, 5, 7** — NAME's *strongest* head hits. This is doc 05's asymmetry biting: DESC's
  tail-favouring pool has holes exactly where NAME is strongest, and a target outside the pool is a hard
  miss.
- **Gain channel = 1.** Global NAME-miss lifted into B's top-10 — a single target, global NAME rank
  **11** (the boundary). **Zero** gains came from DESC's deep recall.
- **Wasted recall = 117.** DESC pulls **186** of the 354 targets into the pool; NAME re-rank keeps only
  69 in the top-10 and pushes **117** back below 10 — because NAME ranked them low in the first place,
  which is *why* they were in DESC's tail and not NAME's head.

Net = 1 − 3 = **−2**: 71 hits → 69. So B ties-loses **primarily because the pool misses NAME's head**,
not because NAME is a poor re-ranker. The corrected one-line mechanism:

> B is indistinguishable from ARM-NAME across all pool sizes; the pool built from the tail-favouring
> vector systematically misses NAME's strongest head hits, and re-ranking recovers no deep recall into the
> head (the gain channel is a single boundary target).

**Why B is flat across P (not a no-op).** B = 0.1949 at P = 50/100/200 is a numeric coincidence of
balanced gains/losses, confirmed non-degenerate: the hit-sets differ (symmetric diff {50,100} = 12 pairs,
{100,200} = 2), condensed R@10 differs (0.2316 / 0.2345 / 0.2316), and B's top-10 set differs from NAME's
on 113/354 pairs. Pooling and re-ranking genuinely run; they just net to NAME.

## 4. Blind adversarial review

A fresh reviewer re-derived every headline from the raw artifacts + a fresh DB dump + the frozen cache in
independent Python, never running the harness. **Every number reproduced exactly**, including doc 05's
full R@k ladder as a cross-check, 0 missing/mis-length vectors, and the 68.1% (241/354) top-10 identity.
Verdict: **HOLDS**, with one correction I have applied above rather than defended:

- **My mechanism sentence was too absolute.** Scanning *every* pool size (not just the pre-registered
  three) shows B's hit count is non-monotone in P: 57 @ P=20, 71 @ P=70, **72 @ P≈76–85 (one MORE than
  NAME's 71)**, 69 @ P=100, 70 @ P=150, 69 @ P=200, 71 @ P≥300. So "you cannot beat NAME's head by
  re-ranking with NAME" is falsified by a single hit in a post-hoc window. Two things keep the verdict a
  tie: the peak bootstraps to +0.0028, CI [−0.0113, +0.0169], **spans 0** (a +1-hit wobble); and P=100
  was frozen pre-data. The honest statement is *indistinguishable at every P*, not *cannot be beaten* —
  which is if anything a cleaner tie.

The reviewer's other checks all passed: no hidden win at any k or corpus (B never significantly beats
NAME anywhere); the identical-across-P R@10 is genuine compensation, not a collapse onto NAME; the
algebraic `B ≥ NAME on the in-pool subset` is **not** exploited (out-of-pool targets are honestly scored
as misses — 168 of 354 at P=100); and the regression gate is a real independent wiring check.

## 5. Disposition

- **Pool-then-re-rank with the two dense representations is settled: a tie.** Retrieval-track consecutive
  ties = **1**.
- **The head/tail asymmetry is not dead as a lever — but the re-ranker has to come from outside the two
  dense arms.** The gain channel here is empty because the re-ranker (NAME) already defines the head. A
  lexical re-ranker (BM25 over names) is a genuinely different signal; that is the shippable-hybrid
  experiment (`nmemo-uhp.18`, queue #2), which doc 05 measured post-hoc at the best R@10 in the study
  (0.2260) and which is next.
- **No build change.** Do not add a DESC→NAME pool-re-rank read path; it reconstructs ARM-NAME at higher
  cost.

## 6. Process notes, against myself

1. I stated the mechanism as an absolute law ("can't beat NAME's head with NAME"); a post-hoc pool scan
   edged it by one non-significant hit. The adversary caught it; the claim is softened to "indistinguishable
   across all P," which the data actually supports more cleanly.
2. My first framing ("B loses 2 hits") read the P=100 point estimate as the story; the point estimate is
   P-sensitive and oscillates in ~[−0.040, +0.003]. The correct headline is the CI, which spans 0 at every
   pre-registered P.
