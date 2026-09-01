# Results — E0: is the retrieval oracle the binding constraint?

**Date:** 2026-09-01 · **Branch:** `feat/single-graph-retrieval`
**Pre-registration:** `06-prereg-e0-oracle.md` (frozen and committed before any number — commit `64dead1`).
**Harness:** `platform/src/test/tools/e0-oracle.ts`. **Artifact:** `prereg-artifacts/e0-oracle-results.json`,
run log `prereg-artifacts/e0-run.txt`. **Status:** banked after blind adversarial review (§6).

---

## 1. The verdict

> Completing the oracle with a verbatim-name relevance tier does **not** significantly change the
> ARM-DESC − ARM-NAME comparison. shift = Δcondensed − Δstrict = **+0.0169**, 95% CI
> **[−0.0141, +0.0480]**, spans 0 (identical across pair / entity / document bootstraps).

But "spans 0" here is an **underpowered non-result, not a demonstration of neutrality** — the CI permits a
DESC-favouring oracle effect as large as +0.048, ~77% of the size of the strict gap it would be
correcting (see §4). And the honest headline that the shift framing must not bury:

> Under the **better** oracle, doc 05's clean "descriptions harm small-k" (Δstrict = −0.0621, CI
> [−0.1045, −0.0226]) weakens to a **borderline tie**: Δcondensed = **−0.0452, CI [−0.0904, 0.0000]** —
> upper bound exactly on zero.

The **regression gate passed bit-exact** (ARM-NAME strict R@10 = 0.20056497175141244, ARM-DESC =
0.13841807909604520, n = 354), so the strict rankings are byte-identical to doc 05 and every moved number
is attributable to the oracle alone.

## 2. What E0 actually establishes

The question was: is the incomplete oracle (fact-endpoint attribution, ~9 labelled entities/doc while
~18–30 are named verbatim) the reason doc 05's numbers are low, and does completing it change which arm
wins? The load-bearing, well-powered answer:

> **Completing the oracle with these two exact-match tiers recovers only ~5–7% of small-k misses**
> (condensation lifted 15 of 283 ARM-NAME misses and 21 of 292 ARM-DESC misses into the top-10). So
> labelling-completion cannot rescue most misses — the recall ceiling doc 05 worried about is not
> dominated by unlabelled-but-verbatim entities.

**What this does NOT establish (adversary trim, §6 finding 1):** that the remaining missed-target slots
are "junk" or that "retrieval succeeded". Tier C = *unlabelled by both tiers*, which re-imports the very
completeness assumption E0 set out to question — an entity named by synonym, abbreviation↔expansion, or
paraphrase is on-topic yet exact-match Tier B cannot see it. So the ~5–7% recovery is a **lower bound** on
what oracle-completion could do, using exact string tiers only. The claim "the retriever, not the
labelling, is the binding constraint" survives as *labelling-completion recovers few misses*, not as *the
misses are retrieval-correct*.

## 3. Numbers

| | ARM-NAME | ARM-DESC | Δ (DESC − NAME) | CI | verdict |
|---|---|---|---|---|---|
| strict R@10 (= doc 05) | 0.2006 | 0.1384 | **−0.0621** | [−0.1045, −0.0226] | harms |
| condensed R@10 (min-3) | 0.2429 | 0.1977 | **−0.0452** | [−0.0904, **0.0000**] | **borderline tie** |
| **shift** (Δcond − Δstrict) | — | — | **+0.0169** | [−0.0141, +0.0480] | not significant |

Per-k, strict → condensed: R@1 .042→.093 / .003→.048; R@5 .153→.189 / .082→.150; R@10 .201→.243 /
.138→.198; R@20 .282→.316 / .226→.319. Condensation lifts both arms (~+0.04–0.06 at R@10) and lifts DESC
slightly more, which is *why* the shift is positive — opposite to the pre-registered expectation (§5).

**shift decomposed to integers (adversary, transparent):** shift = (21 − 15)/354 = +0.0169. It is a
6-query-pair contrast; that is the source of its low power.

## 4. Why the shift is positive, and why it is weak

Pre-registration §5 committed to expecting `shift < 0` (a complete oracle would favour the name arm,
because ARM-NAME retrieves the verbatim entities Tier B credits). **That was falsified.** The mechanism,
read from the miss-mass decomposition:

| arm / corpus | strict-misses | top-10: TierA(other) | TierB | TierC | recovered by condensation |
|---|---|---|---|---|---|
| NAME / dal-nlp | 157 | 1.6 | 2.7 | 5.7 | 8 / 157 |
| NAME / dal-cv | 126 | 1.8 | 1.8 | 6.5 | 7 / 126 |
| DESC / dal-nlp | 162 | 2.5 | 2.0 | 5.6 | 6 / 162 |
| DESC / dal-cv | 143 | 3.0 | 1.5 | 5.5 | 15 / 143 |

