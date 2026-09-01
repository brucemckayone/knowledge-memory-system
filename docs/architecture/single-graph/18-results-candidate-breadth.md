# Results 18 — candidate-breadth sufficiency for the shipped top-N fusion

**Bead:** nmemo-u8j.11 · **Pre-registration:** doc 17 (frozen, committed 9d05990 before computing)
**Verdict:** **PASS** — the shipped fusion defaults preserve the confirmed R4 lever, on the promotable
(condensed) oracle, on both substrates. Blind adversary CONFIRMED bit-for-bit.
**Artifact:** `prereg-artifacts/candidate-breadth-results.json` (untracked, regenerable). **Harness:**
`platform/src/test/tools/candidate-breadth.ts`.

## What this proves

`recallEntitiesFused` (nmemo-u8j.1) ships HNSW top-N candidate lists (default candidateLimit=50,
factLimit=200), but R4 (+0.0724, doc 16) was measured on full-corpus rankings. This sweeps the candidate
depth `(Kc, Kf)` with everything else identical to the frozen FACTNAME arm (held-out, cached, exact
cosine, the SHIPPED `reciprocalRankFusion`). Question: does the shipped default preserve the lever, and
where does the lift converge to full?

## Numbers (R@10; Δ = arm − NAME, byPair cluster bootstrap, seed 20260831)

**arxiv (arxiv-nlp + arxiv-cv, n=387 — the R4-confirmed substrate):**

| (Kc,Kf) | strict | cond | Δcond vs NAME | Δcond vs FULL |
|---|---|---|---|---|
| NAME | 0.1912 | 0.2429 | (baseline) | |
| 25,100 | 0.2403 | 0.2687 | +0.0258 [−0.0026, 0.0543] spans 0 | −0.0233 [−0.0465, 0.0000] spans 0 |
| **50,200 (shipped)** | 0.2610 | 0.2920 | **+0.0491 [0.0181, 0.0801] ABOVE 0** | +0.0000 [−0.0129, 0.0129] spans 0 |
| 100,500 | 0.2636 | 0.2894 | +0.0465 [0.0155, 0.0801] ABOVE 0 | −0.0026 [−0.0078, 0.0000] spans 0 |
| 200,1000 | 0.2636 | 0.2894 | +0.0465 [0.0155, 0.0801] ABOVE 0 | −0.0026 [−0.0078, 0.0000] spans 0 |
| full (=FACTNAME) | 0.2636 | 0.2920 | +0.0491 [0.0155, 0.0801] ABOVE 0 | (is full) |

**dal (dal-nlp + dal-cv, n=354):**

| (Kc,Kf) | strict | cond | Δcond vs NAME | Δcond vs FULL |
|---|---|---|---|---|
| NAME | 0.2006 | 0.2429 | (baseline) | |
| 25,100 | 0.2288 | 0.2542 | +0.0113 [−0.0141, 0.0367] spans 0 | −0.0424 [−0.0678, −0.0169] BELOW 0 |
| **50,200 (shipped)** | 0.2316 | 0.2825 | **+0.0395 [0.0085, 0.0706] ABOVE 0** | −0.0141 [−0.0311, 0.0028] spans 0 |
| 100,500 | 0.2373 | 0.2853 | +0.0424 [0.0085, 0.0763] ABOVE 0 | −0.0113 [−0.0226, −0.0028] BELOW 0 |
| 200,1000 | 0.2429 | 0.2966 | +0.0537 [0.0198, 0.0876] ABOVE 0 | +0.0000 [0.0000, 0.0000] spans 0 |
| full (=FACTNAME) | 0.2429 | 0.2966 | +0.0537 [0.0198, 0.0876] ABOVE 0 | (is full) |

## Against the pre-registered bars (doc 17 §6–7)

- **PRIMARY (condensed, byPair CI lower > 0 at the shipped default):** arxiv +0.0491 ABOVE 0; dal +0.0395
  ABOVE 0. **CLEARS on both.** The shipped defaults deliver the lever.
- **Breadth floor:** (25,100) FAILS the primary bar on both (spans 0). So (50,200) is the *minimum*
  breadth that clears — the shipped default sits exactly at the floor; do not lower it.
- **Integrity anchor (VOID guard):** LTD(full,full) reproduces frozen FACTNAME bit-for-bit — arxiv strict
  0.26356589147286824, cond 0.29198966408268734, strict−NAME byPair +0.07235142118863053; condensed−NAME
  +0.0491 = frozen primaryCondensed. Not void.
- **Degeneracy guard:** LTD(50,200) top-10 == NAME top-10 for **0.0%** of pairs on both — fusion always
  reorders the head; not a no-op.

## Decision (per doc 17 §6)

**No default change.** (50,200) clears the primary bar on both substrates; it is the floor (25,100 fails).
Record the sufficiency point: on arxiv (50,200) is statistically indistinguishable from full (Δvs-full
spans 0, clean); on dal (50,200) also spans 0 vs full but thinly (see caveat 2), and (200,1000) matches
full exactly. **Optional guidance, not required:** raising factLimit toward 1000 closes the small dal
point-estimate gap to full; the default is adequate as-is.

## Caveats (banked plainly — surfaced in the data and by the adversary)

1. **The dal PASS depends on the condensed (promotable, per nmemo-u8j.10) oracle.** dal *strict* at
   (50,200) is +0.0311 CI [−0.0028, 0.0678] — **spans 0**, not significant. arxiv passes BOTH oracles at
   (50,200). So "the shipped default preserves the lever" is true under condensed on both corpora and
   under strict on arxiv; it must NOT be read as "the strict +0.0724 is preserved on both corpora." It is
   not, on dal.
2. **"Indistinguishable from full" is power-limited on dal.** Point estimates are monotone toward 0
   (−0.0424 → −0.0141 → −0.0113 → 0), but the (50,200) Δvs-full CI is wide and its upper edge is thin
   (+0.0028), while the neighbouring larger (100,500) is distinguishably BELOW full — a bootstrap-power
   artifact. On arxiv the indistinguishability is clean. This qualifies only the *secondary*
   characterization, not the primary bar.

## Adversary (blind, before banking)

Independent re-run reproduced the artifact **bit-for-bit** (identical SHA1; `diff` empty) and matched the
frozen R4 anchor **live**. Verified: (a) the top-Kf restriction is real and active — `eligible` applies
the held-out exclusion first, sorts globally, and the grid loop iterates only `j < topKf`; corpora hold
~2860 facts each so Kf=200 is a real ~7% cut, and LTD rows genuinely differ from FULL; (b) the integrity
anchor holds live; (c) the deltas re-derive as integer hit-counts (arxiv cond FULL 113/387, NAME 94/387,
Δ 19/387 = 0.0491); (d) the spec was frozen before compute and the condensed-primary choice is grounded
in nmemo-u8j.10 (predates this), not picked post-hoc. Verdict: **CONFIRMED**, with the two caveats above
stated (both already visible in the artifact).
