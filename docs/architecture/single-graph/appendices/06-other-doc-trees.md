# Appendix 6 — truth-graph, token-usage, benchmarks; and the tiered query architecture

**Provenance headline.** `git diff --name-only 4d3c0b8..HEAD -- docs/` (excluding `cross-corpus-audit`)
returns **exactly one file**: `docs/architecture/viz-perf/bench-log.md`. Every other doc in this scope —
all truth-graph docs, all 5 token-usage docs, the whole benchmark programme, all 13 handoff docs — is
**INHERITED and untouched by the 140-commit arc**. These trees describe the system as of end-June 2026.

---

## 1. The natural-language tiered query architecture

`docs/architecture/truth-graph/39-natural-language-graph-querying.md`, 2026-06-16. Self-labelled
*"Discussion / position doc … not a build spec."* It says *"No bead yet"* — **stale**: epic `nmemo-5co`
was filed in the same commit and has **13 children, 0 closed**.

### 1.1 The reframe — verified true

The doc rejects the premise "querying requires an LLM because the LLM translates NL→Cypher". Verified
against source:

- `executeCypher` (`graph.ts:17`) receives a query string **built in TypeScript**, interpolated into
  `cypher('knowledge_graph', $$ … $$)` at `:22`. No NL reaches it.
- `findConnectedEntities` (`graph.ts:225`) builds one of two fixed skeletons, templating only `entityId`
  (UUID-validated), `safeDepth` (clamped 1–5), `safeLimit` (clamped 1–200), and `relationshipType`
  (regex-gated `A-Z_`).
- Anchoring is pgvector cosine; traversal is AGE Cypher + recursive SQL; ranking is hop-distance +
  pagerank. **No model in any of those.**

So the LLM does query *planning* and *synthesis* only. The conclusion — do not build text-to-Cypher, it
is ~60% accurate at the frontier and silently-wrong-but-runnable queries are unabsorbable for faithful
recall — is sound. **KEEP this decision.**

### 1.2 The tiers, as specified

**Tier 0 — no generative LLM, no agent loop; the intended default.** Extract constraints → anchor on
entities by embedding → apply structured filters (place, time window, predicate, object type) → walk the
graph → return **a ranked list of triples plus an explorable subgraph**, bypassing `invokeReasoningAgent`
entirely. Careful distinction: this is "no *generative* LLM", not "no understanding" — Tier 0 still runs
one local rule-based constraint-extraction step.

**Tier 1 — synthesis on request.** When the user wants prose, **one** LLM call over the subgraph Tier 0
already retrieved. No agent loop, no MCP round-trips.

**Tier 2 — the full agent, rare.** Retained for queries that genuinely need planning plus algorithmic
graph interaction. Canonical example: *"write a report on the causal chains that led to me finding a job
in San Francisco, and cross-analyse disparate parts of my memory for things that caused it without being
directly related."* This is Graph C's showcase and the doc argues it *should* stay agentic.

**The framing the doc prefers over three discrete tiers:** recast as **one effort-budget dial**, Tier 0 =
budget 0, escalation = raising the budget. It cites Microsoft LazyGraphRAG as independently arriving at
the same shape — no LLM summarisation at index time, all LLM deferred to query time, scaled by a single
tunable relevance-test budget. **This dissolves the hard "which tier" decision the doc itself calls the
crux, and is the best idea in it.**

### 1.3 The routing rule

§5 names the problem precisely: if a query must pass through an LLM *just to decide* it is a simple
lookup, the toll booth is back and the cheap case pays the latency you set out to remove. An earlier
draft said "progressive escalation, no upfront router", then proposed a causal-language detector on every
query — which *is* an upfront classifier. The doc corrects itself and names the design **confidence-gated
escalation**, a hybrid of upfront query-text classification (Adaptive-RAG) and post-retrieval confidence
escalation (CRAG, FLARE). Five rules:

1. **Primary signal rides the retrieved subgraph, not the query text.** The decisive factor is
   query-corpus *interaction*: graph density around the anchor. "What coffee in Nice" wants Tier 0 at 2
   coffee facts and Tier 2 at 200 across 5 trips; a verb-detector routes both identically. Escalate on
   large / low-margin (top-1 vs top-2) / multi-component result sets, using CRAG-style **two-threshold
   bands** over the already-computed flat-retrieval confidence.
