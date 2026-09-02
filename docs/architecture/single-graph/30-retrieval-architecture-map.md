# 30 — Retrieval architecture map (verified 2026-09-02)

**Purpose.** An honest inventory of what retrieval machinery actually exists, what reads what, what is
*wired live* vs *experiment-only vs dead*, and what our eval can measure — the shared reference for
designing the adaptive / intent-aware layer (the MCP agent-router vision). Grounded in code at cited
`file:line` (two blind code-sweeps, 2026-09-02), **not** memory — because the mental model has drifted before
(AGE, base branch, `fact_embedding`'s readers).

**Tags:** LIVE = reachable from an HTTP route or an agent MCP tool · EXPERIMENT = built + tested, no non-test
caller · DEAD = no caller at all. And for retrieval *quality*: PROVEN / UNPROVEN / NEGATIVE (from the loop,
docs 05–29).

---

## 0. The headline: there are TWO retrieval systems, and they barely overlap

1. **The LIVE system is already agent-driven over MCP.** `/api/reason` and `/api/reason/query`
   (`index.ts:1417,1494`) hand off to a reasoning agent (`reasoning-agent.ts:64`) that calls an MCP tool
   surface (`graph-mcp.ts`, `GRAPH_TOOLS` in `causal-agent.ts:95`, dispatched by `handleToolCall`
   `causal-agent.ts:1649`). The tools read name-vectors, Qdrant text, the `public.facts` traversal, and
   Graph C causal history. **The "AI through an MCP doing different graph searches" vision already exists in
   skeleton.**
2. **The EXPERIMENT system is where our validated science lives — and none of it is wired.** The two-signal
   fusion `recallEntitiesFused` (`retrieval.ts:94`, bead nmemo-u8j.1, the one PROVEN lever), the
   `fact_embedding` reader chain, and the element/concept cosine layer are all built + tested but **have no
   live caller.**

**The gap that matters:** our experiments validated path (2); the running system is path (1), which uses
*different, mostly corpus-unscoped* retrieval and **does not include the one lever we proved works.** Closing
that gap — exposing the validated fusion as an MCP tool — is both "make the proven thing real" and the first
concrete step of the adaptive-retrieval vision (each validated strategy = one MCP tool the agent can pick).

---

## 1. Substrate inventory

| # | Substrate | Column / store | Corpus-part.? | Populated by | Read by (status) | Retrieval quality |
|---|---|---|---|---|---|---|
| 1 | **Entity name/desc vectors** | `entities.embedding` VECTOR(768), HNSW cosine (`001_consolidated.sql:57`) | YES (`corpus_id`, mig 052) | `createEntity` (`entities.ts:280`), `applyPromotion` (`promotion.ts:282`); **NAME only by default** — `EMBED_DESCRIPTIONS` off (`config.ts:36`, `embed-text.ts:31-55`) | `findSimilarEntities` (`entities.ts:362`) **LIVE**; `recallCrossCorpusCandidates` (`audit-pass.ts:82`) **LIVE** (/api/audit); fusion (`retrieval.ts:115`) EXPERIMENT | name-only PROVEN as the fusion's strong leg; desc-in-vector NEGATIVE/borderline (doc 05/07) |
| 2 | **Fact vectors** | `facts.fact_embedding` VECTOR(768), HNSW (`001_consolidated.sql:239`) | YES | `createFact` (`facts.ts:361`), `applyPromotion` **unconditional now** (`promotion.ts:286`) — *config comment stale* | ONLY `searchFactsByVector`→`searchFacts`→`recallEntitiesByFactSimilarity`→`recallEntitiesFused` — **all EXPERIMENT-ONLY** | PROVEN as the fusion's *second* signal (R4) — but **not on any live path** |
| 3 | **`public.facts` traversal** | recursive CTE, `traverseFromEntities` (`graph.ts:101`) | optional, **defaults ALL corpora** (`graph.ts:115`) | (reads existing facts) | `expandFromAnchors`→`recallViaGraph` (`graph-fallback.ts:194,466`) **LIVE**; neighbourhood/subgraph | NEGATIVE as a *fused recall augmentation* (doc 22, .6); untested as a standalone relational tool |
| 4 | **Graph C causal** | `causal_events` (`event_embedding` 768, has `corpus_id`) + `causal_edges` (**NO `corpus_id`**) | events YES / **edges NO** | causal pass → `staging_causal_edges` → `createCausalEdge` (`causal.ts:224`); gated `DISABLE_CAUSAL_PASS` | `getEntityCausalHistory` (`causal.ts:1070`) + causal agent tools **LIVE** (cross-corpus) | **never evaluated for retrieval** (bead .7); arxiv has zero causal layer (doc 28) |
| 5a | **Element/concept cosine** | `element_embeddings` VECTOR(768) (mig 053) | YES | `upsert*Element` (`element-catalogs.ts:126`) — no live writer | `recallAcrossCorpus`/`recallByConcept` (`element-catalogs.ts:215,269`) **EXPERIMENT** | superseded by #1 for cross-corpus; concept layer NEGATIVE for retrieval (docs 28–32 cross-corpus) |
| 5b | **Bridge edges** | `bridge_edges` (`source/target_corpus_id`) (mig 054) | via endpoint corpora | /api/audit → `propose_bridge_edge` → `applyBridgePromotion` **LIVE** | `recallConceptCandidates` (`audit-pass.ts:143`) **LIVE** (augments audit cosine) | cross-corpus audit only, not the query path |
| 5c | **Community structure** | `entity_topology.community_id` (mig 014) | — | ml-services `/topology/compute` (proxied `index.ts:1738`) | `getTopologySnapshot`→/api/topology **LIVE but VIZ-ONLY** — no retrieval reader | NEGATIVE as a retrieval signal, held-out (doc 29, .8) |
| 6 | **Lexical / name** | `pg_trgm` GIN on `canonical_name` (`001_consolidated.sql:66`); no BM25/tsvector | — | — | in-memory `ILIKE` `findEntitiesByName` (`entities.ts:355`) = ingest-fallback only; BM25 is **eval-only** (`fusion.ts:5`, test tools) | name-presence is ~80% of the eval's signal (doc 27 meta); BM25 tied name-only (doc 15/17) |
| 7 | **Qdrant text** | one `memories` collection, 768, `point_type` window+unit (`qdrant.ts:104`) | via optional `stream_id` (unused live) | ingest `storeMemoryWithUnits` (`pipeline.ts`) | `searchMemoriesByUnit` (`qdrant.ts:199`), `getMemory`, `fact_units`→Qdrant in `recallViaGraph` **LIVE** | the raw-text recall leg of the live agent path; not in our entity-target eval |

Everything except Qdrant text lives in **pgvector** (entities, facts, predicates, elements, causal events,
patterns, cluster centroids).

## 2. Live read-path chains (what the running system actually does)

- **`POST /api/reason`** → reasoning agent (patrol) → MCP tools only (no server-side retrieval).
- **`POST /api/reason/query`** → server pre-flight: `searchMemoriesByUnit` (Qdrant) → gate
  `flatRetrievalFailed` → `findSimilarEntities` (name-vec) → `recallViaGraph` (facts traversal + `fact_units`
  →Qdrant); then the reasoning agent (query mode) with that evidence, calling the same MCP tools.
- **MCP retrieval tools** (`causal-agent.ts` dispatch): `search_memories`(Qdrant), `search_similar_entities`
  (name-vec), `recall_via_graph`(Qdrant+facts), `query_entity_facts`/`query_entity_neighbours`/
  `get_neighbourhood_profile`(facts), `get_memory_text`(Qdrant), `search_predicates`(pred-emb),
  `resolve_anchor`(name-vec+facts), and causal tools `trace_causes`/`get_causal_history`/`get_causal_delta`/
  `project_trajectory`/`find_causal_ghosts`(Graph C).
- **`POST /api/audit`** → `runAuditPass` → `recallCrossCorpusCandidates` (entities.embedding cross-corpus) +
  `recallConceptCandidates` (bridge JOIN). The live cross-corpus recall.

**Corpus-scoping is broken on the live query path** (nmemo-4h3 / -81k, verified): Qdrant search carries no
corpus predicate; `findSimilarEntities` live callers silently pin to `'default'`; `traverseFromEntities`
defaults to **all** corpora and every live caller omits `corpusId`. The **only** corpus-correct query
function is the unwired `recallEntitiesFused`.

## 3. Eval capability layer (what we can currently measure)

The `retrieval-eval` engine (`test/tools/retrieval-eval/*`) expresses exactly **one query type**:
*entity-target-finding* — a paper's title+abstract is the query, the target is a recurring entity, scored by
R@k under two oracles (strict = the specific target's rank; condensed = relevant-set). It does **NOT** express:
global/thematic queries, relational/multi-hop queries, causal queries, or **real (non-document) question
queries** — and doc 27's meta-finding is that ~80% of its targets appear verbatim in the query, so it is
substantially a *name-presence* task. **This is the binding constraint of the whole loop: we can only
validate strategies for the one query type the harness can express.** New intents need new oracles first.

## 4. Proven / unproven / negative (retrieval quality, from the loop)

- **PROVEN:** two-signal fusion `RRF-60(name-vec, fact-vec)` (+0.0724 strict R@10, R4) — degree-gated (doc
  24). A stronger embedder (bge-m3) lifts it (+0.093 condensed, doc 25 — pending as the `.12` migration).
- **NEGATIVE (measured):** cross-encoder rerank (name-in-query artifact, doc 27); community-structure routing
  (leak; held-out −0.062, doc 29); facts-traversal as fused augmentation (doc 22); concept/element layer for
  cross-corpus retrieval (docs 28–32); single-substrate arms incl. BM25-hybrid (docs 05–17).
- **UNPROVEN / untested in its home regime:** Graph C causal retrieval (.7 — never evaluated); community
  summaries on *global* queries (never tested on the query type they target); real-question retrieval (no
  oracle).

## 5. Seams for an adaptive / intent-aware layer

The seam already exists: the **MCP tool surface** (`GRAPH_TOOLS`, `allowlistFor(actor)`
`causal-agent.ts:1604`). An adaptive system is "one validated strategy = one MCP tool; the agent selects."
So the concrete moves, in order:
1. **Wire the proven fusion in.** Add `recallEntitiesFused` (corpus-correct) as an MCP tool + fix the live
   corpus-scoping (nmemo-4h3/-81k). This makes the running system use the one thing we proved, and is the
   smallest real step toward the vision. (No new science needed — it's already validated.)
2. **Give each future strategy an eval in its home regime BEFORE exposing it as a tool** (§3 is the blocker):
   a global-query oracle for community summaries, a relational/causal oracle for Graph C, a real-question
   set so retrieval isn't graded on name-presence.
3. **Composition/routing is last** — the agent's tool-selection is the router; only meaningful once ≥2 tools
   are validated in-regime.

## 6. Live data traps (verified where possible)
- AGE **retired** from the read path — `graph.ts` uses a `public.facts` CTE (confirmed).
- Migration 058 `hnsw.iterative_scan=strict_order` is **required** for correct filtered vector search
  (confirmed; asserted by `startup-validation.ts`) — every filtered reader depends on it.
- `fact_embedding` epoch write is **unconditional** now; the `config.ts:27-36` comment saying it's gated on
  `EMBED_DESCRIPTIONS` is **stale**.
- `facts.source_memory_id` NULL and `fact_units` empty hold for **epoch-ingested** corpora (serial ingest
  populates both); data-state, not structural — verify per corpus.
- `index.ts` has NUL bytes → ripgrep skips it; use `grep -a`.

## 7. One-line net
The system already has an agent-driven MCP retrieval skeleton and all the substrates an adaptive layer would
need — but the one retrieval strategy we've *proven* isn't wired into it, the live path's corpus scoping is
broken, and we can only *measure* one of the several query types the vision requires. Fix the wiring + build
the missing per-intent oracles, and the adaptive layer is a small step, not a rebuild.
