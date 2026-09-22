# scratch — BLIND ADVERSARY audit of I4 causal pass-through (doc 44)

**Auditor:** blind adversary subagent. **Date:** 2026-09-17. **Mode:** read-only (SELECT only; no DB
writes, no source files modified). Own harness written from scratch in the session scratchpad before
any of the experiment's own code or the results artifact was opened.

---

# VERDICT: **VALID-BUT-MISFRAMED**

**The headline reproduces exactly and the UNRESOLVED disposition is correct and robust.** Per-edge dense
ranks agree with the artifact on **1043/1043 edges (0 mismatches)**. Every reported dense, BM25 and RRF
recall@10 figure reproduces to 4 decimal places under my own independent implementations. The bar is
missed by a margin no defensible re-specification recovers, and the miss survives every attack I could
mount on the pool, the unit, the tie-break, the direction and the stratifier.

**The misframing is in the interpretive layer, not the measurement.** The one number carrying the
write-up's "weak evidence against deep causality" consideration — "BM25 median gold rank is **10** on D" —
is computed on a **survivorship-filtered denominator** (73/461 zero-score edges dropped, whose own median
rank is 1271) and is compared against dense's **unfiltered** median. The unconditional value is **25**.
A median of 10 is also arithmetically impossible next to the write-up's own recall@10 = 0.4252. Adding
the missing baseline **reverses that consideration's sign on stratum S**. Three further overclaims and
four silently dropped pre-registered metrics follow.

No finding touches the banked outcome. All of them touch what the write-up says *around* it.

---

## Findings, most serious first

1. **(1-verified) "BM25 median gold rank is 10 on D" is survivorship-conditioned, and it is the number
   the load-bearing interpretive claim rests on.** The artifact's `bm25` block carries a `retrieved`
   field (`"med": 10, "retrieved": 388`) that `dense` does not. I reproduced their 10 exactly by
   conditioning on `bm25_opt IS NOT NULL`: **stratum D n=461, ranks present for 388, 73 dropped (15.8%),
   conditional median 10, unconditional median 25.** My own BM25 rank for those 73 dropped edges has
   **median 1271** (min 87, max 4225) — they are the worst cases in the stratum. Dense's median 46 is
   unconditional (`dense_opt` present on 1043/1043), so line 248's "BM25 median gold rank is **10** on D
   vs dense's **46**" compares a filtered median against an unfiltered one, biased toward BM25.
   Independently, **median 10 cannot coexist with recall@10 = 0.4252**: if half the stratum ranked ≤10,
   recall@10 would be ≥0.50. My quantiles for BM25 on D: **p10=1, p25=3, p50=25, p75=532, p90=1383**.
   This propagates into §"One interpretive consideration" (line 260), which pairs the *conditional*
   median with the *unconditional* 43% recall in one sentence.

2. **(1-verified) The interpretive consideration has no baseline; supplying one reverses it on stratum S
   and amplifies it on stratum D.** I built the control the write-up omits — random within-corpus fact
   pairs, corpus-mix matched, n=1043 each:

   | pairs | DENSE r@10 | DENSE med | BM25 r@10 | BM25 med |
   |---|---|---|---|---|
   | causal edges, stratum D | 0.3688 | 46 | 0.4252 | 25 |
   | **control: random DIFF-subject pair** | **0.0038** | **1337** | **0.0048** | **1065** |
   | causal edges, stratum S | 0.2835 | 108 | 0.4244 | 19 |
   | **control: random SAME-subject pair** | **0.3854** | **40** | **0.5388** | **8** |

   On **D** the causal pairs are ~89x more lexically adjacent than chance (0.4252 vs 0.0048) — the
   write-up's direction is right and the effect is far larger than it conveys. On **S** the causal pairs
   are **less** adjacent than arbitrary pairs about the same entity (BM25 0.4244 vs 0.5388; dense 0.2835
   vs 0.3854). So "the cause facts *do* share surface terms with the effect facts → weak evidence against
   deep non-obvious causality" is **unsound as stated**: against an entity-matched baseline the causal
   pairs share *fewer* surface terms than random ones. The honest two-sided statement is: the edge
   population is demonstrably non-random on the lexical axis (vs chance), and demonstrably not trivially
   adjacent either (vs same-entity pairs).

