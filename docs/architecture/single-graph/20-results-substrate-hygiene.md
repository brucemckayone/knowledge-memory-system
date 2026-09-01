# Results 20 — substrate hygiene: duplicate-name tie-break sensitivity + read-path dedup

**Bead:** nmemo-u8j.9 · **Pre-registration:** doc 19 (frozen, committed 8e738a9 before computing)
**Verdict:** **BAR 1 PASS** (the R4 fusion lever is tie-break-robust) · **BAR 2 refined** (only the
*strict* absolute level rides the tie-break; the promotable *condensed* level does not) · **read-path
decision recorded** (dedup is safe + optional, NOT adopted as default — see §Decision).
**Adversary:** **CONFIRMED** (blind, independent re-derivation — could not break any of the three claims).
**Artifact:** `prereg-artifacts/substrate-hygiene-results.json` + `substrate-hygiene-run.txt` (regenerable).
**Harness:** `platform/src/test/tools/substrate-hygiene.ts`.

## Substrate facts (acceptance criterion 1 — quantification)

| corpus | entities | distinct names | dup_rate | pct in shared group | shared names | max group |
|---|---|---|---|---|---|---|
| arxiv-nlp | 1230 | 1070 | 13.0% | 19.6% | 81 | 21 (`chatgpt`) |
| arxiv-cv  | 1282 | 1169 |  8.8% | 14.7% | 76 |  8 (`stable diffusion`) |
| dal-nlp   | 1133 | 1001 | 11.7% | 17.6% | 67 | 19 (`chatgpt`) |
| dal-cv    | 1262 | 1157 |  8.3% | 14.2% | 74 |  9 (`segment anything model`) |

Because the entity vector embeds the **name only**, every shared-name group collapses to one identical
name vector, so the target ties **exactly** with ≥1 other entity for **258/387 (67%) arxiv** and
**250/354 (71%) dal** query pairs. That is why absolute R@10 is tie-break-dependent — the bead's premise,
reproduced. Biggest groups are generic head terms (`chatgpt`, `large language models`), plausibly the
same concept but not guaranteed (`cnn`-type collisions exist), which is why only a **read-path** collapse
is on the table, never a write-time merge (predicate fold stays OFF, lossy).

## Numbers (R@10; Δ = FACTNAME − NAME, byPair cluster bootstrap, seed 20260831)

**BAR 1 — is the R4 fusion lever robust to the tie-break?** (arxiv primary, n=387)

| tie-break | Δcond | Δstrict |
|---|---|---|
| asc (frozen)  | +0.0491 [0.0155, 0.0801] ABOVE 0 | +0.0724 [0.0413, 0.1034] ABOVE 0 |
| desc (adversarial) | +0.0413 [0.0078, 0.0749] ABOVE 0 | +0.0827 [0.0517, 0.1163] ABOVE 0 |
| rand (seeded) | +0.0439 [0.0103, 0.0775] ABOVE 0 | +0.0801 [0.0491, 0.1111] ABOVE 0 |

**dal secondary (n=354):** Δcond asc/desc/rand +0.0537 / +0.0480 / +0.0508, all ABOVE 0; Δstrict
+0.0424 / +0.0537 / +0.0424, all ABOVE 0.

**PASS on both corpora, both oracles, all three tie-breaks — no sign flip, no loss of byPair
significance.** The confirmed R4 lever does NOT depend on the index-asc artifact. The keep-list claim
"deltas are robust; absolute levels are not" is now empirically demonstrated for the tie-break axis, not
merely asserted.

**BAR 2 — which levels ride the tie-break?** NAME absolute R@10 across {asc, desc, rand}:

| corpus | strict levels | strict swing | cond levels | cond swing |
|---|---|---|---|---|
| arxiv | 0.1912 / 0.1783 / 0.1809 | **0.0129** | 0.2429 / 0.2429 / 0.2429 | **0.0000** |
| dal   | 0.2006 / 0.1836 / 0.1949 | **0.0169** | 0.2429 / 0.2401 / 0.2401 | **0.0028** |

**Refinement of the keep-list claim:** it is specifically the **strict** absolute level that rides the
tie-break (~1.3–1.7% swing). The **condensed** absolute level — the oracle nmemo-u8j.10 promotes — is
essentially tie-break-invariant (0 on arxiv, 0.0028 on dal). Mechanism: `condensedRankOf` only counts
NON-relevant entities above the target, and the target's duplicate-name twins verbatim-match the query's
canonical name (Tier-B), so they are **co-relevant** and never count against the target — the intra-tie
reordering the tie-break performs is invisible to the condensed oracle. So on the metric we actually gate
on (deltas + condensed), the substrate's duplicate-name problem is already neutralised.

## Read-path dedup (group-aware oracle: finding any twin of the target = a hit)

| arm (cond R@10) | arxiv asc | arxiv desc | dal asc | dal desc |
|---|---|---|---|---|
| NAME_dedup      | 0.2610 | 0.2610 | 0.2797 | 0.2797 |
| FACTNAME_dedup  | 0.3721 | 0.3747 | 0.3729 | 0.3672 |

- **Lever preserved under dedup:** FACTNAME_dedup − NAME_dedup cond byPair — arxiv +0.1111 [0.0775,
  0.1447] / +0.1137 [0.0801, 0.1473]; dal +0.0932 / +0.0876 — all ABOVE 0. Fusion still beats name-only
  after collapsing twins.
