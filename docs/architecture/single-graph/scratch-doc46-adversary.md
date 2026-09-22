# scratch — BLIND ADVERSARY report on doc 46 (lexical fact signal / L3)

**Role:** blind adversary. A NULL/retraction is a success for the adversary; this report is written to
kill the claim, and states where it failed to.

**Overall verdict: NARROW.** Doc 46's headline number is real, reproduces bit-exactly, is **not** an RRF
artifact, and survives the tie-break flip. But the experiment does **not** separate "a lexical fact
substrate" from "any third RRF arm that encodes entity fact-degree", and two of doc 46's own
sub-claims (the L2 engineering recommendation, and anything resting on fact *text*) are weaker than
written. The precise narrowed claim is at the bottom.

---

## 0. Reproduction (before any control)

```
cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
  NODE_ENV=test npx tsx src/test/tools/lexical-fact-signal.ts
cd platform && CORPUS_SET=arxiv DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
  NODE_ENV=test npx tsx src/test/tools/lexical-fact-signal.ts
```

Every banked number reproduces exactly, including the regression gate
(`NAME strict R@10 = 0.20056497175141244`, `n = 354`) and all three bootstrap CIs:

| | L3 − FACTNAME | byPair | byEntity | byDoc |
|---|---|---|---|---|
| dal (n=354) | +0.0763 | [0.0395, 0.1130] | [0.0330, 0.1192] | [0.0399, 0.1141] |
| arxiv (n=387) | +0.0801 | [0.0491, 0.1137] | [0.0391, 0.1240] | [0.0471, 0.1146] |

Strongest form of this: re-running the doc's own harness rewrote
`prereg-artifacts/lexical-fact-signal-results-arxiv.json` **byte-identically except the `run_at`
timestamp** (`git diff` = 1 line). The banked dal artifact was written as
`lexical-fact-signal-results.json` and the harness now emits `-dal`, so that one appears as a new file
rather than a diff; its printed numbers match the doc's table exactly.

I then **re-derived every arm from scratch** in my own code path (own base-signal loop, own O(U)
`fusedRank`, own tie-break switch) rather than reusing the doc's arm code. My independent recompute
matches doc 46 to the last digit on all 20+ reported quantities in both corpus pairs — so the numbers
are not a bug in the doc's harness. Adversary harness:
`platform/src/test/tools/doc46adv-controls.ts` (new file; the original harness is untouched).

```
cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
  NODE_ENV=test NSEEDS=10 npx tsx src/test/tools/doc46adv-controls.ts
cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
  NODE_ENV=test NSEEDS=10 TIE=desc npx tsx src/test/tools/doc46adv-controls.ts
cd platform && CORPUS_SET=arxiv DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
  NODE_ENV=test NSEEDS=10 npx tsx src/test/tools/doc46adv-controls.ts
cd platform && CORPUS_SET=arxiv TIE=desc DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
  NODE_ENV=test NSEEDS=10 npx tsx src/test/tools/doc46adv-controls.ts
```
Artifacts: `prereg-artifacts/doc46adv-{dal,arxiv}-{asc,desc}.json`. Read-only, zero API spend.
Self-check printed by every run: `fusedRank vs reciprocalRankFusion agreement check: OK`.

---

## CONTROL 1 — the random / shuffled / zero-information third arm

**Bar written before computing (the kill bar):** if a *meaningless* third ranking, fused with the same
RRF-60 machinery and the same K, reproduces most of +0.076 — i.e. if the real gain does not sit clearly
above the meaningless-arm distribution — doc 46 is an RRF artifact and must be **RETRACTED**.

Three families of meaningless third arm, 10 seeds each, all fused as `RRF-60(NAME, FACTMAX, X)`:

- **RAND** — uniform random permutation of all entities (same support as BM25f, no structure).
- **SHUF** — BM25f's **exact score multiset** with entity labels permuted (matched score distribution,
  destroys score↔entity association *and* degree structure).
- **FSHUF** *(added, tighter than asked)* — permute the per-**fact** BM25 scores across facts, then
  MAX-aggregate with the identical held-out exclusion. Keeps the exact score distribution **and** each
  entity's fact-degree; destroys only the query↔fact-content association. This is the matched control
  that isolates the max-over-degree order statistic.
- **IDX** — the entity index list itself (literally zero information), asc and desc.

Delta vs FACTNAME, strict R@10:

