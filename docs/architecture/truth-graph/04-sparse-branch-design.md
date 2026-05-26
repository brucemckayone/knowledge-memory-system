# Sparse Branch Design — Minimal Truth Graph Implementation

**Branch:** `feat/sparse-truth-graph` (from `feat/cognitive-platform-v1`)
**Purpose:** Strip the platform to the minimum code needed to implement, test, and iterate on the Graph S + Graph C data structures. Remove all orchestration noise (agent framework, job queue, bot, API server) while keeping the full data infrastructure (PostgreSQL, Qdrant, Ollama, ML services, Claude Code CLI). The goal is fast iteration cycles on the data structure itself.

**Build order:** Phase A fixes and hardens Graph S (entity resolution, facts, AGE sync). Phase B layers Graph C on top (causal events, causal edges, Haiku agentic reasoning). Both phases happen on the same branch as sequential commits.

---

## 1. What We're Keeping vs. Cutting

The "sparse" refers to stripping **orchestration and application logic**, not data infrastructure. The full data stack remains because the causal agent needs to query all of it.

### Current Architecture — What's Noise

```d2
direction: right

telegram: Telegram Bot {
  style.fill: "#f8d7da"
  style.opacity: 0.4
  grammy: Grammy Framework
  handlers: Command Handlers
  rate-limiter: Rate Limiter
}

api: Hono HTTP API {
  style.fill: "#f8d7da"
  style.opacity: 0.4
  health: /health
  webhook: /webhook
  ingest: /api/ingest
  search: /api/search
}

workers: Message Processor {
  style.fill: "#f8d7da"
  style.opacity: 0.4
  envelope: Envelope Factory
  classify: LLM Classification
  routing: Workflow Routing
  transcribe: Voice Transcription
}

queue: pg-boss Queue {
  style.fill: "#f8d7da"
  style.opacity: 0.4
  realtime: Realtime Tier
  frequent: Frequent Tier
  periodic: Periodic Tier
}

gardener: KARMA Agent Framework {
  style.fill: "#f8d7da"
  style.opacity: 0.4
  controller: Controller {
    scheduling: Cron Scheduling
    checkpointing: Checkpoint/Restore
    metrics: Metrics Recording
  }
  agents: 15 Agents {
    reader: Reader
    summarizer: Summarizer
    entity-ext: Entity Extraction
    relationship: Relationship
    conflict: Conflict Resolution
    schema: Schema Alignment
    ontology: Ontology Evolution
    context: Context Linker
    community: Community Detection
    insights: Insight Generation
    briefing: Briefing
    contradiction: Contradiction Scanner
    other: "... 3 more"
  }
}

core: Core Services {
  style.fill: "#d4edda"
  style.opacity: 0.4
  entities: services/entities.ts
  facts: services/facts.ts
  predicates: services/predicates.ts
  graph: services/graph.ts
  ml: services/ml-client.ts
  qdrant: services/qdrant.ts
}

db: PostgreSQL + pgvector + AGE {
  style.fill: "#d4edda"
  style.opacity: 0.4
}

qdrant: Qdrant {
  style.fill: "#d4edda"
  style.opacity: 0.4
}

ml: ML Services (Python) {
  style.fill: "#d4edda"
  style.opacity: 0.4
}

ollama: Ollama {
  style.fill: "#d4edda"
  style.opacity: 0.4
}

telegram -> api
api -> workers
workers -> queue
queue -> gardener
gardener.agents -> core
core -> db
core -> qdrant
core -> ml
ml -> ollama
```

**Green = keep. Red = cut.** The red is all orchestration — how code gets called, scheduled, and sequenced. The green is what the code actually does with data.

### Sparse Architecture — What Remains

```d2
direction: down

harness: "Entry Points" {
  cli: "CLI: pnpm tsx src/harness.ts 'text'"
  tests: "Tests: pnpm vitest run src/test/harness/"
}

pipeline: "pipeline.ts" {
  store: "store(text)\n→ embed + Qdrant"
  extract: "extract(memoryId)\n→ entities + relationships + facts"
  ingest: "ingest(text)\n= store + auto-extract"
}

services: Core Services {
  entities: "entities.ts\nresolveEntity(), createEntity(),\nfindSimilarEntities(), linkEntitiesToMemory()"
  facts: "facts.ts\ncreateFact(), expireFact(),\nfindSupersedingFacts(), getEntityFacts()"
  predicates: "predicates.ts\nnormalizePredicate(), syncOntologyToDb(),\nrecordPredicateUsage()"
  graph: "graph.ts\ngetAllEdges(), getSubgraph(),\nfindConnectedEntities(), getEntityDegrees()"
  qdrant: "qdrant.ts\nstoreMemory(), searchMemories(),\ngetMemory(), updatePayload()"
  ml: "ml-client.ts\nembed(), extractEntities(),\nextractRelationships()"
  causal: "causal.ts [Phase B]\ncreateCausalEdge(), traceCauses(),\nprojectTrajectory(), getCausalDelta()"
  causal-agent: "causal-agent.ts [Phase B]\nHaiku with tool-use\nTools for graph/vector/CRUD (see GRAPH_TOOLS — doc 30)"
}

db: "PostgreSQL" {
  pgvector: "pgvector (entity + fact embeddings)"
  age_kg: "knowledge_graph (AGE)"
  age_cg: "causal_graph (AGE) [Phase B]"
  tables: "10 tables (7 Phase A + 3 Phase B)"
}

qdrant: "Qdrant" {
  memories: "memories collection\n(raw source texts + embeddings)"
}

ml: "Python ML Service" {
  embed: "POST /embed → Ollama"
  ent: "POST /extract-entities → LLM"
  rel: "POST /extract-relationships → LLM"
}

claude_code: "Claude Code CLI [Phase B]" {
  causal: "Causal reasoning agent\n(via -p + MCP tools)"
}

ollama: "Ollama" {
  nomic: "nomic-embed-text (768-dim)"
}

harness -> pipeline
pipeline -> services
services.entities -> db
services.facts -> db
services.predicates -> db
services.graph -> db
services.qdrant -> qdrant
services.ml -> ml
services.causal-agent -> anthropic
services.causal-agent -> services.graph: "queries knowledge_graph + causal_graph"
services.causal-agent -> services.qdrant: "searches source texts"
services.causal-agent -> services.causal: "reads/writes causal edges"
services.causal-agent -> services.facts: "reads entity facts"
services.causal-agent -> services.entities: "searches similar entities"
ml -> ollama
```

---

## 2. The Pipeline — Two Phases

### Phase A Pipeline: Graph S (Entity Resolution + Facts)

