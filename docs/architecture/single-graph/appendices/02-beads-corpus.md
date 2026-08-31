# Appendix 2 — Beads corpus survey (559 issues + 53 memories)

`bd export --all` → 559 issues + 53 memories. 62 non-closed (56 open, 6 in_progress), 497 closed.
271 issues carry notes, 5 carry comments. Read-only; no bead modified by the survey.

**Why this survey existed.** Documentation on this project lags the tracker. Bead bodies and especially
notes contain findings, corrections and retractions never promoted into any design doc. Several beads
carry notes that reverse their own titles.

**Verified by code read during the survey (all confirmed still true):** `promotion-plan.ts:534`
`summary: null`; `predicate-resolve.ts:42` `WHERE embedding IS NOT NULL`; `qdrant.ts` has **zero**
`corpus_id` occurrences; `entities.ts:249-257` reuse lookup has no corpus predicate;
`pattern_embedding`/`event_embedding` appear in TS only in two `schema.ts` comments and two schema tests.

---

## Table 1 — Findings that exist only in beads

| BEAD | finding | still true? | where it should live |
|---|---|---|---|
| **nmemo-ecn** (note) | *"a graceful no-op on an empty candidate set lets a core canonicalisation layer be entirely absent while every epoch reports success. The only signal is a log line that reads as a statistic rather than an alarm. Consider making an empty candidate set a loud warning, or a startup check."* | Yes — no startup check exists | Single-graph hardening, as a design rule |
| **nmemo-5fa** | The gardener lost `execute_merge`/`create_same_as_link` from **every** allowlist under the strict E5 reading, *"chosen 2026-06-16 over doc 41 §8a.7"*. Result: *"the gardener can DETECT dedup candidates but has no path to ACT on them."* The decision is recorded only in **nmemo-vpz.5 close notes** and **contradicts doc 41 §8a.7** | Likely (vpz.7 still in_progress) | doc 41 §8a.7 needs amending — this is the only record the doc is wrong |
| **nmemo-an9** | `find_causal_ghosts` lost its only caller (reasoning-agent patrol phase 2.5). Phase-4 is **delta-scoped per epoch + capped**, so **there is no global causal re-sweep any more** | Partly — the tool is still reachable via `reasoning_agent.py:136,292`; what died is ghost-*filling as an action*. The no-global-sweep half stands | Causal-layer doc + epoch-v2 Phase-4 section |
| **nmemo-kgy** | `mlFetch` builds its own AbortController; the branch commented *"Abort by caller — don't retry"* describes a case that cannot occur. Self-timeout → **no retry**; ordinary network error → 3 attempts. Timeout asymmetry: `/chat` 60s vs `/resolve-predicate` 120s vs embed/extract 600s. Five production callers on the 60s path. **`predicate-resolve.ts:156` catches and keeps the raw predicate → a timeout is silent quality loss on the promotion path.** Blanket retry rejected: 600s × 3 = 30min hang | Unverified | ML-client doc — a whole silent-degradation channel with no doc home |
| **nmemo-m8d** | Epoch proposer over-extracts: fact precision corpus10 **0.09–0.13** (~21 extra vs ~6 gold), corpus20 **0.16–0.22** (~47 extra). Named junk: `austin lives_in texas`, `marcus chen founded his_own_venture`, `office_sequence_number`, `drove_funding_success`. *"the aspirational ≥0.70/≥0.80 thresholds are gated by extraction quality, not canonicalization"* | Unverified; proposer prompt unchanged | Extraction-quality doc |
| **nmemo-u70** | `uniq_facts_active_triple` (mig 037) keys only on `expired_at IS NULL`, ignoring `invalid_at`, so an active row and a historically-invalidated row of the same triple collide (23505). *"No service UPDATE sets invalid_at"* — insert-time only. Option A (narrow the index) **ripples into the nmemo-9vk merge dedup**; both must change together. Repro = SC-17. Also a **mis-attribution correction**: SC-17 was bundled into 9vk but *"mergeEntities is never called in it"* | Unverified (likely still red) | Bi-temporal model doc — an unresolved *model* decision, not a bug |
| **nmemo-p0t** | `Actor` union is now **9** (test asserts 8); `actor-tool-allowlist.test.ts` authoritatively partitions the **22 `mutates:true` tools into CANONICAL_WRITES (17) ⊎ PROPOSE_VERDICT_WRITES (5)** | Unverified | The allowlist test is now the SSOT, not doc 41 §8a |
| **nmemo-1tc** (note) | Partial fix landed (31b625d): global dispatcher with `headersTimeout:0` fixed the 300s undici 500s. **Remaining:** ml-services :8000 still dies under sustained load (~40–50 `claude -p` spawns); compare-driver still asserts (libuv `UV_HANDLE_CLOSING`, exit 9) on a 500. Single-arm runs (~20 spawns) complete | Likely | Infra/ops — this is the ceiling on every multi-arm benchmark |
| **nmemo-zro** | LongMemEval needs `claude -p` **~119 times per question**; a shared session limit returns rc=1 with empty stderr, and every remaining window fast-fails, scoring the question 0. *"Getting ONE question through took 3 resumes across 4 sessions."* ml-services also stayed down after rc=1 | Likely | Benchmark runbook — explains why nmemo-bki has stalled |
| **nmemo-xt1** | `cognitive_test` accumulates canonical fixtures because `afterAll` cleans staging only: *"observed: 10 Globex, 8 target, 6 each of acme inc/helix corp/dr. elena vasquez"* → `resolve_anchor` exact-match returns a stale id non-deterministically | Unverified | Test-infra doc |
| **nmemo-du2** | `clearGraphTables()` covers a hand-maintained 17-entry list against **~42 `public.*` tables**. Named omissions: 3 staging tables, `arbiter_verdicts`, `edge_source_refs`, `fact_sources`, `fact_units`, cluster/topology/drift state, `graph_stats`, `derived_freshness`, `cross_cluster_runs`, `stream_participants`, `capture_idempotency`, `llm_usage`, and AGE `knowledge_graph`. Live DB then: **1067 AGE nodes vs 4 `public.entities`** | Unverified | Reset/ops doc; the "derive reset from a schema registry" recommendation is bead-only |
| **nmemo-uhp.19** (comment) | **NEW OQ3 = OVERLAPPING-RULE COLLAPSE**, filed nowhere else: *"when the prefilter surfaces >1 true rule, per-cell adjudication may confirm one and drop the near-duplicate. A recall risk distinct from OQ1/OQ2; the pre-registered ~50 run must measure per-rule recall, not just per-element."* Also stage-1 smoke: real MISRA Ch.22 corpus, **recall@1 0.714 (5/7), recall@3 0.857** through production `recallCrossCorpusCandidates`, vs the .17 opaque-ID floor ~0.42–0.48@5 | Yes — the ~50-element run never ran | Cross-corpus recall doc; OQ3 is a live design constraint |
| **nmemo-uhp.12** (close) | *"B1 pass-registry and B2 edge-rule walker were DEFERRED and are NOT delivered here — file as new work."* **Grep confirms no bead exists for either** | Yes | Phase-B scope; and the tracker needs the two beads |
| **nmemo-2yv.23** (close) | Predicate-evolution API deprecated with `@deprecated` JSDoc; `recordPredicateUsage` retained with **exactly one caller, `facts.ts:320`**. Schema + 37 tests kept as "revival optionality" | Yes — and this is the mechanism behind ecn's observation that all 48 rows have `usage_count=0` (the epoch path bypasses `createFact`) | Predicate-ontology doc — the link between this deferral and the ecn measurement is recorded nowhere |
| **nmemo-1cp** (note) | Prefix adoption is **scoped to memories only**: *"entity-name + fact + search_similar_entities embeds stay on ml.embed() raw"*. The win was recall@1 **0.38 → 0.75** at unit 256/64 with mean score flat. *"entity-prefix consistency left as deferred follow-up"* | Yes | This is the exact open question **nmemo-5co.5** re-asks |
| **nmemo-uhp.15** (close) | Adversary partially voided the description-formula bake-off: *"re-ran ranking with pure token-Jaccard (embeddings removed) and reproduced the winner EXACTLY (0.778/0.931) — 93% of per-item @5 is shared-token-determined; the embedding adds ~nothing atop the dense keyword formula, but lifts PLAIN PROSE 5x (0.085→0.422)"* | Yes | The cleanest single statement of "lexical carries it" |
| **nmemo-uhp.26** (close) | *"PRE-REGISTERED GATE FAIL … Blind adversary = FAIL-IS-ARTIFACT … Canonical retrieved-set RRF (blind, un-tuned, k-robust) = 0.648, hits oracle ceiling, beats BOTH arms at every k. Pessimistic reading RETRACTED. But 0.648 NOT banked (post-hoc variant)"* | Yes, as an unbanked result | The only positive fusion result in the arc, filed under a FAIL |
| **nmemo-uhp.25** (close) | Concept reconciliation gate PASS but narrow: *"recovers bucket-1 SYNONYM-vocab recall (8/29→18/29) … addresses-type & bucket-2 contributed ZERO, recall@1 regressed 0.237→0.159, ties cosine"* | Yes | The @1 regression is the load-bearing half |
| **nmemo-2yv.5/.6/.7/.12/.13** (notes) | T1 *"graph_stats is mostly write-only (1/5 promised consumers wired)"*; T7 *"naming-mismatch is a signature of feature fragmentation — when service name, schema column, and bead title disagree, suspect unwired slices"*; **transport divergence** *"when a feature is replaced by a new transport, the old transport rots silently unless explicitly retired or maintained at parity."* Cycle-wide falsification rate ~5/115 ≈ 4% | Formalised in doc 31 | Low loss risk |
| **nmemo-2yv.14** (note) | *"README is stale beyond doc 19 — docs 20-30 exist but aren't catalogued"* | Now much worse (two parallel series to 42) | truth-graph README |

