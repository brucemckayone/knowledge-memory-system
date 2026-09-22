# 46 — Does a LEXICAL fact signal add to the confirmed name⊕fact fusion? — PRE-REGISTRATION

**Status: PRE-REGISTERED, NOT YET RUN.** Frozen 2026-09-17. **Cost ZERO** (frozen embed cache + BM25;
no Ollama, no LLM). Append results below the RESULTS line.

## 1. Why — convergent evidence from docs 44 and 45, pointing at a KNOWN architectural gap

Docs 44/45 were about causality and both returned nulls, but they produced one consistent side-finding:
**at fact level, lexical matching beats or matches dense on IDENTICAL text.**

- Doc 44: BM25-over-fact-text r@10 0.4252 vs dense-over-fact-embedding 0.3688 on stratum D.
- Doc 45: a held-out logistic regression given both signals learned **`bm25_z` = 0.693 vs `dense_z` =
  0.129 — ~5x the weight on lexical** — consistently across 5 folds and all four arms.
- The texts are the same object: `factEmbedTextFor` (`services/embed-text.ts:66`) embeds `source_text`
  when present, `promotion.ts:512` writes `sourceText: f.reasoning`, and 100% of pool facts have
  non-empty `source_text`. So this is **not** a wrong-text bug — the embedding is simply weaker than BM25
  on this text.

This matters because of a gap the project already recorded. Doc 34 §I1: *"**Substrate:** dense fusion
(name⊕fact) **+ a lexical/BM25 index** … **Current fit:** fusion HAVE (proven, R4); **lexical index
MISSING**."* And the arm registry confirms the gap is structural, not merely unused: **`BM25n` is BM25 over
entity NAMES**, and `FactRow` carried no fact text at all until this experiment added it. **There has never
been a BM25-over-fact-text signal in either the eval harness or the production read path.**

The one lever that has ever worked on this project is **fusing substrates** (R4: dense-names ⊕ dense-facts,
+0.0724 strict R@10, adversary-verified). This tests the obvious next fusion: add the lexical fact signal.

## 2. Task, data, conventions (inherited FROZEN — do not vary)
The established entity target-finding task via `retrieval-eval/harness.ts`, corpora **dal-nlp + dal-cv**,
frozen embed cache `prereg-artifacts/embed-cache.json`, query = paper `title + abstract`, target = the
held-out entity. Inherited verbatim: pair construction, `rankByScore` tie-break (index-asc), retrieved-set
RRF at k=60, the condensed oracle, and the **`regression` guard asserting ARM-NAME strict R@10 =
0.20056497 at n=354** — if that does not reproduce, the run is void (§6).

**Standing validity caveat (stated, not discovered later):** this is the **papers-as-queries** task, which
CLAUDE.md flags as a proxy with a known validity gap, and absolute levels ride on the index-asc tie-break.
**Deltas are the claim; absolute levels are not.** It is nonetheless the task the banked R4 number was
measured on, so it is the only directly comparable baseline.

## 3. The new signal
**BM25f** = BM25 over fact `source_text`, aggregated to an entity by **MAX** over that entity's facts —
mirroring `FACTMAX`'s aggregation exactly so the only difference between FACTMAX and BM25f is
dense-vs-lexical.

**Held-out guard (load-bearing):** `factSignals` (`harness.ts:86`) excludes facts whose source paper is
the query document. **BM25f applies the identical exclusion** (`fs.paper[i] === docId`). Omitting it would
leak the answer, since a fact extracted from the query document contains the query's own text. Asserted in
§6.

## 4. Arms

| arm | definition | role |
|---|---|---|
| NAME | dense over names | frozen baseline + regression guard |
| FACTMAX | dense over facts | the dense fact signal |
| **FACTNAME** | RRF-60(NAME, FACTMAX) | **the confirmed R4 lever — the bar to beat** |
| BM25f | lexical over facts, MAX-aggregated | is the fact signal better served lexically? |
| **L2** | RRF-60(NAME, BM25f) | lexical fact signal *instead of* dense |
| **L3** | RRF-60(NAME, FACTMAX, BM25f) | three-way — does lexical **add**? |

## 5. Metric + bar (frozen)

- **Primary: strict R@10.** Reported for every arm; condensed R@10 reported as secondary with the standing
  warning that the condensed oracle is **not arm-neutral** (it credits lexical/relevance-set retrieval far
  more than dense — doc 12 §3). **The primary claim is strict only.** A condensed-only win is not a win.
- **THE BAR (the house DEMONSTRATED standard):** **L3 − FACTNAME strict R@10 > 0 on all three bootstraps
  (byPair, byEntity, byDocument)**, the same bar R4 cleared at +0.0724. Anything less is a LEAD.
