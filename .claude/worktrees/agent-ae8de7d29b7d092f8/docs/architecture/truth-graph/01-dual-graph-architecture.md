# Dual-Graph Architecture — Technical Conceptual Design

**Status:** Design (build Graph C after Graph S hardening)
**Depends on:** [Graph S Hardening](02-graph-s-hardening.md)
**Research basis:** [Position Paper](00-position-paper.md)

---

## 1. System Overview

The knowledge system maintains two co-existing, independently queryable graph structures:

**Graph S (State Graph)** — A temporal knowledge graph where nodes are entities (people, places, concepts, behaviours) and edges are relationships between them, each carrying a bi-temporal validity window. Graph S answers: *What was the configuration of entities and relationships at time T?*

**Graph C (Causal Graph)** — A directed graph where nodes are **state transitions** (changes in Graph S) and edges are **causal links** between those transitions. Graph C answers: *What caused this state to change? What downstream consequences are likely?*

```
                    Graph S (State Graph)
                    ┌──────────────────────────┐
                    │  Entities ──edges──▶ Entities  │
                    │  [valid_at ... invalid_at]     │
                    │  [created_at ... expired_at]   │
                    └──────────────┬───────────────┘
                                   │
                         state transitions
                         (edges created,
                          strengthened,
                          weakened, expired)
                                   │
                    ┌──────────────▼───────────────┐
                    │  Graph C (Causal Graph)           │
                    │  Transitions ──causes──▶ Transitions │
                    │  [strength, pathway, delay]        │
                    │  [provenance, confidence]           │
                    └──────────────────────────────────┘
```

**The perpendicularity principle:** Graph C is not embedded within Graph S. It is a separate index. The nodes of Graph C are not entities — they are events (transitions in Graph S). A causal edge in Graph C connects two events: "the appearance of edge X in Graph S caused the strengthening of edge Y in Graph S three days later."

This separation means:
- **Backward traversal** (causal tracing) walks Graph C directly, without reconstructing temporal snapshots from Graph S
- **Forward traversal** (trajectory projection) walks Graph C in the forward direction
- **Graph S and Graph C can be queried independently or jointly**

### Relationship to Existing Architecture

The dual-graph model extends the existing Two-Layer Architecture (v2-design.md):

| Layer | Current | With Dual-Graph |
|-------|---------|-----------------|
| **Truth Machine (Layer 1)** | Enrichment chain → Brain Step → Events | Same, plus Graph C updated with causal edges after each transition |
| **Interpretation Layer (Layer 2)** | Consumes events, runs workflows | Consumes events enriched with causal context and trajectory projections |
| **KARMA Agents** | 7 agents processing entity/relationship/schema/conflict | Same agents, plus new `causal-extraction` agent and enhanced `conflict-resolution` with causal context |

---

## 2. Graph S (State Graph) — Current Implementation

Graph S is substantially built. This section documents what exists and what's being fixed.

### 2.1 Bi-Temporal Fact Model

Every fact carries four timestamps following the Graphiti research pattern:

| Timestamp | Timeline | Meaning |
|-----------|----------|---------|
| `valid_at` | Event | When the fact became true in reality |
| `invalid_at` | Event | When it stopped being true (NULL = ongoing) |
| `created_at` | Transaction | When the system recorded it |
| `expired_at` | Transaction | When the system learned it was wrong (NULL = believed correct) |

This enables point-in-time queries on both timelines:
- "What was true at time T?" → filter on `valid_at <= T AND (invalid_at IS NULL OR invalid_at > T)`
- "What did we believe at time T'?" → filter on `created_at <= T' AND (expired_at IS NULL OR expired_at > T')`