```d2
direction: down

input: "Raw Text" {
  shape: document
}

store: "1. store(text)" {
  shape: step
  style.fill: "#d4edda"
  style.opacity: 0.4
}

store_a: "1a. Generate embedding\nml.embed(text) → Ollama" {
  shape: step
}

store_b: "1b. Store in Qdrant\nstoreMemory(memoryId, vector, payload)\n→ returns memoryId" {
  shape: step
}

extract: "2. extract(memoryId)" {
  shape: step
  style.fill: "#fff3cd"
  style.opacity: 0.4
}

extract_a: "2a. Extract entities\nml.extractEntities(text, validTypes)\n→ [{mention, type, start, end, confidence}]" {
  shape: step
}

extract_b: "2b. Resolve each entity\nresolveEntity(mention, contextWindow, type)\n→ [{id, canonicalName, isNew}]" {
  shape: step
}

extract_b1: "Generate embedding for mention + context window" {
  shape: step
  style.fill: "#e2e3e5"
  style.opacity: 0.4
}
extract_b2: "findSimilarEntities(embedding, threshold=0.75)" {
  shape: step
  style.fill: "#e2e3e5"
  style.opacity: 0.4
}
extract_b3: ">0.92 → auto-merge\n0.75-0.92 → LLM verify\n<0.75 → create new" {
  shape: step
  style.fill: "#e2e3e5"
  style.opacity: 0.4
}

extract_c: "2c. Extract relationships\nml.extractRelationships(text, entities, predicates)\n→ [{subject, predicate, object, confidence, temporal_hint}]" {
  shape: step
}

extract_d: "2d. Match subjects/objects to entities\nMulti-tier: exact → substring → embedding\n→ matched pairs with entity IDs" {
  shape: step
}

extract_e: "2e. Create facts\ncreateFact(subject, predicate, object, temporal)\n→ factId (triggers AGE sync)" {
  shape: step
}

result: "Return IngestResult\n{memoryId, entities, facts,\nskipped, timing}" {
  shape: step
  style.fill: "#d4edda"
  style.opacity: 0.4
}

input -> store
store -> store_a
store_a -> store_b
store_b -> extract
extract -> extract_a
extract_a -> extract_b
extract_b -> extract_b1
extract_b1 -> extract_b2
extract_b2 -> extract_b3
extract_b3 -> extract_c
extract_c -> extract_d
extract_d -> extract_e
extract_e -> result
```

**`ingest(text)` = `store(text)` then `extract(memoryId)`**. Store happens first (fast — just embed + Qdrant write). Extraction runs automatically after store, but `extract(memoryId)` is also available standalone for re-processing stored memories.

The decoupling matters because:
- You can bulk-store many texts first, then extract selectively
- The causal agent (Phase B) can query already-stored-but-not-yet-extracted memories via Qdrant
- Re-extraction after bug fixes doesn't require re-storing

### Phase B Pipeline: Graph C (Causal Agent)

```d2
direction: down

trigger: "Graph S changed\n(new entities, new/modified facts\nfrom this ingest)" {
  shape: document
}

collect: "3. Collect delta\nWhat changed in this ingest() call?\n→ {newEntities, newFacts, modifiedFacts,\nsourceMemoryId}" {
  shape: step
}

events: "4. Create causal events\nFor each transition in delta:\nINSERT INTO causal_events\n(fact_id, transition_type, entity_id, ...)" {
  shape: step
}

agent: "5. Run causal agent\nHaiku with tool-use\nInput: delta + sourceMemoryId" {
  shape: step
  style.fill: "#cce5ff"
  style.opacity: 0.4
}

tools: "Agent's available tools" {
  style.fill: "#e8f4fd"
  style.opacity: 0.4
  t1: "query_entity_facts\n→ get all facts for an entity"
  t2: "query_entity_neighbours\n→ AGE graph traversal"
  t3: "search_similar_entities\n→ pgvector cosine search"
  t4: "search_memories\n→ Qdrant semantic search on source texts"
  t5: "get_memory_text\n→ retrieve a specific source text"
  t6: "get_causal_history\n→ existing causal chains for an entity"
  t7: "create_causal_edge\n→ assert a causal link with reasoning"
}

agent_loop: "Agent reasoning loop" {
  style.fill: "#e8f4fd"
  style.opacity: 0.4
  step1: "1. Examine the delta (what changed)"
  step2: "2. Query related entities, facts, source texts"
  step3: "3. Check existing causal chains"
  step4: "4. Reason about what caused these changes"
  step5: "5. Create causal edges with reasoning + sources"
}

result: "Return CausalResult\n{causalEvents, causalEdges,\nreasoning}" {
  shape: step
  style.fill: "#d4edda"
  style.opacity: 0.4
}

trigger -> collect
collect -> events
events -> agent
agent -> tools: "uses"
agent -> agent_loop: "executes"
agent_loop -> result
```

The causal agent is NOT a simple prompt-and-extract call. It is an **agentic loop** where Haiku:
1. Receives the delta (what changed in Graph S during this ingest)
2. Uses its tools to query for context — related entities, historical facts, previous source texts, existing causal chains
3. Reasons about what caused the changes, building its own understanding from the data
4. Asserts causal edges only when it has sufficient confidence
5. Every edge includes detailed reasoning and references to the specific sources (memories, facts, entities) that informed the conclusion

The agent does not operate on the current input text alone. It queries the full history via the graph and vector stores, reasoning over the accumulated knowledge to determine causality.

---

## 3. File Inventory

### Keep (core services + infrastructure)

