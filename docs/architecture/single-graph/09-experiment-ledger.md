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

## Loop state

- **Retrieval-track consecutive ties:** **2** (R1 pool-then-re-rank, R2 hybrid at the frozen K=60). One
  more tie ⇒ stop the retrieval track.
- **SECOND STOP CLAUSE TRIGGERED.** Across name / description / pool-re-rank / hybrid, the target-finding
  metric is saturated at R@10 ≈ 0.20–0.23 **and** is tie-break-sensitive (absolute levels swing on the
  index-asc convention over a duplicate-heavy substrate; deltas are robust). The one place a retriever
  clearly separates — condensed / relevance-set retrieval, hybrid +0.11 — is a **different task**. So the
  binding constraint has moved from the retriever to the **task/oracle definition**. Per the loop rule
  this is a stop-and-decide point, and the decision (which task matters) is a product call → **fork raised
  with the user.**
- **Oracle status:** condensed oracle (E0) adopted; R2 showed it is NOT arm-neutral — it credits
  relevance-set retrieval (lexical/hybrid) far more than dense, because condensation forgives Tier-A
  co-attributed entities the hybrid surfaces above the target.
- **Next-step fork (user):** (i) keep the target-finding task and test a different retrieval *substrate*
  (queue #4 fact-level `fact_embedding`, #5 traversal-augmented, #6 Graph C — genuinely new mechanisms,
  not entity-vector re-rankings); or (ii) treat "which retrieval task" (find-the-entity vs
  find-the-relevant-set) as the thing to pin down first, since it now determines every verdict.
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