DESC's missed targets sit behind **more co-*attributed* (Tier A) entities** (2.5–3.0 vs NAME's 1.6–1.8),
consistent with doc 05 §4.1 (the composite arm produces more diverse candidate sets and ranks a
document's other genuine entities highly). Condensation forgives that, so it helps DESC marginally more.

But the effect is 6 pairs, the CI reaches +0.048, and TierC still fills 5.5–6.5 of every missed target's
top-10 in both arms. So E0 **rules out a large oracle-completion effect, not a material one**.

## 5. Corpus heterogeneity (retrieval-queue item 3) — split cleanly, but read carefully

| corpus | strict Δ | condensed Δ |
|---|---|---|
| dal-nlp | −0.0282 (tie) | −0.0395 (tie) |
| dal-cv | −0.0960 (**harms**) | −0.0508 (tie) |

The **description-effect** gap between corpora narrows from 3.4× to ~1.3×, and dal-cv's clear "harms"
becomes a tie. So the "why does description harm in one corpus and only tie in the other" heterogeneity is
**partly** an oracle sensitivity. **Qualifier (adversary, §6 finding 3):** this is a point-estimate
convergence — one corpus moves up, the other slightly down — and the "now spans 0" rests partly on
discrete mass points (dal-cv shift lo = +0.0000; Δcond hi = 3/177). It is borderline evidence, not
"largely an oracle artifact." What is *robust*: the **absolute** recall gap persists (dal-nlp 0.113 vs
dal-cv 0.288 strict; 0.158 vs 0.328 condensed, still ~2×). dal-cv is genuinely the easier corpus; that
half of item 3 is real, and only the description-effect half is oracle-sensitive.

## 6. Blind adversarial review

A fresh reviewer rebuilt the whole pipeline in Python from the raw artifacts + cache + DB, without running
the harness. **Every number reproduced bit-exact** — strict R@10 both arms, n=354, Δstrict/Δcond/shift,
all bootstrap CIs to 6 dp including the PRNG, miss-mass, sensitivity. `cond R@k ≥ strict R@k` at every k
both arms with 0 violations; 0 missing/NaN/wrong-length vectors; degeneracy guard correctly idle. **No
silent no-op.** Both adversarial attacks failed and strengthened the result:

- **Tier-B spuriousness (attack on overstatement):** names are domain-specific and multi-token; the
  multi-token-only config changes condensed R@10 symmetrically across arms (0.243→0.240, 0.198→0.195) and
  leaves the shift unchanged. Verbatim-name is a defensible relevance signal here.
- **Duplicate-entity crowding (attack on understatement):** the substrate has heavy un-merged duplicate
  names — **250 of 354 targets (70.6%) have a same-name duplicate** with an identical NAME vector (dal-nlp
  199/1133 entities share a name; "chatgpt"×19, "large language models"×12). This produces the exact-score
  ties. But removing same-name duplicates ranked above the target recovers **only 1 pair** into the top-10
  (0.2006→0.2034). So the low recall is **not** an entity-resolution artifact — the misses are genuinely
  deep. (Recorded as a substrate property for the bug-hunt track: dedup is off; relevant to any downstream
  retrieval experiment.)

The three trims above (§2 "junk", §1/§4 the power caveat and the borderline-harm disclosure, §5 the
convergence qualifier) are the adversary's, applied here rather than defended against. The reviewer's
overall verdict: the instrument is correct, reproducible and free of no-ops; the condensed oracle is
**fine to adopt downstream provided both oracles are always reported**, because the two differ by an
amount this study cannot bound tightly to zero.

## 7. Disposition

- **The retrieval track proceeds** (the oracle is not a large hidden ceiling), and every downstream
  experiment reports **both** strict and condensed R@10, per the adversary's condition.
- **Do not spend an iteration on retrieval-queue item 3 as a "mystery".** The description-effect
  heterogeneity is oracle-sensitive; the absolute-recall heterogeneity is dal-cv being genuinely easier.
- **doc 05's build recommendation is unchanged in direction** (name ≥ name+description at small k under
  both oracles) but its strength is now **borderline** under the better oracle, not a clean harm. The next
  experiment (pool-then-re-rank) is the right response to the head/tail asymmetry regardless.
- **Substrate note for the bug-hunt track:** 70.6% duplicate-name rate among targets. Un-merged entities
  are expected (the predicate fold is off) but this is the first quantification on this substrate.

## 8. Process notes, against myself

1. My pre-registered expectation (shift < 0) was **wrong**; freezing it first is what made the falsification
   visible rather than quietly re-narrated.
2. My first-draft conclusions overshot the measurement in three places (the "junk" characterisation, reading
   an underpowered shift as neutrality, and calling the convergence "largely an oracle artifact"). The
   adversary caught all three; they are corrected above, not defended.
3. The one place the strict regression gate does **not** cover is a bug purely in the condensed-removal
   logic — the gate validates only the strict/ranking path. That gap was closed by the adversary's
   independent reproduction (cond ≥ strict, recovery counts non-zero), not by the gate.
