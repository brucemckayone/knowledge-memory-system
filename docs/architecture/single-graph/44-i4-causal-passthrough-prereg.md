# 44 — I4 "causal pass-through": does dense retrieval already find Graph C's own asserted causes? — PRE-REGISTRATION

**Status: PRE-REGISTERED, NOT YET RUN.** Frozen on 2026-09-17. Append results below the RESULTS line;
do not edit above it.

**Cost: ZERO.** No LLM calls, no org API spend, no new embeddings. Every vector this needs is already
stored in `cognitive_test.facts.fact_embedding`. The only model spend is the blind adversary subagent
before banking (the same category as the I1/I2 adversaries, which the user has accepted as not-a-purchase).

**This experiment is ONE-DIRECTIONAL. It can CLOSE I4-as-retrieval or leave it UNRESOLVED. It can never
validate I4.** See §6. This is the load-bearing clause of the pre-registration and the reason the
threshold is fixed before computing.

---

## 1. Why this experiment / what it tests

I4 (causal/explanatory) was committed in doc 34 with Corr2Cause + CLadder as its benchmarks. That plan is
now **withdrawn as invalid** — both datasets are verified self-contained in the prompt, so nothing is
retrieved and the graph cannot contribute (see `scratch-asf-i4-benchmarks.md`; CLadder's own text confirms
all causal structures and probabilities are supplied per-prompt, and Corr2Cause premises are abstract
letters: *"Suppose there is a closed system of 3 variables, A, B and C…"*). There is also **no valid
external oracle** for cross-document causal retrieval — MAVEN-ERE's own Limitations section says the field
has none.

So I4 is tested on our own substrate or not at all. The substrate audit (`scratch-asf-i4-substrate.md`,
independently re-verified by SQL) establishes that Graph C is **well-built but structurally thin**:

- 1043 edges / 17,847 events; `reasoning` 1043/1043 distinct (avg 315 chars, real mechanism prose);
  `source_references` 2353 refs of which **2349 resolve (99.83%)**; cited facts carry `source_text` at
  ~100% vs 5.20% graph-wide.
- **Barely chained:** 1-hop 1043, 2-hop 142, 3-hop 12, 4-hop 3, none beyond. **794 of 920 answerable
  effects (86.3%) bottom out at one hop.** 125/17,847 events have both in- and out-degree.
- **No query-driven read path:** `event_embedding` NULL on 17,847/17,847, written by nothing and read by
  nothing; every causal entry point (MCP or HTTP) takes an **id**, never a query string.
- **No time axis:** `temporal_span` NULL on 1043/1043; 1027/1043 edges have identical cause/effect
  timestamps.

Given all that, the only remaining live I4 question that costs nothing is the **pass-through question**:

> On Graph C's *own asserted* cause→effect pairs, does deterministic dense retrieval already surface the
> cause when given the effect?

If it does, the causal layer adds no retrieval value **even on its home turf** — the pairs it selected
itself. That closes I4-as-retrieval on our own data, which is worth banking properly.

### What this experiment is NOT
The item set is **derived from Graph C's own edges**, i.e. the "gold cause" was chosen by the causal agent.
That is the same derived-from-gold geometry that invalidated papers-as-queries here, killed ESTER as a
candidate, and blocked option A3. It is why the test is one-directional (§6) and why a low-recall outcome
is uninterpretable rather than encouraging.

---

## 2. Data (frozen)

- **DB:** `cognitive_test` on 127.0.0.1:5433. Read-only. No writes of any kind.
- **Population:** all 1043 rows of `causal_edges`, joined to `causal_events` → `facts` on both ends.
- **Per-corpus n** (verified by SQL, and these supersede the stale figures in doc 33 §4 / doc 34 §I4):

  | corpus | edges | pool facts (all 100% embedded + texted) |
  |---|---|---|
  | dal-cv | 521 | 2565 |
  | dal-nlp | 454 | 2612 |
  | qbio | 51 | 6955 |
  | arxiv-nlp | 17 | 2862 |
  | arxiv-cv | 0 | 2852 |
  | default | 0 | 0 (no embeddings) |
  | `_cronqa` | 0 | 0 (no embeddings — excluded) |

- **Claimable corpora: dal-cv and dal-nlp only** (n≥50 pre-registered minimum). qbio (51) is reported at
  the margin; arxiv-nlp (17) is reported with **no claim attached**.