3. **(1-verified) "The CI is entirely below the bar in every single cut (including stratum S and both
   marginal corpora)" (line 210) is false.** Clustered bootstrap by effect fact, 20k resamples, five
   cells have CI upper bounds at or above 0.70: `qbio/S` dense 0.6333 **[0.4483, 0.8000]**, bm25 0.5667
   **[0.3871, 0.7586]**, rrf 0.6667 **[0.4828, 0.8333]**; `arxiv-nlp/D` bm25 0.4286 **[0.1111, 0.8333]**;
   `arxiv-nlp/S` bm25 and rrf 0.4000 **[0.1000, 0.7000]**. The claim holds for all 12 dal-cv/dal-nlp cells,
   which is where the bar was pre-registered, so the **outcome is unaffected** — but the sentence
   explicitly claims the marginal corpora, and there it fails. This is an overclaim in the
   *negative-confirming* direction.

4. **(1-verified) The exploratory BM25 table omits the only cells where BM25 loses, and the delta does not
   survive corpus-level clustering.** Absent from the line 238-245 table: `qbio/D` BM25−dense =
   **−0.0476** and `qbio/S` = **−0.0667**. qbio is the only non-dal corpus with n≥50 and the pre-reg
   promised it "reported at the margin"; it *is* reported for the absolute bar but not for the secondary
   delta, and its sign is the unfavourable one. Re-clustering the bootstrap (10k resamples):

   | clustering | D delta | S delta |
   |---|---|---|
   | by effect fact (pre-reg) | +0.0564 [+0.0172, +0.0957] above 0 | +0.1409 [+0.1045, +0.1780] above 0 |
   | by cause fact | +0.0564 [+0.0174, +0.0957] above 0 | +0.1409 [+0.1051, +0.1765] above 0 |
   | by effect subject entity | +0.0564 [+0.0164, +0.0955] above 0 | +0.1409 [+0.1035, +0.1798] above 0 |
   | iid edge | +0.0564 [+0.0174, +0.0954] above 0 | +0.1409 [+0.1065, +0.1770] above 0 |
   | **by corpus (4 clusters)** | **+0.0564 [+0.0000, +0.0873] SPANS 0** | **+0.1409 [−0.0250, +0.1630] SPANS 0** |

   The "above 0" is robust to every within-corpus clustering and dies when the corpus is the unit of
   replication — consistent with the per-corpus picture (dal-cv +0.0857 [+0.0328, +0.1400]; dal-nlp
   +0.0266 [−0.0321, +0.0865] spans 0; qbio −0.0476). **The pooled effect is carried by dal-cv.** The
   "exploratory / lead, not a demonstration" label is adequate in principle, but the write-up then draws
   a meta-inference from it ("the 'dense is the retrieval engine' meta may be task-scoped rather than
   universal", line 253) that one-of-four corpora reverses. The "different task, not a contradiction"
   defence against CLAUDE.md's non-replication note is **legitimate on its face** (entity target-finding
   vs fact-level pass-through are genuinely different tasks and substrates) but is stated more cleanly
   than the data supports; the honest version names dal-cv as the carrier and qbio as the reversal.
   *(Sensitivity: the sign is NOT an artifact of my BM25 choices — 5 variants (k1/b grid, stopword
   removal including the "Source states/describes" boilerplate, minlen≥3) all give D delta +0.052 to
   +0.061 and qbio negative at −0.048 in every one. Removing the boilerplate makes BM25 **better**
   (D 0.4273, S 0.4519), so BM25's advantage is not a boilerplate artifact — this attack of mine failed.)*

5. **(1-verified) "Ties are a non-issue — pessimistic and optimistic ranks are identical in all eight
   corpus×stratum cells" (line 216) is a dense-only fact stated unscoped.** The artifact computes
   `r10_pess` on `dense` only; `bm25` and `rrf` have no pessimistic rank at all. For dense the claim is
   **true and I verify it independently: 0 boundary flips at K=10 in all 8 cells** (34/1043 edges have any
   tie). For BM25 under full scoring, **341/1043 edges (32.7%) have tied golds and 2 cross the K=10
   boundary**; my optimistic/pessimistic split straddles their reported numbers (`dal-nlp/D` 0.3670/0.3617
   — they report 0.3670; `dal-cv/S` 0.4312/0.4275 — they report 0.4275), which is exactly what a
   retrieved-set BM25 produces and is defensible, but it means "this result does not ride on the
   tie-break" cannot be asserted for the lexical arm whose median is quoted in the interpretation.

6. **(1-verified) Four pre-registered metrics silently dropped.** §4 pre-registers **A4 RANDOM**; the
   artifact has `"random": null` in every row and the write-up never reports it (my own: D 0.0087,
   S 0.0017 — consistent with the predicted ~0.004, so immaterial, but it was promised). §5
   pre-registers **p90 rank** and **MRR** — neither appears anywhere in the artifact or write-up. §5
   pre-registers **recall@{1,5,20}** — present for dense and rrf, but `bm25` carries only `r10`/`r20`,
   so BM25 recall@1 and @5 were never computed (mine: D r1=0.1453, r5=0.3536). None of these changes the
   verdict; the write-up should say they were dropped rather than omit them.

7. **(1-verified, process) The "frozen" pre-registration is untracked in git.**
   `git ls-files --error-unmatch docs/architecture/single-graph/44-i4-causal-passthrough-prereg.md` →
   *"did not match any file(s) known to git"*. It has never been committed, so there is **no
   version-control evidence that the bar preceded the run**. Its mtime (`14:32:08`) post-dates the results
   JSON (`14:30:22`) by 106s, which is *consistent with* the sanctioned append-results-below-the-line
   workflow and is **not** evidence of HARKing — but with the file uncommitted, "frozen on 2026-09-17"
   is unverifiable from the repository. Process gap, not a finding against the result. Fix: commit the
   prereg before the run, so the freeze is provable.

8. **(1-verified + 3-inference) Design: all three arms are direction-blind, and the CLOSE branch was
   close to unreachable.** Reversing the mapping (query = cause, gold = effect) moves pooled D recall@10
   from **0.3688 to 0.3623** and the median from 46 to 45 — cosine is symmetric, so the experiment cannot
   distinguish "retrieved the cause" from "retrieved a mutually-related fact" (*inference:* a hit
   therefore does not mean the retriever identified anything **as** a cause, so the CLOSE branch's
   reading — "dense already has it → the causal layer adds no retrieval value" — would have been
   unearned had the bar cleared; moot because it didn't). Separately, the **union of all three arms'
   top-10 reaches only 0.5011 on D** (oracle@30 = 0.6161, and 0.70 is not reached until **oracle@100 =
   0.7115**), so no combination of the pre-registered arms could have cleared a 0.70 bar at K=10. The
   pre-registration records the threshold as "a judgment call, not a principled derivation" (line 150),
   which is honest, but the positive branch was near-unreachable by construction and the experiment was
   therefore close to guaranteed to return UNRESOLVED. That limits how much the UNRESOLVED outcome tells
   anyone.

---

## 1. Independent reproduction (task 1)

Own code, written before opening the experiment's harness or artifact:
`scratchpad/ranks_dense.sql` (exact ranks by correlated count, pure SQL), `scratchpad/audit.py` (own
BM25 + cosine + RRF-60 + random), `scratchpad/boot.py`, `scratchpad/variants.py`, `scratchpad/controls.py`.

The dense rank SQL, for the record:

```sql
1 + (SELECT count(*) FROM facts p
      WHERE p.corpus_id = e.corpus_id
        AND p.fact_embedding IS NOT NULL
        AND p.source_text IS NOT NULL AND btrim(p.source_text) <> ''
        AND p.id <> e.effect_id
        AND (p.fact_embedding <=> e.effect_emb) < (e.cause_emb <=> e.effect_emb)) AS rank_optimistic
```
with a parallel count of `= ` for the pessimistic rank. Forced exact scan for the top-10 lateral
(`SET enable_indexscan = off`) to avoid the known HNSW/`iterative_scan` filtered-search trap.

### Headline comparison — all (1-verified)

| quantity | reported | mine | match |
|---|---|---|---|
| dal-cv/D dense r@10 | 0.3878 | 0.3878 | exact |
| dal-nlp/D dense r@10 | 0.3404 | 0.3404 | exact |
| pooled D dense r@10 (n=461) | 0.3688 | 0.3688 | exact |
| pooled S dense r@10 (n=582) | 0.2835 | 0.2835 | exact |
| dal-cv/D BM25 / RRF | 0.4735 / 0.4245 | 0.4735 / 0.4245 | exact |
| dal-nlp/D BM25 / RRF | 0.3670 / 0.3936 | 0.3670 / 0.3936 | exact |
| pooled D BM25 / RRF | 0.4252 / 0.4078 | 0.4252 / 0.4078 | exact |
| pooled S BM25 / RRF | 0.4227 / 0.3677 | 0.4227 (pess) / 0.3677 | exact |
| dense median rank D / S | 46 / 108 | 46 / 108 | exact |
| strata dal-cv S/D | 276 / 245 | 276 / 245 | exact |
| strata dal-nlp S/D | 266 / 188 | 266 / 188 | exact |
| strata qbio S/D, arxiv-nlp S/D | 30/21, 10/7 | 30/21, 10/7 | exact |
| BM25−dense pooled D | +0.0564 [0.0175, 0.0955] | +0.0564 [+0.0172, +0.0957] | exact obs, CI within RNG |
| BM25−dense pooled S | +0.1392 [0.1036, 0.1763] | +0.1409 opt / **+0.1392 pess** [+0.1045, +0.1780] | 1-edge tie |
| per-edge `dense_opt` | artifact | mine | **0 / 1043 mismatches** |

**Discrepancies flagged, however small:**
- **BM25 median rank on D: reported 10, mine 25.** Root cause identified and reproduced — survivorship
  conditioning (finding 1). This is the one material discrepancy.
- **Pooled-S BM25 = 0.4227 is my pessimistic value; dal-nlp/D BM25 = 0.3670 is my optimistic value.**
  Not an error: their retrieved-set BM25 treats a zero-score gold as unretrieved (= a miss), which is
  equivalent to pessimistic for zero-score ties and optimistic for genuine mid-list ties. Defensible,
  and it is *why* finding 5's blanket tie claim does not hold for BM25.
- **Median convention:** reported medians match SQL `percentile_disc(0.5)` (lower median). My Python
  upper-median gives 113 for pooled S and 132/515 for dal-cv/S, arxiv-nlp/S. Both defensible, n even.
  No impact.
- **`arxiv-nlp/S` dense median:** artifact 515, my SQL lower-median 341 — same even-n convention.
- **Single-hop count:** write-up says "794 of 920"; I count **795** effects that are never themselves a
  cause (86.4%, not 86.3%). Off-by-one, immaterial.
- BM25 exact ranks differ on 186/960 edges and RRF on 412/1043 — expected for independent
  implementations (retrieved-set vs full-list scoring, tokenizer differences); recall@10 nonetheless
  agrees to 4dp in every reported cell, which is the metric in play.

### Pre-run assertions independently re-verified (all 1-verified)
1043 edges, `0` null cause/effect `fact_id`, `0` self-loops (`cause_id = effect_id`), `0` cross-corpus
edges, 768 dims uniform, gold present in pool for 1043/1043, `0` expired endpoints. Corpus mix
dal-cv 521 / dal-nlp 454 / qbio 51 / arxiv-nlp 17 = 1043.

---

## 2. Attacks on the design (task 2) — all of these FAILED to break the verdict

- **Is the pool right? (1-verified)** The pool filter is a **no-op**: in all four corpora
  `fact_embedding IS NOT NULL` and non-empty `source_text` hold for **100%** of facts (dal-cv 2565/2565,
  dal-nlp 2612/2612, qbio 6955/6955, arxiv-nlp 2862/2862), so "including facts without source_text"
  changes nothing. Both alternative pools I built move the verdict the *wrong* way for the system or not
  far enough:
  - **cross-corpus pool** (all 5 real corpora, 17,846 facts): D dense drops 0.3688 → **0.2733**, median
    46 → 149. The same-corpus pool is the *favourable* choice; the verdict is robust to the unfavourable
    direction.
  - **causally-live oracle pool** (candidates restricted to the ~500/2565 facts that are ever a cause —
    unavailable at query time, so it bounds pool-size effects): D dense rises to **0.5249** pooled,
    **dal-cv 0.4980**, **dal-nlp 0.5213**. Still below 0.70 in both bar-bearing corpora. **The bar miss
    is not a pool-size artifact.** (qbio/S hits 0.9667 and arxiv-nlp/D 0.8571 but their oracle pools
    collapse to 50 and 16 candidates — degenerate.)
- **Is the gold well-defined? (1-verified)** **106 effects have multiple causes** (91×2, 13×3, 2×4),
  touching **229/1043 edges (22.0%)**; 1043 edges over 920 distinct effects. Under the pre-reg's own
  secondary **recall-any-per-effect** unit: **D 0.3814** (430 units) vs per-edge 0.3688; **S 0.3034** vs
  0.2835. The per-edge unit does mildly penalise the retriever, by **+0.013 on D**. **Verdict unchanged.**
  No (cause, effect) fact pair appears twice (1043 distinct pairs), and event→fact fan-out is 1:1 for all
  but one fact, so there is no hidden duplicate-unit inflation.
- **Duplicate / near-duplicate hazard — the doc-05 analogue: ABSENT here (1-verified).** Duplicate
  `source_text` within corpus is only **1.1–2.7%** (dal-cv 27/2565, dal-nlp 67/2612, qbio 108/6955,
  arxiv-nlp 76/2862) and duplicate embeddings 2.6–5.5% — far from the 14–18% that made 250/354 targets
  tie in doc 05. I verified the strong claim directly: **dense optimistic == pessimistic in all 8 cells,
  0 boundary flips**. And the shadowing test: of the **708 edges where dense misses**, **0** have a fact
  in their top-10 whose `source_text` or whose embedding is byte-identical to the gold's, and only **4**
  have anything within cosine 0.10 (mean nearest-to-gold cosine in the top-10 = **0.3251**). **The low
  dense recall is genuine — the retriever is not finding a paraphrase of the gold and being scored
  wrong.** This attack failed cleanly and the result is stronger for it.
- **Is the effect-exclusion correct and sufficient? (1-verified)** Correct — my ranks match the artifact
  on 1043/1043 dense edges, which only holds if the exclusion matches. Sufficient — only **29 pool facts
  across 23 edges** share the effect's exact `source_text` (8 in D over 7 edges, 21 in S over 16 edges),
  at most one top-10 slot on 2.2% of edges. And only **2/1043** edges have cause and effect sharing
  `source_text`, confirming the pre-reg's line 126.
- **Direction/conflation (1-verified).** The mapping is correct: I read the `reasoning` prose on sampled
  edges and in every case the `cause_event_id` side is the antecedent (e.g. *"ViT-22B's demonstrated
  improved robustness at scale directly enabled the fairness-performance tradeoff improvement"* with
  cause = robustness, effect = tradeoff). But the numbers **cannot** detect a reversal: reversing gives
  pooled D **0.3623** vs 0.3688 and S 0.2973 vs 0.2835. See finding 8.
- **Stratifier validity (1-verified).** No silent NULL bucketing: `causal_events.subject_entity_id` is
  **non-null on both sides of all 1043 edges**, `IS NOT DISTINCT FROM` and `=` give the identical 582,
  and event-level subject ids agree with `facts.subject_entity_id` on **1043/1043** (0 mismatches on
  either side). `facts.subject_entity_id` is `NOT NULL` by schema. The stratifier is clean.
- **Bootstrap (1-verified).** See finding 4. Clustering by effect fact is a reasonable choice and the
  delta survives four alternative within-corpus clusterings; it dies under corpus-level clustering. Other
  dependencies checked: 1043 edges over 920 effects and 995 causes, so cause-side repetition is even
  weaker than effect-side; document-level clustering is **impossible** (no `memories` table,
  `fact_sources` and `fact_units` both empty, `facts.source_memory_id` and
  `causal_edges.source_memory_id` NULL on every row) — the write-up records this correctly.
- **Crowding mechanism, which the write-up calls "speculative, untested" — now TESTED and supported
  (1-verified).** Mean sibling count of the effect's subject entity is 12.01 in S vs 8.10 in D. Splitting
  S at its median sibling count: dense r@10 **0.3389** low-crowding (n=301) vs **0.2242** high-crowding
  (n=281); Spearman(sibling count, dense rank) = **+0.145** in S and +0.130 in D. So crowding is real and
  measurable — but finding 2's control shows it is *not* the whole story, because random same-subject
  pairs face identical crowding and still reach 0.3854. The residual is that causal S edges specifically
  select unusually distant same-entity pairs.

### Banked substrate claims — spot-checked, all correct (1-verified)
`1043/1043` distinct `reasoning`, avg length **315** chars; `event_embedding` NULL on **17,847/17,847**;
`temporal_span` NULL on **1043/1043**; **2353** total `source_references`; graph-wide `source_text`
coverage **5.20%** (17,846/343,018); **125** events with both in- and out-degree; **920** distinct
effects. Only the single-hop count is off by one (795 vs 794).

---

## 3. The conclusion and the framing (task 3)

**Is UNRESOLVED honest?** **Yes, on its own terms, and it is robust.** On the pre-registered definition
(best of A1/A3, stratum D, both dal-cv and dal-nlp) the best arms are dal-cv RRF **0.4245 [0.3629,
0.4876]** and dal-nlp RRF **0.3936 [0.3243, 0.4649]** — missed by ~0.28-0.31 with no CI overlap. It
survives the recall-any unit, a cross-corpus pool, a causally-live oracle pool, direction reversal, five
BM25 variants and six clusterings. The write-up's "no defensible bar in the 0.55-0.85 range would change
the outcome" is **verified true** (the maximum D cell in a bar-bearing corpus is BM25 0.4735). The
author is **not** hedging away from a positive.

**But the write-up under-claims in one specific place.** §6's "nothing is demonstrated" and "a dense miss
is equally consistent with genuine non-obvious causality and with a spurious edge" is, after finding 2's
control, **too agnostic**. Chance for a different-subject within-corpus pair is dense r@10 **0.0038**,
median rank **1337**. The causal D pairs sit at **0.3688 / 46**. If a large share of the 1043 edges were
hallucinated, their endpoints should look like random pairs; they emphatically do not. That does **not**
establish correctness (a plausible-but-wrong edge is also topically related, and the extraction process
plausibly drew candidates from a related pool to begin with — *3-inference*), so the forbidden inference
stays forbidden. But "the edge population is non-random on the lexical/dense axis at ~89x chance" is a
free, deterministic, bankable fact that the write-up leaves on the table while asserting that nothing
was learned. **Recommendation: keep UNRESOLVED, and add the control as what the run did establish.**

**Is the "weak evidence against deep causality" consideration sound?** **No — over-stated as written,
and directionally wrong on one stratum.** It rests on the survivorship-conditioned median of 10 (finding
1; the honest number is 25) and it has no baseline (finding 2; against an entity-matched baseline the
causal pairs are *less* lexically adjacent, BM25 0.4244 vs 0.5388). Its hedging paragraph ("not
adjudication... a genuine causal link can also be lexically adjacent") is good and should be kept, but
the claim itself needs restating two-sidedly. One attack of mine *failed* and should be recorded in the
author's favour: I suspected BM25's advantage came from the shared `"Source states / describes"`
boilerplate, but stripping those tokens makes BM25 **better** (D 0.4273, S 0.4519), so the lexical
signal is real content overlap, not template overlap.

**Is the exploratory labelling adequate?** **The label is; the execution is not.** "Lead, not a
demonstration... promote only via a fresh pre-registration" matches house convention and the doc-12
precedent. But the table omits the two cells where BM25 loses (qbio D −0.0476, S −0.0667), the pooled
delta spans 0 under corpus-level clustering, and the write-up nonetheless draws a meta-inference about
the "dense is the retrieval engine" meta being task-scoped. The "different task, not a contradiction"
defence against CLAUDE.md's non-replication note is **legitimate** — fact-level causal pass-through
really is not entity target-finding — but it is stated more confidently than warranted for an effect
carried by one of four corpora.

**Readings the write-up has suppressed.** (i) qbio's negative BM25−dense in both strata — the one
non-dal corpus with n≥50 (finding 4). (ii) The chance baseline, which is the strongest free positive
statement available about Graph C's edges (above). (iii) The same-entity baseline, which reverses the
shallowness reading on S (finding 2). (iv) That the CLOSE branch was near-unreachable — the union of all
three arms' top-10 tops out at 0.5011 on D (finding 8) — so the informativeness of the UNRESOLVED
outcome is lower than the write-up's confident tone suggests.

---

## 4. Required corrections before banking

1. Replace "BM25 median gold rank is **10** on D" with **25** everywhere (line 248 and line 260), or
   report it as "10 conditional on the gold being retrieved (388/461 edges); 25 unconditional" and stop
   comparing it to dense's unconditional 46. Fix the harness to emit an unconditional BM25 median.
2. Restate the interpretive consideration two-sidedly with the baselines: vs chance (0.0048, median 1065)
   the causal pairs are far more adjacent; vs same-entity pairs (0.5388, median 8) they are *less*
   adjacent. Drop or heavily qualify "weak evidence against deep causality".
3. Narrow line 210 to "entirely below the bar in all twelve dal-cv and dal-nlp cells"; five
   marginal-corpus cells have CI upper bounds ≥0.70.
4. Add qbio and arxiv-nlp rows to the BM25−dense table, and add the corpus-clustered CI showing the
   pooled delta spans 0 when the corpus is the unit of replication.
5. Scope the tie sentence to dense; state that no pessimistic rank was computed for BM25 or RRF and that
   BM25 ties on ~33% of edges under full scoring.
6. State that A4 RANDOM, p90, MRR and BM25/RRF recall@{1,5} were pre-registered and not reported.
7. Commit the pre-registration to git *before* the next run so the freeze is provable.
8. Add the two free, verified positives the run earned: the chance-baseline lift, and the crowding
   mechanism (now tested: S high-crowding 0.2242 vs low 0.3389, Spearman +0.145) moving from
   "speculative, untested" to "tested, modest, not the whole story".

**Nothing above changes the banked outcome: UNRESOLVED, bar missed decisively.** That part is sound,
exactly reproducible, and survived every attack I could construct.

---

*Artifacts of this audit (scratchpad, not committed):* `ranks_dense.sql`, `pooled.sql`, `anyunit.sql`,
`shadow.sql`, `direction.sql`, `pool_alt.sql`, `pool_pro.sql`, `audit.py`, `boot.py`, `variants.py`,
`controls.py`, `ranks.csv`. No repository file other than this scratch doc was written; no DB write was
issued.