2. **Lexical cues are a secondary OR-input, never the sole gate.** Pure lexical routers miss intent
   without trigger words ("how did I end up in SF?") and false-positive on incidental ones ("the coffee
   that *caused* my headache").
3. **A dedicated aggregation/negation escalation class.** "How many coffees did I drink in Nice?" has no
   causal verb and looks simple, but vectors structurally cannot count, negate, or join. Cues (how many /
   count / total / not / never / compare / most / least) must escalate even at high retrieval confidence,
   and route to a **structured-SQL path, not Tier 1** — an LLM narrating an unaggregated triple list will
   hallucinate the count.
4. **Obvious agentic verbs route directly to Tier 2.** Escalation-after-Tier-0 is *slower* than direct
   routing. Deep queries must not pay the Tier 0 tax first.
5. **Calibrate against answer quality, not escalation rate** — a router optimised for savings games the
   metric by routing everything cheap.

### 1.4 The response shape

Left as an open question but constrained: Tier 0 must return the ranked triples **plus** an explorable
subgraph the UI can render and the user can re-steer (drop an entity, widen hops, follow a predicate),
**plus the grounded constraints themselves** — e.g. the resolved time window — so a mis-grounded filter
is visible and correctable. That last clause is load-bearing: it is the mitigation for the doc's own worst
failure mode.

### 1.5 The prerequisite list — why nothing is built

§6 is a hard prerequisite list, not a caveat. "What coffee did I have in Nice last summer" is not pure
ANN search; it carries a place, a relative time window, a predicate and an object type. Three things must
exist first:

1. **A relative-date grounder** against an explicit reference time, owning a hemisphere-aware
   season→range mapping. Candidate tooling all rule-based/local so Tier 0 keeps its no-generative-LLM
   property: duckling, SUTime, HeidelTime.
2. **Place / object-type extraction** — GLiNER (zero-shot, CPU, Apache-2.0) or spaCy GPE/LOC, with the §5
   lexical routing cue folded into the same pass so routing costs zero marginal work.
3. **A structured fact-query API** taking `{asOfStart, asOfEnd, predicate, subjectId, objectEntityType}`
   as WHERE clauses, built on `facts_at_time()`.

### 1.6 The three failure modes the doc owns

- **Tier 0 can be confidently WRONG.** Vector anchoring on "Nice" + "coffee" returns high-cosine facts
  *regardless of date*. A mis-grounded window near a June boundary yields the right coffee from the wrong
  summer, ranked top, with no signal the constraint failed and no LLM to notice. Mitigation is
  structural: a tolerant filter that **demotes rather than drops**, the grounded window surfaced in the
  UI, and constraint ambiguity treated as an escalation signal.
- **Discoverability vs ownership.** *"The middle-man never summons itself"* strands users who don't know
  the deep path exists. The doc distinguishes "silently spend 10 min of agent time" (rejected) from
  "proactively *offer* the deep path when signals fire" (necessary).
- **The latency premise is unmeasured.** The whole design is motivated by latency and none of it is
  quantified — and Tier 0's own traversal is a round-trip storm, not "instant".

### 1.7 BUILT vs DESIGNED-ONLY — verified in source

**Nothing of the tiered architecture is built. Every query is Tier 2.** `POST /api/reason/query`
(`index.ts:1466`) unconditionally reaches `invokeReasoningAgent({mode:'query'})`. The pre-flight
`computeQueryFallbackEvidence` does run deterministic anchored retrieval — but only when flat retrieval
*fails*, and it **hands its evidence to the agent**; it never returns a standalone answer.

| piece | state | evidence |
|---|---|---|
| Tier 0 path | **DESIGNED-ONLY** | No endpoint returns triples; no `/api/search`, no `/api/facts/search` |
| Tier 1 single-call synthesis | **DESIGNED-ONLY** | No non-agent LLM synthesis over a subgraph anywhere |
| Tier 2 | **BUILT** | `reasoning-agent.ts`, `graph-mcp.ts`, ~50 tools, per-actor allowlists, `traceCauses`/`projectTrajectory`, `causal-patterns.ts` 1266 lines |
| Relative-date grounder | **DESIGNED-ONLY, zero code** | Repo-wide grep for duckling/SUTime/HeidelTime/GLiNER: one coincidental hit inside the LongMemEval dataset. No spaCy in requirements |
| Structured fact-query API | **DESIGNED-ONLY** | `getEntityFacts` hardcodes `NOW()`; `searchFacts` accepts only `{limit, threshold}`; `facts_at_time()` referenced only from tests |
| Confidence gate | **PARTIAL — one threshold, not two** | `flatRetrievalFailed` is a single floor, `TRIGGER_MIN_SCORE` default 0.5. CRAG bands absent |
| Lexical causal cue | **BUILT, wired elsewhere** | `hasCausalLanguage` (`causal-pass-trigger.ts:50`) is used for the *ingest* causal pass, not query routing |
| Fact vectors ("the keystone already ships") | **FALSE on the epoch path** | Column + HNSW exist; `searchFacts` filters `WHERE fact_embedding IS NOT NULL` — and see §5 |
| Predicate vectors | **BUILT since the doc — write-side only** | Doc says "not done"; stale — mig 045 added the column + HNSW. But the purpose is promote-time folding, **not read-side edge ranking**, so Tier 0 still cannot rank facts by predicate relevance |
| Chain vectors | **DESIGNED-ONLY** | `causal_patterns.pattern_embedding` exists with an HNSW index, never written or read |
| Personalized PageRank | **DESIGNED-ONLY** | `getPageranks` is used solely as a sort tie-break |
| Fact prefix decision | **doc claim VERIFIED** | `embedForQuery` is raw `ml.embed`, no prefix; prefixes are memories-only |
| Latency measurement (`nmemo-5co.1`) | **NOT DONE** | `performance.bench.ts` micro-benches DB/Qdrant/ML only; never touches `/api/reason/query` |

Line numbers in the doc (`index.ts:1078`) have drifted ~400 lines.

### 1.8 The round-trip storm is real, and worse than the doc says

`expandFromAnchors` (`graph-fallback.ts:166`) is a nested loop, not a batch:

- per anchor, **one fresh AGE Cypher walk per depth level** (`:188-194`) — the walk is re-issued at depth
  1 then depth 2 purely to recover each neighbour's first-reached hop;
- then **one `getEntityFacts()` SQL query per reachable entity, per anchor** (`:209-210`);
- then one `getPageranks` and one batched Qdrant fetch.

At the defaults (5 anchors, 2 hops) that is 10 Cypher walks plus O(anchors × reachable) sequential SQL
round-trips. **The hop-recovery re-walk is pure waste — a single walk returning depth removes half the
Cypher calls.**

### 1.9 Two silent-failure paths on the exact primitives Tier 0 would sit on

- `findConnectedEntities` wraps its walk in `catch → console.error → return []` (`graph.ts:270-273`). **A
  failed AGE traversal is indistinguishable from an empty neighbourhood.** Tier 0 would report "no
  results", not an error.
- `computeQueryFallbackEvidence` logs `fallback_skipped_no_anchor` whenever `recallViaGraph` returns
  empty — but `recallViaGraph` returns empty for **three** distinct reasons (no anchors, no expansion, no
  evidence units) and the log names only the first. **The third is the one that actually fires** — see §5.

### 1.10 More of Tier 0 exists than the doc knows

`GET /api/hero` is an inherited, fully deterministic, LLM-free graph read returning an active node,
neighbours, edges and second-degree stubs — an anchored explorable subgraph. Its prose companion
`voice-c-composer.ts` is explicitly *"NO LLM call in v1"* and emits `{text, annotations}`
deterministically. `GET /api/viz/unified` is the largest deterministic read and is corpus-scopable.

**So Tier 0's *output* half is already built twice over. What is missing is the *input* half: NL →
constraints → anchored, filtered retrieval.** That materially changes `nmemo-5co`'s shape: `.8` (response
shape) and `.11` (Tier 1) have working precedents to copy; `.2` and `.3` (fact-query API, constraint
extractor) are the genuine greenfield, and the epic's own dependency graph already makes them block `.6`.