| File | Purpose | Changes for Sparse Branch |
|------|---------|---------------------------|
| `src/config.ts` | Environment config | Strip to: `DATABASE_URL`, `ML_SERVICES_URL`, `QDRANT_URL`, `EMBED_MODEL`, `EMBED_DIMENSIONS`, `NODE_ENV`. Add `CLAUDE_CODE_PATH` (Phase B, defaults to `claude`). Remove: `TELEGRAM_BOT_TOKEN`, `WEBHOOK_URL`, `QUEUE_CONCURRENCY`, `RATE_LIMIT_MESSAGES_PER_MINUTE`, `GARDENER_FREQUENT_INTERVAL`, `GARDENER_PERIODIC_INTERVAL`, `INGESTION_SESSION_WINDOW_MINUTES`, `MNEMO_API_KEY`, `WATCH_DIR`, `WATCH_ENABLED`, `OBSIDIAN_VAULT_PATH`, `OBSIDIAN_ENABLED`. |
| `src/db/index.ts` | Drizzle DB connection | No changes. Imports `config.DATABASE_URL`, creates postgres client + drizzle instance. |
| `src/db/raw.ts` | Raw SQL helper (`rawQuery()`) | No changes. Used by entities.ts, facts.ts, graph.ts for pgvector/AGE/trigram queries. |
| `src/db/schema.ts` | Drizzle table definitions | Strip to graph tables only: `entities`, `entityAliases`, `entityMerges`, `memoryEntities`, `facts`, `factPredicates`, `entityTypes`, `entityTypeHistory`. Phase B adds: `causalEvents`, `causalEdges`, `causalPatterns`. Remove everything else: `tasks`, `epics`, `settings`, `processingState`, `contextSummaries`, `communities`, `insights`, `briefings`, `obsidianSyncState`, `conversationState`, `channelProfiles`, `ingestionSessions`, `ingestionSessionMembers`, `memoriesChunks`, `contradictionReviews`, `contentHashes`, `ingestSources`, `sourceBindings`, `projectAssociations`, `associationAmbiguities`, `conversationSummaries`, `memoryMetadata`, `gardenerJobMeta`, `gardenerMetrics`. |
| `src/services/entities.ts` | Entity CRUD + resolution | Apply hardening fixes from `02-graph-s-hardening.md`: advisory lock or ON CONFLICT in `createEntity()`, context-windowed embedding in `resolveEntity()`, targeted error catching in `addAliasIfNew()`. |
| `src/services/facts.ts` | Bi-temporal facts | Apply dedup fix: pre-insert check for matching `(subject_entity_id, predicate, object_entity_id/object_value)`. Phase B: add causal event creation inside `createFact()`, `expireFact()`, `invalidateFact()`. |
| `src/services/predicates.ts` | Ontology normalization | No changes. `normalizePredicate()`, `syncOntologyToDb()`, `recordPredicateUsage()`, `CANONICAL_ONTOLOGY` (69 predicates). |
| `src/services/graph.ts` | Apache AGE Cypher queries | No changes initially. Phase B: add `causal_graph` queries alongside existing `knowledge_graph` queries. |
| `src/services/ml-client.ts` | HTTP client to Python ML services | Strip to: `embed()`, `extractEntities()`, `extractRelationships()`. Remove: `classify()`, `summarize()`, `transcribe()`, `scrape()`, `parseContent()`, `extractTasks()`, `chat()`, `checkContradiction()`, `comparePredicate()`, `resolveEntity()` (ML-based). Keep timeout/retry logic. |
| `src/services/qdrant.ts` | Qdrant vector store client | Keep: `ensureCollections()`, `storeMemory()`, `searchMemories()`, `getMemory()`, `updatePayload()`, `checkQdrantHealth()`. Remove: `COLLECTIONS.CONTEXTS` (only need `COLLECTIONS.MEMORIES`), `scrollPoints()` (not needed for sparse branch). |

### Create (new for sparse branch)

| File | Purpose | Phase |
|------|---------|-------|
| `src/harness.ts` | CLI entry point — parses args, calls `ingest()`, prints results | A |
| `src/pipeline.ts` | Core pipeline functions: `store()`, `extract()`, `ingest()` | A |
| `src/services/causal.ts` | Graph C service: `createCausalEvent()`, `createCausalEdge()`, `traceCauses()`, `projectTrajectory()`, `getCausalDelta()`, `getEntityCausalHistory()`, `findPatternInstances()` | B |
| `src/services/causal-agent.ts` | Haiku tool-use agent: system prompt, tool definitions, reasoning loop, edge creation with traceability | B |
| `src/db/migrations/001_consolidated.sql` | Single clean migration with all graph tables (Phase A + B) | A |
| `src/test/harness/entity-resolution.test.ts` | Entity resolution convergence tests | A |
| `src/test/harness/fact-creation.test.ts` | Bi-temporal facts + dedup tests | A |
| `src/test/harness/pipeline.test.ts` | Full `ingest()` pipeline tests | A |
| `src/test/harness/frankenstein.test.ts` | 10-chunk Frankenstein regression | A |
| `src/test/harness/causal-agent.test.ts` | Haiku causal reasoning tests | B |
| `src/test/harness/causal-chains.test.ts` | Multi-input causal chain traversal tests | B |

### Delete (entire directories/files)

| Path | What It Is | Why It's Noise |
|------|-----------|----------------|
| `src/bot/` | Telegram bot (Grammy framework, command handlers, rate limiter) | No user-facing interface needed — CLI + tests are the entry points |
| `src/workers/` | Message processor (envelope factory, LLM classification, workflow routing, voice transcription) | Orchestration — the sparse pipeline replaces this with direct function calls |
| `src/gardener/` | KARMA agent framework: `controller.ts` (pg-boss scheduling, tiers, checkpointing, metrics), `agents/` (15 agents: reader, summarizer, entity-extraction, relationship, conflict-resolution, schema-alignment, ontology-evolution, context-linker, community-detection, insight-generation, briefing, contradiction-scanner, project-association, project-refresh, obsidian-write), `errors.ts` (typed error hierarchy) | The main noise source — ~5,000 lines of orchestration replaced by ~200 lines in pipeline.ts |
| `src/routes/` | Hono HTTP API endpoints (ingest, search, health) | No HTTP server needed |
| `src/workflows/` | Workflow pipelines (process-link, process-task) | Application logic, not data structure |
| `src/skills/` | Skill framework and handlers | Application logic |
| `src/middleware/` | Auth middleware | No HTTP server |
| `src/queue/` | pg-boss queue setup and initialization | No job queue — direct function calls |
| `src/services/hybrid-search.ts` | RRF fusion of vector + graph + keyword search | Rebuild later on top of Graph S + C; not needed for structure testing |
| `src/services/ingest/` | Ingest router service | Replaced by pipeline.ts |
| `src/services/ml.ts` | Re-export wrapper for ml-client.ts | Unnecessary indirection — use ml-client.ts directly |
| `src/index.ts` | Full Hono server (health check, Telegram webhook, search API, memory API, bot polling, queue init, Qdrant init, agent registration) | Replaced by harness.ts |
| `src/core/` | Envelope factory, message routing | Application logic |
| `src/benchmark/` | Performance benchmark suite | Not needed during structure development |

---

## 4. The `ingest()` Function — Detailed Design

### Function Signatures

```typescript
/**
 * Store raw text in Qdrant with embedding. Fast — just embed + store.
 * Returns the memoryId which can be used for later extraction.
 */
async function store(
  text: string,
  metadata?: { source?: string; timestamp?: Date }
): Promise<string>  // returns memoryId

/**
 * Extract entities and relationships from an already-stored memory.
 * Can be called immediately after store() or later for batch processing.
 * Can be called again after bug fixes for re-extraction.
 */
async function extract(memoryId: string): Promise<ExtractResult>

/**
 * Store + auto-extract. The default entry point for most usage.
 * Equivalent to: const id = await store(text); return await extract(id);
 */
async function ingest(
  text: string,
  metadata?: { source?: string; timestamp?: Date }
): Promise<IngestResult>
```

