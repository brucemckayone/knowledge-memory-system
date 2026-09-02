# Single-graph refinement — experiment ledger

Running record of the recursive loop from `01-kickoff-goal.md`. One row per iteration. The
**convergence rule**: stop the retrieval track after **three consecutive pre-registered retrieval
experiments return ties**, or when the diagnostics say the binding constraint is the *oracle* rather than
the retriever. Bug-hunt iterations and oracle-instrument iterations do not count toward the retrieval-tie
streak.

**Reading order for a result:** the frozen prereg (metric/bar/kill), then the results doc (§ on what
changed and the adversary review). Every retrieval number is reported under **both** oracles (E0 §6
adversary condition).

---

## Loop state — retrieval track CONCLUDED with one confirmed lever

- **Three single-substrate PRIMARY ties** (R1 pool-then-re-rank, R2 hybrid@K60, R3 fact-max) — name /
  description / pool-re-rank / hybrid / fact-max all tie for target-finding at R@10 ≈ 0.20–0.23. The
  single-substrate track is exhausted.
- **The one confirmed lever: cross-substrate FUSION** (entity-name ⊕ fact-level, RRF-60). R3 secondary
  found it (dal); **R4 CONFIRMED it as a primary on the independent arxiv extraction** — strict
  FACTNAME − NAME = **+0.0724, above 0 on all three bootstraps** (the pre-registered DEMONSTRATED bar),
  both corpora, every k; genuine complementarity (keeps 24 name-only + 20 fact-only + 15 emergent hits),
  embeddings adversary-verified genuine. **Two qualifications:** the gain is degree-concentrated (may
  shrink on sparse graphs); "robust" = byPair/byDoc everywhere, entity-cluster CI is the fragile one that
  migrates between oracles.
