# 39 — Natural-Language Graph Querying Without the Middle-Man (tiered query architecture)

**Status:** Discussion / position doc (2026-06-16, hardened) — captures a design conversation, not a build spec. No bead yet. Incorporates a fleet review (code grounding + SOTA web research + adversarial critique) run 2026-06-16; claims below are grounded in the code at that date.
**Relates to:** `38-graph-anchored-fallback-retrieval.md` (the deterministic traversal this builds on), `10-reasoning-layer-overview.md` (the agent query path today), `03-graph-c-technical-design.md` (causal traversal), `06-graph-meta-layer.md` (meta-causal patterns).

---

## 1. The question that started this

> "I'd like to query the full graph — nodes, edges, chains — from natural language, fast, and give the user a feeling of ownership over their own data rather than always going through a middle-man. Right now querying requires an LLM. Could we vectorize predicates, nodes, and chains so the graph itself is searchable, instead of leaning on the model every time?"

The motivation is **latency and user experience**, not capability: the user wants fast answers and a sense of control, with the LLM summoned only when genuinely needed.

The short version of where this landed: the premise contains a wrong assumption that, once corrected, makes the problem smaller and clearer — and reframes the vectorization idea from "the unlock" to "a quality upgrade on the real unlock." But several of the *easy* parts turn out to be the hard parts, and they are flagged honestly below rather than smoothed over.

## 2. The reframe: the LLM is not translating your query

The instinct behind "vectorize the graph so we don't need the LLM" assumes the LLM is doing **text-to-query** — turning English into Cypher/SQL. If that were true, vectorizing the graph to skip the translation step would be the whole game.

It is not true here, and this is **verified against the code**. The retrieval and traversal are already deterministic and LLM-free; every Cypher query is a fixed-skeleton template with validated/clamped parameters (`src/services/graph.ts` `executeCypher` receives a hardcoded string; `query_entity_neighbours` templates `maxDepth`/`relationshipType`, never NL). Tracing the path:

- `POST /api/reason/query` (`src/index.ts` ~1057) → `invokeReasoningAgent({ mode: 'query', ... })` (`src/services/reasoning-agent.ts:60`).
- That spawns a **Claude Code subprocess** connected to a graph MCP server (`src/services/causal-agent.ts`, served via `src/services/graph-mcp.ts`).
- Inside the agent loop, every actual query the model issues is a deterministic tool call:
  - **Anchoring** — `ml.embedQuery()` (`src/services/ml-client.ts` ~179) + `findSimilarEntities()` (`src/services/entities.ts`), pgvector cosine. No LLM.
  - **Traversal** — `query_entity_neighbours` (Cypher via AGE, `src/services/graph.ts`), `trace_causes` / `project_trajectory` (recursive SQL, `src/services/causal.ts`), `recallViaGraph()` (graph-anchored fallback, `src/services/graph-fallback.ts`, doc 38).
  - **Ranking** — structural heuristics (hop-distance + pagerank centrality), with query-driven predicate weighting (`expandFromAnchors`, `src/services/graph-fallback.ts:239-245`). No ML model.

So the LLM does exactly two things in the query path:

1. **Query planning** — decides which entity to anchor on, how many hops to walk, which tools to call in what order, when to stop.
2. **Synthesis** — reads the retrieved facts/units and writes the prose report.

**There is no text-to-Cypher step to vectorize away.** The latency cost is the subprocess spawn plus the multi-turn agent loop plus synthesis — not query construction.