### `store()` Implementation Detail

1. Generate a UUID for `memoryId`
2. Call `ml.embed(text)` → Ollama nomic-embed-text → 768-dim vector
3. Call `qdrant.storeMemory(memoryId, vector, { content: text, source: metadata?.source, created_at: metadata?.timestamp || new Date(), status: 'stored' })`
4. Return `memoryId`

The raw text lives in Qdrant, not PostgreSQL. This is deliberate — Qdrant provides semantic search over source texts, which the causal agent (Phase B) needs. The `memoryId` is the reference used throughout the system: `facts.source_memory_id`, `memory_entities.memory_id`, `causal_events.source_memory_id`.

### `extract()` Implementation Detail

1. Fetch the memory from Qdrant: `qdrant.getMemory(memoryId)` → `{ content, vector }`
2. Get valid entity types: `getValidEntityTypes()` (cached 1 minute from `entity_types` table)
3. Call `ml.extractEntities(content, validTypes)` → `[{mention, type, start, end, confidence}]`
4. **Entity specificity filter:** Reject mentions that are common nouns, generic descriptors, or anaphoric references (e.g., "a lady", "the old man", "frost", "dauntless courage"). This is a post-extraction filter applied before resolution.
5. For each surviving entity:
   a. Compute context window: if `start`/`end` are available, take 100 chars before + 100 chars after the mention in the source text. Otherwise, first 200 chars.
   b. Call `resolveEntity(mention, contextWindow, type)` — the three-stage pipeline:
      - Generate embedding for `mention + contextWindow`
      - `findSimilarEntities(embedding, { threshold: 0.75, limit: 10, type })`
      - If any candidate scores >0.92: auto-merge (add alias, update `last_seen_at`, return existing ID)
      - If candidates between 0.75 and 0.92: take best match (TODO: LLM verification gate)
      - If no candidates above 0.75: `createEntity()` with advisory lock / ON CONFLICT
   c. Call `linkMemoryToEntity(memoryId, entityId, { text: mention, start, end })`
6. Get canonical predicates: `SELECT predicate FROM fact_predicates WHERE status IN ('canonical', 'provisional')`
7. Call `ml.extractRelationships(content, resolvedEntities, canonicalPredicates)` → `[{subject, predicate, object, confidence, temporal_hint, source_text}]`
8. For each relationship, resolve subject and object to entity IDs using multi-tier matching:
   a. **Exact match:** `entities.find(e => e.name.toLowerCase() === rel.subject.toLowerCase())`
   b. **Substring match:** `entities.find(e => e.name.toLowerCase().includes(rel.subject.toLowerCase()) || rel.subject.toLowerCase().includes(e.name.toLowerCase()))`
   c. **Embedding match:** Generate embedding for `rel.subject`, compare against entity embeddings via `findSimilarEntities()` with threshold 0.75
   d. **Skip with warning:** Log which relationship was skipped and why
9. For each matched relationship:
   a. `normalizePredicate(rel.predicate)` → canonical form
   b. Compute `validAt`/`invalidAt` from `temporal_hint` (current/past/future/unknown)
   c. `createFact({ subjectEntityId, predicate, objectEntityId, objectValue, validAt, invalidAt, sourceMemoryId: memoryId, sourceText: rel.source_text, confidence })` — this triggers the AGE sync via PostgreSQL trigger
   d. `recordPredicateUsage(canonicalPredicate)`
10. Return `ExtractResult`:
    ```typescript
    interface ExtractResult {
      memoryId: string;
      entities: ResolvedEntity[];           // [{id, canonicalName, entityType, isNew, confidence}]
      facts: CreatedFact[];                 // [{id, subject, predicate, object, confidence}]
      skipped: SkippedRelationship[];       // [{subject, predicate, object, reason}]
      filtered: string[];                   // entity mentions rejected by specificity filter
      timing: {
        embedText: number;
        extractEntities: number;
        resolveEntities: number;
        extractRelationships: number;
        matchSubjects: number;
        createFacts: number;
        total: number;
      };
    }
    ```

---

## 5. The Causal Agent — Detailed Design (Phase B)

### 5.1 When the Causal Agent Runs

The causal agent is triggered after `extract()` completes, if the extraction produced any Graph S changes (new entities, new facts, modified facts). Changes from a single input are batched together — the agent receives the full delta from one `ingest()` call, not individual entity/fact creation events.

```typescript
// Inside ingest():
const extractResult = await extract(memoryId);

if (extractResult.facts.length > 0 || extractResult.entities.some(e => e.isNew)) {
  const causalResult = await runCausalAgent(memoryId, extractResult);
  return { ...extractResult, causal: causalResult };
}
```

### 5.2 What the Agent Receives

The agent's input is the **delta** — what changed in Graph S during this ingest:

```typescript
interface CausalAgentInput {
  sourceMemoryId: string;              // The memory that triggered these changes
  sourceText: string;                  // The raw text (for context)
  newEntities: Array<{
    id: string;
    canonicalName: string;
    entityType: string;
  }>;
  newFacts: Array<{
    id: string;
    subjectEntityId: string;
    subjectName: string;
    predicate: string;
    objectEntityId?: string;
    objectName?: string;
    objectValue?: string;
    confidence: number;
    validAt: Date;
    invalidAt?: Date;
  }>;
  modifiedFacts: Array<{              // Facts that were superseded/expired by this ingest
    id: string;
    change: 'superseded' | 'expired';
    reason: string;
  }>;
}
```

### 5.3 The Agent's Tools

The causal agent (Claude Code via `-p` with MCP tools) has access to seven tools. Each tool is exposed via an MCP server and maps to an existing service function:

| Tool Name | Description | Maps To | Returns |
|-----------|-------------|---------|---------|
| `query_entity_facts` | Get all active bi-temporal facts for a given entity. Includes facts where the entity is subject OR object. | `services/facts.ts:getEntityFacts(entityId)` | Array of facts with subject, predicate, object, validAt, invalidAt, confidence, sourceText |
| `query_entity_neighbours` | Traverse the knowledge graph (AGE) to find entities connected to a given entity, optionally filtered by relationship type and depth. | `services/graph.ts:findConnectedEntities(entityId, { relationshipType?, maxDepth? })` | Array of connected entities with relationship type and distance |
| `search_similar_entities` | Semantic similarity search over all entities using pgvector. Find entities whose embeddings are close to a query text. | `services/entities.ts:findSimilarEntities(embedding, { threshold, limit, type? })` | Array of entities with similarity scores |
| `search_memories` | Semantic search over source texts in Qdrant. Find past inputs that are semantically related to a query. | `services/qdrant.ts:searchMemories(queryVector, { limit, filter? })` | Array of memories with content, similarity score, metadata |
| `get_memory_text` | Retrieve the full source text of a specific memory by ID. | `services/qdrant.ts:getMemory(memoryId)` | Memory content, metadata, created_at |
| `get_causal_history` | Get existing causal chains involving a given entity. Returns causal events and edges from Graph C. | `services/causal.ts:getEntityCausalHistory(entityId)` | Array of causal events + edges with reasoning, strength, source references |
| `create_causal_edge` | Assert a causal link between two transitions (causal events) with detailed reasoning and source references. | `services/causal.ts:createCausalEdge(params)` | Created edge ID |

### 5.4 The `create_causal_edge` Tool — Input Schema

When the agent calls `create_causal_edge`, it must provide:

```typescript
interface CreateCausalEdgeParams {
  causeEventId: string;              // The causal event that is the cause
  effectEventId: string;             // The causal event that is the effect
  strength: number;                  // 0.0-1.0 confidence in the causal link
  reasoning: string;                 // Detailed justification for this causal assertion.
                                     // Must explain WHY the agent believes A caused B.
                                     // Not overly verbose but must justify the conclusion.
  sourceReferences: Array<{          // Every source that informed this conclusion
    type: 'memory' | 'fact' | 'entity';
    id: string;                      // UUID of the memory, fact, or entity
    relevance: string;               // How this source informed the causal conclusion
  }>;
  temporalSpan?: string;             // Estimated delay between cause and effect (ISO 8601 duration)
}
```

**The reasoning and source references are non-negotiable.** Every causal edge must be auditable — you must be able to trace back from any edge to the specific memories, facts, and entities that caused the agent to draw that conclusion. This is essential for:
- Tracking causal chains over time and revising them as new information arrives
- Debugging false positives (the reasoning explains what went wrong)
- Building confidence in the graph (well-sourced edges are more trustworthy)
- Enabling future agents to reason about the quality of existing causal links

### 5.5 System Prompt for the Causal Agent

The system prompt instructs Haiku to:

1. **Examine the delta:** Understand what changed in Graph S during this ingest. Read the source text and the extracted entities/facts.
2. **Gather context:** Use tools to query related entities, historical facts, past source texts, and existing causal chains. Do not reason about causality from the current text alone — query the graph and vector store to understand the broader context.
3. **Reason about causality:** Based on the delta AND the gathered context, determine what causal links exist. Consider:
   - Did the source text explicitly state causality? ("because", "caused by", "led to")
   - Do temporal patterns in Graph S suggest causality? (A consistently precedes B for this entity)
   - Do existing causal chains extend? (This new transition is a known downstream effect)
   - Are there indirect causes? (A caused B, B now appears to cause C)
4. **Assert causal edges:** For each causal link you identify, call `create_causal_edge` with:
   - The specific cause and effect event IDs
   - A strength score reflecting your confidence (0.3-0.6 for inferred, 0.7-1.0 for explicitly stated)
   - Detailed reasoning explaining your conclusion
   - A complete list of source references (memories, facts, entities) that informed the conclusion
5. **Do not hallucinate causality.** If you cannot identify a clear causal mechanism, do not create an edge. It is better to miss a causal link than to assert a false one. The system will have more opportunities to discover links as more data arrives.

### 5.6 LLM Provider Routing

The causal agent uses **Claude Code** invoked via the `-p` flag. The tools in `GRAPH_TOOLS` (see `src/services/causal-agent.ts`) are exposed as an **MCP server** (`src/services/graph-mcp.ts`) that Claude Code connects to via `--mcp-config`. This approach is vendor-agnostic — the MCP interface is a standard protocol, not tied to any specific LLM provider. See [doc 30 — MCP transport](30-mcp-transport.md) for the full two-transport contract (MCP via Claude Code vs Pi bridge).

```typescript
import { execFile } from 'child_process';

// Invoke Claude Code with the causal system prompt + delta as input
const result = execFile('claude', [
  '-p', formatPrompt(systemPrompt, delta),
  '--mcp-config', mcpConfigPath,
  '--output-format', 'json',
]);
```

Claude Code manages the tool-use loop internally — it calls MCP tools, processes results, and continues reasoning until it has finished asserting causal edges. No hand-rolled loop required.

---

## 6. Schema — All Tables

### Phase A Tables (Graph S — 7 tables)

```d2
direction: right

entities: entities {
  shape: sql_table
  id: UUID {constraint: PK}
  canonical_name: VARCHAR(500)
  entity_type: VARCHAR(100)
  description: TEXT
  properties: JSONB
  embedding: "VECTOR(768)"
  merged_from: "UUID[]"
  confidence: FLOAT
  first_seen_at: TIMESTAMPTZ
  last_seen_at: TIMESTAMPTZ
}

entity_aliases: entity_aliases {
  shape: sql_table
  id: UUID {constraint: PK}
  entity_id: UUID {constraint: FK}
  alias: VARCHAR(500)
  alias_type: VARCHAR(50)
  source: VARCHAR(100)
}

entity_merges: entity_merges {
  shape: sql_table
  id: UUID {constraint: PK}
  source_entity_id: UUID
  target_entity_id: UUID {constraint: FK}
  merge_reason: TEXT
  merge_method: VARCHAR(50)
  similarity_score: FLOAT
  merged_at: TIMESTAMPTZ
}

memory_entities: memory_entities {
  shape: sql_table
  id: UUID {constraint: PK}
  memory_id: UUID
  entity_id: UUID {constraint: FK}
  mention_text: VARCHAR(500)
  mention_start: INTEGER
  mention_end: INTEGER
  mention_context: TEXT
  relationship: VARCHAR(100)
  confidence: FLOAT
}

facts: facts {
  shape: sql_table
  id: UUID {constraint: PK}
  subject_entity_id: UUID {constraint: FK}
  predicate: VARCHAR(255)
  object_entity_id: UUID {constraint: FK}
  object_value: TEXT
  valid_at: TIMESTAMPTZ
  invalid_at: TIMESTAMPTZ
  created_at: TIMESTAMPTZ
  expired_at: TIMESTAMPTZ
  expire_reason: TEXT
  source_memory_id: UUID
  source_text: TEXT
  extraction_method: VARCHAR(100)
  confidence: FLOAT
  fact_embedding: "VECTOR(768)"
}

fact_predicates: fact_predicates {
  shape: sql_table
  predicate: VARCHAR(255) {constraint: PK}
  description: TEXT
  inverse_predicate: VARCHAR(255)
  predicate_type: VARCHAR(50)
  is_exclusive: BOOLEAN
  category: VARCHAR(50)
  aliases: "TEXT[]"
  is_canonical: BOOLEAN
  status: VARCHAR(20)
  first_seen_at: TIMESTAMPTZ
  usage_count: INTEGER
  distinct_memory_count: INTEGER
  promoted_at: TIMESTAMPTZ
  rejected_at: TIMESTAMPTZ
  rejection_reason: TEXT
}

entity_types: entity_types {
  shape: sql_table
  name: VARCHAR(100) {constraint: PK}
  description: TEXT
  status: VARCHAR(20)
  promoted_at: TIMESTAMPTZ
}

entities -> entity_aliases: "1:N"
entities -> entity_merges: "target"
entities -> memory_entities: "1:N"
entities -> facts: "subject"
entities -> facts: "object"
facts -> fact_predicates: "predicate lookup"
```