## Documentation hazard found while checking citations

`docs/architecture/truth-graph/` contains **two doc 38s** (`38-graph-anchored-fallback-retrieval.md`,
`38-parallel-ingestion.md`) and **two doc 39s** (`39-graph-validity-harness.md`,
`39-natural-language-graph-querying.md`), and `cross-corpus-audit/` runs its own 35–42 series. Beads cite
bare *"doc 38 §6"* / *"doc 39 §4"* / *"doc 42 §9"* — up to **three** candidate files each.
`nmemo-5co` cites truth-graph 39; `nmemo-4h3`/`cki`/`mdc` cite cross-corpus-audit 42; `nmemo-m8d` cites
truth-graph 42. **Any doc-driven reading of these beads will mis-resolve references.**

---

## Table 2 — Self-reversing beads

| BEAD | title claims | note corrects to | current | title misleading? |
|---|---|---|---|---|
| **nmemo-ecn** open **P0** | ontology is *"domain-locked to personal memory"* | **Two** reversals. Note: *"MY PRIMARY DIAGNOSIS IN THIS BEAD WAS WRONG … THE PREDICATE FOLD NEVER ATTEMPTED A SINGLE MATCH."* Comment: *"TITLE CLAIM NOW TESTED AND REFUTED AS THE PRIMARY CAUSE … seed type pairs are person/* so type_pair_overlap caps at 0.5 … 0 of 3,963 keys could reach even 'ambiguous' (max reachable 0.7917)."* Also cuts its own follow-up: entity-type-fragmentation-is-upstream was CUT (*"1,551 of 2,241 (69.2%) ALREADY had a tov=1.0 candidate and only 88 merged"*) | The comment. Root cause = the jaro-winkler term (nmemo-4g9). Domain content is secondary and untested. All measurements survive | **YES — worst in the tracker.** A P0 whose title states a cause refuted twice, one by direct test |
| **nmemo-w2p** open P2 | *"backfill-predicate-embeddings.ts was never run"* | *"SUPERSEDED AS WRITTEN — do NOT run the backfill yet … 2,240 → 2,157 = 3.7% reduction (bar 60%) … net-harmful as calibrated: precision 0.43 … trades 3.7% collapse for unrecoverable corruption of ~2% of facts."* Records the deliberate P0→P2 demotion | The comment. Title fact is true; the implied action is now forbidden | Partly. Action-misleading; body is a stale copy of ecn's note |
| **nmemo-uhp.6** in_progress P1 | *"E1: behaviour-to-rule embedding recall spike (schema-less)"* | 12 chained notes, **5 self-launder retractions caught by adversaries**: gate answered → *"RETRACTED/DOWNGRADED — verdict OVERCLAIMED"* → Leg-1 *"VOID"* → Leg-2 floor PASS → Leg-3 field precision **0.13@2%** → Leg-4 real code reproduces the collapse (**1/7 = 0.14**) → Leg-5 *"ADVERSARY CUT 'architecture validated'"* → Leg-6 *"INTEGRITY FAILURE: the smart-AST that 'beat' the LLM was swapped post-hoc … adversary CUT it"* → Leg-7 *"INCONCLUSIVE"* → *"INVESTIGATION PAUSED (terminal state)"* | The last two notes. Acceptance criteria still describe the **retracted** gate | **YES.** Open P1 naming an abandoned approach; status should be `deferred`, not in_progress |
| **nmemo-x4s** open P1 | entity fragmentation ratchet; body points at the ontology bead as upstream | Reversed **from another bead** — ecn's comment cuts the upstream claim | Title + the entity measurement stand (19.6%/15.3% dupes, `entity_merges=0`). The causal chain to the fold does not | Mildly — the cross-reference framing is stale |
| **nmemo-uhp.17** in_progress P2 | authoring convention *"worth ~+0.35 macro recall@5"* | *"VERDICT FAIL — no robust embedding-leg recall lift vs plain prose (adversarially verified; 7th launder-catch — first run's +0.13 was a seeding-bug artifact, corrected to +0.056/ns). Do NOT adopt as ingest default."* | The note. The +0.35 is a doc-12 grid number, not a validated lift | **YES** |
| **nmemo-2yv.5** closed | Review #5 | *"INVALID PREMISES: … 'graphStatsPanel is dead UI' based on working-tree grep. Falsified by git grep against HEAD … working tree has substantial uncommitted deletions; HEAD is the source of truth"* | The correction | No, but the **method rule** is durable |
| **nmemo-2yv.102** closed | destructive-action preflight | Notes carry a **REFUTED** block reversing 8 of its own findings, plus a live `NULL-FALLBACK NOTE`: `pre_expire_blast_radius IS NULL` conflates *cascade-internal* with *preflight-failed* | Notes | No, but the NULL-conflation caveat is an undocumented forensics limit |
| **nmemo-4w4** closed | synthetic-N cross-component pairs | *"SUPERSEDED BY nmemo-2yv.95 … the literal acceptance 'regenerate synthetic-1k and 10k' is intentionally NOT met — those remain mode='intra-component'"* | Superseding note | No, but anyone assuming synthetic-1k/10k contain cross-component bridges will be wrong |
| **nmemo-uhp.5** closed | PC dispositions | *"CORRECTION per PC8-5: `inverse_predicate` is **LIVE** … NOT inert"* — reverses PC-7 and uhp.1's register entry | The correction | No — but nmemo-4g9 notes the inverse **guard** is effectively unreachable (*"only 2 of 2,240 corpus predicate strings are within its reach"*). Live code, dead effect |
| **nmemo-6do** closed | LLM token/cost tracking | *"RECONCILIATION … STALE-FACT CORRECTIONS epic-wide: (1) MIGRATION NUMBER: the new table is **050**_llm_usage.sql, NOT 040 … Every '040' in this epic and in token-usage/00 is stale"* + 6 more. Also *"NOTHING COMMITTED — awaiting user go-ahead"* | The reconciliation note | No — **but "NOTHING COMMITTED" on a closed epic is a trap.** Subsequently verified: mig 050, `usage.ts`, `usage-report.ts` all exist, so the go-ahead came |