| third arm | dal asc | dal desc | arxiv asc | arxiv desc | seeds clearing all 3 bootstraps |
|---|---|---|---|---|---|
| **REAL BM25f (L3)** | **+0.0763** | **+0.0960** | **+0.0801** | **+0.0749** | — (clears in all 4) |
| RAND (mean of 10) | −0.0169 | −0.0198 | −0.0155 | −0.0235 | 0/10 in every config |
| RAND (min…max) | −0.0254…−0.0028 | −0.0311…−0.0028 | −0.0310…0.0000 | −0.0336…−0.0129 | |
| SHUF (mean of 10) | −0.0189 | −0.0226 | −0.0199 | −0.0266 | 0/10 in every config |
| SHUF (min…max) | −0.0339…−0.0113 | −0.0367…−0.0141 | −0.0310…−0.0129 | −0.0362…−0.0181 | |
| FSHUF (mean of 10) | +0.0181 | +0.0215 | +0.0098 | +0.0111 | 0/10 in every config |
| FSHUF (min…max) | 0.0000…+0.0339 | +0.0056…+0.0367 | −0.0103…+0.0233 | −0.0052…+0.0207 | |
| IDX-asc | −0.0226 | −0.0169 | **+0.0155** | +0.0155 | n/a (deterministic) |
| IDX-desc | −0.0508 | −0.0480 | −0.0103 | −0.0284 | n/a |

Also, the real arm beats the tightest matched control head-to-head:
`L3 − L3fshuf(seed 1000)` = **+0.0706** dal-asc [byPair 0.0339–0.1073, byEntity 0.0296–0.1129, byDoc
0.0337–0.1086], **+0.0847** dal-desc, **+0.0672** arxiv-asc, **+0.0543** arxiv-desc — above 0 on all
three bootstraps in all four configurations.

**VERDICT — control 1: doc 46 SURVIVES, cleanly.** 30 seeded meaningless third arms per configuration
(10 RAND + 10 SHUF + 10 FSHUF) x 4 configurations = **120 draws, 0 of which clear the bar**. No RAND or
SHUF draw in any configuration is positive (worst case exactly 0.0000, arxiv-asc); the 40
degree-preserving FSHUF draws span −0.0103…+0.0367. The best meaningless draw anywhere (+0.0367,
dal-desc) sits well below the real gain in that same configuration (+0.0960). RRF mechanics alone do
not manufacture this.

One honest caveat for the record: the zero-information index arm is nominally **+0.0155 on arxiv** (both
tie-breaks), so the fusion-mechanics floor on arxiv is not exactly zero — small relative to +0.0801,
but it is not 0.

---

## CONTROL 2 — index-DESCENDING tie-break

**Bar written before computing:** absolute R@10 on this task is known to ride on the index-asc
tie-break (CLAUDE.md; ~250/354 targets tie exactly). Deltas are the claim. Kill condition: if
`L3 − FACTNAME` loses all-three-bootstrap clearance under the flip, the headline is a tie-break
artifact and must be **RETRACTED**.

`L3 − FACTNAME`, strict R@10:

| | index-ASC (banked) | index-DESC | verdict |
|---|---|---|---|
| dal (n=354) | +0.0763 [0.0395,0.1130] / [0.0330,0.1192] / [0.0399,0.1141] | **+0.0960** [0.0593,0.1328] / [0.0491,0.1436] / [0.0593,0.1352] | clears both |
| arxiv (n=387) | +0.0801 [0.0491,0.1137] / [0.0391,0.1240] / [0.0471,0.1146] | **+0.0749** [0.0413,0.1111] / [0.0285,0.1237] / [0.0417,0.1099] | clears both |

Absolute levels do move as expected (dal NAME 0.2006 → 0.1836; L3 0.3192 → 0.3333; arxiv NAME 0.1912 →
0.1783; L3 0.3437 → 0.3359) — so the doc's standing caveat is correct and load-bearing. The headline
**delta** does not depend on it.

**One doc-46 sub-claim DOES die here.** The "Engineering note (the shippable shape)" asserts
`L2 − FACTNAME` is "both above 0 on all three bootstraps". Under index-DESC on arxiv:
`L2 − FACTNAME = +0.0413, byEntity CI [0.0000, 0.0841] → SPANS 0` — it loses clearance. dal holds
(+0.0678, all three above 0). So **L2, the arm doc 46 actually recommends shipping, is tie-break-fragile
on the independent extraction.**

**VERDICT — control 2: the headline SURVIVES; the L2 engineering recommendation does NOT (arxiv,
index-DESC).**

---

## CONTROL 3 — is BM25f partly an entity-degree prior?

