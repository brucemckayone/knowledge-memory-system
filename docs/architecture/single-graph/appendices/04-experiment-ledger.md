# Appendix 4 — Experiment ledger (arc docs 20–38)

Primary-source survey of the experiment era. **Doc 39 is accurate on every number traceable to docs
37/38, but its omissions run one way: too pessimistic and too clean.** The drift list at the end is the
most load-bearing part of this appendix.

Note two files share the `35-` prefix: `35-multihop-concept-recall-prereg.md` and `35-adversary-brief.md`.

---

## 1. The ledger

| doc | question | pre-registered bar | measured | verdict | adversary? | survived / cut |
|---|---|---|---|---|---|---|
| **20** concept-JOIN recall (C++, clang-tidy oracle, n=29 elts / 9 guidelines) | does concept-JOIN beat `max(cosine, BM25)`, esp. sub-lexical? | macro@5 ≥ max+0.15; dominance at all k; JOIN > both on the sub-lexical slice | JOIN 0.256 / cos 0.467 / BM25 0.433; sub-lexical n=14: cos 0.429 > JOIN 0.214 | **FAIL** (all 3) | yes — "FAIL SOUND" | Survived: FAIL; connectivity only 8/29; a perfect resolver ceilings at 0.444 < cos 0.467. **Cut: "significantly worse"** — arm-vs-arm CIs [−0.537,+0.100] include 0 → an underpowered tie |
| **21** blind cross-corpus concept reconciliation | does a blind agent aligning the two vocabularies recover recall without promiscuity? | macro@5 ≥ 0.40 **and** ≥ 0.356; ≤1/10 decoys; ≤15% density | 0.444; 0/10 decoys; 0.89% density; connectivity 8/29→**18/29** | **PASS** | yes — **QUALIFIED-HOLD** | Survived: bucket-1 synonym recovery, externally graded, robust to stripping all 11 questionable relations. Qualified: synonym-only; bucket-2 recovered 0; **recall@1 regressed 0.237→0.159**; ties cosine (0.467); same-model circularity |
| **22** RRF fusion of JOIN + cosine | does complementarity convert into recall? | hybrid macro@5 ≥ 0.567, full-ranking RRF k=60 | full-ranking 0.444 → FAIL; k-sweep max 0.556 | **FAIL as written** | yes — **FAIL-IS-ARTIFACT-RETRACT** | Survived: the frozen gate FAIL. **Cut: the FAIL's *interpretation*.** Canonical **retrieved-set** RRF = **0.648**, beats both single arms at every k, k-robust, tie-break-invariant, blind. Explicitly **not banked** (post-hoc variant) |
| **23** conform-on-ingest convergence (120 cs.CL abstracts) | does conform-on-ingest prevent explosion without over-merge? | reduction ≥40% **and** growth Q4/Q1 ≤0.5; distinct-field ≥90%; verbatim ≤0.10 | 4.5% / 0.87 / 100% / 0.47 | **FAIL** (c1, c3) | yes — QUALIFIED | Survived: FAIL reproduced to float precision. Cause relocated **upstream**: identical text re-extracts **47% novel labels**; only 3.4% of labels are exact repeats; true synonyms sit 0.70–0.84 so 75% of decisions fall to the judge. cond2's pass downgraded to low-power. Adversary **forbade** "convergent space unbuildable" |
| **24** convergence bake-off, arms 0/A/B | which lever fixes it — embedding-side or extraction-side? | doc-23 bars inherited | 0: 4.5/0.87 · A: 6.7/**0.96** · B: **43.2**/0.72/**96.5**/0.36 | **all three FAIL** | yes — numbers PASS-SOUND (0/162 mismatches) | Survived: **Arm A is a clean negative — embedding representation is not the bottleneck**; Arm B = 10× reduction with over-merge controlled. **Cut: "residual extraction non-determinism"** — 9/20 verbatim new nodes are **MRU-500 cap artifacts**; clean residue 0.054 |
| **25** relevance-preserving vocab window (Arm R, K=100) | does relevance-not-recency recover cond3? | doc-23 bars | 46.7% / 0.72 / 95.0% / **0.19** | **FAIL** — 5th consecutive | yes — numbers sound | Survived: MRU-cap artifact **confirmed real** (0.36→0.19 on window change alone); **growth-saturation ~0.72 is window-independent**; cond2 sound. **RETRACTED: "genuine non-determinism floor"** — the top-100 window covered only **72%** of a verbatim doc's own twin labels; 27/31 misses were *never shown*; 2 docs with full coverage produced 0 fresh labels |
| **26** direct semantic-redundancy reframe | is "no explosion" = low redundancy rather than count-plateau? | strict ≤5% **and** lenient ≤10% **and** strict ≤0.5×free-form | R: 1.45% strict / **32.3% lenient**; FF: 5.63% / 48.8% | **cond-R FAILS** on the lenient bound | yes — QUALIFIED | Survived: the space is not strict-redundant; **growth-ratio retirement is principled**, not convenient. **Cut two over-claims:** 1.45% is inside the judge's ~2% false-SAME floor → report "≤~2%"; and it is **surface-variant** dedup (plurals/acronyms), **not semantic**. Adversary agreed the lenient metric is ill-posed **but ruled the FAIL stands** |
| **27** corrected non-chaining redundancy metric | under a sound metric, is the space clean? | R_confirmed ≤5%; R_upper ≤10%; R_strict ≤0.5×FF | 0.41% / 2.28% / 1.45% vs 2.82% | **PASS** — the only outright gate PASS in the arc | yes — then **dismantled both new constructs** | Survived: **R_strict 1.45% + comparative alone carry the PASS**; honest number is a bracket **[1.5%, ~6%]**, **~74% below free-form**. **RETRACTED: R_confirmed is not a valid denoise** (it dropped textbook dups at cos 0.938) and **R_upper is not an upper bound** (all 7 SAME pairs sit below 0.85; promoting ≥0.75 gives 15.7% → would FAIL). **Owed: held-out confirmation** |
| **28** does the convergent concept layer help cross-corpus query? (294 arXiv, OpenAlex oracle) | H1 JOIN−BM25 ≥ +0.05 CI excl 0; H2 JOIN ≥ EMB−0.05 | as pre-reg'd | recall@10: JOIN 0.061 / **EMB 0.162** / BM25 0.064 / RRF 0.067 | **FAIL both** | yes — reproduced to 4dp | Survived: embedding is the best single signal; **structural ~13% coverage ceiling**; convergence real (96 genuine bridges). **Cut: the dramatization** — the pre-reg "ties against JOIN" rule roughly **halves** JOIN (0.061 against / 0.104 neutral / 0.124 positive-only); under a neutral tie-break **JOIN significantly beats BM25** (+0.040, CI [0.028,0.058]) and **H2 passes at L≥3**. "Concept layer adds nothing over lexical" = **false** |
| **29** agent over the graph; 2×2 + free-nav | H-A 2-hop ≥ 2×1-hop; **H-B STRUCT−TEXT ≥ +0.05 p@5, CI excl 0**; H-C STRUCT > JOIN-pool | as pre-reg'd | H-A 13%→**62%**→65%; H-B **tie** (p@5 0.21 vs 0.21, MRR 0.404 vs 0.399); H-C FAIL (0.21 < 0.34) | H-A holds; **H-B robust null**; H-C FAIL | yes — every number to the digit | Survived: **H-B — the graph *representation* earns nothing over the agent reading the text**; oracle-independent because both arms eat the same noise. **RETRACTED: "agent < mechanical"** as an oracle artifact — a 13-term junk filter dissolves **25%** of "related" pairs; on agent/oracle disagreements the **agent is often right**. Counter-evidence kept: the agent returns hubs, collapses at L=3 |
| **30** citation (co-citation) oracle as the settling test | JOIN-full − EMB-full p@5, CI excl 0; **void if Jaccard > 0.6** | as pre-reg'd; amended before scoring (`referenced_works` empty → co-citation) | p@5: JOIN 0.19 / **EMB 0.30**; MRR 0.36 / 0.60; CI [−0.157,−0.074]; void-check passed (Jaccard 0.065) | **does NOT settle** | yes — **3 corrections** | Survived: EMB robustly out-ranks JOIN **as currently extracted**; concept signal real-but-weak (AUC 0.60). **Cut (central):** the oracle is **not** embedding-independent — cosine predicts co-citation at **AUC 0.79**. **Cut (pessimistic):** "concept genuinely loses" — **73.4% of co-cited pairs share ZERO nodes**. **Cut (optimistic):** free-nav "parity" is noise (n=18). Integrity flag: the author omitted the pre-reg-required citation-pool-recall = 0.648 |
| **31** the text-dissimilar slice (cos < 0.615) | H1 JOIN−EMB **and** JOIN−RANDOM CIs excl 0; H2 hybrid > EMB-alone | as pre-reg'd | **coverage ceiling 4.4%** (7/160); H1 FAIL (0.165/0.118/0.118, both CIs straddle 0); H2 FAIL (RRF 0.374 < EMB 0.410); **agent recovers 0 of 92** | **FAIL** | yes — bit-exact; **first correctly-calibrated conclusion of the arc** | Survived: the deterministic 4.4% ceiling; **the 7 covered links are genuine**; **EMB = RANDOM inside the band** (it is genuinely disabled there). Adversary killed even the pro-concept point estimate: 11 of JOIN's 14 top-5 TPs are 0-score tie-order artifacts |
| **32** extraction density (~6 → ~33 concepts/doc) | coverage ≥25% **and** AUC ≥0.63 | as pre-reg'd | both-populated coverage **9.1%**; **AUC 0.579 < sparse 0.596** | **DEAD on both bars** | **NO — DEBT (now paid, see Appendix 5)** | Verdict survives. **Three comparative claims CUT** by the later audit — see Appendix 5 |
| **33** sweep coverage at equal adjudicator budget | **§13 amendment, before any number:** complementarity ≥1 **and** frontier dominance | as amended | A 229 cells / 24 pairs · **B 10 cells / 8 pairs, 0.80 of cells true** · C 231 / 25. complementarity = **1**; dominance = **+1 pair → FRAGILE_DOMINANCE** | **both bars MET, at the weakest defined grade** | **NO — DEBT (now paid)** | Survived: the concept leg is **sparse and precise** (0.80 true vs cosine's 0.105); cosine's cheapest matching setting costs **84 cells vs 10**; the **4-of-104 pivot ceiling**. Self-struck before the adversary: arm B's `CLEAR_WIN` is void (grid granularity) |
| **34** construction audit (not an experiment) | none — *"no bar, no claim, no adversary needed"* | — | 0 of 104 concepts have a description or embedding; **83/104 are degree-1**; **0 facts** in the cj corpora; 55 code-only / 45 rule-only / **4 both**; extractor probe: C++ **0.0** entities/doc, rule text **0.0**, abstracts 6.8 | AUDIT — **scopes every prior negative** | n/a | Established as fact: docs 20–33 measured **single-hop label coincidence over factless, disconnected entities**; depth was **structurally 1**. Named the **register mismatch** (`floating-point-literal` vs `magic-constant` — not synonyms, so no resolver could bridge them) |
| **35** multi-hop pre-registration + adversary brief (written before any number existed) | reach ≥3× S0 **and** ≥25% absolute; AUC ≥0.63 **and** ≥ S0; ≥half the gain survives top-3 hub exclusion | — | pre-reg only | brief pre-committed | Named its own likely failure ("2 hops reaches everything"). **`maxPairs` was omitted from the frozen list — a pre-registration defect** |
| **36** handover (not an experiment) | none | — | corpora 147+147, 2,512 entities / 5,714 facts, attribution 100%; **170 of 564 both-sided pivots**; **every concept labelled from a bare entity NAME**; fragmentation 19.6%/15.3%; `resolve_anchor` cross-corpus read-path bug + fix `c1da213` | STATE | n/a | Both handicaps recorded **before numbers existed**. §4 is load-bearing: corpus A *"was not a passing test; it was a test that could not fail"* — the composite FK is what prevented a silent graph fusion |
| **37** multi-hop results | doc-35 bars | as above | S0 cov 0.7424/0.5313, AUC 0.6844, **precision 8.50%**; M1 0.8610/0.7937, 0.6755, 5.96%; M2 0.9518/0.9187, 0.6578, **5.37% at a 4.99% base rate**; E AUC 0.7943 | **FAIL** | yes — **6 corrections, 5 against the author** | See §2.7. The headline explicitly states **almost none of the support is in the pre-registered bars** |
| **38** single-graph hardening audit | none | — | see the keep list | AUDIT + 11-item backlog | n/a | *"Every structural layer of the pipeline works. Every semantic layer is empty or inert."* Contains a **self-correction of its own §3.1** (the predicate fold never ran ≠ domain-locked ontology) |

**Adversary tally for 20–38:** run on 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 37 (**13 runs**).
Not run on **32 and 33** (2 debts — both now paid, Appendix 5). Not applicable to 34, 35, 36, 38.

## 1.1 The complete retraction list

| # | doc | direction | what was cut |
|---|---|---|---|
| 1 | 20 | pessimistic | "significantly worse than cosine" → the honest CIs include 0; an underpowered tie |
| 2 | 21 | optimistic | 6 binding qualifications; recall@1 **regressed**; `addresses`/bucket-2 contributed **zero** |
| 3 | 22 | pessimistic | the whole FAIL disposition ("complementarity does not convert") is **false** |
| 4 | 23 | both | cause relocated upstream; cond2 downgraded; "unbuildable" forbidden |
| 5 | 24 | pessimistic | "residual extraction non-determinism" → substantially an MRU-cap harness artifact |
| 6 | 25 | **pessimistic (own-admitted)** | "genuine residual non-determinism floor" **withdrawn** — refuted by the shown-window log |
| 7 | 26 | optimistic ×2 | 1.45% is inside judge noise → "≤~2%"; surface-variant **not** semantic dedup. Plus the lenient-bar rescue refused |
| 8 | 27 | optimistic ×2 | **R_confirmed and R_upper both dismantled** — *"the launder resurfaced as rigor"* |
| 9 | 28 | pessimistic | the tie-rule dramatised the FAIL; "JOIN ≡ lexical" is false |
| 10 | 29 | pessimistic | **"agent retrieves worse than embedding" withdrawn** as an oracle artifact |
| 11 | 30 | 2 pessimistic + 1 optimistic | oracle-independence overclaim (AUC 0.79); "settled loss" (73% sparsity confound); free-nav "parity" is noise |
| 12 | 31 | — | correctly calibrated; adversary nonetheless killed JOIN's point-estimate edge |
| 13 | 37 | pessimistic | **"discrimination down — the doc-32 pattern"** does not survive; plus undisclosed truncation, circular frontier, 3 wrong numbers |

**That is 12–13 adversary-forced correction events in docs 20–38 alone, against doc 39's "six" — and
since doc 24 the majority have been in the pessimistic direction.**

## 1.2 A meta-finding the primaries make and doc 39 does not

**In four runs the pre-registered *instrument*, not the mechanism, decided the verdict.** Doc 22's
full-ranking RRF (wrong tool for a sparse arm); doc 26's component-chaining lenient bound
(adversary-confirmed ill-posed); doc 28's ties-against-JOIN rule (halves the arm under test); and doc
37's three bars — **bar 1 mathematically unsatisfiable** (3 × 0.5313 > 1.0), **bar 2 firing on noise**,
**bar 3 near-unfailable by construction** — plus the frontier metric inherited from doc 33 that is
**circular**. Two further pre-registration defects: `maxPairs` omitted from doc 35's frozen list while
`minScore` was included; and doc 22's pre-reg was written but **not committed before the run**.

---

## 2. Settled negatives, precisely scoped

Each with an explicit boundary, because the boundary is what doc 39 drops.

**N-1. Concept-JOIN does not beat dense retrieval on ranked recall (C++ floor).**
Tested: doc 20, blind per-side extraction, external clang-tidy oracle, against canonical BM25 and
production cosine on identical inputs.
**Does NOT settle:** not statistical inferiority (an *underpowered tie* at n=9); not the fused
configuration; not a convergence-forced extractor; not field prevalence; and **not the mechanism** —
doc 33 §13.5 licenses only *"the concept leg as currently conformed"*.

**N-2. Isolated per-corpus extraction produces near-disjoint vocabularies.**
Tested: 61 code labels vs 50 rule labels, **only 2 exact-string overlaps**; doc 33 quantified it as a
hard ceiling (**4 of 104 both-sided**); doc 34 diagnosed *why* (register mismatch, one abstraction level
apart).
**Does NOT settle:** this negative was **repaired** — doc 21's reconciliation lifted connectivity
8/29→18/29, and the shared-vocabulary conform mechanism lifted pivots **4 of 104 → 170 of 564**. Treat
N-2 as a fixed defect, not a standing negative.

**N-3. Embedding representation is not the convergence bottleneck.**
Tested: doc 24 Arm A — embedding a one-sentence gloss instead of the bare label moved reduction
4.5%→6.7% and *worsened* growth and verbatim; adversary verified the glosses were genuinely embedded.
**Does NOT settle:** this is a clean negative **about the comparison representation only**. It is *not*
evidence against description-aligned **entity/node** vectors — a different object. Conflating the two
would be wrong.

**N-4. Naive conform-on-ingest does not converge same-field prose.**
Tested: docs 23/24/25, five arms on a byte-identical 120-doc corpus; all FAIL.
**Does NOT settle:** the binding failure is **cond1 growth-saturation ~0.72**, and doc 25 leaves open
whether same-field prose *genuinely* saturates at 120 docs. cond3's residual is a **window-coverage
artifact twice over**, and **the uncapped full-vocab verbatim re-read that would establish a true
non-determinism floor was never run.** Untried levers: centroid (not first-mention) node identity,
hybrid A+B, hierarchical vocabulary, deterministic/normalised extraction.

**N-5. Growth-ratio is the wrong operationalisation of "explosion".**
Tested: doc 26 — the conflation argument is sound *independently* of it being the metric that failed;
doc 27 confirmed the reframe is *"a legitimate fix, not relabel-to-pass"*.
**Does NOT settle:** the replacement is narrow. Redundancy removed is **surface-variant, not semantic**.
Precision below the judge's **~2% false-SAME floor** is unclaimable. And **the held-out confirmation the
PASS triggers was never run** — so cond-R′ remains **exploratory, not banked**.

**N-6. The concept layer is not a cross-corpus retrieval mechanism — sparse, dense, mechanical or agentic.**
Tested: docs 28, 29, 30, 31, 32, 37.
Root cause is uniform and deterministic: **coverage blindness from extraction sparsity** — 13%, 73.4%
zero-overlap, **4.4%** in the blind spot, 9.1% even at 33 concepts/doc.
**Does NOT settle — five distinct boundaries:**
1. **Not intrinsic to the mechanism.** Where it fires it is correct: the 7 covered band pairs are
   *genuine* cross-domain links; doc 33 measured **0.80 of the concept leg's cells true** vs cosine's 0.105.
2. **Not description-aligned.** Every concept label came from a **bare entity name** because
   `promotion-plan.ts:534` hardcodes `summary: null`. *"You never gave it descriptions"* is recorded in
   the primaries as a **correct** rejoinder.
3. **Not on a credible oracle.** The topical oracle is junk-laden (25% of "related" pairs dissolve under
   a 13-term filter) and the co-citation oracle is **79% cosine-predictable**. **Within the
   de-circularised slice nothing separates any arm** (S0 0.6126 / M1 0.6179 / M2 0.5978 / E 0.6171, all
   CIs spanning zero).
4. **Not on a merged graph.** 41% of S0's and 29% of M1's hard-slice coverage rides on name-duplicated
   entities, and the M1−S0 AUC gap **flips to +0.045** without them.
5. **Not with a capable model, not B→A, not hops ≥ 3, not a second corpus pairing.**

**N-7. Multi-hop traversal adds reach but costs more than it returns.**
Tested: doc 37 — cell-normalised reversal (M1 truncated to S0's budget: 0.6589/0.4938 vs 0.7424/0.5313);
precision falls monotonically 8.50%→5.96%→5.37% against a 4.99% base rate; untruncated M2 proposes
**88.5% of the pair space at 1.08× chance**; E ≈ 2× every concept arm at every precision@k.
**Does NOT settle:** **none of that is in the pre-registered bars.** Bar 1's *spirit* survives as a
**near miss**: at top-10/top-20 hub exclusion traversal delivers **1.90× and 2.55×**. M1's extreme head
is *better* than S0 (p@100 0.360 vs 0.260), crossover around k ≈ 500. And **absolute discrimination for
both arms is hub-driven** — strip the top-20 generic labels and both fall below bar 2's own 0.63.

**N-8. The graph *representation* adds nothing over an agent reading the text.**
Tested: doc 29 H-B — same agent, same matched pool, only the representation differs. Tie on every metric
at L=2. Robust because both arms eat the same oracle noise, so it cancels.
**Does NOT settle:** run on the **factless** substrate, so it tested "named concept structure vs text",
**not** "traversable entity+fact graph vs text". Haiku-floor only. **And doc 39's "STRUCT lost at L=3" is
a tie** — CI [−0.225, +0.0125], n=16.

**N-9. Density is dead as a retrieval lever.**
**Does NOT settle:** the adversary was never run at the time (now paid — three comparative claims cut,
Appendix 5). 34% of docs extracted empty. Doc 32 itself flags description-aligned nodes as a distinct,
untested variant.

**N-10. The pipeline's semantic layers, on this domain.**
Tested by direct query: 0 descriptions, 0 aliases, 0 `entity_meta`, 0 `fact_sources`, 8
`memory_entities` of ~2,512, 0 merges against 19.6% duplicates, 9 causal edges, 2,240 predicates with
68.7% hapax, 338 entity types with 47.3% hapax.
**Does NOT settle:** the *diagnosis* was corrected mid-document. **The domain-lock hypothesis is
untested, not established.**

---

## 3. Positives — things that measurably worked

| # | positive | evidence | strength |
|---|---|---|---|
| **P-1** | **Blind cross-corpus vocabulary reconciliation recovers recall without promiscuity.** The only gate PASS on a retrieval-adjacent metric | macro@5 0.256 → **0.444**, connectivity 8/29 → **18/29**, 0/10 decoys, 0.89% density. Robust to stripping all 11 questionable relations; the pessimistic tie-break was used | PASS, adversary QUALIFIED-HOLD. Synonym-level only; ties cosine, does not beat it |
| **P-2** | **Blind retrieved-set RRF fusion beats both single arms — the only thing in the arc to beat plain cosine** | **0.648** vs cosine 0.467 vs JOIN 0.444; better at **every** k; k-robust; 0.537 even F.16-stripped | **NOT banked** — post-hoc variant; margin is F.16-carried (2 of 29 elements). **Deserves a clean pre-registered re-run** |
| **P-3** | **cond-R′ PASS: the controlled-vocab space is genuinely low-redundancy** | R_strict **1.45%**, bracket **[1.5%, ~6%]**, **~74% below free-form** (the author's comparative claim *understated* it) | PASS on the plain strict metric; surface-variant scope; **held-out confirmation owed** |
| **P-4** | **Controlled-vocabulary extraction with a relevance window is the working convergence lever** | Arm B 43.2% reduction / 96.5% over-merge control; Arm R **46.7%** / 95.0%, verbatim 0.47→0.36→0.19 as the window improved. 10× arms 0/A | Each arm still FAILed the full gate on growth |
| **P-5** | **The shared-vocabulary conform mechanism repaired the pivot ceiling** | *"the register-mismatch deficit is repaired: 4 to 170 both-sided pivots"*. Plus the transferable observation: the model **reuses a shown vocabulary heavily** — **303 existing labels, only 17 new** across corpus B's first 100 entities | **The single most transferable positive to ontology seeding** |
| **P-6** | **Traversal genuinely connects pairs single-hop misses** | S0's covered set is an exact **subset** of M1's (S0∖M1 = **0**, M1∖S0 = 128); hard-slice **McNemar 42–0, p ≈ 1e-11**; both Δcoverage CIs exclude zero | Deterministic + significant. *"The mechanism does something real; it is the cost and precision that condemn it"* |
| **P-7** | **The concept leg is sparse and precise; cheap at the margin** | **0.80** of its cells true vs cosine's **0.105**; 10 cells for 8 true pairs vs cosine's cheapest match at **84 cells** (~8×) | Deterministic, one corpus, fragile grade |
| **P-8** | **Multi-hop's extreme head beats single-hop** | p@100 **0.360 vs 0.260**, crossover ≈ k 500 | A tie at n=100 |
| **P-9** | **The agent makes categorical judgments the oracle and embedding both miss** | `CodeGen2` returned for 4 LLM queries though the oracle marks it related to 0/40 (its L2 tags are junk); InstructBLIP → ImageBind-LLM; BLIP-2 → object-hallucination-in-VLMs — all agent-right / oracle-blind | On disagreement cases; **not** a proven retrieval win (it also returns hubs, 22/40) |
| **P-10** | **Corpus partitioning works; the composite FK caught a real fusion breach** | Zero facts with endpoints in different corpora across 5,714. **36 corpus-B entities had anchored across into corpus A**, and the DB constraint is what stopped a silent merge. Five unscoped paths found and fixed | Measured |
| **P-11** | **Extraction volume is stable and domain-insensitive; the graph is navigable** | Median 18 facts/paper in both subfields, no silent-failure tail; giant component 65.0%/73.5%, ~2.5% isolated; **dedup counterfactual lifts it to ~86%** in both, removing ~40% of components | Measured |
| **P-12** | **The ontology fix is sized, and seeding is viable** | top 20 heads = 46.4% of edges, top 50 = 62.3%, **top 100 = 75.0%**, top 200 = 86.5%; qualifiers (`uses_technique`) collapse losslessly into `uses` + existing `object_type`. **Top 25 entity types = 73.4%** | Measured, unreviewed |
| **P-13** | **The adversary process itself pays** | On doc 37 it reproduced every number bit-exactly, cut the load-bearing claim, and **found a truncation bug that had hidden the run's actual result**. Five of six corrections went against the author | Measured |

---

## 4. Doc-39 drift list

Doc 39 is accurate on every number traceable to docs 37/38, including caveats. **The drift is omission,
and it runs one way: too pessimistic and too clean.**

| # | doc 39 says | primary says | direction |
|---|---|---|---|
| **D-1** | §5.1: docs 28–33 + 37 "**failed**", as a clean measured negative | doc 37's own headline: *"almost none of the support for it is in the pre-registered bars — the cost and base-rate arithmetic decided this run, and doc 35 did not ask for either."* Bar 1 was **mathematically unsatisfiable**; bar 2 **fired on noise** (ΔAUC CI [−0.0261,+0.0090], flips positive under two sensitivities → *"discrimination is FLAT, not down"*); bar 3 is **near-unfailable by construction** | **method drift** — the negative is real but rests on *post-hoc* arithmetic, a weaker banking status under this project's own rules |
| **D-2** | §5.1 lumps **doc 33** into the negative | doc 33 §14.2: **both frozen primary bars were MET** (`FRAGILE_DOMINANCE`), and §13.5 licenses *only* "the concept leg as currently conformed", explicitly not "the concept layer is dead" | **factual mis-direction** — a fragile PASS reported as part of a negative |
| **D-3** | nothing about **doc 21** anywhere | **GATE PASS** — blind reconciliation recovered macro@5 0.256 → **0.444**, connectivity 8/29 → 18/29, 0/10 decoys, robust to stripping every questionable relation | **too pessimistic** — the arc's clearest recall-adjacent positive is missing |
| **D-4** | §5.4 *"dense embedding is the retrieval engine"*, no mention of fusion | blind, un-tuned, k-robust **retrieved-set RRF = 0.648** beats cosine 0.467 and JOIN 0.444 **at every k** — *"the first thing in the whole arc to beat plain cosine"* (unbanked) | **too pessimistic** — a robust counter-datum omitted entirely |
| **D-5** | nothing about **doc 27's PASS** | **cond-R′ PASSES** — ~1.5% redundant, under the 5% ceiling, **~74% below free-form**; *"first mechanism to clear the reframed gate"* | **too pessimistic**, and it drops the **held-out debt** that PASS triggers |
| **D-6** | §5.1 cites 170 pivots only as substrate context | doc 37 §8 lists it as one of **two things this run changes**: *"the register-mismatch deficit is repaired: 4 to 170"*. Doc 38's *"303 existing, 17 new"* is the same mechanism | **too pessimistic** — a working mechanism, and the direct precedent for ontology seeding, is uncredited |
| **D-7** | §5.1 gives multi-hop only as failure | S0 ⊂ M1 exactly (S0∖M1 = 0), **McNemar 42–0, p ≈ 1e-11**, both CIs excluding zero — *"the mechanism does something real; it is the cost and precision that condemn it"*. Plus the near-miss (1.90×/2.55×) and the better extreme head | **too pessimistic** — deterministic, significant positives dropped |
| **D-8** | §5.4 *"dense embedding is the retrieval engine, **including inside its own blind spot**"* | inside the band **EMB = RANDOM** (p@5 0.118 vs 0.118; EMB MRR 0.257 *below* random 0.290). The finding is that *nothing* works there, and adding concept via RRF **hurts** | **precision drift** — the phrasing implies embedding wins in its blind spot, the opposite of what was measured |
| **D-9** | §8 *"this arc records **six** instances"* | **12–13** correction events in docs 20–38 (§1.1). The primaries' own counters disagree by scope (5, ~7, ~8, 11, 11+) | **undercount** — and it flattens the pattern that since doc 24 the *majority* have been pessimistic-direction |
| **D-10** | §5.3 states doc 29's H-B null and its [U] boundary correctly | but omits doc 29's **retraction** — *"agent retrieves worse than embedding"* was withdrawn as an oracle artifact — and H-A's 13%→62%→65% | **omission** — the retraction is recorded nowhere in doc 39 |
| **D-11** | §6 lists 6 untested items | misses **four pre-registered-as-mandatory confirmations that never ran**: held-out convergence, retrieved-set RRF confirmation, fair-tie-break re-pre-reg, uncapped verbatim re-read — plus doc 33's adjudicator-specificity test and doc 24's untried levers | **omission** — makes the open-question surface look ~half its real size |
| **D-12** | §3.5/§7.10 "use SQL recursion, not AGE Cypher" | correct, but doc 39 nowhere records that **doc 33's frontier metric is circular** (~90% of the apparent advantage was definitional) or that **doc 32's 0.63 AUC threshold was inherited from an unreviewed run** | **omission with reuse risk** |
| **D-13** | §2.5 "promotion is order-independent and replayable [M] — the E8 litmus" | **not traceable to docs 20–38.** Doc 38 §3.2 records that `detectMergeCandidates`/barrier reconcile were *removed* from this path — adjacent, not the same claim | **unverifiable from this territory** — flagged, not disputed |
| **D-14** | §3.3 "**147 papers** produced 9 causal edges" | doc 36 attributes the 9 to **corpus A's** ingest while doc 38 tables it as "from this run" — a 294-paper run. The both-corpora total is nowhere stated | inherited imprecision, minor |

### Doc 39 §8's adversary-debt claim: CONFIRMED, exactly two

- **doc 32** — *"Blind adversary NOT yet run (session limit)."* Note a provenance inconsistency doc 39
  inherits: docs 33, 35, 36 and 39 all attribute the skip to *"an explicit user decision"*, while doc 32's
  own result section attributes it to a session limit. Both may be true in sequence.
- **doc 33** — *"the §12 blind adversary has not run… Recorded as debt."*
- **No third debt.** Doc 35's adversary *did* run (doc 37 is adversary-reviewed against the pre-committed
  brief).
- **Both are now paid — see Appendix 5.**

---

## 5. Open questions the docs themselves flag

**Retrieval levers never tried**
1. **Description-aligned nodes** — the one retrieval lever never tested, and *silently unavailable*
   rather than merely skipped. Backfill is ruled out with numbers (corpus A 9.8% vs corpus B 99.7%
   staging survival); the re-run must use **new corpus ids**.
2. **Node typing (things vs topics)** — 33.1% of entity names are abstract nouns. Hypothesis: the concept
   layer added little because *the entities were already doing that job, untyped*.
3. **The fragmentation counterfactual** — what a *merged* graph does.
4. **Agent-over-graph on a substrate that has facts** — doc 29's H-B null was measured on a factless one.
5. **hops ≥ 3, capable-model agents, B→A direction, a second corpus pairing.**
6. **A text-orthogonal oracle** — human relevance judgment, or a de-junked fine concept oracle. Every
   negative in 28–37 inherits the oracle caveat.

**Owed confirmations pre-registered as mandatory and never run** *(doc 39 omits all four)*
7. **The held-out convergence confirmation** (astro-ph.GA base / cs.CL distinct). Pre-registered as the
   rule that *no winner is banked without it*. **cond-R′ is therefore exploratory, not banked.**
8. **Clean confirmation of retrieved-set RRF** on data whose number isn't known.
9. **The fair-tie-break re-pre-registration** needed to bank "JOIN > lexical".
10. **The uncapped full-vocab verbatim re-read** that would establish the true extraction
    non-determinism floor.

**Untried convergence levers:** centroid (not first-mention) node identity; hybrid A+B; hierarchical
vocabulary; deterministic/normalised extraction. The doc-23 adversary explicitly **forbade** concluding
"unbuildable" on their account.

**Newly opened by doc 38:** does the predicate fold work once embeddings are backfilled (now answered:
3.7%, net-harmful); do the 48 CRM predicates suit other domains (**still untested**); whether
bi-temporality/supersession work at all on any domain (99.8% undated here is domain-correct, so the
machinery is **unexercised, not broken**); adjudicator specificity on wasted cells.