```d2
direction: right

event_time: "Event Timeline\n(reality)" {
  style.fill: "#d4edda"
  style.opacity: 0.4
  valid: "valid_at\n(became true)"
  invalid: "invalid_at\n(ceased to be true)"
  valid -> invalid: "fact is true\nduring this window"
}

tx_time: "Transaction Timeline\n(our knowledge)" {
  style.fill: "#e8f4fd"
  style.opacity: 0.4
  created: "created_at\n(we recorded it)"
  expired: "expired_at\n(we learned it was wrong)"
  created -> expired: "we believed it\nduring this window"
}

example: "Example: 'John works at Acme'" {
  style.fill: "#fff3cd"
  style.opacity: 0.4
  e1: "valid_at = 2024-01-15\n(John started at Acme)"
  e2: "invalid_at = 2024-09-01\n(John left Acme)"
  e3: "created_at = 2024-02-01\n(we learned about it)"
  e4: "expired_at = NULL\n(we still believe this record is correct)"
}
```

**Implementation:** `platform/src/db/migrations/004_facts.sql`, `platform/src/services/facts.ts`

### 2.2 Entity Model

Entities are canonical nodes with:
- **Canonical name** and **entity type** (dynamically managed via `entity_types` table)
- **Embedding** (768-dim, nomic-embed-text via pgvector HNSW index)
- **Aliases** (accumulated variant mentions: abbreviations, nicknames, typos, merged names)
- **Merge tracking** (`merged_from` UUID array, `entity_merges` audit trail)
- **Temporal tracking** (`first_seen_at`, `last_seen_at`)

**Resolution pipeline** (three-stage):

```d2
direction: down

mention: "New mention arrives\n'the old man'" {
  shape: document
}

embed: "1. Generate embedding\nmention + context window (200 chars)" {
  shape: step
}

search: "2. pgvector cosine search\nfindSimilarEntities(embedding,\nthreshold=0.75, limit=10)" {
  shape: step
}

high: "> 0.92 similarity" {
  shape: diamond
  style.fill: "#d4edda"
  style.opacity: 0.4
}

medium: "0.75 — 0.92 similarity" {
  shape: diamond
  style.fill: "#fff3cd"
  style.opacity: 0.4
}

low: "< 0.75 similarity\n(no candidates)" {
  shape: diamond
  style.fill: "#f8d7da"
  style.opacity: 0.4
}

merge: "Auto-merge\nAdd alias, update last_seen\nReturn existing entity ID" {
  shape: step
  style.fill: "#d4edda"
  style.opacity: 0.4
}

llm: "LLM verification\n(TODO: ML service decides\nMERGE | LINK | CREATE)" {
  shape: step
  style.fill: "#fff3cd"
  style.opacity: 0.4
}

create: "Create new entity\nGenerate embedding\nconfidence = 0.8" {
  shape: step
  style.fill: "#f8d7da"
  style.opacity: 0.4
}

mention -> embed
embed -> search
search -> high
search -> medium
search -> low
high -> merge
medium -> llm
low -> create
```

**Implementation:** `platform/src/services/entities.ts`, `platform/src/db/migrations/003_entities.sql`
**Bugs being fixed:** See [Graph S Hardening](02-graph-s-hardening.md) — entity dedup, context windowing, concurrency protection

### 2.3 Predicate Ontology

69 canonical predicates across 7 categories (professional, personal, location, education, creation, skills, events). Each predicate carries:
- Inverse pair registration (e.g., `manages` ↔ `reports_to`)
- Exclusivity flag (if true, only one active per subject+predicate, e.g., `works_at`)
- Alias mappings (tense variants normalised: `worked_at` → `works_at` + temporal metadata)
- Staging lifecycle: `staging → candidate → provisional → canonical` (or `rejected`)

**Implementation:** `platform/src/services/predicates.ts`, `platform/src/db/migrations/025_predicate_staging.sql`
**Design:** `docs/design/living-ontology.md`

### 2.4 Apache AGE Graph Projection

Entities and facts are automatically synced to an Apache AGE property graph (`knowledge_graph`) via PostgreSQL triggers:
- `sync_entity_to_graph()` — MERGE entity nodes on CREATE/UPDATE
- `trigger_sync_fact()` — MERGE relationship edges on fact creation (non-expired only)

Graph queries available: subgraph extraction, neighbour discovery, path finding (max depth configurable), edge listing, degree calculation.

**Implementation:** `platform/src/db/migrations/005_apache_age.sql`, `platform/src/services/graph.ts`

### 2.5 Hybrid Search