---

## Table 3 — Built-but-inert features

| BEAD | what is inert | evidence |
|---|---|---|
| **nmemo-w2p / ecn** | **The entire predicate fold.** *"BUILT AND SHIPPED but INERT for want of a setup step."* Nine closed beads delivered a layer that has never resolved a single predicate | `predicate-resolve.ts:42` filters `WHERE embedding IS NOT NULL`; 48 rows, zero embeddings. Every epoch logs `reused=0 minted=0 deferred=ALL`. Now compounded — do **not** run the backfill |
| **nmemo-86z / yq1** | **`EMBED_DESCRIPTIONS` is a flag with nothing to act on.** *"Both ingests ran with EMBED_DESCRIPTIONS=true and the composite path is correctly wired — but with e.summary always null, EVERY entity vector embedded the bare NAME."* Cascades: `link-corpus-concepts.ts` falls back to `text = name`, so every doc-35 concept label came from a bare name | Verified `promotion-plan.ts:534`. All 2,512 entities `description NULL` while 1,430/1,558 (92%) staged proposals carry a summary |
| **nmemo-8rm** | **Graph C does not populate at production batch size.** *"147 papers produced 9 causal edges … non-fatal by design, so it is SILENT"* | `[WinError 206]` every batch, symmetric across corpora. Also `[causal-pass] scope hit cap 200 … truncated` |
| **nmemo-ygk** | **Provenance writes nothing.** `fact_sources = 0`, `memory_entities = 8` for 294 docs. *"cleanupAbandonedStaging() runs every epoch batch and deletes staging older than STAGING_TTL_MS (default 1 HOUR) … This already destroyed one corpus's provenance once"* | "Source traceability" is a stated core promise |
| **nmemo-5fa** | **Gardener long-range dedup is a no-op** — detect without dispose. Interacts with x4s: `entity_merges = 0` because `detectMergeCandidates` and the barrier reconcile were removed from the epoch path | E5 retired the merge tools from every allowlist including `gardener_agent` |
| **nmemo-x8b** + **5co.13** | **Dead columns carrying live HNSW indexes** → write-amplification on every causal insert. The `schema.ts` comment *"handled directly via SQL"* is stale — no such SQL | Verified: only TS occurrences are those comments plus two schema assertions |
| **nmemo-2yv.23** | **Predicate evolution lifecycle has no production consumer.** `recordPredicateUsage` has one caller inside `createFact`, which the epoch path never calls | Confirmed by ecn: *"EVERY row has usage_count = 0 and last_used_at = NULL"*. The staging→provisional→canonical lifecycle cannot function |
| **nmemo-n6k** | **AGE is structurally unmaintainable, not just stale.** No DELETE trigger on either sync; AGE silently drops edge `SET`, so **fact expiry cannot be represented on an edge at all**. 6,973 vertices vs 3,406 rows (2.05×); 5,534 edges vs 3,148 (1.76×) | *"Cypher traversal sees deleted entities and expired facts as LIVE."* Corollary: `concept-multihop.ts` used SQL recursive CTEs, *"currently the only expiry-correct traversal path"* |
| **nmemo-mdc** | **Qdrant has no isolation of any kind.** Filters by `stream_id`, never `corpus_id`. Plus `qdrant.ts:25` resolves `QDRANT_COLLECTION ?? 'memories'`, so `NODE_ENV=test` does not isolate it either | Verified zero `corpus_id` in `qdrant.ts`. The 294-doc run wrote 11,927 points into shared `memories` while `memories_test` sat at 0 |
| **nmemo-4h3** | **Read-side isolation does not exist.** ~39 query/search/traverse services carry no corpus predicate. *"FIVE unscoped corpus paths found and fixed across this arc … Five found by hand means a sixth exists"* | Recurrence is the evidence; the fix is structural |
| **nmemo-cki** | **The default entity path is not graph-isolated** — and the workaround is a *second ingest path* | Verified `entities.ts:249-257` |
| **nmemo-hxg** | `findConnectedEntities` catches and returns `[]` (`graph.ts:270-273`), so `recallViaGraph`/`expandFromAnchors` **silently degrade recall** whenever AGE lags | Combines with n6k into a traversal layer that fails soft in both directions |
| **nmemo-w6o** | `recallMultiHopConcepts` default `maxPairs = 100_000`, stderr warning only. **This corrupted a published measurement**: true sizes were hops=1 137,922 (27.5% dropped) and hops=2 736,882 (**86.4% DROPPED**). *"The truncation HID the run's actual headline finding"* | Found by a blind adversary, not the author. Fixed in the scorer; *"the unsafe default remains in the service"* |
| **nmemo-6do** closed | **Possible phantom feature** — epic closed with *"NOTHING COMMITTED"* | **Subsequently disproven:** mig 050 + `usage.ts` + `usage-report.ts` all exist |
| **nmemo-gnt** | `create_llm_client()` treats any unknown `LLM_PROVIDER` as Claude with an info log; `startup-validation.ts` defaults `'pi'`, `llm.py` defaults `'claude'` → **cross-process default drift on an unset var** | Inert *validation*, not an inert feature |

