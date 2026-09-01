# Pre-registration — pool-then-re-rank (retrieval experiment #1)

**Status:** FROZEN pre-registration. Written and committed BEFORE any number was computed.
**Date:** 2026-09-01 · **Branch:** `feat/single-graph-retrieval`
**Follows:** `05-results-...md` (the head/tail asymmetry this tests) and `07-results-e0-oracle.md` (the
condensed oracle, adopted here — both oracles reported, per the E0 adversary's condition).

---

## 1. Why this is retrieval experiment #1

Doc 05 §2, exact: a bare-name entity vector (ARM-NAME) wins the head; a name+description composite
(ARM-DESC) wins the tail and has the better mean rank.

| | R@1 | R@10 | R@20 | R@50 | R@100 | R@200 | mean rank |
|---|---|---|---|---|---|---|---|
| ARM-NAME | .0424 | **.2006** | .2825 | .3955 | .5198 | .6328 | 272.7 |
| ARM-DESC | .0028 | .1384 | .2260 | **.4040** | **.5254** | **.7119** | **181.0** |

So ARM-DESC pulls the target into a **wider net** (higher deep recall, better average rank) but ranks it
**lower in the top-20**. The natural read-path: **retrieve wide with the description vector, then re-rank
the head with the name vector.** This is the strongest lead in doc 05 and the kickoff's top-ranked
retrieval item.

## 2. The question

Does pool-then-re-rank retrieve the held-out target into the top 10 **more often** than the best single
small-k arm (ARM-NAME), on the same graph, same query pairs, same frozen vectors?

## 3. Design — two representations, one pools, the other re-ranks

Rankings reuse the committed embedding cache (`prereg-artifacts/embed-cache.json`) and the identical
cosine/query-pair machinery of doc 05 / E0. No re-embedding; nothing about the vectors changes.

- **Arm B (primary) = DESC-pool(P) → NAME-rerank.** Pool = the P entities with the highest ARM-DESC
  cosine to the query. Re-rank those P by ARM-NAME cosine (desc, tie-break entity index asc). Final
  ranking = the re-ranked pool; entities outside the pool are unranked (a miss for the target if it is
  not in the pool).
- **Arm B' (control) = NAME-pool(P) → DESC-rerank.** The mirror. Expected NOT to help (it pools with the
  weaker-recall representation and re-ranks with the weaker head). Included so a B win is shown to be
  order-specific, not just "two vectors touched it".
- **Baselines:** ARM-NAME and ARM-DESC, recomputed here (must reproduce doc 05 — see §6 gate).

**Algebraic note (stated so the result is read correctly, not a hidden bar):** whenever the target is in
the DESC pool, its NAME-rank *among pool members* is ≤ its global NAME-rank (re-ranking a subset only
removes competitors). So B ≥ ARM-NAME on the in-pool subset, and B misses exactly where the target falls
outside DESC-top-P. Therefore B beats ARM-NAME iff the recall it gains (targets DESC pulls into the pool
and NAME then lifts to the head) exceeds the recall it loses (targets in ARM-NAME's own top-10 that sit
outside DESC-top-P). B is **not** guaranteed to win; that trade is the experiment.

**Pool sizes:** headline **P = 100**; sensitivity **P ∈ {50, 200}**.

## 4. Metric, oracle, and the null

- **Metric:** Recall@10 (target in the top 10 of the final ranking), under **both** the strict oracle
  (doc 05) and the condensed oracle (E0, Tier-B min-3). Both reported for every arm; neither is dropped.
- **The null (kickoff):** "re-ranking cannot recover what the pool missed." The ceiling of B at pool P is
  ARM-DESC R@P (the target must be in the pool at all): P=50 → 0.3955, P=100 → 0.5254, P=200 → 0.7119
  (strict). Report B R@10 against that ceiling — B R@10 near ARM-NAME R@10 means the re-rank added
  nothing over just using ARM-NAME; B R@10 near the ceiling means the re-rank is near-perfect at the head.

## 5. Bars — pre-registered

Paired bootstrap CI, 10,000 resamples, seed **20260831**, resampling query pairs; plus cluster bootstraps
by entity and by document (doc 05 discipline). Verdicts by the standard rule (CI above 0 / spans 0 /
below 0).

- **PRIMARY (strict oracle):** `B(P=100) R@10 − ARM-NAME R@10`.
  - CI entirely above 0 → **pool-then-re-rank DEMONSTRATED**.
  - spans 0 → **TIE** (a tie is a tie; not "a slight win").
  - entirely below 0 → **HARMS**.
- **Secondary, reported unconditionally, NOT promotable over the primary:** the same delta under the
  **condensed** oracle; `B − ARM-DESC` (both oracles); `B'(control) − ARM-NAME`; B R@10 vs the ARM-DESC
  R@P ceiling; and P ∈ {50, 200} sensitivity for B.

A win requires the primary strict bar to clear. The condensed number is reported so the two oracles'
verdicts are both visible, but the promotable claim is the strict one (condensed's shift from strict is a
quantity E0 could not bound tightly to zero, so it is context, not the headline).

## 6. Kill / void conditions

- **Strict regression gate.** Recomputed ARM-NAME and ARM-DESC strict R@10 MUST reproduce doc 05:
  `0.20056497175141244` and `0.13841807909604520` (assert `|Δ| < 1e-9`) at **n = 354**. Mismatch →
  **VOID** (harness mis-wired).
- **Arm-identity degeneracy.** If B's top-10 equals ARM-NAME's top-10 for **> 95%** of query pairs, the
  pool never excludes an ARM-NAME competitor → the arms are effectively identical and no B-vs-NAME
  conclusion is drawn (report the overlap and stop).
- **n < 100** → UNDERPOWERED, no verdict.
- **Clean-0/clean-1 guard.** Any R@k landing exactly at 0.0000 or 1.0000 is verified two ways before it is
  believed (the doc-05 §9.5 silent-no-op trap).

## 7. Process commitments

- Committed before the harness exists; not edited once numbers exist except to append results in a marked
  section. Harness audited against this text before numbers are read.
- Deterministic set arithmetic; no LLM in the measurement path; bootstrap seeded (20260831); cluster
  bootstraps by entity and document.
- A **blind adversary** reviews before banking, tasked in **both** directions, and specifically tasked to
  check that any B-over-NAME win is not an artifact of the algebraic ≥ relation in §3 (i.e. that B wins on
  *recall gained*, not merely by never being worse where the pool contains the target).