- Secondary, reported always: L2 − FACTNAME, BM25f − FACTMAX (the head-to-head on the fact substrate),
  L3 − NAME, R@{1,5,20,30}, and the **component top-10 Jaccard** between FACTMAX and BM25f — if that
  Jaccard is >0.9 the two signals are the same thing and any fusion result is uninformative (the
  degeneracy check `hybrid-names.ts` already applies).
- Per-corpus breakdown for both corpora; a delta carried by one corpus is a LEAD, not a demonstration
  (doc 44 C4: the BM25 lead there died under corpus clustering).

## 6. Kill / invalid conditions (fix; do NOT report as a finding)
1. ARM-NAME strict R@10 ≠ 0.20056497 at n=354 → substrate drift; void.
2. BM25f not applying the query-document fact exclusion → leak; void.
3. FACTMAX/BM25f top-10 Jaccard > 0.9 → signals degenerate; result uninformative.
4. Fact text empty on a material fraction of facts → BM25f is measuring nothing; report the coverage.
5. Any arm's aggregation differing from MAX between FACTMAX and BM25f → confounded comparison.
6. Any database write.

## 7. Pre-registered expectation
I expect **BM25f ≥ FACTMAX** on the fact substrate (docs 44/45 both point that way) and I am **genuinely
uncertain whether L3 beats FACTNAME** — adding a third signal can dilute RRF as easily as help it, and
doc 45 saw exactly that (RRF was *worse* than its better component on dal-cv).

Risk carried: doc 44 produced eight adversary corrections, three of them overclaims toward my own
conclusion, one a code bug in the headline number, and doc 45 contained a circular feature and a vacuous
check. Guards here: the frozen regression guard, the pre-specified degeneracy check, strict-only primary,
the three-bootstrap bar, and per-corpus reporting.

## 8. Discipline
Deterministic; no Claude in the measurement path. Pre-register → measure → blind adversary → bank.
NULL/negative pre-committed as valid. Frozen above the RESULTS line.

---

## RESULTS (append below; do not edit above this line)

**Run 2026-09-17. Cost ZERO.** Artifacts `prereg-artifacts/lexical-fact-signal-results-{dal,arxiv}.json`;
harness `platform/src/test/tools/lexical-fact-signal.ts`. Ran on **both** corpus pairs: `dal` (the R4 /
doc-12 pair, with the frozen regression guard) and `arxiv` (the **independent extraction** R4 was
confirmed on) — replication was not pre-registered but is reported as the stronger evidence.

### Two validations of the harness before any claim
- **Regression gate PASSED exactly:** ARM-NAME strict R@10 = 0.20056497175141244, n = 354 (dal).
- **R4 reproduces its banked number on arxiv:** `FACTNAME − NAME = +0.0724`, above 0 on all three
  bootstraps — bit-identical to CLAUDE.md's banked R4 figure.
- **Doc 12 reproduces its banked tie on dal:** `H60 − NAME = +0.0254`, CI spans 0 — its banked value.
- Degeneracy checks clean: FACTMAX vs BM25f top-10 Jaccard **0.085**, BM25n vs BM25f **0.046**. Fact text
  coverage **100%** (5177/5177). Held-out exclusions fired 9962 times.

### HEADLINE — the bar CLEARS on both corpus pairs

Strict R@10:

| arm | dal (n=354) | arxiv (n=387) |
|---|---|---|
| NAME | 0.2006 | 0.1912 |
| FACTMAX | 0.1780 | 0.2222 |
| **FACTNAME (R4)** | **0.2429** | **0.2636** |
| BM25n | 0.1893 | 0.1499 |
| H60 (doc 12) | 0.2260 | 0.2300 |
| BM25f | 0.2288 | 0.1886 |
| L2 = RRF(NAME, BM25f) | 0.3107 | 0.3049 |
| **L3 = RRF(NAME, FACTMAX, BM25f)** | **0.3192** | **0.3437** |
| L3n (lexical over names instead) | 0.2994 | 0.3230 |
| L3c (conservative, leak-hardened) | 0.3107 | 0.3437 |

**THE BAR: `L3 − FACTNAME` above 0 on all three bootstraps, in BOTH pairs.**

| | delta | byPair | byEntity | byDoc |
|---|---|---|---|---|
| dal | **+0.0763** | [0.0395, 0.1130] | [0.0330, 0.1192] | [0.0399, 0.1141] |
| arxiv | **+0.0801** | [0.0491, 0.1137] | [0.0391, 0.1240] | [0.0471, 0.1146] |