### Phase B Tables (Graph C — 3 additional tables)

```d2
direction: right

causal_events: causal_events {
  shape: sql_table
  id: UUID {constraint: PK}
  fact_id: UUID {constraint: FK → facts}
  transition_type: "VARCHAR(20)\ncreated|strengthened|\nweakened|expired|invalidated"
  subject_entity_id: UUID {constraint: FK → entities}
  predicate: VARCHAR(255)
  delta_confidence: FLOAT
  occurred_at: TIMESTAMPTZ
  event_embedding: "VECTOR(768)"
  source_memory_id: UUID
  source_text: TEXT
  created_at: TIMESTAMPTZ
}

causal_edges: causal_edges {
  shape: sql_table
  id: UUID {constraint: PK}
  cause_event_id: UUID {constraint: FK → causal_events}
  effect_event_id: UUID {constraint: FK → causal_events}
  strength: FLOAT
  reasoning: "TEXT NOT NULL"
  source_references: "JSONB NOT NULL\n[{type, id, relevance}]"
  temporal_span: INTERVAL
  extraction_method: VARCHAR(20)
  corroboration_count: INTEGER
  last_corroborated: TIMESTAMPTZ
  initial_strength: FLOAT
  pattern_id: UUID {constraint: FK → causal_patterns}
  pattern_position: INTEGER
  created_at: TIMESTAMPTZ
  expired_at: TIMESTAMPTZ
  expire_reason: TEXT
}

causal_patterns: causal_patterns {
  shape: sql_table
  id: UUID {constraint: PK}
  name: VARCHAR(255)
  description: TEXT
  template_structure: JSONB
  template_length: INTEGER
  topology_type: VARCHAR(20)
  pattern_embedding: "VECTOR(768)"
  status: "VARCHAR(20)\nstaging|candidate|\nprovisional|canonical"
  instance_count: INTEGER
  first_seen_at: TIMESTAMPTZ
  last_seen_at: TIMESTAMPTZ
  promoted_at: TIMESTAMPTZ
  avg_temporal_span: INTERVAL
  avg_strength: FLOAT
  activation_count_30d: INTEGER
}

causal_events -> causal_edges: "cause"
causal_events -> causal_edges: "effect"
causal_edges -> causal_patterns: "pattern membership"
```

### Apache AGE Graphs

Two separate AGE graphs in the same PostgreSQL instance:

| Graph | Node Type | Edge Type | Purpose |
|-------|-----------|-----------|---------|
| `knowledge_graph` | `:Entity {entity_id, name, type}` | `:[PREDICATE] {fact_id, confidence, valid_at}` | Graph S — entity-relationship traversal |
| `causal_graph` | `:Transition {event_id, fact_id, type, entity_id, predicate}` | `:CAUSED {strength, method, pattern_id}` | Graph C — causal chain traversal |

Both are auto-synced via PostgreSQL triggers on the `entities`, `facts`, `causal_events`, and `causal_edges` tables.

---

## 7. Config — `.env` for Sparse Branch

```bash
# Database
DATABASE_URL=postgres://cognitive:cognitive@localhost:5433/cognitive

# Qdrant (kept — causal agent needs source text search)
QDRANT_URL=http://localhost:6335

# ML Services (Python FastAPI — entity/relationship extraction + embeddings)
ML_SERVICES_URL=http://localhost:8000

# Embeddings
EMBED_MODEL=nomic-embed-text
# EMBED_DIMENSIONS auto-detected as 768 for nomic-embed-text

# Claude Code (Phase B — causal reasoning agent)
# Claude Code CLI must be on PATH

# Node environment
NODE_ENV=development
```

**Config.ts Zod schema:**

```typescript
const envSchema = z.object({
  DATABASE_URL: z.string(),
  QDRANT_URL: z.string().default('http://localhost:6335'),
  ML_SERVICES_URL: z.string().default('http://localhost:8000'),
  EMBED_MODEL: z.string().default('nomic-embed-text'),
  EMBED_DIMENSIONS: z.coerce.number().optional(),
  CLAUDE_CODE_PATH: z.string().default('claude'),  // Path to Claude Code CLI (Phase B)
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});
```

---

## 8. ML Services — What to Keep

```d2
direction: down

ml_python: "Python ML Service (FastAPI)" {
  keep: "Keep" {
    style.fill: "#d4edda"
  style.opacity: 0.4
    embed: "POST /embed\n→ Ollama nomic-embed-text\n→ Returns 768-dim vector"
    entities: "POST /extract-entities\n→ LLM structured extraction\n→ Returns [{mention, type, start, end, confidence}]"
    relationships: "POST /extract-relationships\n→ LLM triple extraction\n→ Returns [{subject, predicate, object, confidence, temporal_hint}]"
    health: "GET /health"
  }
  cut: "Cut (unused endpoints stay in code but not called)" {
    style.fill: "#f8d7da"
  style.opacity: 0.4
    classify: "/classify"
    summarize: "/summarize"
    parse: "/parse-content"
    tasks: "/extract-task"
    scrape: "/scrape"
    transcribe: "/transcribe"
    chat: "/chat"
    contradiction: "/check-contradiction"
    compare: "/compare-predicates"
  }
}

claude_code: "Claude Code CLI" {
  style.fill: "#cce5ff"
  style.opacity: 0.4
  causal: "Causal reasoning agent [Phase B]\n→ Invoked via -p flag\n→ Tools via MCP server"
}
```

The Python ML service stays as-is — unused endpoints don't need to be deleted, they just aren't called. The sparse TypeScript `ml-client.ts` only calls the three kept endpoints.