Reciprocal Rank Fusion (RRF) combining three signals:
- **Vector search** (Qdrant, weight 1.0) — cosine similarity on memory embeddings
- **Graph search** (Apache AGE, weight 0.8) — entity neighbourhood traversal
- **Keyword search** (Qdrant payload filter, weight 0.6) — text matching

**Implementation:** `platform/src/services/hybrid-search.ts`

---

## 3. Graph C (Causal Graph) — Design

### 3.1 What Graph C Contains

Graph C's nodes are **not** entities. They are **state transitions** — discrete changes in Graph S. A state transition is:
- A fact being created (new relationship established)
- A fact being strengthened (confidence increased, new corroborating evidence)
- A fact being weakened (contradicting evidence, confidence decreased)
- A fact being expired (superseded by new information)
- A fact being invalidated (ceased to be true in reality)

Graph C's edges are **causal links** between transitions. A causal edge says: "Transition A caused Transition B."

### 3.2 Causal Edge Properties

Each causal edge carries:

| Property | Type | Purpose |
|----------|------|---------|
| **strength** | float (0-1) | Confidence that A caused B |
| **reasoning** | text (required) | Detailed LLM justification for the causal assertion. Must explain why the agent believes cause led to effect. Every edge is auditable. |
| **source_references** | JSONB (required) | Structured list of every source that informed the conclusion: `[{type: 'memory'\|'fact'\|'entity', id: UUID, relevance: text}]`. Full traceability at every level. |
| **pathway** | reference[] | Mediator transitions between cause and effect |
| **temporal_span** | interval | Delay between cause and effect |
| **extraction_method** | enum | `llm` (Haiku agentic reasoning) |
| **source_memory_id** | UUID | The memory whose ingest triggered this edge |
| **corroboration_count** | integer | How many independent sources support this link |
| **last_corroborated** | timestamp | When the link was last supported by new evidence |

The reasoning and source references are **non-negotiable requirements**. Every causal edge must be traceable back to the specific memories, facts, and entities that the agent used to reach its conclusion. This enables revision of causal chains as new information arrives, debugging of false positives, and confidence assessment of the graph.

### 3.3 Causal Extraction — Agentic Reasoning

Causal edges are created by an **agentic LLM** (Claude Code via `-p` with MCP tools). The agent does not simply parse the current text for causal language — it actively queries Graph S, Qdrant, and Graph C to build its own context before asserting any causal links.

**Trigger:** The agent runs after entity/relationship extraction completes, whenever there are Graph S changes (new entities, new or modified facts). Changes from a single input are batched together.

**Agent tools (7 total):**
1. `query_entity_facts` — Get all active facts for an entity from Graph S
2. `query_entity_neighbours` — Traverse the knowledge graph (AGE) for connected entities
3. `search_similar_entities` — Semantic similarity search over entities (pgvector)
4. `search_memories` — Semantic search over source texts in Qdrant
5. `get_memory_text` — Retrieve a specific source text by ID
6. `get_causal_history` — Get existing causal chains from Graph C
7. `create_causal_edge` — Assert a causal link with reasoning + source references

**Agent reasoning process:**
1. Examine what changed in Graph S (the delta from this ingest)
2. Use tools to gather context — related entities, historical facts, past source texts, existing causal chains
3. Reason about causality considering: explicit causal language, temporal patterns across the history, existing chain extensions, indirect causes
4. Assert causal edges only when confident, with detailed reasoning and complete source traceability
5. Do not hallucinate — if uncertain, do not create an edge. More data will arrive.

This agentic approach means the system can discover causality that is never explicitly stated. If a user mentions sleeping badly this week, and the graph shows they started a new job two weeks ago, and a past memory says "I always sleep badly when stressed about work", the agent can connect these across time and across inputs — something a simple text parser cannot do.

Deterministic causal patterns (regex-based extraction of "because", "led to", etc.) will become apparent as we build the graphs out, but the LLM-first approach ensures we capture the full richness of implicit causality from the start.

### 3.4 Meta-Causal Patterns

Over time, recurring causal chains crystallise into named pathway types — **meta-causal archetypes**. These are first-class objects in Graph C's own emergent ontology.

**Example patterns** (illustrative, not predefined — these emerge from data):