*(Note: the iOS surface is being stripped. Extract the span-attribution pattern from
`voice-c-composer.ts` before deleting it — see the keep list §2.2.)*

---

## 2. Truth-graph docs — capability inventory

| NAME | WHERE | STATE | K/P/D | why |
|---|---|---|---|---|
| NL tiered query architecture | `truth-graph/39-natural-language-…`; epic `nmemo-5co` 0/13 | **DESIGNED-ONLY** | **KEEP — top priority** | The read path is the single-graph-optimisation lever |
| Doc 39 §7 predicate-vector row | vs `045_predicate_enrichment.sql:27` | **DOC STALE** | KEEP (fix the doc) | Says "not done"; it shipped, write-side only |
| Graph validity harness (design) | `truth-graph/39-graph-validity-harness.md` | **BUILT except D-live + one C invariant** | **KEEP** | The only correctness instrument — see §4 |
| Rich export + snapshot store | `graph-canonical-query.ts:187`, `/api/graph/full`, `scripts/{generate,load,ensure,verify}-snapshot.ts` | **BUILT** | KEEP | Reusable as a Tier 0 subgraph serialiser |
| Epoch hardening issues I1–I8 | `truth-graph/40-epoch-hardening.md` | **SUPERSEDED by doc 41** | **PARK** | I1/I2/I3 addressed by epoch-v2 E1/E4/E3. Historical value only |
| Epoch v2 propose/promote | `truth-graph/41-epoch-v2-design.md`; epic `nmemo-vpz` **7/8** | **BUILT** | **KEEP** | The production ingest path. Only `vpz.7` (retire band-aids) open |
| Epoch v2 §5 promotion = deterministic authority | `promotion.ts:354`, `:39` | **BUILT** | KEEP | Single-writer, one transaction, replayable — the right place to concentrate correctness |
| Living predicate ontology | `truth-graph/42-living-predicate-ontology.md`; epic `nmemo-213` **8/8** | **BUILT, NOT EFFECTIVE** | **KEEP — value claim retracted** | All code present. Its close gate has since been contradicted at scale |
| Doc 42's PC8 close gate | §9 "PC8 result (2026-06-20)" | **PASSED then INVALIDATED** | PARK the numbers | Reported sprawlMax 0, B7=0/B8=100%/B9=90.6%, fold *"fired strongly (reused 12–21)"*. Corpus10/20 only; `nmemo-3aq` shows the reuse statistic is a self-resolution artefact |
| Truth-graph README | `truth-graph/README.md` | **STALE by own admission** | PARK | Catalogue stops at doc 19; docs 40/41/42 unlisted |
| README Key Decision #4 "Ontology is emergent" | — | **FALSIFIED** | **DROP the decision** | Emergent ontology degenerated to 2,240 predicates / 68.7% hapax on arXiv; 338 entity types / 47.3% hapax |
| `issues/01` self-referential facts | — | BUILT (`007_no_self_reference.sql`) | DROP (closed) | — |
| `issues/02` mention_context | — | BUILT | DROP (closed) | Param exposed, threaded, persisted. **But the epoch path writes no `memory_entities` at all** |
| `issues/03` gardener fact expiry | — | SUPERSEDED by issue 6 | DROP | — |
| `issues/04` predicate explosion | — | **ADDRESSED then REGRESSED** | **KEEP as the live problem** | Doc 42's lineage ancestor. The leak it names (`normalizePredicate` returns unknown input as-is) is exactly what `nmemo-ecn` re-measured at 68.7% hapax |
| `issues/05` merge vs same-as | — | BUILT | DROP | — |
| `issues/06` reasoning agent | — | BUILT (= Tier 2) | KEEP | — |
| `prompts/phase1-implementation.md` | 155 lines | **HISTORICAL ARTEFACT** | **DROP** | A session-kickoff prompt for work long shipped |
| Structural embeddings (doc 26) | `truth-graph/26-structural-embeddings.md` | **DESIGNED-ONLY** | PARK | Repo grep for `structural_embedding` → zero hits |