**Pattern the tracker names itself** (nmemo-2yv.13): *"transport divergence — when a feature is replaced
by a new transport, the old transport rots silently unless explicitly retired or maintained at parity."*
Every row above is an instance of that, of **T13 half-built**, or of the **T9 observability gap**.

---

## Table 4 — Subsystem inventory (tracker's view)

| SUBSYSTEM | built | broken | designed-only | beads |
|---|---|---|---|---|
| **Graph S core** | entity dedup w/ advisory lock, fact dedup, bi-temporal columns, `facts_at_time()`, exclusive-group supersession, `embedForWrite` contract, AGE sync triggers | `createEntity` not corpus-scoped; fragmentation ratchet (19.6%/15.3%, `entity_merges=0`); no merge disposer; `uniq_facts_active_triple` blocks supersession; `getEntityFacts` hardcodes `NOW()`; predicate usage counting bypassed | temporal/predicate/type filters on `searchFacts` | cki, x4s, 5fa, u70, wyb, 9vk✓, avd✓ |
| **Predicate ontology / fold** | 48 canonicals, alias arrays, `inverse_predicate` (live), `/resolve-predicate`, promote-time fold, stale-canonical demotion, threshold sweep, backfill script | **fold inert**; scorer is a string-edit matcher (jw arithmetically necessary; precision **0.43**, 42/88 LOSS incl. negations and an inverse); **not a function of the predicate string** (8 strings → 2 canonicals, 110 facts); no union-find; the `reused` statistic is fake (**1,715/1,722 self-resolutions**); 2,240 predicates / 68.7% hapax; 338 entity types / 47.3% hapax | seedable per-corpus ontology with a growth path; negation/ordinal veto; semantic-only merge path | **4g9(P0)**, **ecn(P0)**, xhn, 3aq, w2p |
| **Epoch v2** | E1 group-aware supersession, E2 staging + propose tools + allowlists, E3 deterministic promotion, E4 chunk ordering, E5 arbiter escalation, E6 causal split-out, E8 validity harness as gate | drops every entity description; no `fact_sources`/`memory_entities`; proposer over-extracts (precision 0.09–0.22) | — | **vpz** (7/8, vpz.7 in_progress), 86z, yq1, ygk, m8d |
| **Causal layer** | schema + AGE causal_graph, events on fact changes, read/write services, tools, agent loop, conditional trigger, corroboration ledger (051), Phase-4 delta pass | **does not populate at batch size** (9 edges / 147 papers, silent); ghost-filling has no disposer; no global re-sweep; two dead embedding columns w/ live HNSW | pattern vectorization + chain pruning; Corr2Cause/CLadder reality check | **8rm**, an9, x8b, 5co.13, 4fd, 9hp |
| **Query / retrieval** | flat vector retrieval, `expandFromAnchors` + trigger + re-rank, nomic prefixes on the memories path (recall@1 0.38→0.75), unit-grained read path, static pagerank tie-break | every `/api/reason/query` spawns a full Claude Code subprocess + MCP loop, incl. trivial retrieval; fallback silently `[]` on unsynced AGE; fallback uplift never demonstrated; `predicateWeight` defaults to 0 | **all of Tier 0/1/2** — 13 sub-issues, zero implemented | **5co** + .1–.13, hxg, 7ra |
| **Graph isolation** | `corpus_id` partition, 4 fusion guards, composite-FK backstop, immutability trigger, policy preset, D5 escalation, 8/8 acceptance suite | writes guarded, **reads not** (~39 services); `createEntity` global; **Qdrant has no partition** | one un-bypassable scoped helper, or RLS failing closed | **4h3**, **cki**, **mdc**, uhp.7–.11✓ |
| **Cross-corpus audit** | Phase A schema; Phase B linker spine; element catalogs + `element_embeddings` + `recallAcrossCorpus`; faceted authoring; corpus-ingest | .17 authoring convention **FAILED** its gate; recall is pure-vector; embedding is the weakest leg on every measurement; OQ1/OQ2/**OQ3** unmeasured | **B1 pass registry + B2 edge-rule walker — deferred, no bead exists**; hybrid BM25 (.18); graph-mediated recall test (.19); Phase C (.13) | **uhp** epic, .18, .19, .13, .6 |
| **Concept layer** | mig 057, `extractAndLinkConcepts`, `resolveConcepts`, `recallByConcept` wired into `runAuditPass`, merge re-points bridges | **retrieval thesis dead** on every config and oracle | ingest-time extraction wiring; concept provenance in audit scope | uhp.20–.27✓, **rcy (in_progress, owes adversary)** |
| **Benchmarks** | `/benchmarks/` workspace + shared `_common/` | LongMemEval stalled since May; harness dies on session limits; ml-services dies under load | **all 5 baselines** | **bki**, eue, 4fd, 9hp, 46r, q0e, 9qq, zro, 1tc |
| **Topology / clustering / drift** | components, k-core, articulation+bridges, communities, centrality, HDBSCAN, ADWIN drift, cross-cluster generator, auto-triggers, 1k/10k benchmarks | `graph_stats` largely write-only — 1 of 5 promised consumers wired | — | a7f.*✓(34) |
| **Infra / ops** | migrations, AGE init, snapshot infra, viz | ml-services dies under load; driver libuv assert; reset covers 17 of ~42 tables + no AGE; 3 non-idempotent migrations; `LLM_PROVIDER` silent fallback + default drift; ml-client retry inversion; flaky `resolve_anchor` test | schema-registry-derived reset | 1tc, du2, ved, gnt, kgy, xt1, p0t |
| **LLM cost tracking** | 12 beads closed, 74 tests green; **verified present on this branch** | captured **nothing since 2026-06-30** — the arc's harnesses bypass the instrumented path | mid-flight USD ceiling; arbiter/causal actor capture; Ollama token estimation | 6do.*✓(12) |

---

## Table 5 — Priority anomalies

| BEAD | current | should be | reasoning |
|---|---|---|---|
| **nmemo-yq1** | P1 open | **close as duplicate of nmemo-86z** | Same defect, same line, same measurements. 86z supersedes it and adds the second-order finding. Two open beads on one line invites two fixes or none |
| **nmemo-ecn** | **P0 open** | retitle + re-point; arguably P1 | Its own note and comment refute the title's causal claim. As written it directs work at authoring a domain ontology, which the comment proves insufficient and not-first. The surviving content is a measurement, not a fix |
| **nmemo-8rm** | P1 open | **P0** | A whole graph layer does not populate at production batch size, and fails **silently** by design. It also invalidates **nmemo-4fd** and **nmemo-9hp** in advance — run today they measure 9 edges and return a false negative that reads as a capability verdict |
| **nmemo-4fd, nmemo-9hp** | P1 / P2 | **add a hard dependency on 8rm** | Neither has any dependency edge to it |
| **nmemo-mdc** | P1 | **P0 if multi-graph is the direction** | Its own body: *"the largest single isolation gap … the one component with no isolation story."* Same argument for **4h3** and **cki**. All three sit at P1 under two P0s that are predicate-quality issues |
| **nmemo-uhp.18** (hybrid BM25) | **P2** | **P1** | Later independent runs made this the single most-supported retrieval change, and none are cited on the bead: uhp.15 (token-Jaccard reproduces the winner exactly), doc-15 (BM25@3 0.880 ≥ embedding 0.838), doc-17 (embedding R@1 39–44% vs BM25 72%), uhp.26 (RRF 0.648 beats both arms at every k) |
| **nmemo-w2p** | P2 | correct as-is | Deliberately demoted P0→P2 *in a comment with the reason*. The tracker's one clean example of evidence-driven re-prioritisation |
| **nmemo-5co** + 13 children | P1 | hold, or re-sequence behind 4g9/n6k | Largest open investment and its foundations moved under it. **5co.4** carries its own warning (*"synonym spreading would mostly be spreading over one-offs"*) yet has **no dependency edge** to ecn or 4g9. **5co.6/.7** rank via traversal over an AGE index n6k shows is 2× oversized and cannot represent expiry — also no edge. The epic's own gate (5co.1, measure first) is unstarted |
| **nmemo-uhp.13** (Phase C) | P3, now **unblocked** | keep P3 or defer explicitly | Its blocker closed, so it will surface as ready work — on the strength of a thesis that has since been retired |
| **nmemo-uhp.6** | P1 **in_progress** | `deferred`, retitled | Explicitly *"INVESTIGATION PAUSED (terminal state)"* |
| **nmemo-uhp.1** | P2 in_progress | close | *"PC-8 audit COMPLETE"*, all 8 findings filed as their own beads. Only residue: *"TODO: fold into 05 register"* |
| **nmemo-uhp.17** | P2 in_progress | close as FAIL, or retitle | Kept open against an acceptance criterion measured false. Live successor is uhp.19 |
| **nmemo-rcy** | P2 in_progress | close, or split the adversary owed | Gate ran and recorded; only the blind adversary is owed |
| **nmemo-eue** | P1 in_progress since 2026-05-27 | re-plan behind zro + 1tc | Stalled 3 months; the two beads explaining why are P2. The whole bki epic is gated on infra filed below it |
| **nmemo-u70** | P2 | answer its own embedded question first | *"does any production ingest path actually insert a fact with invalid_at in the past alongside an active same-triple row? If yes → real P2 data-loss. If never → P3 test-model artifact."* Unanswered, so the priority is a guess |
| **missing beads** | — | file | (a) **B1 pass-registry**, (b) **B2 edge-rule walker** — deferred with *"file as new work"*, neither exists. (c) The **doc-numbering collision**, which silently corrupts every doc citation in the tracker |

---

## The 53 memories

**Composition:** 44 durable engineering lessons + 9 project-status snapshots, now stale (they describe the
removed learn platform and April doc-numbering states) — safe to prune.

**Highest-value durable lessons, all tracker-only:**

*Postgres / Drizzle traps — every one a silent-wrong-data class:*
- **drizzle 0.29 + postgres-js 3.4 silently stringify JSONB** passed via `.values({field: obj})` → the row lands as `jsonb_typeof='string'`. Use `jsonbLiteral` from `services/audit.ts`. *"The drizzle ORM path is broken for non-trivial JSONB payloads."*
- **`NOW()` inside a transaction returns transaction-start, not statement-start** → two audit rows in one tx get identical `occurred_at`; order-by-DESC tests must use set-membership. Use `clock_timestamp()`.
- **`UPDATE…RETURNING` is the only audit-set-integrity-preserving shape** for "one audit row per mutated row" — SELECT-then-UPDATE races under READ COMMITTED.
- `COUNT()` → bigint → postgres.js delivers a **string**; JSONB selected without `::jsonb` returns JSON-encoded strings; the `sql` template won't serialise JS arrays into `uuid[]` for UNNEST (use `(VALUES …)`, ~32k pair cap); `pg_try_advisory_xact_lock(integer)` has **one keyspace across all single-arg callers**; `ON CONFLICT … RETURNING (xmax = 0)` is the canonical upsert-detection idiom.
- **`deleteFromTables` in `src/test/setup.ts` silently filters against an internal whitelist** — `merge_candidates`, `entity_meta`, `entity_topology`, `entity_clusters`, `graph_stats` are dropped without warning. This has bitten measurements.
- **Rebuilding a search_path-polluted AGE database:** drop+recreate, run `init-age.sql` **first** (it owns the DB-level `ALTER DATABASE … SET search_path`; migration 001 is session-level only), then migrate. *"Selective ag_catalog table cleanup is insufficient — leaked functions/sequences also shadow public."*

*Design rules worth promoting into CLAUDE.md:*
- **`??` fallback on a domain-meaning value is dangerous when the fallback is a post-filter variant of the same shape** — both branches type-check and the fallback can invert the invariant the gate enforces. *"Treat NULL on a metadata column as stale-upstream (skip with structured reason), never as missing-default."* Same defect class as the `EMBED_DESCRIPTIONS` no-op and the empty-candidate-set no-op.
- **A hand-maintained allowlist in a different file from the entity declarations will drift the moment the list grows** — push the property onto each declaration as a required typed field and derive the set at module load. Directly applicable to `CLEARABLE_TABLES` and `EXPECTED_WRITE_TOOLS`.
- **Prompt-safety: cap + sanitise at the READ-into-prompt boundary, never write-time**, so pre-cap rows and writer-bypassing paths are covered; mirror tag strings across the Python/TS boundary in the same commit; structural neutralisation beats blocklisting.
- **`nomic-embed-text` 500s above ~2048 tokens (~10–13K chars)** — chunk at `max_ingest_chars` (6000).
- **Don't rank configs on recall@k when k is close to N** — at n=8 recall@5 moves in 0.125 steps and one outlier mis-steers the conclusion; rank on the smoothest goal-aligned signal, demote recall to a tiebreaker.
- **Cross-process integration tests sharing a DB with a long-running server need the server restarted with the test `DATABASE_URL`** — it reads `.env` at boot, not per invocation.
- **When a scaffolding test surfaces an out-of-scope pre-existing bug, pin both sides**: `it.skip` for expected behaviour + `rejects.toThrow` regression guard. *"Better than a TODO comment because machine-checked."*
- **`git stash push -u <specific files>`** to test whether a failure is pre-existing — an explicit file list stops the stash sweeping unrelated cruft.
- **`Math.abs(sum) < EPS`, not `sum === 0`**, for weight-normalisation checks; FP cancellation to `-1e-17` then divides by tiny and yields astronomical weights.
- From nmemo-2yv.5, **not currently a memory and should be**: *"working tree has substantial uncommitted deletions; HEAD is the source of truth"* — re-grep HEAD before filing a dead-code finding.

**Skew:** ~15 of 44 lessons are d3-force/viz-specific. Only 3 touch the graph's semantic core. The most
reusable lessons — *silent no-ops report success*; *a value plumbs only as wide as the narrowest gate*;
*a merge is lossy and unrecoverable while over-minting is gardener-recoverable* — live in **bead notes,
not memories**.

## What this survey could not determine

1. **All live database state.** Every measurement quoted is from bead bodies; no DB connection was made. Several were measured on `cognitive_test`, which the beads flag as churn-inflated.
2. Which findings are already in docs — the survey was scoped out of `docs/`. The "should be documented" column is inferred from whether a bead cites a doc section.
3. Whether the doc-38/39 duplicates are a genuine collision or an intentional two-series scheme.
4. **261 beads have `close_reason: "Closed"` and no notes** — mostly 2yv and a7f children. Any finding in those is unrecoverable from the export.
5. Current state of `nmemo-vpz.7` (E7 band-aid retirement) — in_progress with no notes. Whether `filterLiveEntityIds` and the per-chunk CAUSE path are gone determines whether 5fa's gardener gap is live.
6. Cost/effort realism of nmemo-bki — estimates exist (5–8 weeks serial) but no actual spend or elapsed data after 3 months.