The causal agent is invoked via Claude Code's `-p` flag with an MCP config that connects to the causal MCP server. This keeps the tool interface vendor-agnostic — any MCP-compatible LLM client could replace Claude Code.

---

## 9. Migration — Single Consolidated File

Instead of running 25 existing migrations (many creating tables we don't use), create a single `001_consolidated.sql` that contains exactly what the sparse branch needs:

**Phase A contents:**
1. Extensions: `pgvector`, `pg_trgm`, `uuid-ossp`, `btree_gist`
2. Apache AGE: extension + `knowledge_graph` graph creation
3. Tables: `entities`, `entity_aliases`, `entity_merges`, `memory_entities` (from migration 003)
4. Tables: `facts`, `fact_predicates` (from migration 004)
5. AGE helper functions: `sync_entity_to_graph()`, `create_entity_edge()`, `find_entity_paths()`, `get_entity_neighbors()` (from migration 005)
6. AGE triggers: `trigger_sync_entity`, `trigger_sync_fact` (from migration 005)
7. Truth graph fixes: `expire_reason` column, `merge_entities()` dedup logic (from migration 022)
8. Ontology restructure: tense pair merging, inverse syncing (from migration 023)
9. Dynamic entity types: `entity_types`, `entity_type_history` tables (from migration 024)
10. Predicate staging: status, usage tracking, promotion columns (from migration 025)
11. Indexes: HNSW for entity/fact embeddings, trigram for entity names, temporal for facts
12. Seed data: 69 canonical predicates across 7 categories, 7 entity types (person, company, project, concept, place, event, other)

**Phase B additions** (can be in same file or as `002_causal_graph.sql`):
1. `causal_graph` AGE graph creation
2. `causal_events` table with indexes
3. `causal_edges` table with indexes + unique constraint
4. `causal_patterns` table with indexes
5. AGE sync triggers for causal events and edges
6. Causal graph helper functions

---

## 10. Test Strategy

```d2
direction: down

integration: "Integration Tests\n(DB + Qdrant required, ML required)" {
  shape: hexagon
  style.fill: "#fff3cd"
  style.opacity: 0.4
  t1: "Entity resolution convergence"
  t2: "Entity concurrency protection"
  t3: "Fact supersession chains"
  t4: "Fact deduplication"
  t5: "AGE graph sync verification"
  t6: "Predicate ontology sync"
  t7: "Entity specificity filtering"
}

pipeline: "Pipeline Tests\n(DB + Qdrant + ML required)" {
  shape: hexagon
  style.fill: "#f8d7da"
  style.opacity: 0.4
  t1: "ingest(hand_crafted_text) → verify entities + facts"
  t2: "ingest(same_text_twice) → verify entity dedup"
  t3: "ingest(multi_text_same_characters) → verify resolution"
  t4: "ingest(first_person_narrative) → verify subject matching"
  t5: "store() then extract() separately → verify decoupling"
  t6: "Timing benchmarks per pipeline stage"
}

causal: "Causal Agent Tests [Phase B]\n(DB + Qdrant + ML + Anthropic required)" {
  shape: hexagon
  style.fill: "#cce5ff"
  style.opacity: 0.4
  t1: "Explicit causality: 'X because Y' → causal edge"
  t2: "Reasoning quality: edge has non-empty reasoning"
  t3: "Source traceability: edge references specific memories/facts"
  t4: "Multi-input: 3 texts → causal agent connects across memories"
  t5: "Chain traversal: traceCauses() returns correct chain"
  t6: "No hallucination: ambiguous input → no false causal edges"
}

regression: "Frankenstein Regression\n(10-chunk baseline)" {
  shape: hexagon
  style.fill: "#d4edda"
  style.opacity: 0.4
  t1: "0 duplicate entities (was 15 excess rows)"
  t2: "<7% subject mismatch (was 48%)"
  t3: "<3 vague entities (was ~15)"
  t4: "0 exact duplicate facts (was 1)"
  t5: "Wider predicate coverage (was 14/47)"
}

integration -> pipeline: "pass"
pipeline -> regression: "pass"
regression -> causal: "Phase B"
```

### Test Data

**Hand-crafted scenarios** (deterministic validation — we know exactly what the output should be):
```
"John Smith works at Acme Corp in London."
→ Entities: John Smith (person), Acme Corp (company), London (place)
→ Facts: John Smith works_at Acme Corp, Acme Corp located_in London

"John quit Acme because his boss was toxic. He now works at GlobalTech."
→ Entities: John Smith (resolved to existing), Acme Corp (resolved), GlobalTech (new)
→ Facts: John Smith works_at Acme Corp (invalidated), John Smith works_at GlobalTech (new)
→ Causal edge [Phase B]: boss_toxic → quit_acme (explicit, strength ~0.9)
```

**Frankenstein chunks** (real-world complexity — compare against `truth-graph-findings.md` baseline):
- 10 chunks from Project Gutenberg Frankenstein text
- Existing baseline metrics document expected improvement targets

### Test Infrastructure Reuse

The existing test setup (`src/test/setup.ts`) provides:
- `testDb` — direct PostgreSQL connection to `cognitive_test` database
- `createTestEntity()`, `createTestFact()` — direct DB writes bypassing services
- `randomEmbedding()`, `normalizeVector()`, `cosineSimilarity()` — vector utilities
- `isMLServiceAvailable()` — graceful check before ML-dependent tests
- `deleteFromTables()` — parallel-safe cleanup (DELETE not TRUNCATE)
- Extension availability gating (`hasVectorExtension`, `hasTrgmExtension`)

The existing test generators (`src/test/generators/`) provide:
- Realistic entity generation by type with aliases and properties
- Fact generation with supersession chains and contradictions
- Memory generation with mention tracking and position data

---

## 11. Iteration Loop

```d2
direction: right

edit: "Edit service code" {
  shape: step
}

test: "pnpm vitest run\nsrc/test/harness/" {
  shape: step
}

ingest: "CLI harness:\npnpm tsx src/harness.ts\n'some text'" {
  shape: step
}

inspect: "Inspect graph:\npsql queries\nCypher queries\nQdrant search" {
  shape: step
}

edit -> test: "< 5s"
test -> ingest: "< 30s\n(with ML)"
ingest -> inspect: "immediate"
inspect -> edit: "see what's wrong"
```

### Running the Sparse Branch

```bash
# Terminal 1: Infrastructure (Docker)
make up  # Starts PostgreSQL + Qdrant (Ollama runs on host)

# Terminal 2: ML services (Python)
cd ml-services && make ml  # Starts FastAPI on port 8000

# Terminal 3: Development
cd platform

# Run the CLI harness
pnpm tsx src/harness.ts "Robert Walton writes to his sister Margaret Saville from St. Petersburgh."

# Pipe a file
pnpm tsx src/harness.ts < test-data/frankenstein-chunk-001.txt

# Run tests
pnpm vitest run src/test/harness/

# Run just the regression
pnpm vitest run src/test/harness/frankenstein.test.ts

# Inspect the graph
psql -h localhost -p 5433 -U cognitive -d cognitive -c "SELECT canonical_name, entity_type FROM entities ORDER BY created_at DESC LIMIT 20;"
psql -h localhost -p 5433 -U cognitive -d cognitive -c "SELECT * FROM ag_catalog.cypher('knowledge_graph', \$\$MATCH (a)-[r]->(b) RETURN a.name, type(r), b.name LIMIT 20\$\$) as (a agtype, r agtype, b agtype);"
```

---

## 12. Implementation Phases

### Phase A: Graph S Hardening

| Step | What | Files | Depends On |
|------|------|-------|------------|
| A1 | Strip codebase — delete noise directories, strip config/schema/ml-client/qdrant | All files in "Delete" and "Keep" lists above | — |
| A2 | Create consolidated migration (`001_consolidated.sql`) | `src/db/migrations/001_consolidated.sql` | A1 |
| A3 | Verify TypeScript compiles | `pnpm typecheck` | A1 |
| A4 | Create `pipeline.ts` with `store()`, `extract()`, `ingest()` | `src/pipeline.ts` | A1, A2 |
| A5 | Create `harness.ts` CLI entry point | `src/harness.ts` | A4 |
| A6 | Apply entity concurrency fix — advisory lock or ON CONFLICT in `createEntity()` | `src/services/entities.ts` | A1 |
| A7 | Apply entity specificity filter — post-extraction filter | `src/pipeline.ts` (in `extract()`) | A4 |
| A8 | Apply entity context windowing — use mention positions for embedding context | `src/services/entities.ts:resolveEntity()` | A1 |
| A9 | Apply relationship matching fix — multi-tier fuzzy matching | `src/pipeline.ts` (in `extract()`) | A4 |
| A10 | Apply fact dedup fix — pre-insert check | `src/services/facts.ts:createFact()` | A1 |
| A11 | Write integration tests | `src/test/harness/entity-resolution.test.ts`, `fact-creation.test.ts` | A6-A10 |
| A12 | Write pipeline tests with hand-crafted scenarios | `src/test/harness/pipeline.test.ts` | A4, A5 |
| A13 | Run Frankenstein 10-chunk regression | `src/test/harness/frankenstein.test.ts` | A11, A12 |
| A14 | Iterate on fixes until regression passes | All service files | A13 |

### Phase B: Graph C (Causal Layer)

| Step | What | Files | Depends On |
|------|------|-------|------------|
| B1 | Add causal tables to migration (or create `002_causal_graph.sql`) | Migration file | A14 (Graph S solid) |
| B2 | Add causal table definitions to `db/schema.ts` | `src/db/schema.ts` | B1 |
| B3 | Create `services/causal.ts` — Graph C query/write functions | `src/services/causal.ts` | B1, B2 |
| B4 | Extend `services/facts.ts` — create causal events on fact create/expire/invalidate | `src/services/facts.ts` | B3 |
| B5 | Extend `services/graph.ts` — add `causal_graph` queries | `src/services/graph.ts` | B1 |
| B6 | Create `services/graph-mcp.ts` — MCP server exposing the GRAPH_TOOLS catalogue (currently 38) | `src/services/graph-mcp.ts` | B3, B4, B5 |
| B7 | Create `services/causal-agent.ts` — Claude Code invocation via `-p` with MCP config, system prompt | `src/services/causal-agent.ts` | B6 |
| B8 | Extend `pipeline.ts` — call causal agent after extract() | `src/pipeline.ts` | B7 |
| B9 | Add `CLAUDE_CODE_PATH` to config | `src/config.ts` | B6 |
| B10 | Write causal agent tests with hand-crafted scenarios | `src/test/harness/causal-agent.test.ts` | B7, B8 |
| B11 | Write causal chain traversal tests | `src/test/harness/causal-chains.test.ts` | B10 |
| B12 | Validate reasoning quality and source traceability | Manual inspection + assertions in tests | B10, B11 |

---

## 13. Final File Structure

```
platform/src/
├── config.ts                                  # Minimal config (DB, Qdrant, ML, Anthropic)
├── harness.ts                                 # CLI entry point
├── pipeline.ts                                # store(), extract(), ingest()
│
├── db/
│   ├── index.ts                               # Drizzle DB connection
│   ├── raw.ts                                 # Raw SQL helper
│   ├── schema.ts                              # Stripped to 10 tables (7 Phase A + 3 Phase B)
│   └── migrations/
│       ├── 001_consolidated.sql               # Graph S tables + AGE + predicates + entity types
│       └── 002_causal_graph.sql               # Graph C tables + causal_graph AGE [Phase B]
│
├── services/
│   ├── entities.ts                            # Entity resolution (hardened)
│   ├── facts.ts                               # Bi-temporal facts (deduped, creates causal events in Phase B)
│   ├── predicates.ts                          # Ontology normalization
│   ├── graph.ts                               # AGE queries (knowledge_graph + causal_graph)
│   ├── ml-client.ts                           # HTTP client (embed, extractEntities, extractRelationships)
│   ├── qdrant.ts                              # Qdrant client (storeMemory, searchMemories, getMemory)
│   ├── causal.ts                              # Graph C service [Phase B]
│   └── causal-agent.ts                        # Haiku tool-use agent [Phase B]
│
└── test/
    ├── setup.ts                               # Existing test helpers (reused as-is)
    ├── global-setup.ts                        # Existing global setup (reused as-is)
    ├── generators/                            # Existing generators (reused as-is)
    │   ├── entity.ts
    │   ├── fact.ts
    │   └── memory.ts
    ├── fixtures/                              # Existing fixtures (reused as-is)
    │   └── minimal-seed.ts
    └── harness/                               # NEW — sparse branch tests
        ├── entity-resolution.test.ts          # Convergence, dedup, concurrency
        ├── fact-creation.test.ts              # Bi-temporal, supersession, dedup
        ├── pipeline.test.ts                   # Full ingest() with hand-crafted texts
        ├── frankenstein.test.ts               # 10-chunk regression baseline
        ├── causal-agent.test.ts               # Haiku reasoning quality [Phase B]
        └── causal-chains.test.ts              # Multi-input chain traversal [Phase B]
```