### 2.1 Three findings that undercut the predicate ontology

| finding | detail |
|---|---|
| **The fold reports reuse that collapses nothing** (`nmemo-3aq`) | `reused=1810/3963` reads as 46% reuse; **1,715 of 1,722 fast-path reuses resolved a predicate onto itself.** Genuine redirects in the whole run: 4 via alias, 88 via scoring; **84 of 2,240 distinct strings eliminated** |
| **The registry has zero embeddings in the live DB** | Queried directly: `fact_predicates` = **48 rows (27 canonical / 21 rejected), 0 with an embedding**, while the mig-045 columns *are* applied. `searchPredicates` documents *"Returns [] if no predicates carry embeddings yet"* |
| **Predicate usage counters are dead on the epoch path** | `recordPredicateUsage` is called from exactly one place — inside `createFact`. `promote()` inserts facts directly and never calls `createFact`. Measured: **max `last_used_at` in the live DB is 2026-06-30**, frozen at the arc base. So the `usage_count`-driven staging→candidate→canonical lifecycle — the "growth path" `nmemo-ecn` asks for — is **unreachable from production, not merely unexercised.** Not named in `nmemo-ecn` |

---

## 3. Token usage and cost tracking

All **INHERITED** from the single base commit `4d3c0b8` (37 files, +2941/−109).

| NAME | STATE | K/P/D | note |
|---|---|---|---|
| `UsageRecord` 16-field spec | **BUILT** | KEEP | Field-for-field match to the spec; 33 pytest green |
| `llm_usage` table (30 cols, 7 idx) | **BUILT** | KEEP | Structurally identical to the doc; drift guard 4/4 green against the live DB |
| Price table + `computeCost` | **BUILT** | KEEP | 18 models (3 confirmed / 14 estimated / 1 local), `PRICING_VERSION='2026-06-16'`; cost arithmetic reconciles by hand against live rows |
| Cache 5m/1h TTL split | **BUILT and load-bearing** | KEEP | Live rows put **100% of cache writes in the 1h bucket** |
| Capture→price→persist chain | **PARTIAL — 3 of ~20 paths** | **KEEP, extend** | `agentFetch`'s type union *is* the instrumented surface: `reasoning_agent | graph_agent | gardener_agent` |
| `reconciliation_agent` usage | **HALF-WIRED** | KEEP (cheap fix) | Python echoes it; TS drops it. An "Active" operation that can never produce a row |
| `/causal-agent`, `/audit-agent`, `/arbiter-agent`, `/extract-agentic`, `/…/drift` | **DESIGNED-ONLY** | KEEP | Raw `fetch`, no echo, no rows — all live paths |
| `mlFetch` usage capture | **DESIGNED-ONLY** | PARK | Zero `usage` matches in the file; `/embed`, `/chat`, `/extract-*`, `/resolve-predicate` all silent |
| Attribution (`trace_id`/`memory_id`/`source`) | **INERT** | KEEP (cheap fix) | Accepted by the API; the sole call site passes none. NULL on all 7 live rows |
| Reporting group-bys | **PARTIAL — no runtime caller** | KEEP | Correct SQL; no `/api/usage`, no CLI, no viz panel |
| Daily budget alerts | **BUILT (inert)** | PARK | `OPERATION_DAILY_BUDGETS = {}` → every call a no-op |
| Dead enum branches | **MISLEADING** | KEEP (fix) | `token_source` is hardcoded `'provider'`, so the report's `FILTER (WHERE token_source='estimated')` can never match — `estimatedSharePct` is structurally always 0 |
| Retention / partitioning | **DESIGNED-ONLY** | PARK | The table is also absent from `CLEARABLE_TABLES`, so `/api/reset` never prunes it → unbounded |
| Gateway reconciliation, OTel exporter, streaming capture | **DESIGNED-ONLY** | DROP | §8 lists streaming as unit-verified; no streaming path and no such test exist |