**Bar written before computing:** BM25f aggregates by MAX, so an entity with more facts gets more draws
at a high score. Kill condition: if a **degree-only** third arm — entities ranked purely by fact count,
**no query involved at all** — reproduces the gain, the "lexical substrate" story is really a popularity
prior and doc 46's *mechanism* claim must be **RETRACTED/NARROWED**.

### 3a. The task rewards high degree by construction
A pair only exists when an entity appears in **≥2 papers**, so targets are structurally well-connected.
Measured, then **independently re-derived with SQL + the attribution ledger** (agrees to 2 d.p., and
recovers n=354 / n=387):

| | mean **target** fact-degree | mean **corpus** fact-degree | ratio |
|---|---|---|---|
| dal | 13.56 | 3.32 | **4.08x** |
| arxiv | 16.57 | 3.51 | **4.73x** |

(SQL cross-check of the corpus means alone: dal-nlp 3.470, dal-cv 3.193, arxiv-nlp 3.585, arxiv-cv 3.429.)

### 3b. BM25f is half degree
Mean Spearman rho(BM25f entity score, eligible fact degree) = **0.501** (dal) / **0.509** (arxiv).
Top-10 Jaccard BM25f~DEG is only 0.046/0.052, so it is not the same *ranking* — but the monotone
association is strong.

### 3c. A query-free degree third arm reproduces most of the gain
`DEG` = entities ranked by their count of **eligible** facts (post-exclusion), ties by index. It contains
**zero query information**; if anything it is biased *against* the target, because the held-out guard
strips the query document's facts and the target is always in the query document.

| delta vs FACTNAME (strict R@10) | dal asc | dal desc | arxiv asc | arxiv desc |
|---|---|---|---|---|
| **L3** (real BM25f third arm) | +0.0763 **clears** | +0.0960 **clears** | +0.0801 **clears** | +0.0749 **clears** |
| **L3deg** (degree-only third arm) | **+0.0650 CLEARS** (byPair [0.0311,0.0989], byEntity [0.0087,0.1244], byDoc [0.0319,0.0977]) | +0.0650 **clears** | +0.0517 (byEntity [0.0000,0.1058] spans 0) | +0.0491 (byEntity [−0.0085,0.1086] spans 0) |
| L2deg (degree instead of lexical, two-way) | +0.0282 spans 0 | +0.0508 byEntity spans 0 | +0.0388 spans 0 | +0.0388 spans 0 |

`DEG` **alone** is a weak retriever (R@10 = 0.1243 dal / 0.1783 arxiv, both at or below NAME's 0.2006 /
0.1912) — it only becomes powerful when *injected as a third RRF arm*, which is exactly doc 46's move.

And the decisive head-to-head is a **tie in all four configurations**:

| `L3 − L3deg` | delta | byPair | byEntity | byDoc |
|---|---|---|---|---|
| dal asc | +0.0113 | [−0.0254, 0.0480] | [−0.0324, 0.0571] | [−0.0256, 0.0486] |
| dal desc | +0.0311 | [−0.0056, 0.0678] | [−0.0154, 0.0794] | [−0.0081, 0.0706] |
| arxiv asc | +0.0284 | [−0.0078, 0.0646] | [−0.0226, 0.0807] | [−0.0104, 0.0672] |
| arxiv desc | +0.0258 | [−0.0103, 0.0646] | [−0.0272, 0.0805] | [−0.0125, 0.0647] |

**The real lexical third arm is statistically indistinguishable from a query-free popularity prior at
this n.** On dal the popularity prior clears the very same house DEMONSTRATED bar (+0.0650, all three
bootstraps above 0) that doc 46 uses to declare a demonstration.

### 3d. MAX aggregation is what carries it
Swap MAX for MEAN (same text, same guard, same fusion — removes the max-over-degree order statistic):

| delta vs FACTNAME | dal asc | dal desc | arxiv asc | arxiv desc |
|---|---|---|---|---|
| L3mean | +0.0254 spans 0 | +0.0311 spans 0 | +0.0129 spans 0 | +0.0000 spans 0 |
| `L3 − L3mean` | +0.0508 (byEntity [0.0000,0.1055] spans 0) | +0.0650 clears | +0.0672 clears | +0.0749 clears |

**With MEAN aggregation the lexical fact signal does not clear the bar on either corpus pair.** The
result is specific to the degree-amplifying aggregator.

### 3e. Is it fact *text*, or entity names relayed through fact text?
Strip the fact's two endpoint canonical names out of its `source_text` (word-boundary, all occurrences)
and rebuild the index (`BM25fX`). BM25f alone falls from 0.2288 → **0.1158** (dal) and 0.1886 → 0.1240
(arxiv). As a third arm:

| | dal asc | arxiv asc | arxiv desc |
|---|---|---|---|
| `L3x − FACTNAME` | +0.0311 **spans 0** | +0.0439 clears | +0.0439 byEntity [0.0000,0.0902] spans 0 |
| `L3 − L3x` | +0.0452 clears | +0.0362 clears | +0.0310 clears |

The target's canonical name appears verbatim in the fact BM25f picks as its argmax **79.4%** (dal) /
**78.3%** (arxiv) of the time. Combined with doc 46's own `L3 − L3n` spanning 0 on both pairs, "lexical
**over fact text**" is not separated from "lexical over entity names".

**VERDICT — control 3: doc 46's MECHANISM claim FAILS.** The headline delta is not attributable to a
lexical fact substrate. It is reproduced, to within noise in all four configurations, by a third arm
built from nothing but entity fact-degree — a quantity the pair-construction rule inflates 4.1x/4.7x for
targets. The surviving positive finding (see control 1's FSHUF) is that BM25f carries *some* genuine
query-content signal on top of degree; what it does not carry is a demonstrated *substrate* story.

---

## LEAK INTERROGATION

**Question put:** does any part of the BM25 text include the query paper's own text/title, or the target
entity name verbatim? Does the L3c held-out guard actually hold out?

1. **Yes, structurally — and the guard is genuinely load-bearing.** `facts.source_text` frequently quotes
   the source abstract verbatim (e.g. `"Abstract: 'With the launch of the GPT-4 engine, the translation
   performance of ChatGPT is sig…'"`). Mean token-containment of a fact's text in its own source paper's
   title+abstract is **0.784**. Consequence: with the guard **removed**, BM25f alone goes to strict R@10
   **0.7175** (dal) / **0.7132** (arxiv) versus 0.2288 / 0.1886 guarded, and `L3ng − L3` = **+0.1412** /
   **+0.1034** (all three bootstraps above 0). The guard is correctly applied in doc 46's harness — but
   this is a substrate where any mapping hole is worth ~0.5 R@10, so the hole had to be audited.

2. **The 3.5% hole is benign, and I traced *why*.** dal-nlp's `attribution-dal-nlp.json` contains
   **137 of 147** ingest-ledger papers; the 179 unmapped facts (179/5177 = 3.5%, **all** in dal-nlp,
   arxiv has **0/5714**) are the facts of the 10 missing papers. Traced by argmax token-containment:
   **154/179** point at one of those 10 papers, 25 point at a mapped paper — and the tracing heuristic is
   itself only 85% accurate (it recovers the *recorded* paper for 256/300 mapped facts), so 179/179 is
   consistent with the data. **Those 10 papers can never be a query document**, because query pairs are
   built from `paperToEntities` keys, so an unmapped fact cannot leak the query document's own text.
   Empirically: 7/354 dal pairs have an unmapped fact as the target's BM25f argmax, and doc 46's L3c
   (drops all unmapped facts) still gives **+0.0678**, all three bootstraps above 0.
   **The doc's leak-hardening claim holds.**

3. **I closed a channel the guard structurally *cannot* catch — and it is empty.** If two fact rows
   shared a `source_text` and were mapped to *different* papers, the guard would exclude one copy and let
   the identical text through. I enumerated all duplicate-`source_text` groups across the four corpora:
   **169 groups, 0 split across papers** (163 all-same-paper, 6 containing an unmapped row). This is
   structural — attribution joins on `staging.reasoning = facts.source_text`, so duplicate texts always
   receive the identical candidate paper set. Channel closed.

4. **Residual textual leak is small but non-zero.** Max token-containment of the target's *surviving*
   facts in the query doc: mean **0.584** (dal) / **0.601** (arxiv), versus **0.333** / **0.334** for 20
   random non-target entities; `≥0.9` on **4/354** (dal) and **11/387** (arxiv); `== 1.0` on 0/354 and
   **7/387**. Caveat I must state against my own probe: the target-vs-random gap is *itself* confounded by
   degree (a max over 13.6 facts beats a max over 3.3), so it is not evidence of leakage per se.

5. **Entity-name verbatim presence: yes, 79.4% / 78.3%** (see 3e). Legitimate — BM25n does the same — but
   it is the mechanism, not fact semantics.

**VERDICT — leak: no kill.** Doc 46's guard is applied, is load-bearing, and its residual hole is bounded
and demonstrably not driving the result.

---

## Other things I checked and could not turn into a kill

- Doc 46's own kill conditions all genuinely pass: fact-text coverage 5177/5177 and 5714/5714 (100%);
  FACTMAX~BM25f top-10 Jaccard 0.085/0.084 and BM25n~BM25f 0.046/0.047 (nowhere near the 0.9 degeneracy
  threshold); held-out exclusions fire 9962/13030 times; no DB writes.
- `rankByScore(entMax, −Infinity)` gives BM25f a **full-length** ranking (97.9% / 97.4% of entities get a
  strictly positive BM25f score) whereas `BM25n` uses `minScore = 0` and is short. I suspected an
  asymmetric-list-length artifact in retrieved-set RRF; the SHUF control (identical length and score
  multiset, permuted labels) is **negative** in every config, so length asymmetry is not the mechanism.
- `L3` vs `L3c` on arxiv is *identical* (0.3437 both) because arxiv has zero unmapped facts — so the
  arxiv leg of doc 46's leak-hardening is vacuous, not confirmatory. The dal leg is the real one, and it
  passes.

---

## FINAL VERDICT: **NARROW**

Doc 46 must not be banked as written. It should be re-banked as:

> **What is demonstrated.** Adding a **third** retrieved-set RRF-60 arm that is **MAX-aggregated over an
> entity's facts** raises strict R@10 over the confirmed R4 fusion by **+0.0763 (dal, n=354)** and
> **+0.0801 (arxiv, n=387)**, above 0 on all three bootstraps in both corpus pairs, and it survives the
> index-DESC tie-break flip (+0.0960 dal, +0.0749 arxiv, all three above 0). This is **not** an RRF
> artifact: 40 meaningless third arms per corpus pair — uniform-random, entity-label-shuffled, and
> fact-score-shuffled-with-degree-preserved — produce 0/40 clearances and are mostly negative, and the
> real arm beats the tightest matched control head-to-head (`L3 − L3fshuf` = +0.0706 dal / +0.0672 arxiv,
> all three above 0). The held-out guard is applied, is load-bearing (removing it triples BM25f), and its
> 3.5% mapping hole is traced to 10 papers that can never be query documents; L3c confirms it.
>
> **What is NOT demonstrated — and doc 46 currently claims it.** That the **lexical fact substrate** is
> what earns the gain. A third arm built from **entity fact-degree alone, with no query input**,
> reproduces +0.0650 (dal — **clearing the identical DEMONSTRATED bar**) and +0.0517 (arxiv — byEntity
> spans 0), and `L3 − L3deg` **spans 0 in all four configurations** (+0.011 to +0.031). Targets on this
> task carry **4.08x / 4.73x** the corpus mean fact-degree **by construction** (an entity qualifies as a
> target only by appearing in ≥2 papers), so a popularity prior is directly predictive of target-hood
> here. Consistent with that: replacing MAX with MEAN aggregation — which removes the max-over-degree
> order statistic — **fails to clear the bar on either pair** (+0.0254 / +0.0311 dal, +0.0129 / +0.0000 arxiv, all four spanning
> 0); stripping endpoint entity names out of the fact text removes the clearance on dal (+0.0311, spans
> 0) and the target's own name is verbatim in BM25f's chosen fact ~79% of the time; and doc 46's own
> `L3 − L3n` already spans 0. So the mechanism is **not** "fact text is a distinct lexical substrate" —
> it is consistent with "MAX-over-facts injects a fact-degree prior plus entity-name lexical matching",
> and the current experiment cannot tell those apart.
>
> **Sub-claim retracted.** The engineering recommendation — L2 = RRF-60(dense-names, BM25-over-fact-text),
> "cheaper than R4 and better" — **loses its all-three-bootstrap clearance on arxiv under index-DESC**
> (`L2 − FACTNAME` = +0.0413, byEntity CI [0.0000, 0.0841]). It is a LEAD, not a demonstration, and must
> not be shipped into `recallEntitiesFused` on this evidence.
>
> **Status:** DEMONSTRATED that a third MAX-over-facts RRF arm helps on this proxy task.
> **UNPROVEN** that the lexical fact substrate (rather than a fact-degree prior) is the reason.
> Doc 34 §I1's "lexical index MISSING" gap is **not** closed by this result.

**What would settle it** (the owed experiment, since the degree prior was never pre-registered):
pre-register a degree-controlled arm — e.g. degree-stratified or degree-residualised BM25f, or the same
five arms on a **degree-balanced** query-pair construction that does not require an entity to appear in
≥2 papers — and require `L3 − L3deg` (not `L3 − FACTNAME`) to clear all three bootstraps. Until a
fusion arm beats a query-free popularity prior, the lexical-substrate claim is not established.