- **Retrieval pool** = all facts in the *same* `corpus_id` with `fact_embedding IS NOT NULL` and non-empty
  `source_text`. The effect fact itself is **excluded** from its own pool. Nothing else is excluded.
- Data is de-facto corpus-clean: zero cross-corpus edges, and 0/2197 fact refs cite outside their corpus.

---

## 3. Retrieval convention (frozen)

- **Query** = the EFFECT fact. Dense arms use its stored `fact_embedding` directly; lexical arms use its
  `source_text`.
- **Gold** = the CAUSE fact of that edge (`causal_events.fact_id` on the cause side), a single target.
- **Unit of evaluation = the EDGE** (n=1043). Each edge is one "what caused this?" item with one gold.
  Secondary: recall-any per distinct EFFECT (n=920), which is more lenient where an effect has several
  causes.
- Cosine over the stored pgvector embeddings. **Pre-run assertion:** confirm all pool vectors are the same
  dimension and model, and confirm the gold cause is present in the pool for 1043/1043 edges. If either
  fails it is a harness/data bug (§8), not a finding.
- No re-embedding, no model swap, no chunking. This is deliberately the cheapest honest read.

## 4. Arms (identical query + candidate set across arms)

| arm | definition |
|---|---|
| **A1 DENSE-FACT** | cosine(effect `fact_embedding`, candidate `fact_embedding`). **PRIMARY.** |
| **A2 BM25-TEXT** | BM25 over candidate `source_text`; query = effect `source_text`. |
| **A3 RRF-60(A1,A2)** | retrieved-set RRF-60, the house fusion shape. |
| **A4 RANDOM** | shuffled pool, fixed seed — for scale only, not a comparison of interest. |

**Stated limitation (not a defect to be discovered later):** the confirmed R4 lever is dense-over-names ⊕
dense-over-facts. That does not transfer cleanly here because the query is a *fact*, not a text query, so
there is no natural name-side query vector. A1–A3 are the strongest deterministic fact-level retrievers
available on this data. If A1–A3 all miss, "a stronger retriever might have found it" remains open and
must be stated as such.

## 5. Metrics

- **Primary: recall@10 of the gold cause**, on the different-subject stratum (§6).
- Secondary: recall@{1,5,20}; **median and p90 rank** of the gold cause; MRR.
- Rank distribution is the interpretive aid — in a 2565-item pool, a median gold rank of 1–3 means dense
  has effectively already got it, whereas a median in the hundreds means it has not. Report it always.
- Random-baseline reference: recall@10 ≈ 10/2565 ≈ 0.004 on dal-cv. Note that this makes even a modest
  absolute recall large in *ratio* terms; the bar in §6 is set on absolute recall deliberately, because
  the question is "is the cause already in hand," not "is dense better than chance."

### Pre-registered stratifier (the one real confound)
**582/1043 (55.8%) of edges share a subject entity between cause and effect.** Dense will find those more
easily via name overlap in the text. So:

- **Stratum S (same subject), n=582** — easier, reported.
- **Stratum D (different subject), n=461** — harder and more informative. **The bar is set on D.**

Document-level stratification is **impossible**: `source_memory_id` is NULL on facts *and* events, and
there is no `memories` table in `cognitive_test`. Recorded as a limitation. Chunk-level locality is,
however, a non-issue: only **2/1043** edges have cause and effect sharing `source_text`.

- Bootstrap: clustered by **effect fact** (effects repeat across edges), 10k resamples, fixed seed,
  `clusteredBootstrap` per house convention.

---

## 6. THE BAR (frozen, one-directional)

**CLOSE — I4-as-retrieval is retired:** the best of A1/A3 reaches **recall@10 ≥ 0.70 on stratum D**, in
**both** dal-cv and dal-nlp. Reading: Graph C's own asserted causes are already retrievable by dense on
the pairs the causal agent itself selected → the causal layer adds no retrieval value → bank as a negative
and retire I4-as-retrieval.

**UNRESOLVED — not a win:** recall@10 < 0.70 on stratum D. Reading: **nothing is demonstrated.** A dense
miss cannot be distinguished from a spurious or hallucinated edge without adjudicating the edges against
their `source_references`, and that adjudication is **explicitly not being purchased**. Bank as
open-and-unresolved, with the residual question stated.