**Measured: 7 real rows, all dated 2026-06-30.** graph_agent ×5 + reasoning_agent ×2, haiku-4-5.
`total_tokens` reconciles exactly on all 7. Row 1 is the dated-model-id bug caught in flight; the
suffix-strip fix landed between 13:06 and 13:11 and every later row is `priced`.

**Three things the rows prove that the docs get wrong:**

1. **The grain is not one row per LLM call.** The migration comment and the spec both say it is. Measured
   rows carry `turns` = 1…40 collapsed into one row — the real grain is **one row per agent HTTP
   invocation**. So no intra-loop model mix is visible, and the spec's "~3600 synchronous inserts per
   question" risk (and the batching that answers it) solves a problem that does not exist at this grain.
2. **Cache is 98–99% of tokens and 65–76% of cost on every row**, all in the 1h write bucket — while
   `blendedRate`/`multiplier` are **cache-blind by construction**. The routing multipliers therefore rest
   on the one dimension the measurements say is a rounding error. The doc carries the caveat; it doesn't
   say the caveat swallows the result.
3. **`README.md:26-29` says "No implementation yet."** The subsystem shipped in `4d3c0b8`.

**Nothing has been captured in two months.** Newest row in `llm_usage`, `entities`,
`extraction_reports`, `reasoning_reports` and `graph_stats` is all 2026-06-30. 140 arc commits of agent
work produced **zero** usage rows — the arc's harnesses bypass the instrumented `/ingest` → `agentFetch`
path. **The subsystem is shipped, tested, and not in use.** Automated tests: **74/74 pass.**

---

## 4. The validity harness

**What it validates.** Six dimensions: (A) ground-truth correctness vs a gold graph — fact/entity P/R,
current-state correctness for exclusive attributes, predicate sprawl; (B) per-step instrumentation;
(C) deterministic graph-integrity invariants; (D) LLM-as-judge over the graph; (E) reports review,
cross-checking agents' self-reported actions against the graph; (F) longer runs + repeats.

**Dimension C — the load-bearing part. Five invariants, all registered in `runInvariants`:**

| invariant | line | severity | check |
|---|---|---|---|
| `singleActivePerExclusiveGroup` | `:96` | **error** | ≤1 active fact per (subject, exclusive group) |
| `causalJustification` | `:143` | **error** | every causal edge has non-empty `reasoning` + `sourceReferences`; no self-loops |
| `referentialIntegrity` | `:183` | **error** | all fact/event/edge/contradiction/same_as FKs resolve |
| `objectValueNotSentence` | `:236` | warning | literal `object_value` ≤64 chars, ≤12 words |
| `orphanEntities` | `:265` | info | entities referenced by no active fact |

**Doc 39 §2.C specifies a sixth that is not implemented: "one audit row per mutation".**

Other dimensions: A → `graph-correctness.ts` (295 LOC); B → `perStep` in `metrics.json`; D →
`graph-review.ts` (467 LOC); E → `reports-review.ts` (159 LOC); F → `--repeats`.

**Is it implemented?** Yes, and it is the best-tested thing in this scope: **67 unit tests, all green**
(reports-review 7, benchmark-report 12, graph-review 13, graph-correctness 7, graph-invariants 26,
benchmark-snapshot 2), pure and DB-free by design.

**Does it run? No — nothing runs it.** No CI config anywhere in the repo. `grep -rn 'compare-ingestion'`
across the Makefile and every `package.json` and `*.yml` → **no hits**; it is invoked only by hand-typed
`npx tsx`. Its unit tests are not in the default suite. Dimension D is off by default.
`validity-harness.md:6` calls it *"the regression gate for epoch-v2"* — **it is not a gate**: no trigger,
no threshold, no failing condition wired to anything.