**DEMONSTRATED by the house standard**, and **all four individual corpora improve** (dal-nlp
0.1638→0.2260, dal-cv 0.3220→0.4124, arxiv-nlp 0.1768→0.2597, arxiv-cv 0.3398→0.4175) — the per-corpus
robustness doc 44's BM25 lead failed.

Against the name-only baseline the total gain is **+0.1186 (dal)** and **+0.1525 (arxiv)**, both above 0
on all three bootstraps — roughly **double R4's own +0.0724**.

**The leak exposure is not driving it.** 179/5177 (3.5%) of facts have no source-paper mapping, so the
held-out guard cannot fire for them. The conservative arm L3c drops those facts entirely and still
clears: **+0.0678 (dal)** and **+0.0801 (arxiv)**, all three bootstraps above 0 — on arxiv it is identical
to L3.

### The mechanism claim is NARROWER than the headline — controls matter
1. **`L3 − L3n` spans 0 on both pairs** (+0.0198 dal, +0.0207 arxiv). Swapping the lexical component from
   fact text to entity **names** is not distinguishable in the three-way. So the demonstrated claim is
   **"add a lexical substrate,"** *not* "fact text specifically."
2. **BUT in the two-way, fact text wins decisively: `L2 − H60` is above 0 on all three bootstraps in both
   pairs** (+0.0847 dal, +0.0749 arxiv). Once FACTMAX is present it partly substitutes for what fact-text
   lexical provides, which explains why the three-way difference collapses. Coherent, and both reported.
3. **`BM25f − FACTMAX` spans 0 and FLIPS SIGN across pairs** (+0.0508 dal, **−0.0336** arxiv). **This
   refutes the generalisation of docs 44/45's side-finding.** Lexical beating dense at fact level held on
   the *causal pass-through* task; it does **not** hold on entity target-finding. The docs-44/45 finding
   is task-specific and must not be cited as a general property of `fact_embedding`.

### Engineering note (the shippable shape)
**L2 = RRF-60(dense-names, BM25-over-fact-text)** reaches 0.3107 / 0.3049 — beating R4 (`L2 − FACTNAME` =
+0.0678 dal, +0.0413 arxiv, both above 0 on all three bootstraps) while needing **no fact embeddings at
all**: entity-name vectors plus a BM25 index over `facts.source_text`. That is *cheaper* than the current
R4 read path and better. L3 is nominally best and is the recommended target if fact embeddings are being
computed anyway.

### Caveats (standing, stated not discovered)
- **Papers-as-queries proxy task** with a known validity gap (CLAUDE.md). Deltas are the claim;
  **absolute levels ride on the index-asc tie-break** and are not.
- **Strict metric only.** The condensed oracle is not arm-neutral — it credits lexical retrieval far more
  than dense (doc 12 §3) — so it would inflate exactly these arms. Deliberately excluded from the claim.
- `FACTNAME − NAME` on **dal** is +0.0424 with byEntity spanning 0, weaker than its banked +0.0724 (which
  reproduces on arxiv). The L3 delta is measured against the FACTNAME computed in the same run, so it is
  internally valid, but R4's strength is corpus-dependent.
- Replication on arxiv was **not pre-registered**; it is a strengthening, and its `H60 − NAME` clears on
  arxiv (+0.0388) where doc 12 banked a tie on dal — so doc 12's tie is also corpus-dependent.
- **Blind adversary: NOT YET RUN.** Required before this is banked (§8).

### Banked disposition (pending adversary)
**The first demonstrated retrieval improvement in this arc.** Adding a lexical substrate as a third
signal to the confirmed name⊕fact fusion clears the house DEMONSTRATED bar on two independent corpus
pairs and all four corpora, roughly doubling R4's gain over name-only, and survives leak-hardening. The
mechanism is "a third, lexically-distinct substrate," not "fact text" specifically. **Recommended
follow-up:** wire a BM25 index over `facts.source_text` into the production read path
(`recallEntitiesFused`) — which closes doc 34 §I1's recorded **"lexical index MISSING"** gap.

---

## ADVERSARY VERDICT (2026-09-22) — **NARROW.** The headline survives; the mechanism claim does not.

Blind adversary run at §8's requirement. Full report: `scratch-doc46-adversary.md`. Harness:
`platform/src/test/tools/doc46adv-controls.ts` (the original `lexical-fact-signal.ts` is untouched).
Artifacts: `prereg-artifacts/doc46adv-{dal,arxiv}-{asc,desc}.json`. Every number below was
re-checked by the main session against those artifacts, and the degree base rates were reproduced
independently by SQL.

**Reproduction first.** Re-running the banked harness rewrote `lexical-fact-signal-results-arxiv.json`
byte-identically except `run_at`. The ARM-NAME regression gate is exact (0.20056497175141244, n=354).
So none of what follows is a harness bug.