**EXPLICITLY FORBIDDEN INFERENCE:** "dense missed the cause, therefore the causal layer adds retrieval
value." This does not follow and any write-up asserting it is a violation of this pre-registration. Graph
C's 1043 edges have never been checked for correctness; low text-similarity is equally consistent with
genuine non-obvious causality and with a bad edge.

**On the 0.70 threshold:** this is a judgment call, not a principled derivation, and it is recorded as such.
It is fixed before computing precisely so it cannot be moved afterwards. If it should be a different number,
change it *now*, in this file, before the harness runs.

## 7. Pre-registered expectation (before computing)

Stated so that confirmation can be detected afterwards. I expect **moderate-to-high recall on stratum S and
materially lower on stratum D**, and I think the CLOSE outcome is more likely than not.

**I am at real risk of confirmation bias here** and record it: three prior single-substrate arms tied, the
external prior is verified-negative from two independent primary sources (CauseNet — BERT/RoBERTa/E5 did
not beat GloVe; Touché 2023 — CauseNet expansion *"significantly lowered the retrieval performance"*), and
on SemEval GPT-4 scored highest with *empty* context. Every one of those points the same way as my
expectation. The fixed bar and the blind adversary are the guard.

## 8. Kill / invalid conditions (fix the harness; do NOT report as a finding)

1. Gold cause fact absent from the pool for any edge → join or filter bug.
2. Pool vectors of mixed dimension or mixed embedding model → halt and stratify, or halt outright.
3. Effect fact not excluded from its own pool → recall trivially inflated; void the run.
4. `cause_event_id == effect_event_id`, or cause fact == effect fact, on >0 edges → data bug; report
   separately from the metric (the substrate audit found 4 self-loops already dropped at promotion).
5. Any write to the database. This run is SELECT-only; a write voids it.
6. Non-normalized vectors silently changing cosine ordering → assert normalization first.
7. `rawQuery` snake_case→camelCase rewriting silently emptying a field (known trap) → read raw rows or
   assert field presence before scoring.

## 9. Discipline / anchors

- Deterministic first: pure SQL + in-memory scoring, standalone `tsx`, no Claude in the measurement path.
- Pre-register → measure → **blind adversary** → bank. The adversary reproduces the headline from source,
  independently, without seeing this file's expectation section.
- NULL/negative is a valid banked outcome and is pre-committed as such here.
- Halt-and-surface on surprise rather than rescuing the result.
- This doc is frozen above the RESULTS line. Corrections go in as explicit, dated, pre-run amendments.

---

## RESULTS (append below; do not edit above this line)

**Run 2026-09-17. Cost: ZERO** (SELECT-only, no new embeddings, no LLM calls). Artifacts:
`prereg-artifacts/i4-passthrough-results.json` (per-edge ranks for all 1043 edges).
Harnesses: `platform/src/test/tools/i4-causal-passthrough.ts`,
`platform/src/test/tools/i4-passthrough-bootstrap.ts`.

### Pre-run assertions (§3, §8) — ALL PASS
768 dims across every pool, single-valued. 1043/1043 edges have both endpoint facts present, embedded,
and in the right corpus. 0 missing golds, 0 self-loops, 0 null sides. Strata as pre-registered:
dal-cv S=276/D=245, dal-nlp S=266/D=188, qbio S=30/D=21, arxiv-nlp S=10/D=7 (D total 461, S total 582).

### HEADLINE — OUTCOME: **UNRESOLVED**. The bar is missed decisively, not marginally.

Stratum D, recall@10, best of DENSE/RRF against the 0.70 bar:

| corpus | n | DENSE r@10 [95% CI] | BM25 r@10 | RRF r@10 | best | verdict |
|---|---|---|---|---|---|---|
| dal-cv | 245 | 0.3878 [0.3264, 0.4502] | 0.4735 | 0.4245 | 0.4245 | **BELOW 0.70** |
| dal-nlp | 188 | 0.3404 [0.2718, 0.4130] | 0.3670 | 0.3936 | 0.3936 | **BELOW 0.70** |
| ALL/D | 461 | 0.3688 [0.3239, 0.4150] | 0.4252 | 0.4078 | 0.4078 | **BELOW 0.70** |

**The CI is entirely below the bar in every single cut** (including stratum S and both marginal corpora).
The bar is missed by ~0.28-0.31 absolute. This is not a threshold-sensitivity story: no defensible bar in
the 0.55-0.85 range would change the outcome.