- **Build direction (the loop's positive output):** a **two-signal read path** — dense-over-names ⊕
  dense-over-facts fused by retrieved-set RRF — not a single entity vector. `fact_embedding` earns its
  keep as the second signal. Honest limit: independence is extraction-only (same 294 papers); a
  new-corpus/new-domain test and a sparse-graph stress test are the next confirmations before shipping.
- **New-domain test DONE (nmemo-u8j.3 / doc 24, 2026-09-02): fusion is a DEGREE-GATED lever.** On a
  genuinely disjoint domain (arXiv q-bio, 3670 entities / 6955 facts) the aggregate `FACTNAME − NAME` is a
  TIE (strict −0.0106, spans 0), so R4's win does NOT reproduce in aggregate — but the **per-degree lift
  curve replicates arxiv** (degree-8+ lift +0.167 q-bio vs +0.158 arxiv; both negative at degree 1). The
  difference is purely a **query-degree mixture** (q-bio targets 73% degree 1–3 vs arxiv 36%). So the
  degree-concentration caveat is **SUPPORTED** (cross-domain), and the shipping rule is: **fuse only where
  retrieval targets are well-connected (degree ≳ 8); expect a wash on sparse-query corpora.** Not
  domain/vocabulary-specific. Tie-break invariant. Sparse-graph stress = this same result (low-degree bins).
- **Oracle status:** condensed oracle (E0) adopted; NOT arm-neutral (credits relevance-set retrieval
  more than dense). Both oracles reported throughout.
- **Retrieval track status: CONCLUDED** — 3 ties settled saturation, and the one separating lever (fusion)
  is confirmed. Remaining untested substrates (traversal #5, Graph C #6) and the task-definition question
  are the open avenues if the track is reopened; the immediate build follow-up is to productionise and
  measure the two-signal path.
- **Bug-hunt findings (BH-1, done):** signature bug class (silent NULL-embedding on write) verified
  **CLOSED**. One new confirmed dead path: `entity_type_history` dead end-to-end (table + index + the
  reclassification feature that would fill it) — filed **`nmemo-r51`** (P2). #2/#3 (`setCorpusPolicy`
  unreachable, element-catalogs unwired) already in keep-list PARK/DROP. No new boolean/fallback/
  default-open bug.
- **Substrate note:** 70.6% of query targets have a same-name duplicate entity (dedup off) — quantified in
  E0, low retrieval impact (removing dups recovers 1 pair).

---

## Iterations

| # | type | prereg | result | headline | adversary | banked |
|---|---|---|---|---|---|---|
| E0 | oracle instrument | `06` | `07` | shift Δcond−Δstrict = **+0.0169 [−0.0141,+0.0480]**, spans 0 — oracle is **not** the binding constraint; doc 05 harm goes **borderline** under condensed oracle (Δcond −0.0452, CI upper bound 0.0) | PASS (bit-exact repro, both attacks failed; 3 interpretation trims applied) | ✅ `6baa2e5` |
| R1 | retrieval | `08` | `10` | B(P=100 DESC-pool→NAME-rerank) − ARM-NAME = **−0.0056 [−0.0169,+0.0056]**, spans 0 — **TIE**. B≈NAME (0.1949 vs 0.2006); control B′ worse (−0.0508); B beats DESC (+0.0565) | PASS — HOLDS (bit-exact repro; mechanism prose softened: indistinguishable at every P, not "unbeatable") | ✅ |
| R2 | retrieval | `11` | `12` | H(RRF-60 dense-names + BM25-names) − ARM-NAME = **+0.0254 [−0.0056,+0.0565]**, spans 0 — **TIE at K=60**. Small-K lead real but thin (K=10 +0.0339 CI>0, McNemar p=0.043) = a LEAD not a demo. Condensed +0.1102 = different task (relevance-set), Tier-A-driven | PASS — HOLDS (bit-exact repro; 2 fixes: condensed mechanism is Tier-A not Tier-B; absolute levels ride on index-asc tie-break, delta robust) | ✅ |
| R3 | retrieval | `13` | `14` | FACT-MAX − ARM-NAME = **−0.0226 [−0.0678,+0.0226]**, spans 0 — **TIE (3rd)**. FACT-MEAN worse (−0.096). SECONDARY **FACTNAME (name⊕fact fusion)**: condensed +0.0537 (all 3 bootstraps>0), strict +0.0424 (pair/doc>0, entity-cluster borderline). R@10 0.2429 best in study | PASS — HOLDS (bit-exact repro; guard leak-free, stricter guard strengthens; fusion genuine 86>71>63). Forced a harness fix: §5 cluster bootstraps were omitted for secondaries → strict lead downgraded to borderline | ✅ |
| R4 | retrieval (confirm) | `15` | `16` | FACTNAME − ARM-NAME strict = **+0.0724, all 3 bootstraps ABOVE 0** on the independent arxiv extraction — **fusion DEMONSTRATED** (larger than dal, clears the entity bar R3 missed). Both corpora >0, every k. Condensed +0.0491 (pair/doc>0, entity borderline) | PASS — HOLDS (embeddings re-embedded 30/30 cos 1.0, genuine; primary bit-for-bit; guard exact bijection). Quals: gain degree-concentrated; "robust"=pair/doc, entity-CI fragile | ✅ |
| BH-1 | bug hunt | — | (ledger + bead) | `entity_type_history` dead end-to-end; signature NULL-embedding bug verified closed; no new bool/fallback/filter bug | independent-method sweep (371 exported symbols; index.ts NUL trap defeated) | ✅ |

## What each result changes for the build

- **E0 →** proceed on retrieval (oracle is not a large hidden ceiling); always report both oracles;
  retrieval-queue item 3's *description-effect* heterogeneity is oracle-sensitive (don't chase it), its
  *absolute* 2.5× recall gap is real (dal-cv genuinely easier).