### What SURVIVES
- **Not an RRF artifact.** 120 draws across three random/shuffled third-arm families x 10 seeds x 4
  configs: **0 clear the bar**. Uniform-permutation and score-multiset-shuffled arms are never positive.
  The tightest control — permuting per-fact BM25 scores across facts, preserving both the score
  distribution *and* every entity's fact-degree — means +0.0098…+0.0215, against a real +0.0763/+0.0801.
  `L3 − L3fshuf` is above 0 on all three bootstraps in all four configs.
- **Index-DESC tie-break.** `L3 − FACTNAME` goes +0.0763 → **+0.0960** (dal) and +0.0801 → **+0.0749**
  (arxiv), above 0 on all three bootstraps under both tie-breaks. Absolute levels move as the standing
  caveat predicts (dal NAME 0.2006 → 0.1836).
- **The held-out guard is sound and load-bearing.** Removing it takes BM25f to R@10 0.7175/0.7132 (from
  0.2288/0.1886), so the audit mattered. dal's 3.5% unmapped hole traces to 10 papers missing from
  `attribution-dal-nlp.json`, and those papers can never be a query doc, so no query text can leak
  through it. All 169 duplicate-`source_text` groups map to a single paper (0 split), closing a channel
  the guard structurally could not catch.

### What FAILS — a query-free popularity prior reproduces the gain
- Targets carry **4.08x** (dal) / **4.73x** (arxiv) the corpus mean fact-degree **by construction** — a
  pair only exists if the entity appears in >=2 papers. Verified independently by SQL: corpus mean
  fact-degree dal-nlp 3.470, dal-cv 3.193, arxiv-nlp 3.585, arxiv-cv 3.429.
- Spearman rho(BM25f entity score, eligible fact degree) = **0.501 / 0.509**.
- **`L3deg` — a third arm that is pure eligible-fact COUNT, with zero query input, and biased *against*
  the target because the guard strips the query doc's own facts — gives `L3deg − FACTNAME` = +0.0650
  (dal), above 0 on all three bootstraps: byPair [0.0311, 0.0989], byEntity [0.0087, 0.1244], byDoc
  [0.0319, 0.0977]. That is the identical house DEMONSTRATED bar the headline claims.** On arxiv it is
  +0.0517 with byEntity [0.0000, 0.1058] spanning 0. DEG *alone* is a weak retriever (R@10
  0.1243/0.1783, at or below NAME) — it only bites when injected as a third RRF arm, which is exactly
  this doc's move.
- **`L3 − L3deg` SPANS 0 in all four configs** (+0.0113, +0.0311, +0.0284, +0.0258). At this n the real
  lexical arm is statistically indistinguishable from a query-free degree prior.
- **MAX is what carries it.** `L3mean − FACTNAME` spans 0 in every config (+0.0254, +0.0311, +0.0129,
  0.0000). The win rides on the max-over-facts order statistic, which is itself degree-driven.
- **Not fact text.** Stripping endpoint canonical names from `source_text` drops BM25f from 0.2288 to
  0.1158 (dal) and `L3x − FACTNAME` to +0.0311, spanning 0. The target name is verbatim in BM25f's argmax
  fact **79.4% / 78.3%** of the time. Combined with this doc's own `L3n` tie, "lexical over fact text" is
  not separated from "lexical over names".

### CORRECTIONS OF RECORD to the sections above
1. **§"Engineering note (the shippable shape)" is RETRACTED to a LEAD.** Under index-DESC on arxiv,
   `L2 − FACTNAME` = +0.0413 with byEntity **[0.0000, 0.0841] — lower bound exactly 0, so it does not
   clear** "above 0 on all three bootstraps". L2 must NOT be wired into `recallEntitiesFused` on this
   evidence.
2. **§"Banked disposition"'s recommended follow-up is WITHDRAWN.** Doc 34 §I1's recorded "lexical index
   MISSING" gap is **NOT closed** by this result.
3. The surviving demonstrated claim is narrower than the headline: **adding a third MAX-over-facts RRF-60
   arm beats R4** by +0.076/+0.080 (+0.096/+0.075 index-DESC), all three bootstraps, both pairs. **Why**
   it works is unproven, and the leading explanation is now an artifact of how the task selects targets.

### OWED settling experiment (degree was never pre-registered here)
Pre-register either a degree-residualised / degree-stratified BM25f, or a degree-balanced pair
construction, and require **`L3 − L3deg`** — not `L3 − FACTNAME` — to clear all three bootstraps. Until
that runs, `nmemo-v3g` is a pre-registration task, not a ship.