And keeping it that way is the right call, with evidence: text-to-Cypher is unreliable even at the frontier. GPT-4o reaches only ~60% execution accuracy on [CypherBench](https://arxiv.org/html/2412.18702v1) and ~30% on the [Neo4j Text2Cypher 2024 benchmark](https://neo4j.com/blog/developer/benchmarking-neo4j-text2cypher-dataset/); sub-10B models score under 20%. The failure modes — schema/relation hallucination, wrong edge direction, silently-wrong-but-runnable queries — are exactly what a faithful-recall memory system cannot absorb. The architecture never asks the model to emit a query, and that is a feature.

## 3. The real spectrum of queries

The two examples that bracket the range are genuinely far apart:

- **Simple retrieval** — *"What coffee did I have in Nice last summer?"* One anchor, a short walk, structured filters (place, time window, predicate).
- **Deep agentic analysis** — *"Write a report on the causal chains that led to me finding a job in San Francisco, and cross-analyse disparate parts of my memory for things that caused it without being directly related."* Backward causal-graph traversal plus meta-causal pattern surfacing plus narrative synthesis. Irreducibly agentic.

No single mechanism serves both ends. A vector index can't write the causal report; an agent loop is absurd overkill for the coffee question. So the architecture has to be **tiered**, and — the consequence that matters — something has to **decide which tier** a query belongs to.

## 4. The tiered model

> **Build status:** none of this is wired today. `POST /api/reason/query` always calls `invokeReasoningAgent({ mode: 'query' })` (`src/index.ts:1078`) — i.e. every query is Tier 2 right now. The `computeQueryFallbackEvidence` pre-flight (`src/index.ts:1073`) runs deterministic anchored retrieval but **hands its evidence to the agent**; it does not return a standalone answer. §2 describes today; §4–§7 describe future work.

```d2
direction: right

q: "NL query" { shape: oval }

t0: "Tier 0 — no agent loop\nextract constraints -> anchor -> filter -> traverse -> rank\nreturns ranked triples + subgraph" {
  style.fill: "#d4edda"
}
t1: "Tier 1 — synthesis on request\nONE LLM call over the\nalready-retrieved subgraph" {
  style.fill: "#cfe8ff"
}
t2: "Tier 2 — full agent\nplanning + algorithmic graph work\n(causal report, cross-analysis)" {
  style.fill: "#fff3cd"
}

q -> t0
t0 -> t1: "user asks to\nexplain / summarise"
t0 -> t2: "escalation signal\n(see §5)"
t1 -> t2: "still insufficient"
```

- **Tier 0 — no generative LLM, no agent loop (the default).** Extract constraints from the query, anchor on entities (the embedding path exists today), apply structured filters, walk the graph, return a **ranked list of triples plus a subgraph**. Bypasses `invokeReasoningAgent` entirely. This is the actual unlock for latency and ownership: the user gets the raw graph to explore and can see how the result was reached. (Label is "no generative LLM," not "no understanding at all" — see §6; Tier 0 still does one minimal, local constraint-extraction step, which is what every cheap SOTA system also keeps.)
- **Tier 1 — synthesis on request.** When the user wants prose, make **one** LLM call over the subgraph Tier 0 already retrieved. No agent loop, no MCP round-trips.
- **Tier 2 — full agent (rare).** The current path, kept for queries that genuinely need planning and algorithmic graph interaction — the San Francisco causal report is the canonical example. This is Graph C's showcase (`trace_causes` + meta-causal patterns, docs 03 and 06), and it *should* stay agentic.

**A cleaner framing than three discrete tiers.** [Microsoft LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/) independently arrived at this exact shape — no LLM summarization at index time, all LLM deferred to query time, scaled by a single tunable "relevance test budget" via iterative deepening, matching GraphRAG global quality at far lower query cost. Worth considering recasting the three tiers as **one effort-budget dial**: Tier 0 = budget 0, escalation = raising the budget. That preserves the ownership model (the user raises the budget) while dissolving the hard "which tier" decision §5 calls the crux.

The point is not to delete the agent. It is to stop routing the coffee question through it.

## 5. The crux: routing without re-introducing the toll booth

If a query must pass through an LLM **just to decide** that it's a simple lookup, the toll booth is back — the cheap case pays the latency we set out to remove. So routing is the unsolved design question.

An earlier draft of this doc called the answer "progressive escalation (no upfront router)." That was imprecise: it then proposed reusing a causal-language detector on every query, which **is** an upfront query-text classifier. The literature splits the options cleanly — upfront query-text classification ([Adaptive-RAG](https://arxiv.org/html/2403.14403v2)) vs post-retrieval confidence escalation ([CRAG](https://arxiv.org/abs/2401.15884); [FLARE](https://arxiv.org/pdf/2305.06983)) — and what this design actually wants is the **hybrid**, named honestly: **confidence-gated escalation**.

The mechanism, hardened against the critics:

- **Primary signal rides the retrieved subgraph, not the query text.** The decisive routing factor is query-corpus *interaction* — graph density around the anchor, not the sentence. "What coffee in Nice" needs Tier 0 if there are 2 coffee facts and Tier 2 if there are 200 across 5 trips; a verb-detector routes both identically. So escalate when the result set is large / low-margin (top-1 vs top-2 score) / multi-component (anchor fans out to >N entities or results span disconnected subgraphs). Use [CRAG](https://arxiv.org/abs/2401.15884)-style two-threshold bands (confident → Tier 0 final / ambiguous → offer escalation / low → escalate) on doc 38's already-computed flat-retrieval confidence.
- **Lexical cues are a secondary OR-input, never the sole gate.** A causal-language detector (reusing the ingest one, CLAUDE.md decision #6) catches "report/analyse/why," but pure lexical routers are brittle: they miss intent without trigger words ("how did I end up in SF?") and false-positive on incidental words ("the coffee that *caused* my headache"). Backed by the subgraph-confidence floor, neither failure is fatal.
- **A dedicated aggregation/negation escalation class.** "How many coffees did I drink in Nice?" has no causal verb, looks simple, and would route to Tier 0 — which returns ranked triples, not a count, because vectors structurally cannot count, negate, or join. Cues like "how many / count / total / not / never / compare / most / least" must escalate even at high retrieval confidence, and route to a **structured-SQL path, not Tier 1** (an LLM narrating an unaggregated triple list will hallucinate the count).
- **Obvious agentic verbs route directly to Tier 2.** A Tier 0 pass on the SF causal report is a wrong-*shaped* answer, and escalation-after-Tier-0 is *slower* than direct routing (Tier 0 + render + human-decision delay + full Tier 2). Don't make deep queries pay the Tier 0 tax first.
- **Calibrate against answer quality, not escalation rate.** A router optimised for "savings" games the metric by routing everything cheap at a quality cost. Hold out a query sample and measure correctness.

This is the part most worth getting right, and it's a product question as much as a technical one (see also discoverability, §8).

## 6. The irreducible parsing floor — and the API gap behind it

"What coffee did I have in Nice last summer" looks like pure vector search but isn't. It carries **structured constraints**: a place (Nice), a time window ("last summer", *relative to today*), a predicate (drank/had), an object type (coffee). So Tier 0 is never pure approximate-nearest-neighbour; it is **vector anchoring + structured filters** over the bi-temporal facts that already exist (`valid_at` / `invalid_at` in `001_consolidated.sql`).

This is a **hard prerequisite list**, not a caveat. Tier 0 cannot exist until three things are built:

1. **A relative-date grounder** anchored to an explicit reference time. "Last summer" must resolve against today's date, and Tier 0 must own a **hemisphere-aware** season→date-range mapping (seasons normalise to a hemisphere-agnostic code with no day-level interval). Candidate tooling, all rule-based/local so the "no generative LLM" property holds: [duckling](https://github.com/facebook/duckling) (takes an explicit `reference_time`), or [SUTime](https://nlp.stanford.edu/pubs/lrec2012-sutime.pdf)/HeidelTime for higher normalization F1.
2. **Place / object-type extraction** — [GLiNER](https://github.com/urchade/GLiNER) (zero-shot, CPU, Apache-2.0) or spaCy GPE/LOC. (The predicate slot is handled by predicate vectorization, §7, not a tagger.) Fold the §5 lexical routing cue into this same pass so routing costs zero marginal per-query work.
3. **A new structured fact-query API** — and this is the gap that bites. Even with constraints extracted, *nothing today can consume a time window*: `getEntityFacts()` hardcodes `NOW()` (`src/services/facts.ts:789, :801, :811`); `searchFacts()` has no temporal/predicate/entity-type filter (`src/services/facts.ts:822-843`). The SQL function `facts_at_time(query_time)` accepts an as-of timestamp (`001_consolidated.sql:300-310`) but the service layer never passes one. Tier 0 needs an API taking `{asOfStart, asOfEnd, predicate, subjectId, objectEntityType}` as WHERE clauses, built on `facts_at_time()`. Without it, extracted constraints have nowhere to land.

**Apply soft constraints as a tolerant filter, not a hard drop** (see the R1 risk in §8): a mis-grounded time window should *demote* off-window facts, not delete them, and the grounded window must be surfaced to the user so they can see and correct it.

## 7. Where the vectorization idea actually fits

The original instinct — vectorize predicates, triples, chains — was pointed at the wrong bottleneck (there is no translation step), but it is right as a *quality upgrade to Tier 0*. Reframed: these vectors don't make an AI smarter; they make the **user's** search land on the right edge, not just the right node. Corrected current state (an earlier draft got this table badly wrong):

| Idea | State today (verified) | Value to Tier 0 |
|---|---|---|
| **Vectorize triples / facts** | **Already implemented.** `facts.fact_embedding VECTOR(768)` (`001_consolidated.sql:239`, HNSW cosine index `:251`), populated by `createFact()` (`src/services/facts.ts:251-311`), with a working NL→fact cosine search in `searchFacts()` (`src/services/facts.ts:822-849`). | The keystone already ships. Remaining work is **wiring it into Tier 0** + prefix alignment (below), not the embedding |
| **Vectorize predicates** | Not done — `predicate` is a plain `VARCHAR` with a B-tree `predicate_index` (`001_consolidated.sql`) | Lets Tier 0 rank *edges* by relation relevance. Normalise the predicate to a phrase (`reports_to` → "reports to"), embed with the same model, **spread synonyms** — the synonym spread is the actual reason a predicate vector beats the B-tree index |
| **Vectorize chains** | **Placeholder only** — `causal_patterns.pattern_embedding` exists in `002_causal_graph.sql` but is never populated or read | Pre-embed only the bounded named causal patterns Graph C produces. For open-ended "what led to X," prefer **query-time path pruning** ([PathRAG](https://neo4j.com/blog/developer/graphrag-field-guide-rag-patterns/)) between anchored cause/effect nodes — the meaningful path set depends on the query's anchor pair, unknown at index time |

Field consensus backs promoting fact + predicate vectors from "nice-to-have" to **core Tier 0**: [GraphRAG](https://microsoft.github.io/graphrag/examples_notebooks/local_search/) embeds entities, relationships *and* text units; [LightRAG](https://arxiv.org/abs/2410.05779) makes edge embedding load-bearing and splits query keywords into low-level (specific entity) vs high-level (concept) — a good pattern for the §6 extractor; [HippoRAG 2](https://www.emergentmind.com/topics/hipporag-2) embeds passages *and* triples.

Two design notes carried from the existing system:

- **Verbalize-then-embed, not knowledge-graph embeddings.** KGE methods (TransE, RotatE, ComplEx) learn entity/relation vectors in their own trained space; an NL query cannot be embedded there without a trainable alignment layer ([ALIGNed-LLM, arXiv:2507.13411](https://arxiv.org/abs/2507.13411)). Verbalising graph elements to short strings and embedding them with the *same* model the query uses keeps query and graph in one space — the validated train-free path ([KG-RAG, arXiv:2504.08893](https://arxiv.org/html/2504.08893v1)). **The decisive argument is ingest-side, not query-side:** KGE trains globally over the whole triple set, so new facts force periodic retraining and can drift existing vectors ([continual KGE is an open problem, arXiv:2405.04453](https://arxiv.org/html/2405.04453v1)). Verbalize-then-embed is an O(1) frozen-model upsert per fact with zero coupling — which is exactly what `createFact()` already does.
- **Mind the prefixes (and don't assume).** An earlier draft assumed verbalised facts would use the `search_document:` / `search_query:` asymmetric nomic scheme. The code does the opposite *by design*: fact and entity-name embeddings use **raw `ml.embed()` with no prefix**, treated as a symmetric similarity (`src/services/ml-client.ts:64-67`); the asymmetric scheme applies only to memory window/unit text and `search_memories`. Whether to move facts to the asymmetric scheme is a real, untested change — decide it with a recall side-test, not by assumption.
- **Ranking.** `getPageranks()` is already computed in `expandFromAnchors` (`src/services/graph-fallback.ts:236`) but used only as a tie-break. Consider promoting it to a full **query-seeded Personalized PageRank** ([HippoRAG 2](https://www.marktechpost.com/2025/03/03/hipporag-2-advancing-long-term-memory-and-contextual-retrieval-in-large-language-models/): SOTA multi-hop, sub-1s, train-free, LLM-free), seeded from *both* Qdrant (source text) and pgvector (entity/fact) — mapping directly onto Mnemo's dual store. This gives Tier 0 principled multi-hop ranking it currently lacks.

## 8. What this is and isn't — and where it can hurt

- **It is** a reframe (the LLM orchestrates and narrates; it does not translate) plus a tiered query model that serves the simple end without the agent.
- **It is not** a plan to delete the reasoning agent. Tier 2 keeps it for queries that genuinely need planning and algorithmic graph work.
- **Retrieval is not querying.** Vector search returns fuzzy relevance. It cannot do aggregation, counting, negation, or exact multi-constraint joins — those need execution (structured filters in Tier 0, or the structured-SQL/agent path in §5). Vectors widen the front door; they don't answer "how many."

Three honest failure modes the design must own (an earlier draft claimed "no silent quality loss" — that was false):

- **Tier 0 can be confidently WRONG.** Vector anchoring on "Nice" + "coffee" returns high-cosine facts *regardless of date*. A mis-grounded time window ("last summer" near a June boundary is genuinely ambiguous) yields the right coffee from the *wrong summer*, ranked top, with no signal the constraint failed — and (per §6) no working temporal filter and no LLM to notice. The mitigation is structural: tolerant/widening time filter that demotes rather than drops, the grounded window surfaced in the UI, and constraint-ambiguity itself treated as an escalation signal. The honest claim is "no silent loss of *structure* — but Tier 0 can be confidently wrong when a soft constraint is mis-grounded."
- **Discoverability vs ownership.** "The middle-man never summons itself" strands users who don't know the deep path exists — a new user asking "why did I end up in San Francisco?" gets a triple list, never sees the affordance, and concludes the product can't answer causal questions. Distinguish "silently spend 10 min of agent time" (correctly rejected) from "proactively *offer* the deep path when signals fire" (necessary). Tier 0 returns instantly **and** surfaces a prominent "this looks like something I can analyse in depth — go deeper?" affordance. The user still pulls the trigger; the system must advertise it.
- **The latency premise is still unmeasured.** The whole design is motivated by latency, but the agent path, the Tier 0 target, and the extractor cost are all unquantified — and Tier 0's traversal (`expandFromAnchors`, doc 38) is a round-trip storm, not "instant": a fresh AGE Cypher walk per depth level per anchor (`graph-fallback.ts:188-194`) plus a `getEntityFacts()` query per reachable entity (`:209-210`) plus a Qdrant batch. Measure before claiming interactivity; the fanout likely needs batching.

## 9. Open questions (for whenever this becomes real work)

1. **Measure first.** Capture current `/api/reason/query` p50/p95 latency, set a Tier 0 SLO (e.g. <200ms incl. constraint extraction + batched walk), and measure the extractor's own cost. Accept that escalation-after-Tier-0 is *slower* than direct Tier-2 routing for agentic queries, so obvious agentic verbs must not default to Tier 0.
2. **The missing structured fact-query API (blocking).** Tier 0 cannot exist until there is an API accepting `{asOfStart, asOfEnd, predicate, subjectId, objectEntityType}` as WHERE clauses, built on `facts_at_time()`. Today `getEntityFacts` hardcodes `NOW()` and `searchFacts` has no filters.
3. **Constraint extractor.** Commit to rule-based/local tooling (duckling/SUTime for time, always grounded against an explicit reference timestamp; GLiNER/spaCy for place/object-type; predicate-vectorization for the predicate slot). Own a hemisphere-aware season→date-range mapping. Apply time as a tolerant widening overlap filter that demotes, never hard-drops, and surface the grounded window in the UI.
4. **Fact prefix alignment.** Facts are embedded raw/un-prefixed today (symmetric space, `ml-client.ts:64-67`). Decide — with a recall side-test, like the memories one — whether to move to the `search_query:`/`search_document:` asymmetric scheme. Define the verbalization template (`snake_case`→spaces, synonym spread) and whether it duplicates or complements entity embeddings.
5. **Routing mechanism.** Adopt confidence-gated escalation whose primary signal is computed against the retrieved subgraph (anchor fan-out, top-1/top-2 margin, component count), with the lexical causal-detector as a secondary OR-input only. Add an aggregation/counting/negation/comparison escalation class routing to structured SQL, not Tier 1. Use CRAG-style two-threshold bands on doc 38's confidence, calibrated against answer quality (not escalation rate). Consider reframing the whole thing as a single LazyGraphRAG-style effort-budget dial.
6. **Discoverability vs ownership.** Default to user-driven escalation, but proactively *offer* the deep path when signals fire, or non-experts never find it. Any optional server-side auto-escalation must be bounded to one tier per request, surfaced in the UI, and never a silent jump to the Tier 2 agent.
7. **Tier 0 ranking algorithm.** Decide whether to promote the existing pagerank tie-break (`graph-fallback.ts:236`) to a full query-seeded Personalized PageRank (HippoRAG 2), seeded from both Qdrant (source text) and pgvector (entity/fact). Train-free, sub-second.
8. **Subgraph response shape.** Define what Tier 0 returns so the UI can render an explorable graph and let the user re-steer (drop entity, widen hops, follow predicate). It must include the grounded constraints (e.g. the resolved time window) so the user can see and correct a mis-grounded filter (ties to the R1 failure mode in §8).