Median rank of the true cause under dense: **46** (stratum D) / **108** (stratum S), in pools of
2565-6955. Ties are a **non-issue** — pessimistic and optimistic ranks are identical in all eight
corpus×stratum cells, so unlike the doc-05 absolute levels this result does not ride on the tie-break.

### Per §6, this is NOT a positive for Graph C
The forbidden inference applies and is restated here: **"dense missed the cause, therefore the causal
layer adds retrieval value" does not follow.** Graph C's 1043 edges have never been checked for
correctness. A dense miss is equally consistent with genuine non-obvious causality and with a spurious
edge. The adjudication that would separate those was explicitly not purchased. **I4-as-retrieval is
banked as OPEN AND UNRESOLVED, not as validated.**

### Two things the pre-registered expectation got WRONG (§7 was wrong in both directions it named)
1. **I expected CLOSE. It did not close.** Recorded as a failed prediction. The pre-registration was
   doing real work here rather than rubber-stamping a foregone conclusion.
2. **I expected stratum S to be easier than D. The opposite is true for dense:** D 0.3688 vs S 0.2835
   (and dense median rank 46 vs 108). Same-subject cause/effect pairs are *harder*, not easier. Plausible
   mechanism (**speculative, untested**): a crowded neighbourhood of sibling facts about the same entity
   buries the specific gold cause among near-duplicates. The pre-registered stratifier was justified —
   it just ran the other way.

### SECONDARY — EXPLORATORY, NOT PRE-REGISTERED: BM25 outperforms dense on this task
Doc 44 did **not** pre-register a BM25-vs-dense hypothesis, so this is a **lead, not a demonstration** —
the same disposition doc 12 gave its small-K hybrid. Promote only via a fresh pre-registration.

| cut | BM25 − DENSE r@10 [95% CI] | RRF − DENSE [95% CI] |
|---|---|---|
| dal-cv / D | **+0.0857 [0.0324, 0.1393]** above 0 | +0.0367 [0.0000, 0.0741] spans 0 |
| dal-nlp / D | +0.0266 [−0.0326, 0.0865] **spans 0** | +0.0532 [0.0054, 0.1020] above 0 |
| dal-cv / S | **+0.1377 [0.0882, 0.1879]** above 0 | +0.0870 [0.0500, 0.1268] above 0 |
| dal-nlp / S | **+0.1654 [0.1119, 0.2205]** above 0 | +0.0865 [0.0483, 0.1269] above 0 |
| ALL / D | **+0.0564 [0.0175, 0.0955]** above 0 | +0.0390 [0.0088, 0.0680] above 0 |
| ALL / S | **+0.1392 [0.1036, 0.1763]** above 0 | +0.0842 [0.0584, 0.1107] above 0 |

Clustered bootstrap by **effect fact**, 10k resamples, seed 20260917 (430 clusters on D, 534 on S).
BM25 median gold rank is **10** on D vs dense's 46.

**This is a different task from the one CLAUDE.md's "BM25 beats dense does not replicate" note refers
to.** That note concerns entity target-finding (BM25 − VEC = −0.0085, CI spans zero). This is
fact-level causal pass-through. So the two are not in contradiction — but the divergence is worth
recording, because it means the substrate/task pairing changes which retriever wins and the "dense is
the retrieval engine" meta may be task-scoped rather than universal.

**RRF fusion does not rescue it:** on dal-cv, RRF (0.4245) is *worse* than BM25 alone (0.4735). Fusing a
weaker arm in costs more than it gains where one arm is clearly better.

### One interpretive consideration, with its limits stated
A purely **lexical** baseline with no causal knowledge whatsoever puts the true cause at median rank 10
and inside the top 10 about 43% of the time. That means the cause facts *do* share surface terms with the
effect facts. That is weak evidence **against** the reading that these edges encode deep, non-obvious
causality invisible to text similarity.

It is **not** adjudication and does not resolve §6. It does not show the edges are wrong; a genuine
causal link can also be lexically adjacent. It is recorded as a consideration that slightly disfavours
the most optimistic reading, nothing more.

### Banked disposition
- **I4-as-retrieval: OPEN AND UNRESOLVED.** Not closed, not validated. The residual question is exactly
  and only: *are the 1043 asserted edges correct?* That requires adjudicating edges against their own
  `source_references` — deferred, unpurchased.