**Has it produced output?** Yes — 6 committed runs with manifest/metrics/report, 6 lines in
`history.jsonl`, 2 gold files. Three problems: (a) **the input corpora were never added on any branch** —
`git log --all --diff-filter=A` finds no `corpus3/10/20.json`, while the golds that grade them *are*
committed, so **not one run is reproducible**; (b) **dimension D never executed** — no `review` key in
any `metrics.json`, corroborated by the parallel-ingestion report (*"the judge has likely never actually
executed"*); (c) the committed `predicateSprawlMax: 0` in 5 of 6 runs is **buggy-version output** — the
subject-aware sprawl fix landed *after* all 6 runs.

**Verdict: KEEP.** The only correctness instrument the project has, the code is sound and tested, and the
three fixes are small: commit the corpora, put `factF1VsGold` in the report, wire one arm to a trigger.

---

## 5. The finding that matters most for single-graph optimisation

**The query problem is currently a write-path problem.** The deterministic read primitives Tier 0 would
be built from are all built, and their inputs are all empty on the production ingest path.

`runEpochBatch` → `propose()` → `promote()`. It **never calls `extract()`**. Consequences, each verified:

1. **`facts.fact_embedding` is NULL by default on the epoch path.** `promotion.ts:250` gates fact
   embedding on `config.EMBED_DESCRIPTIONS`, which defaults `false` and is not set in `.env`. The code
   comment says so outright: *"the epoch path historically left it NULL (nmemo-uhp.14), making
   epoch-minted edges invisible to vector recall."* Since `searchFacts` filters
   `WHERE fact_embedding IS NOT NULL`, **doc 39 §7's "the keystone already ships" is false on the path
   that actually ingests.**
2. **`fact_units` is never written on the epoch path.** The only writer is inside `extract()`, keyed on
   `facts.source_memory_id`. `promote()` sets no `sourceMemoryId` at all and sets
   `sourceText: f.reasoning` — the agent's reasoning, not a verbatim source span, so the span-offset
   mapping would fail even if it were called.
3. **Therefore doc 38's graph-anchored fallback retrieval silently returns nothing.**
   `expandFromAnchors` reads `factUnits`; with no rows every `ExpandedEvidence.units` is `[]`;
   `recallViaGraph` returns `[]`; and `computeQueryFallbackEvidence` logs
   **`fallback_skipped_no_anchor`** — a misleading message, since anchors *were* found. **The one
   deterministic retrieval booster that exists is fed by a table production ingest never populates, and
   it fails silently with the wrong diagnosis.**
4. **Provenance is unrecoverable** — `promote()` writes no `fact_sources` and no `memory_entities`.
   Tier 0's "show the user how the result was reached" has nothing to show.
5. **Predicate canonicalisation and the ontology growth path are both dead** on this path (§2.1).
6. **The AGE traversal index is desynchronised and has no prune path.** Measured on the live `cognitive`
   DB: **AGE holds 1,071 Entity nodes and 2,000 edges while Postgres holds 4 entities and 2 facts.**
   `clearGraphTables()` DELETEs 17 tables and `/api/reset` also clears Qdrant — **neither touches the AGE
   graph**, so ghosts accumulate monotonically across every reset. `findConnectedEntities` walks that
   stale index and returns entity_ids that no longer exist; `expandFromAnchors` then calls
   `getEntityFacts` on ghost ids and gets nothing, silently.

**If Tier 0 were built today on top of these primitives it would return empty or ghost-laden results and
report them as "no matches".** That ordering is the actionable conclusion: fix
`EMBED_DESCRIPTIONS`/`fact_units`/`source_memory_id` on the promote path, and give AGE a prune path,
**before** building `nmemo-5co.6`. The epic's own build-order gate does not cover any of this, because
doc 39 was written against the pre-epoch-v2 `extract()` path.

---

## 6. Legacy trees

| what | state | K/P/D | why |
|---|---|---|---|
| `docs/handoff/**` (13 docs, 2026-03-31 → 04-27) | **HISTORICAL** | **DROP** | All from `feat/sparse-truth-graph` / `feat/reasoning-agent`; Phase A/B completion, Frankenstein findings, MCP blockers — all resolved |
| `docs/handoff/merge-prep-cognitive-platform-v1.md` | HISTORICAL | PARK | The only one with residual value: records what must not be lost in a merge that has since happened |
| `docs/architecture/{current,v2-design,ml-services-design,multi-source-processing}.md` | **FOSSIL** | **DROP** | Describe the KARMA / pg-boss / Telegram architecture that was stripped |
| `docs/INDEX.md` | **FOSSIL** ("Last Updated: 2026-03-17") | DROP or rewrite | 5 months stale |
| `docs/design/living-ontology.md` + `-verification.md` | **SUPERSEDED** | PARK | Doc 42's cited ancestor; its "LLM verifies every merge" conclusion was explicitly replaced |
| `docs/work-packets/**` (45 packets) | **FOSSIL** | **DROP** | Work packets for the deleted architecture |
| `docs/architecture/viz-perf/bench-log.md` | **the only arc-owned doc in this scope** — BUILT + MEASURED + PASSED | **KEEP** | See §7 |

---

## 7. Benchmark status

All **INHERITED.** `git log 4d3c0b8..HEAD` over `benchmarks/`, `docs/benchmarks/`,
`platform/benchmark-results/`, `compare-ingestion.ts` and the seven harness services returns **empty** —
zero of 140 arc commits touch the benchmark programme.

| BENCHMARK | RUNNER | DATASET | RUN? | RESULT + n | TRUSTWORTHINESS |
|---|---|---|---|---|---|
| **LongMemEval** | `run.py:253` (`run_real`), `:157` (`run_dry`); `score.py:29`; `_common/judge.py:93` | **YES** — 500 q, 277 MB, **untracked** | 6 committed runs | **1 dry (n=21, synthetic) + 5 real, all n=1**: accuracy 0.000 ×4, 1.000 ×1; 3 of the 5 are pure exceptions | **Nil. No real result above n=1** |
| Corr2Cause | NONE | NO | NO | — | Plan-only (`nmemo-4fd`) |
| CLadder | NONE | NO | NO | — | Plan-only (`nmemo-9hp`) |
| LOCOMO | NONE | NO | NO | — | Plan-only (`nmemo-46r`) |
| GraphRAG-Bench | NONE | NO | NO | — | Plan-only (`nmemo-q0e`) |
| CronQA | NONE | NO | NO | — | Plan-only (`nmemo-9qq`) |
| *Validity harness* | `compare-ingestion.ts` + 7 services | Gold **YES**; **corpora never added on any branch** | **YES** — 6 runs | see §4 | Code trustworthy (67 tests); **runs irreproducible**; gold F1 undisclosed |
| *MISRA e2e* | `e2e-misra-benchmark.test.ts:272` | fixture | **NO** — live block gated on an env var, self-skips | scaffold only | Mock-tested; no live number |
| *legacy `platform/src/benchmark/`* | **DELETED** 2026-04-02 | — | — | 2 orphan HTML reports dated 2026-01-26 | **8 dead `package.json` `benchmark:*` targets** point at a deleted directory |

### 7.1 The LongMemEval number is a dry run

**The widely-cited 0.524 / 0.667 / sanity_pass=True figures match
`benchmarks/results/longmemeval/runs/2026-06-02-239263d.json` exactly. That file is a `--dry-run`
artifact.**

- `run.py:5` documents `--dry-run` as *"Synthetic mini-dataset, **no download, no Mnemo, no Sonnet**."*
- `run_dry` is the only writer of `judge_prompt_version="dry-run"`; all five other runs carry `"v1"`.
- **The numbers are constants, not measurements.** `run.py:122-135` builds 6 real types × 3 + 3
  abstention = **21** stubs. `run.py:145` assigns `score = 1.0 if idx % 2 == 0 else 0.0`. Even indices →
  11 correct → **11/21 = 0.5238**. Abstention items are indices 18/19/20 → 2 correct → **0.6667**. Every
  published digit falls out of `idx % 2`.
- `n=21` is neither questions nor sessions — 21 synthetic stubs, each one session of two turns, answer
  `"forty-two"`. Real dataset questions average ~50 sessions each.
- **Why it reads as real:** `judge_prompt_version` is written to JSON but **never rendered** by the
  markdown/dashboard generator, whose columns are Date/SHA/Cut/Model/Judge/N/Scores/Notes. The row's
  notes say *"nmemo-3f9.4 smoke"*, not "DRY RUN", and it inherits real-looking
  `model_under_test=claude-haiku-4-5` / `judge_model=claude-sonnet-4-6` from static constants present
  whether or not a model was called.
- `run.py:120`'s docstring says *"15 total"* — wrong, the code produces 21. That stale docstring is
  plausibly how a synthetic n=21 passed as a real sample size.

**`abstention_rate` is misnamed.** Per `score.py:71-75` it is *accuracy on the abstention subset*, not how
often the system declined; `score.py:39-44`'s own docstring is self-contradictory. Abstentions fold into
`overall_accuracy` on equal footing and are graded by the same generic judge prompt with no
abstention-aware instruction — intent is right, but **that path has never executed against a real
abstention item.**

**`sanity_pass=True` is not a passed check — the gate is structurally unreachable.**
`sanity_pass = abstention_rate is not None and 0.0 < abstention_rate < 1.0`. Abstention items start at
dataset index **64**; `run.py:257` samples `questions[:sample_size]`. **Any run with N ≤ 64 has zero
abstention items → `None` → False, always.** It also *punishes perfection* (30/30 correct abstentions
scores 1.0 and fails), and it gates the exit code — **all five real runs exited 1.** It has only ever
passed in the dry run, where the code engineers the pass.

**The dashboard headline is worse than the 0.524.** `results/README.md:7` shows only the latest run
(sorted desc), which is 2026-06-15 `overall_accuracy=1.000`. Its notes: *"resume window 95 (final 24 +
query)"*. Via `--resume-from` the first ~71 of ~95 windows were ingested in earlier, separately-failed
sessions. **One question, correct once, on a graph assembled across multiple interrupted sessions,
published as 1.000.**