| Pattern | Structure | Meaning |
|---------|-----------|---------|
| Ruminative Loop | A → B → C → A | Circular causation that reinforces itself |
| Cascade | A → B → C → D | Linear chain of downstream effects |
| Convergent Cause | A → C, B → C | Multiple independent causes producing one effect |
| Divergent Effect | A → B, A → C | Single cause producing multiple effects |

Patterns are detected by subgraph matching in Graph C, promoted through a staging lifecycle identical to predicate staging (frequency threshold → probation → canonical), and named by LLM classification once stable. They become queryable: "How often does pattern X fire? Has its frequency changed?"

### 3.5 Graph C in Apache AGE

Graph C lives in a **separate** AGE graph (`causal_graph`) alongside Graph S's `knowledge_graph`. Both graphs share the same PostgreSQL instance but have independent node/edge sets.

This separation is deliberate:
- Different query patterns (Graph S: entity neighbourhood. Graph C: causal chain traversal)
- Different node types (Graph S: entities. Graph C: transitions)
- Independent evolution (Graph C is eventually consistent with Graph S, not synchronous)
- Different index requirements (Graph C benefits from temporal indexing on causal edges)

Cross-graph queries are possible via SQL joins — a causal edge in `causal_graph` references a fact ID from the `facts` table, which is also synced to `knowledge_graph`.

---

## 4. Emergent Ontology System

### 4.1 The Convergence Principle

Neither Graph S nor Graph C operates on a predefined ontology. Entity types, predicate categories, and causal pathway types emerge from the data through a schema-generative process:

1. **Open extraction:** The LLM extracts raw triples freely from each input
2. **Canonicalisation:** Each new entity, predicate, or causal pattern is compared against the existing graph's semantic vector space. If a sufficiently close match exists, merge. If not, create.
3. **Convergence:** Over time, repeated patterns stabilise the vocabulary. The richer the graph, the harder it becomes to create duplicates — the matching surface grows with every extraction round.

**Critical property:** More data means more constraint, not more mess. This is the opposite of naive extraction, where more data means more noise.

### 4.2 Three-Layer Predicate Intelligence

From `docs/design/living-ontology.md`, benchmarked and validated:

```d2
direction: down

input: "New predicate:\n'employed_at'" {
  shape: document
}

layer1: "Layer 1 — Structural\n(deterministic, zero cost)" {
  style.fill: "#d4edda"
  style.opacity: 0.4
  l: "Lemmatise → 'employ_at'\nTense check → maps to 'works_at'?\nInverse check → is it an inverse?\nString normalise → case, whitespace"
}

layer2: "Layer 2 — Embedding\n(vector signals)" {
  style.fill: "#fff3cd"
  style.opacity: 0.4
  l: "Enriched description embedding\nMean-centering (anisotropy fix)\nCosine similarity vs all canonicals\n≥0.905 → auto-merge\n<0.848 → clearly distinct\n0.848–0.905 → review zone"
}

layer3: "Layer 3 — LLM Gate\n(expensive verification)" {
  style.fill: "#e8f4fd"
  style.opacity: 0.4
  l: "LLM verifies merge candidates\nBatch: 3-5 per call\nPrevents over-generalisation\n(avoids the CESI problem)"
}

merge: "Merge into canonical\n(add as alias)" {
  shape: step
  style.fill: "#d4edda"
  style.opacity: 0.4
}

promote: "Promote as novel\n(staging → provisional → canonical)" {
  shape: step
  style.fill: "#cce5ff"
  style.opacity: 0.4
}

input -> layer1: "always runs"
layer1 -> layer2: "not resolved\nstructurally"
layer2 -> layer3: "in review zone\n(0.848–0.905)"
layer2 -> merge: "≥0.905"
layer2 -> promote: "<0.848"
layer3 -> merge: "LLM says merge"
layer3 -> promote: "LLM says distinct"
layer1 -> merge: "alias/tense match"
```

**Layer 1 — Structural (deterministic, zero cost):**
- Lemmatisation (e.g., "employs" → "employ")
- Tense → temporal metadata mapping (e.g., `worked_at` → `works_at` + `invalid_at = NOW()`)
- Inverse registry lookup
- String normalisation (whitespace, case)