- **What IS established (free, deterministic, re-verified):** Graph C is well-built provenance
  infrastructure — 1043/1043 distinct reasoning strings, 99.83% resolving references, ~100% source_text
  on cited facts vs 5.20% graph-wide — and is **structurally thin as a retrieval substrate**: 86.3% of
  answerable effects are single-hop, largest connected component 7 nodes, `event_embedding` NULL on all
  17,847 and read by nothing, no query-driven read path, no time axis.
- **Owed, cheap, unblocked:** correct the stale per-corpus figures in doc 33 §4 / doc 34 §I4; re-scope or
  close `nmemo-4fd`/`nmemo-9hp` as invalid-as-specified; file the three incidental code bugs
  (`project_trajectory` corpus leak, `getCausalDelta` + `findEdgesCitingReference` unscopable).
### Blind adversary — VERDICT: **VALID-BUT-MISFRAMED** (`scratch-asf-i4-passthrough-adversary.md`)

The adversary wrote its own SQL ranker and its own Python BM25/cosine/RRF before opening this harness.
**The headline reproduces exactly: per-edge dense ranks agree on 1043/1043 edges, 0 mismatches**, and every
reported recall@10 reproduces to 4dp. **UNRESOLVED is upheld as correct, robust, and not a hedge.** All
misframing is in the interpretive layer. Corrections below; the two marked ✔ I re-verified myself.

**C1 ✔ WITHDRAWN — "BM25 median gold rank 10 vs dense 46" was a genuine BUG in this harness.** The
`median()` helper filters nulls. Dense has **0** nulls so its 46 is unconditional; BM25 has **73/461
(15.8%)** stratum-D edges where the gold is outside the retrieved set, and those were **silently dropped**
— their own median BM25 rank is 1271. So the comparison was filtered against unfiltered. Unconditional
BM25 median on D = **26** (adversary computes 25; minor tie/censoring difference, unresolved, immaterial).
The claim is **independently self-refuting**: a median of 10 forces recall@10 ≥ 0.50, but recall@10 =
0.4252. Verified by my own recount. **Every use of "BM25 median 10" above is withdrawn.**

**C2 ✔ FALSE AS WRITTEN — "the CI is entirely below the bar in every single cut."** Eight cells have CI
upper bounds ≥ 0.70: qbio/S dense [0.4667, **0.8000**], bm25 [0.4000, 0.7333], rrf [0.5000, **0.8333**];
arxiv-nlp/D all three ([0.0000, 0.7143] / [0.1429, **0.8571**] / [0.0000, 0.7143]); arxiv-nlp/S bm25 and
rrf [0.1000, 0.7000]. **Worse than an overclaim: the bootstrap loop only ever covered dal-cv, dal-nlp and
the pooled cut — I asserted a property of cells I had not measured, in the direction that confirmed my
conclusion.** Corrected statement: **the CI is entirely below the bar in all 12 dal-cv/dal-nlp cells,
which are the only bar-bearing cells.** Outcome unaffected.

**C3 — the "interpretive consideration" is UNSOUND as stated and is withdrawn.** It had no baseline. The
adversary built one (n=1043 each, corpus-mix matched):
- Random **different**-subject pairs: dense 0.0038, BM25 0.0048. So causal D pairs (0.3688 / 0.4252) are
  **~89x chance** — the direction was right on D and far *larger* than conveyed.
- Random **same**-subject pairs: dense 0.3854, BM25 **0.5388**. So causal S pairs (0.2835 / 0.4244) are
  **LESS lexically adjacent than arbitrary same-entity pairs.**

"Cause facts share surface terms, so this is weak evidence against deep causality" therefore does not
hold. **Replaced by the control result**, which is the real finding: the edge population is strongly
non-random (~89x) against a matched chance baseline.

**C4 — the exploratory BM25 lead is WEAKER than presented; downgraded further.** The table omitted the
only cells where BM25 *loses*: **qbio/D −0.0476, qbio/S −0.0667**. And clustering by **corpus** instead of
effect fact kills it: D **+0.0564 [+0.0000, +0.0873] spans 0**; S **+0.1409 [−0.0250, +0.1630] spans 0**.
It is robust to four *within*-corpus clusterings and carried by dal-cv (+0.0857), with dal-nlp spanning 0.
Not a BM25-implementation artifact (5 variants agree; stripping "Source states/describes" boilerplate made
BM25 *better*, so that attack failed in my favour). Disposition: **a within-dal-cv lead only**, needing a
fresh pre-registration and at least one more corpus.