**Why every real run is n=1.** Measured over the real dataset at `max_ingest_chars: 6000`: **~117 ingest
windows per question**. At the harness's own ~190 s/window that is ~6.2 h per question and **~129 days
serial for the full 500**. `plan.md:135` acceptance #1 is *"completes on the full 500-question cut"* and
`config.yaml:23` has `sample_size: null` — **the committed config *is* the 129-day run.** Recorded nowhere
as a blocker.

**Upstream pinning is decorative.** `plan.md:60` claims the submodule satisfies the
publish-the-harness-commit hygiene rule. The upstream harness is **never executed** — the only use of
`UPSTREAM_DIR` is shelling `git rev-parse HEAD`. Scoring is a local reimplementation, so `harness_commit`
names code that never ran and **the numbers are not comparable to published LongMemEval figures.**

### 7.2 The other results, blunt on n

| result | n | verdict |
|---|---|---|
| `parallel-ingestion-2026-06-09.md` | one corpus, one repeat per cell, **6 cells** | Best-written doc here — caveats explicit, manual judging disclosed, `model=pi` mislabel flagged. Directional, and it says so. **Two defects:** (a) **undisclosed gold F1** — the same runs recorded `factF1VsGold` = 0.211/0.200/0.182/0.190/0.140/0.154 in `history.jsonl`, and the report never mentions gold/precision/recall; root cause visible as `extraFacts` 21…62 against golds of ~8–16, i.e. **3–5× over-generation**. (b) §3.1 overstates: `singleActivePerExclusiveGroup` also passed in two other arm-orders — 3 of 11, not 1 — and one cell has no reverse arm at all, so its "PASS" is forward-only scored against two-sided cells |
| `epoch-v2-litmus.md` | **3 chunks**, one arm | Smoke test; the doc concedes it. **Its artifacts are not on this branch** — both runIds are absent from `benchmark-results/runs/` and from `git ls-files`, existing only inside a worktree. The one defensible claim is deterministic (`singleActivePerExclusiveGroup` = 0 across all three orders). The "litmus 0.42 ≈ determinism 0.44" verdict is a 2 pp gap on a **9-fact graph**, inside single-fact noise |
| `lpy_window_sweep.md` | **2 configurations**, 1 corpus, 6 gold facts | Concludes *"window_size=6000 VALIDATED"* while the data shows 6000 is **worse** on completeness (0.50 vs 0.67); the recommendation rests on cost against a pre-declared margin. "VALIDATED" is too strong — and this constant is now shared across three ingest sites |
| `yxj1_embedding_unit_sweep.md` | **8 needles** × ~7 configs | Most methodologically sound artifact (explicit answer-shape spread table). 8 needles means recall@1 moves in 0.125 steps, so 0.62 vs 0.38 is a **2-needle difference**. Directional. The sole measured basis for the nomic prefix adoption (recall@1 0.38→0.75) |
| `viz-perf/bench-log.md` (**arc-owned**) | **3 consecutive runs**, 2 workloads, 4 pre-registered bars | **The strongest measured artifact in this scope.** SVG baseline 12 FPS full / 30 default, no settle in 15 s, invariant FAIL (1314/1314 value nodes undrawn). Canvas 2D + `alphaDecay 0.035`: median 57.1/56.8/56.5 FPS full (bar ≥30), settle 3229/3294/3246 ms (bar ≤5000), default 56.8/56.8/59.9 (bar ≥50), **invariant PASS every run** (drawn == payload). Bars declared before the fix, invariant checked against the API payload rather than a post-cull set, limitations honest. **This is how the rest of the programme should look** |