**Layer 2 — Embedding (vector signals):**
- Enriched description embeddings (not raw labels — "The relationship 'works_at' describes employment...")
- Mean-centering to fix anisotropy
- HAC clustering with complete linkage
- Two-threshold zones: ≥0.905 (auto-merge), <0.848 (distinct), 0.848–0.905 (LLM review)

**Layer 3 — LLM Gate (expensive verification):**
- LLM verifies ALL merge candidates (not just ambiguous)
- Batch review: 3-5 candidates per call
- Prevents over-generalisation (the CESI problem: merging "place of death" with "place of birth")

### 4.3 Entity Type Evolution

Entity types follow the same staging lifecycle as predicates:
- Dynamic `entity_types` table (migration 024) with `canonical`/`provisional`/`deprecated` status
- `entity_type_history` for bi-temporal typing (an entity's type can change over time)
- Cache invalidation on promotion (1-minute TTL for extraction agents)

### 4.4 Graph C's Emergent Vocabulary

Graph C develops its own emergent ontology of causal pathway types, using the **identical** mechanism:
1. Causal chains are extracted freely
2. Recurring patterns are detected and clustered
3. Clusters that meet a frequency threshold enter staging
4. LLM names and classifies stable patterns
5. Canonical patterns become queryable first-class objects

This means the system doesn't need a predefined taxonomy of causal patterns. The patterns that matter emerge from the data — "avoidance cascade", "confidence spiral", "external trigger chain" — named by what they actually represent in the user's experience.

---

## 5. Semantic Vector Alignment

### 5.1 Entity Resolution (Current)

The three-stage pipeline for entity resolution (embedding blocking → similarity scoring → LLM verification) is the core mechanism for preventing entity explosion. Each entity carries a 768-dim embedding enriched by its name, type, description, and accumulated context.

When a new mention arrives:
- Generate embedding for `mention + context_window`
- Find candidates via pgvector HNSW index (cosine similarity >0.75)
- Apply threshold-based decision (>0.92 auto-merge, 0.75-0.92 LLM verify, <0.75 create new)
- If merged: add alias, update `last_seen_at`, return existing ID
- If new: create entity, generate embedding, return new ID

### 5.2 Cross-Epoch Alignment

At lifetime scale, the person at age 25 and the person at age 55 are effectively **different graphs** sharing a label. The dominant entity types, relationship categories, and conceptual vocabulary may shift dramatically between life epochs (career phase → parenting phase → retirement phase). Structural graph matching fails because the topology is fundamentally different.

**The insight:** Cross-epoch alignment and cross-client alignment are the **same problem**. Both require resolving entities across graphs with different structure but shared semantic meaning.

**The mechanism:** Alignment is resolved through the **semantic base** of each node — its embedding enriched by:
- Type tags (emergent, not predefined)
- Accumulated extraction context (the raw text from which it was derived)
- Relational metadata (what kinds of edges connect to it)
- Temporal metadata (when it was most active, how it has evolved)

Two entities from different epochs resolve as equivalent if their semantic vectors are sufficiently proximate, regardless of local graph topology. "Career" at 25 (connected to Ambition, Proving Myself) and "Career" at 55 (connected to Legacy, Meaning) share a semantic core despite divergent structural neighbourhoods.

### 5.3 Implications for Graph C

The causal graph inherits semantic vector alignment from Graph S. A causal chain that begins in one life epoch and terminates in another (e.g., formative experiences causing adult patterns) can be traced through Graph C even when the entities at each end live in semantically distant regions of Graph S. The causal graph provides the bridge that structural alignment cannot.

---

## 6. Lifetime-Scale Considerations

### 6.1 Hierarchical Temporal Abstraction

At lifetime scale, querying Graph S at full resolution is computationally expensive and semantically noisy. The system needs variable-resolution access:

| Resolution | Timespan | What's Preserved | What's Compressed |
|------------|----------|-------------------|-------------------|
| **Fine** | Days/weeks | Full state graph, all edges, all validity windows | Nothing — full fidelity |
| **Medium** | Months/quarters | Consolidated summary nodes replace clusters. Key edges + aggregate strengths preserved | Daily fluctuations, transient entities |
| **Coarse** | Years/epochs | Life-chapter summaries. Dominant entity clusters, major causal chains, ontological regime shifts | Everything below the causal significance threshold |

```d2
direction: down

fine: "Fine Resolution\n(days / weeks)" {
  style.fill: "#f8d7da"
  style.opacity: 0.4
  l: "Full state graph\nAll edges + validity windows\nAll causal events + edges\nRecent history"
}

medium: "Medium Resolution\n(months / quarters)" {
  style.fill: "#fff3cd"
  style.opacity: 0.4
  l: "Summary nodes replace clusters\nKey edges + aggregate strengths\nDaily fluctuations compressed\nCausal chains preserved"
}

coarse: "Coarse Resolution\n(years / epochs)" {
  style.fill: "#d4edda"
  style.opacity: 0.4
  l: "Life-chapter summaries\nDominant entity clusters\nMajor causal chains only\nOntological regime shifts"
}

fine -> medium: "compress\n(non-causal\nevents dropped)"
medium -> coarse: "compress\n(only causally\nsignificant chains)"
```

**Key principle:** Graph C provides the scaffolding for compression. Causally significant transitions — the ones that drove actual state changes — are preserved at all resolutions. Transitions with no downstream causal effect are what gets compressed away.

**Causality determines what is signal and what is noise in temporal compaction.**

### 6.2 Epoch Detection

Life epochs are not predefined — they're detected by the system as **regime changes** in the graph:
- Sudden appearance of new entity clusters (new job, new relationship, new city)
- Rapid ontological shift (new entity types, new predicate categories)
- Change in causal pattern frequency (existing patterns stop firing, new ones appear)

Epoch boundaries become first-class objects in the system — they're the seams where hierarchical abstraction transitions between resolution levels.

### 6.3 Identity Continuity

The convergent ontology handles gradual entity evolution naturally — aliases accumulate, embeddings drift, but the canonical entity persists. The harder problem is **philosophical identity continuity**: when an entity's meaning changes so fundamentally that the canonical name is misleading.

The bi-temporal model handles this partially — `entity_type_history` tracks type changes over time. But deeper identity shifts (the meaning of "Career" changing, not its type) require the cross-epoch alignment mechanism from Section 5.2.

### 6.4 Memory Consolidation

Analogous to how human memory works — episodic memories (specific events) fade into semantic knowledge (general patterns). The system should:
- Preserve episodic detail at fine resolution for recent history
- Consolidate into semantic summaries at medium resolution for older history
- Retain only causally significant chains and epoch-level patterns at coarse resolution

This is a future implementation concern. The bi-temporal model already supports it (facts can be expired with reason "consolidated"), but the compaction logic doesn't exist yet.

---

## 7. Query Operations

### 7.1 Point-in-Time State Query (Existing)

```sql
SELECT * FROM facts
WHERE subject_entity_id = ?
  AND valid_at <= ?
  AND (invalid_at IS NULL OR invalid_at > ?)
  AND expired_at IS NULL
```

Already implemented in `platform/src/services/facts.ts`.

### 7.2 Backward Causal Trace (Graph C)

"Why does this state exist?"

```cypher
-- In causal_graph (Apache AGE)
MATCH path = (effect:Transition {fact_id: ?})<-[:CAUSED_BY*1..10]-(root)
WHERE root.confidence > 0.5
RETURN path
ORDER BY length(path) ASC
```

Walks Graph C backwards from a known state transition to its causal antecedents. Returns causal chains with provenance at each step.

### 7.3 Forward Trajectory Projection (Graph C)

"Where is this likely heading?"

```cypher
MATCH path = (cause:Transition {fact_id: ?})-[:CAUSED*1..5]->(downstream)
WHERE cause.confidence > 0.6
RETURN downstream, length(path) as distance
ORDER BY distance ASC
```

Walks Graph C forward from a currently active transition to its known downstream effects. Not prediction from statistics — traversal of a concrete causal structure built from reported experience.

### 7.4 Causal Delta Report

"What changed and why?"

Compare Graph S state between T₁ and T₂, identify transitions, then enrich each transition with its Graph C context:

```
Transition: Anxiety→Work edge strengthened (+0.3 confidence)
Graph C context:
  - Caused by: Boss→Criticism event (Tuesday, confidence 0.8)
  - Consistent with: "Ruminative Loop" pattern (activated 6 times in past year)
  - Downstream risk: Sleep→Disruption edge likely within 72 hours (historical pattern)
```

This transforms structural diff into causal narrative.

### 7.5 Ghost Node Detection

"What's missing?"

```cypher
MATCH (dense:Entity)
WHERE size((dense)-[]-()) > 5
WITH dense
MATCH (isolated:Entity)
WHERE size((isolated)-[]-()) <= 1
  AND isolated.entity_type IN ['concept', 'person', 'behaviour']
RETURN isolated.name, isolated.entity_type
```

Identifies entities that should be connected (based on type and context) but aren't. The graph has dense clusters around some concepts but other relevant nodes are disconnected — potential blind spots worth exploring.

### 7.6 Contradiction Detection (Enhanced)

Current contradiction detection (`conflict-resolution.agent.ts`) checks for structural conflicts in Graph S — same subject+predicate with different objects. Enhanced contradiction detection adds causal context:

- **Structural contradiction:** "Client believes X" (Week 1) vs "Client believes not-X" (Week 4)
- **Causal enrichment:** Is the causal chain leading to the new belief well-established? If yes → genuine change. If no → surface-level inconsistency worth investigating.
- **Graph C provides the signal** to distinguish cognitive evolution from cognitive dissonance.

---

## 8. Data Flow — Complete Pipeline

```
Input arrives (any source)
    │
    ▼
┌─── store(text) ──────────────────────────────────────────────────────┐
│  1. Embed text (Ollama nomic-embed-text)                              │
│  2. Store in Qdrant → memoryId                                        │
└──────────────────────────────────┬────────────────────────────────────┘
    │
    ▼
┌─── extract(memoryId) — Graph S ──────────────────────────────────────┐
│                                                                       │
│  3. Extract entities (Python ML service → LLM)                        │
│  4. Resolve each entity (pgvector similarity + trigram + thresholds)   │
│  5. Extract relationships (Python ML service → LLM)                   │
│  6. Match subjects/objects (multi-tier: exact → substring → embedding) │
│  7. Create facts (bi-temporal, triggers AGE sync to knowledge_graph)   │
│                                                                       │
│  → Graph S updated: entities linked, facts created, AGE synced        │
└──────────────────────────────────┬────────────────────────────────────┘
    │
    ▼
┌─── Causal Agent — Graph C ───────────────────────────────────────────┐
│                                                                       │
│  8. Collect delta (new entities, new/modified facts from this ingest)  │
│  9. Create causal events for each Graph S transition                  │
│ 10. Run Haiku causal agent (tool-use loop):                           │
│     → Agent examines delta                                            │
│     → Agent queries Graph S via tools (entity facts, neighbours)      │
│     → Agent queries Qdrant via tools (related source texts)           │
│     → Agent queries Graph C via tools (existing causal chains)        │
│     → Agent reasons about causality                                   │
│     → Agent creates causal edges with reasoning + source traceability │
│     → Causal edges synced to AGE causal_graph via triggers            │
│                                                                       │
│  → Graph C updated: causal events + edges with full provenance        │
└──────────────────────────────────┬────────────────────────────────────┘
    │
    ▼
┌─── Interpretation Layer (Layer 2) ────────────────────────────────────┐
│  Event-triggered workflows                                            │
│  Causal delta reports                                                 │
│  Trajectory projections                                               │
│  Ghost node alerts                                                    │
│  Periodic reviews (daily/weekly/monthly)                              │
└───────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─── Scheduled Maintenance ─────────────────────────────────────────────┐
│  Nightly: Ontology evolution (predicate + entity type + causal pattern)│
│  Nightly: Contradiction scanning (structural + causal)                │
│  Periodic: Hierarchical temporal abstraction (future)                 │
│  Periodic: Epoch detection and boundary marking (future)              │
└───────────────────────────────────────────────────────────────────────┘
```