- **R1 (pool-then-re-rank) →** doc 05's head/tail asymmetry is **not exploitable** by pooling with one
  dense representation and re-ranking with the other: the only re-ranker that improves the head *is* the
  head. A re-ranker outside the two dense arms (BM25, cross-encoder) is a different lever — that is the
  shippable-hybrid experiment (queue #2), not this one.
- **R2 (shippable hybrid) →** tie at the standard RRF K=60 on target-finding; do **not** ship it as a
  demonstrated win. It clears at small K (K=10/30, thin) — pursue only via a fresh pre-registration, not a
  re-label. Its large condensed win is relevance-set retrieval (a different task the hybrid genuinely does
  better). Net: entity-vector retrievers are saturated for target-finding; leverage is task definition (a
  product call) or a new substrate (facts/traversal/causal).
- **R3 (fact-level) →** fact-max alone ties name (3rd tie, single-substrate track concluded). **Fusing
  entity-name and fact-level retrieval is the one thing that separates** — robust on the relevance-set
  (condensed) task, borderline on target-finding (strict). Build direction if confirmed: a two-signal
  read path (entity-vector ⊕ fact-vector via RRF), not a single vector. Confirm on independent corpora
  (R4) before shipping. `fact_embedding` earns its keep as the second signal, not standalone.
- **R4 (fusion confirmation) →** CONFIRMED on the independent arxiv extraction: strict fusion win
  DEMONSTRATED (all 3 bootstraps, +0.0724), both corpora, every k, embeddings genuine. **Build the
  two-signal read path** (dense-over-names ⊕ dense-over-facts, retrieved-set RRF) and measure it in
  production. Caveats to carry: gain is degree-concentrated (dense-graph entities benefit most);
  independence is extraction-only (same papers) so a new-domain + sparse-graph test is the honest
  pre-ship confirmation.

## Epic nmemo-u8j — build + prove (post-loop)

- **DECISION nmemo-u8j.10 (2026-09-01) →** primary retrieval task = **find-the-relevant-set**; the
  **condensed** oracle is the promotable one (strict reported alongside; deltas robust, absolute levels
  ride the tie-break). The condensed oracle is not arm-neutral (doc 12 §3), so every lever result reports
  BOTH oracles. Experiment children .3–.8 are scored + promoted on condensed, both-oracle reported,
  blind-adversary gated.
- **BUILT nmemo-u8j.1 →** shipped the two-signal fusion read path `recallEntitiesFused` = RRF-60(
  dense-over-names, dense-over-facts-max), corpus-scoped; the fusion primitive `reciprocalRankFusion`
  (services/fusion.ts) is shared with the eval so the harness measures shipped code.
- **nmemo-u8j.11 / doc 18 (candidate-breadth) → PASS.** The shipped default (candidateLimit=50,
  factLimit=200) HNSW top-N candidate lists PRESERVE the R4 lever: condensed R@10 fusion − name > 0 on
  both corpora (arxiv +0.0491, dal +0.0395), indistinguishable from full-ranking fusion; (25,100) fails,
  so 50/200 is the floor. Adversary CONFIRMED bit-for-bit. Caveat: the dal pass is condensed-oracle-
  dependent (dal strict spans 0); arxiv passes both oracles. **The shipped implementation delivers the
  confirmed lever at production breadth — no default change.**
- **nmemo-u8j.9 / doc 20 (substrate hygiene) → BAR 1 PASS.** Duplicate-name rate quantified per corpus
  (8–13% dup_rate; 14–20% of entities in a shared-name group; 67–71% of query targets tie exactly on
  name cosine). BAR 1: the confirmed R4 fusion delta (FACTNAME − NAME) is **tie-break-robust** — condensed
  byPair ABOVE 0 under asc/desc/rand on both corpora (arxiv +0.0491/+0.0413/+0.0439), strict too; anchor
  reproduces frozen R4 bit-for-bit. BAR 2 **refines the keep-list**: only the **strict** absolute level
  rides the tie-break (~1.3–1.7%); the promotable **condensed** level is tie-break-invariant (≤0.28%),
  because same-name twins are co-relevant under Tier-B and invisible to `condensedRankOf`. So "every
  absolute R@10 rides the tie-break" is OVERCLAIMED — true for strict, false for the gated oracle.
  **Read-path decision: NO change** — canonical_name dedup is a safe, lossy, optional presentation
  collapse; its +0.08 apparent gain is 87% oracle-relaxation (adversary), not a retrieval improvement,
  and the promotable metric needs no stabilization. Pre-registered decision criterion (b) "swing < half"
  was **tautological** (a collapse is tie-break-invariant by construction) — future dedup/normalization
  gates need an exact-id-preserving metric, not a swing test. Adversary CONFIRMED all three claims
  (SHA1-identical re-run, desc delta re-derived 16/387 by hand).
- **nmemo-u8j.6 / doc 22 (traversal-augmented) → NEGATIVE.** Vector recall → traverse `public.facts`
  (spreading activation from top-Ks name-cosine seeds, decay 0.5, ≤H hops = the in-process
  `traverseFromEntities`) → fuse RRF-60(NAME, FACT, TRAV) does NOT beat the R4 fusion RRF-60(NAME, FACT).
  PRIMARY FACTNAMETRAV(25,1) − FACTNAME condensed byPair: arxiv −0.0078 (spans 0), dal −0.0339 (BELOW 0,
  hurts); no grid cell clears. **Root cause = redundancy + zero-sum displacement:** the seeds ARE the
  name-head (traversal redundant with NAME already in the fusion), and it displaces more real fusion hits
  than it adds (arxiv 10 vs 7 with 0/7 non-seed; dal 18 vs 6). Not a decay/wiring artifact — adversary's
  decay sweep {0.5,0.9,1.0} tops out at a TIE (net 0 dal / −1 arxiv), the RRF rank budget is zero-sum.
  Not sparsity (avg degree 3.42; 60/70 targets reached via genuine non-seed paths). Held-out guard
  load-bearing. Integrity anchor bit-for-bit; adversary **CONFIRMED-NEGATIVE**. **Decision: do NOT build a
  `public.facts` traversal signal into the read path.** Closes queue #5 (our own graph substrate) as
  measured-negative; scopes only this spreading-activation design (learned/path-constrained/Graph-C =
  queue #6, untested). R4 fusion untouched.
- **nmemo-u8j.3 / doc 24 (generalization to q-bio) → PRIMARY FAILS both oracles; NEGATIVE, but the failure
  is a query-degree MIXTURE effect, not a domain effect. CLOSED.** Built a genuinely disjoint domain (320
  arXiv **q-bio** abstracts, corpus_id `qbio`, 3670 entities / 6955 facts; 0 id-overlap, vocab-disjoint).
  `FACTNAME − NAME` strict R@10 = **−0.0106, SPANS 0** all 3 bootstraps (condensed +0.0000, spans 0) — R4's
  fusion win does NOT reproduce in aggregate here (n=94; no complementarity — FACTMAX 24 < NAME 34, fusion
  33 dilutes names). **BUT the per-degree lift curve replicates arxiv:** degree-8+ lift +0.167 (q-bio, n=12,
  CI touches 0) vs +0.158 (arxiv, n=164, ABOVE 0); both negative at degree 1. The aggregate differs only by
  **query-mix** — q-bio targets are degree-poor (73% degree 1–3 / 13% degree 8+) vs arxiv degree-rich
  (36% / 42%). So the lever is **query-degree-mix-specific, not CS/vocabulary-specific.** Caveat 2
  (degree-concentration) SUPPORTED by the cross-domain replication (not "confirmed" off the single
  touch-0 q-bio bin); caveat 1 partially closed. Delta is **tie-break invariant** (index-asc == index-desc,
  33/94 dup-name targets). Wiring anchor bit-for-bit; ingest = production epoch path with the causal pass
  disabled (new `DISABLE_CAUSAL_PASS`, Graph-S-neutral). Adversary reproduced everything + rewrote the
  framing (both corrections adopted). **Decision: fusion is a degree-gated lever — deploy it where query
  targets are well-connected (degree ≳ 8), expect a wash on sparse-query corpora.** (harness `qbio-fusion.ts`
  + supporting `arxiv-degree.ts`)
- **nmemo-u8j.5 / doc 25 (embedding upgrade bge-m3 vs nomic, arxiv A/B) → PRIMARY PASS (condensed,
  DEMONSTRATED).** bge-m3 (1024-dim) lifts the confirmed fusion on the promotable oracle:
  `FACTNAME_bge − FACTNAME_nomic` condensed R@10 **+0.0930, above 0 on all three bootstraps** (149 vs 113
  hits/387). Name signal lifts too (NAME_bge−NAME_nomic condensed +0.0724, all 3), and the R4 fusion lever
  is PRESERVED under a different embedder (FACTNAME_bge−NAME_bge +0.0698, all 3 — a cross-embedder
  robustness confirmation of R4). **Strict deltas are positive but span 0** (condensed-oracle-dependent,
  same shape as candidate-breadth's dal). Integrity anchor bit-for-bit; frozen caches untouched; bge
  1024-dim unit-norm; identical fact ids both arms. Adversary CONFIRMED, decomposing the +36 condensed
  win as 72% genuine target-finding / 28% relevant-set rescue (majority real). **Decision: bge is worth a
  GATED production swap** — filed follow-up bead nmemo-u8j.12 (dim 768→1024 pgvector migration + full-DB
  re-embed + HNSW rebuild + second-substrate re-measure before any default flip). Caveats: single arxiv
  substrate; strict not significant; the exact-dot eval is an UPPER BOUND (approximate HNSW could erode
  the gap). No production swap done overnight.
- **nmemo-u8j.4 / doc 26 (cross-encoder rerank) → pre-registered config NEGATIVE; name-only variant is a
  LEAD that REOPENS it. Bead OPEN.** Reranked the top-K=50 fusion pool with an open cross-encoder
  (`BAAI/bge-reranker-v2-m3`, local CPU, no Claude) scoring query title+abstract against a
  `name + ≤10 held-out fact-sentence` candidate. **PRIMARY fails both:** arxiv strict R@10
  RERANK−FACTNAME = **−0.1059, below 0 all 3 bootstraps** (it HURTS; 102→61 hits), qbio −0.0106 spans 0
  (tie). NOT ceiling-bound (pool holds the target 50.9% vs RERANK 15.8% — headroom wasted; targets demoted
  to median position 23). Mechanism (evidenced): 64/65 demoted targets scored on the FULL untruncated
  candidate and still rejected (15 below 0.1) — the cross-encoder reorders by query↔passage TOPICAL
  RELEVANCE, not cross-paper TARGET IDENTITY. Reinforces doc 10 (fusion is already the head). Wiring anchor
  bit-for-bit; adversary reproduced everything + scoped it (this model + this candidate, NOT "cross-encoders
  in general"; "impractical @22s/query" is CPU-specific). **THE SURPRISE:** an exploratory name-only slice
  (n=60) — candidate = bare entity NAME, no facts — gives RERANK **21/60 = 0.350 vs fusion 13/60 = 0.217
  (+0.133)**, while name+facts ties fusion on the same slice. The fact-blob MISLEADS the cross-encoder;
  name-only BEATS the fusion. This is a LEAD not a win (n=60, no bootstrap, not pre-registered). **Next:
  fresh prereg (doc 27) runs name-only at full scale (n=387, both oracles, all-3 bootstraps, adversary)
  before any claim.** (tools `rerank-dump.ts` / `rerank_score.py` / `rerank-eval.ts`)
- **nmemo-u8j.4 continued / doc 27 (name-only rerank full scale) → clears the naive bar but is a NAME-IN-QUERY
  LEXICAL ARTIFACT, NOT a lever. Experiment COMPLETE, no shippable reranker. Bead CLOSED.** Name-only rerank
  clears the pre-registered PRIMARY (arxiv strict +0.0724 all 3; qbio +0.1915 all 3; 102→130 / 33→51 hits) —
  BUT the bar was blind to an artifact: **~80% of targets appear verbatim in the query** (313/387 arxiv /
  74/94 qbio), and a trivial **`query.includes(canonical_name)` reranker BEATS the cross-encoder** (LEX arxiv
  +0.1189 = 164% of the CE gain; qbio +0.2128 = 111%). The CE does NOT improve target-specific ranking (R@1
  REGRESSES 0.062<0.070 arxiv, 0.064<0.128 qbio — it floats the name-present cluster mid-pool) and does NOT
  transfer off-query (not-in-query subgroup: CE +5/74 arxiv thin, +0/20 qbio; LEX −7/74 hurts). Adversary
  ruled (b) real-but-artifact; reproduced independently via `rerank-lexcheck.ts`. **NET for .4: cross-encoder
  reranking (name+facts hurts, name-only = name-in-query artifact) yields NO shippable lever; the fusion stays
  the head. Do NOT build a CE reranker.** META-diagnostic to carry: this eval's target-finding is ~80%
  name-presence detection (papers-as-queries limitation affecting the whole loop); future rerank preregs MUST
  register a lexical-baseline + not-in-query control arm. Wiring anchor bit-for-bit; froze first; ~18–22s/query
  CPU. Nearly banked as "first lever since R4" — the blind adversary caught the launder (see
  [[verify-empirical-gates]]).