**Dashboard coverage:** `docs/benchmarks/results/README.md` has **one row** (longmemeval). The epoch
litmus, the parallel-ingestion report and both sweeps are orphaned from the page `plan.md:118` designates
as *"the page we look at first."*

**`plan.md:221`** — the load-bearing Graph C reality check (*"does the causal layer lift over a no-memory
baseline"*) — has **no code and no result**. Per `landscape.md:275` that is the check on whether Graph C
is *"performance theatre"*. Unanswered.

**Port drift:** `benchmarks/README.md:51` and `_common/config.py:18` say 3000; `.env.example:5` and
`validity-harness.md:22` say **3001**. The untracked `.env` is load-bearing for every run.

---

## 8. What this survey could not determine

- **Whether the epoch-path starvation is intentional or drift.** `promotion.ts:242-245` names the
  `fact_embedding` gap as a known inconsistency and gates the fix behind a flag, but there is no doc or
  bead explaining why `EMBED_DESCRIPTIONS` defaults false, nor any bead covering
  `fact_units`/`source_memory_id` on the promote path.
- **The real live-scale numbers.** The `cognitive` DB has been idle since 2026-06-30 (2 facts, 4
  entities). The 294-doc arXiv graph is in neither visible database, so `nmemo-ecn`/`nmemo-3aq` claims
  rest on the beads; the *mechanisms* were verified in code instead.
- **Migration application state** — only 2 of the 3 migration-057-era tables probed are present in the
  live DB, so it lags the migration set.
- **Whether `abstention_rate` behaves correctly on real abstention items** — the judge path has never
  executed against one.
- **`truth-graph/33-implementation-lessons.md` (403 KB)** — not read; too large to survey usefully
  alongside the rest. May contain relevant post-mortems.
- **Doc 39's latency premise** — still entirely unmeasured. No p50/p95 for `/api/reason/query` anywhere.
  `nmemo-5co.1` remains the correct first bead.
