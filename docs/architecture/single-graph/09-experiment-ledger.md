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