- **Level swing under dedup → 0** on both corpora (strict 0.0129→0, 0.0169→0). But this is **by
  construction**: collapsing a tied twin-block to its single best-ranked representative removes the
  intra-tie ordering entirely, so the group ranking is tie-break-invariant definitionally — not an
  empirical discovery.
- **The +0.08 "dedup impact" (FACTNAME_dedup − FACTNAME) is oracle-confounded.** The dedup arm scores
  over `canonical_name` GROUPS (an easier find-any-twin task); the non-dedup arm scores over ENTITIES
  (find the exact id). The absolute jump is largely the oracle getting easier, NOT a demonstrated
  retrieval improvement. It is reported for completeness, not as a gain.

## Decision (per doc 19 §6, recorded honestly)

The pre-registered rule fires **ADOPT** — both (a) lever preserved and (b) swing < half are literally
met. But two things qualify what "adopt" should mean, both surfaced above:

1. Condition (b) passes **tautologically** (dedup removes the tie-break degree-of-freedom by
   construction), so it is not the empirical discriminator the rule assumed.
2. On the **promotable** (condensed) oracle the absolute level does not swing even without dedup (BAR 2),
   so there is nothing for dedup to stabilise on the metric we gate on. The only thing dedup fixes is the
   **strict** absolute level (~1.3–1.7%), which the loop does not promote on.

**Recorded decision: NO read-path change.** Canonical_name dedup is a safe, optional presentation-layer
collapse (it cannot hurt the group-aware metric and it makes strict absolute levels tie-break-invariant),
but it is **not adopted as default** because: the deltas and the promotable condensed levels are already
tie-break-robust; the apparent absolute gain is oracle-driven not real; and the collapse is lossy (can
merge distinct concepts that share a name). Keep it available as an optional read-path toggle for callers
that need exact-id-stable absolute levels; do not claim it improves retrieval without an exact-id or human
oracle.

## Caveats (banked plainly)

1. **The dedup absolute gain (+0.08) is not a retrieval improvement** — it is the group-aware oracle
   scoring an easier task. The adversary decomposed the arxiv-asc +31-hit jump: **27 hits (87%) come
   from the success-relaxation** (crediting any same-name twin instead of the exact target) and only
   **4 hits (13%) from the actual list-collapse**. Only the *within-arm* comparisons (lever-preserved,
   swing) are oracle-fair.
2. **"Levels ride the tie-break" is now scoped:** true for strict (~1.3–1.7%), effectively false for the
   promotable condensed oracle (≤0.28%). Do not cite the old blanket claim; cite this refinement.
3. **BAR 1 robustness is over three tie-break policies** (asc/desc/rand), not all permutations; but asc
   and desc bracket the extreme orderings a duplicate block can take, and rand is a neutral third point.
4. Integrity anchor reproduces frozen R4 bit-for-bit (six values); group counts == SQL distinct names
   (1070/1169/1001/1157); dedupVoid=0 (no target ever dropped by the collapse).
5. **Pre-registered decision criterion (b) was non-discriminating (tautological).** "NAME_dedup swing
   < half NAME swing" cannot fail whenever any tie exists, because dedup makes the group ranking
   tie-break-invariant by construction (swing = 0). The literal rule fires ADOPT; the recorded decision
   deliberately overrides it (see §Decision). **Lesson for future gates:** a dedup / normalization arm
   must be gated on an **exact-id-preserving** metric, not a swing-reduction test — a swing test is a
   mathematical identity for any collapse. (Adversary's addition.)

## Adversary (blind, before banking) — CONFIRMED

Independent re-derivation from the frozen prereg, harness, and DB, blind to this write-up's conclusions.
Verdict: **CONFIRM on all three claims — could not break it.**

- **Integrity:** prereg commit `8e738a9` (17:30) adds only doc 19; results JSON written 17:33 (frozen
  before compute). End-to-end re-run is **SHA1-identical** to the committed artifact. Anchor reproduces
  all six frozen R4 values. tsc still 69. Group collapse faithful (distinct names 1070/1169/1001/1157;
  dedupVoid=0). condensed-primary is prior decision nmemo-u8j.10 (ledger, predates this) — not HARKed.
  Tie-break genuinely active (258/387 exact ties; NAME strict hits move 74→69→70 across asc/desc/rand).
- **BAR 1 CONFIRMED:** re-derived the desc delta from raw ranks bypassing the harness bootstrap —
  NAME 94 cond hits, FACTNAME 110 → Δ = 16/387 = +0.0413; strict 69→101 → +0.0827. Matches to the digit.
- **BAR 2 CONFIRMED + the blanket keep-list claim is OVERCLAIMED:** strict swings (0.0129/0.0169),
  condensed is tie-break-invariant (0.0000/0.0028); mechanism confirmed in `condensedRankOf` + Tier-B.
- **Dedup decision SOUND/HONEST:** oracle symmetry is fair (target→`tGroup` and relevant→`relGroups`
  both group-mapped); criterion (b) is tautological (caught + disclosed); +0.08 impact is 87%
  oracle-relaxation / 13% list-collapse (would have been self-deception if banked as "dedup improves
  retrieval" — explicitly disavowed).

Housekeeping: adversary created + deleted two temp re-derivation scripts; working tree unchanged
(results JSON untouched).