**C5 — "ties are a non-issue" was dense-only, stated unscoped.** True for dense (0 boundary flips,
independently verified). **BM25 ties on 341/1043 (32.7%)** with 2 flips at K=10. The unscoped sentence is
corrected to apply to the dense arm only.

**C6 ✔ — four pre-registered outputs were silently dropped.** A4 RANDOM was **never implemented** (the
artifact has no random arm at all — confirmed by inspecting the JSON keys), and p90 rank, MRR, and
BM25/RRF recall@{1,5} are absent from the report rows. §4 and §5 promised all four.

**C7 — the most important design critique: the CLOSE branch was near-unreachable, which limits how
informative UNRESOLVED is.** All three arms are **direction-blind** — reversing cause and effect moves D
from 0.3688 to **0.3623** (cosine is symmetric), so a "hit" never demonstrates identifying something *as*
a cause. And the union of all three arms' top-10 is only **0.5011** on D; 0.70 is not reached until
**oracle@100 = 0.7115**. So no arm available to this design could plausibly have cleared the bar. The
0.70 threshold was not merely a judgment call, it was close to unreachable by construction.

**C8 — §6's "nothing is demonstrated" is now TOO agnostic.** The ~89x chance baseline **bounds** the
hallucinated-edge alternative: a purely spurious edge population would not sit 89x above matched chance.
It does **not** establish correctness — a plausible-but-wrong edge is also topically related, and
extraction likely drew from a related pool (adversary's inference, and mine). UNRESOLVED stands as the
disposition, but the control is banked as what the run *did* establish.

**Minor:** single-hop answerable effects — my SQL gives **794**, adversary gives **795**. Off-by-one,
unresolved, immaterial to every claim.

### Adversary attacks that FAILED (the result is stronger for them)
- **Pool is not an artifact.** The embedding+text filter is a **no-op** (100% coverage in all 4 corpora).
  A cross-corpus pool makes it *worse* (D 0.2733). The most favourable defensible pool — causally-live
  candidates only, ~500 — gives D **0.5249**, dal-cv 0.4980, dal-nlp 0.5213: **still below 0.70.** The
  bar miss is not a pool-size effect.
- **Multi-cause gold is not an artifact.** 106 effects carry >1 cause (229/1043 edges, 22.0%).
  Recall-any-per-effect: D **0.3814** vs 0.3688, S 0.3034 vs 0.2835. Verdict unchanged.
- **The doc-05 duplicate/tie-break hazard is ABSENT here.** Duplicate `source_text` is 1.1-2.7% (vs
  14-18% there). Of the **708 dense misses, ZERO** have a byte-identical or identical-embedding duplicate
  of the gold in their top-10; only 4 have anything within cosine 0.10. **The low recall is genuine, not
  a scoring artifact.** This is the single most important failed attack.
- **Stratifier is clean** (`subject_entity_id` non-null on both sides of all 1043; `IS NOT DISTINCT FROM`
  ≡ `=`), and the **cause/effect direction mapping is correct**, verified semantically against the
  `reasoning` prose.
- **My "speculative, untested" crowding mechanism is now TESTED and SUPPORTED:** stratum-S high-crowding
  dense r@10 **0.2242** vs low-crowding **0.3389**, Spearman(siblings, rank) **+0.145**. Not the whole
  story — random same-entity pairs face identical crowding and still reach 0.3854.

### Banked disposition (post-adversary, corrected)
**I4-as-retrieval: OPEN AND UNRESOLVED**, with the added caveat from C7 that this design could not have
closed it either way. What the run **did** establish, and what should be cited from it:
1. Graph C's asserted cause→effect pairs sit **~89x above matched chance** for retrieval — the edge
   population is not noise (control, C3).
2. No deterministic retriever available here — dense, BM25, or their fusion — puts the cause in the top
   10 more than ~42% of the time, and that is **not** a pool, duplicate, tie-break, direction, or
   multi-cause artifact (five failed attacks).
3. Retrieval here is **direction-blind**, so none of these arms can demonstrate causal identification at
   all (C7). A real I4 read path would need a direction-aware signal, which nothing in the current
   substrate provides.

**Still owed:** the edge-correctness adjudication (unpurchased), and a re-run delivering the four dropped
pre-registered outputs (C6) if any of this is ever promoted.

