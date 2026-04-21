# Mnemo Platform — Comprehensive Codebase Analysis

**Date:** April 16, 2026  
**Branch:** `feat/sparse-truth-graph`  
**Status:** Phase A (Graph S Hardening) + Phase B (Graph C Causal Layer)

---

## Executive Summary

The Mnemo Platform is a **dual-graph knowledge system** for extracting and reasoning over temporal facts and causal relationships from natural language documents. It consists of:

1. **Graph S** (Temporal State Graph): Entities, bi-temporal facts, and their history via Apache AGE
2. **Graph C** (Causal Graph): Causal events, causal edges with LLM reasoning, and meta-causal patterns
3. **Graph M** (Meta Layer): Entity statistics, merge candidate detection, and reconciliation signals

The system ingests raw text → embeds + stores in Qdrant → extracts entities/facts via ML service → **optionally invokes Claude Haiku** for causal reasoning → stores all findings in PostgreSQL.

---

## Architecture Overview

### Three-Layer Design

#### **Graph S: Temporal Knowledge Graph**
- **Canonical entities** with embeddings, types, aliases, merge history
- **Bi-temporal facts**: `valid_at/invalid_at` (when true in reality) + `created_at/expired_at` (when recorded)
- **Entity merges**: Audit trail of deduplication operations
- **Memory links**: Cross-references to Qdrant source texts
- **Fact predicates**: 40+ canonical predicates organized into 7 categories

#### **Graph C: Causal Graph**
- **Causal events**: State transitions (created/strengthened/weakened/expired/invalidated)
- **Causal edges**: Directed links with **mandatory reasoning + source_references (JSONB)**
- **Causal patterns**: Recurring chain archetypes (staging → candidate → provisional → canonical)
- **Apache AGE**: Graph index for traversal queries (cypher-based)

#### **Graph M: Meta Layer**
- **Entity meta**: Mention count, source memory count, fact count, centroid vector, spread
- **Merge candidates**: Three-signal detection (centroid similarity + memory overlap + structural similarity)
- **Same-as links**: Non-destructive identity links for narrative ambiguity (e.g., "the stranger" vs "Victor Frankenstein")
- **Reconciliation reports**: Stored extraction traces for agent consumption

---

## Core Data Flow

### Pipeline: Synchronous, Three-Phase

```typescript
ingest(text) → store(text) → extract(memoryId) [→ optional causal-agent]
```

**Phase 1: Store**
- Embed text via Ollama (nomic-embed-text, 768-dim)
- Write to Qdrant with UUID + vector + metadata
- Return `memoryId`

**Phase 2: Extract**
- Fetch source text from Qdrant
- Invoke **unified graph agent** (Haiku via Claude Code CLI)
- Agent runs 5 phases: ORIENT → EXTRACT → RELATE → CAUSE → VERIFY
- Agent creates entities/facts/causal events directly via MCP tool calls
- Query DB for created entities/facts, compute entity meta, detect merge candidates

**Phase 3: Reconciliation (Optional)**
- If merge candidates or unconfirmed aliases exist, trigger **reconciliation agent**
- Fire-and-forget pattern (never blocks extraction)

### Conditional Causal Trigger (B07)

Causal agent runs **only when**:
- (a) Entities have existing causal history in Graph C, **OR**
- (b) >3 facts were created, **OR**
- (c) Source text contains explicit causal language ("because", "led to", etc.)

---

## Database Schema

### PostgreSQL with pgvector, pg_trgm, Apache AGE

#### **001_consolidated.sql** — Graph S tables (Phase A)

**Core Tables:**
- `entities`: UUID, canonical_name, entity_type, embedding (pgvector 768), confidence, merged_from[], timestamps
- `entity_aliases`: Alternative names with type (name/role/reference/pronoun/unconfirmed)
- `entity_merges`: Audit trail of destructive entity deduplication
- `facts`: subject_id, predicate, object_id/object_value, valid_at/invalid_at, created_at/expired_at, embedding
- `memory_entities`: Link Qdrant memories to entities with mention context
- `fact_predicates`: 40+ canonical predicates (works_at, knows, lives_in, etc.) with inverse relationships
- `entity_types`: Dynamic registry (canonical/provisional/deprecated)
- `entity_type_history`: Bi-temporal typing

**Indexes:**
- Trigram on entity/alias names
- HNSW on embeddings (pgvector)
- Active facts (expires_at IS NULL)
- Temporal ranges

#### **002_causal_graph.sql** — Graph C tables (Phase B)

**New Tables:**
- `causal_events`: fact_id, transition_type, subject_entity_id, predicate, delta_confidence, occurred_at, embedding
- `causal_edges`: cause_event_id, effect_event_id, strength [0.0-1.0], **reasoning TEXT NOT NULL**, **source_references JSONB NOT NULL**, temporal_span, corroboration_count, decay_applied
- `causal_patterns`: Archetype templates with topology (linear/loop/convergent/divergent)
- Apache AGE `causal_graph`: Cypher-based traversal index

**Constraints:**
- No self-loops in edges
- Mandatory reasoning + source_references for every edge
- Strength ∈ [0.0, 1.0]

#### **003_graph_meta.sql** — Entity statistics

- `entity_meta`: entity_id, mention_count, source_memory_count, fact_count, centroid (pgvector), spread, first/last_mentioned_at
- Computed from `memory_entities` and `facts`

#### **004_entity_summary.sql** — Entity profiles

- Stores `entity_meta.summary`: Natural language description of entity state + narrative role + unresolved ambiguities

#### **005_reconciliation.sql** — Same-as links + extraction reports

- `same_as_links`: entity_a_id, entity_b_id, reasoning, source_evidence (JSONB), confidence, created_by
- `extraction_reports`: memoryId, reportText (full agent trace for reconciliation)
- `merge_candidates`: entity_a_id, entity_b_id, centroid_similarity, memory_overlap, structural_similarity, combined_score, status, detection_count

---

## TypeScript Services Architecture

### Core Services (src/services/)

#### **entities.ts** — Entity Management
- `createEntity()`: Create with embedding, advisory lock, dedup check
- `findSimilarEntities()`: pgvector similarity search
- `findEntitiesByName()`: Trigram fuzzy match
- `resolveEntity()`: Find or create, with embedding-based resolution
- Thresholds: >0.92 auto-merge, 0.75-0.92 needs LLM, <0.75 new entity

#### **facts.ts** — Bi-temporal Fact Management
- `createFact()`: Insert with supersession detection for exclusive predicates (lives_in, works_at)
- `expireFact()`: Mark as incorrect in records, creates causal event
- `invalidateFact()`: Mark as no longer true in reality
- `findSupersedingFacts()`: Find overlapping facts temporally
- Auto-emits causal events on fact state changes

#### **causal.ts** — Graph C Write/Read Functions
- `createCausalEdge()`: Validates reasoning, source_references, event existence
- `traceCauses()`: Walk backward from fact's event to root causes via recursive CTE
- `projectTrajectory()`: Walk forward to downstream effects

#### **qdrant.ts** — Vector Store
- `storeMemory()`: Embed + upsert to Qdrant
- `searchMemories()`: Semantic search
- `getMemory()`: Retrieve by ID
- `getMemoryVectors()`: Bulk retrieve for entity centroid computation
- Collection: "memories" with 768-dim cosine distance

#### **graph.ts** — Apache AGE Traversal
- `getAllEdges()`: Cypher query with type filter
- `getEntityDegrees()`: In/out edge counts per entity
- `getSubgraph()`: BFS around seed entities
- `findConnectedEntities()`: Neighbor discovery
- Pattern: Cypher queries executed via `cypher()` function with `ag_catalog.knowledge_graph`

#### **graph-meta.ts** — Entity Statistics + Merge Detection
- `updateEntityMeta()`: Compute mention count, memory count, fact count, centroid, spread
- `detectMergeCandidates()`: Three-signal scoring:
  - 0.3 × centroid_similarity (pgvector cosine)
  - 0.4 × memory_overlap (Jaccard)
  - 0.3 × structural_similarity (shared outgoing facts)
- Thresholds: >0.4 staging, >0.7 candidate
- `getMergeCandidates()`: Query ranked candidates

#### **causal-agent.ts** — Tool Definitions + Dispatch
- **18 MCP-compatible tools** across 4 categories:
  - **Query tools** (7): query_entity_facts, query_entity_neighbours, search_similar_entities, search_memories, get_memory_text, get_causal_history, get_fact_source
  - **Extraction tools** (5): resolve_entity, create_fact, get_entity_sources, link_entity_to_memory, add_entity_alias, search_entity_aliases, update_entity_summary
  - **Reconciliation tools** (5): create_same_as_link, execute_merge, resolve_candidate, get_reconciliation_context
  - **Factory tools** (1): create_causal_edge
- `handleToolCall()`: Dispatch tool name to handler, return JSON string

#### **causal-mcp.ts** — MCP Server (Standalone Subprocess)
- Exposes 7 tools via stdio to Claude Code CLI
- Connects: `claude -p <prompt> --mcp-config causal-mcp.json`

#### **causal-trigger.ts** — Conditional Trigger (B07)
- `shouldRunCausalAgent()`: Evaluate conditions (a) existing history, (b) fact count, (c) causal language
- Fast path: check (c) first (no DB), then (b), then (a) only if needed

#### **ml-client.ts** — ML Service Client
- Retry logic: 3 attempts with backoff [500ms, 1000ms]
- `embed()`: Text → 768-dim vector via Ollama
- `extractEntities()`: NER via Python FastAPI service
- `extractRelationships()`: Relationship extraction

#### **predicates.ts** — Predicate Registry
- `normalizePredicate()`: Canonicalize (aliases → canonical)
- `recordPredicateUsage()`: Track for living ontology
- `getValidPredicates()`: Current canonical set

---

### HTTP Server (index.ts) — Hono Framework

**Endpoints:**
- `POST /ingest` → Full pipeline (store + extract)
- `POST /store` → Store only, return memoryId
- `POST /extract` → Extract only (needs memoryId)
- `POST /ingest/queue` → Enqueue for serial processing (FIFO)
- `GET /viz` → Graph visualization dashboard
- `GET /api/viz/*` → Data endpoints for viz (entities, facts, events, edges, merge candidates)
- `POST /api/viz/run-meta` → Compute entity meta + detect candidates (idempotent)
- `POST /api/reset` → Clear PostgreSQL + Qdrant
- `GET /api/viz/stats` → Entity/fact/event/edge counts

---

## Python ML Services (FastAPI, Port 8000)

### Core Services

#### **embed.py**
- POST `/embed`: Text → embedding via Ollama (nomic-embed-text)
- Timeout: 600s

#### **extract_entities.py**
- POST `/extract-entities`: NER with optional known_entities + valid_types constraints
- Returns: mention, type, confidence, span positions

#### **extract_relationships.py** (relationships.py)
- POST `/extract-relationships`: Relationship tuples from text + entity context
- Returns: subject, predicate, object, confidence, temporal_hint, source_text

#### **causal_reason.py** (Phase B)
- POST `/causal-reason`: Invokes Claude Code CLI with causal-mcp.json config
- Spawns subprocess with --mcp-config pointing to causal-mcp.ts server
- Returns: structured report from Claude

#### **graph_agent.py** (Phase B)
- POST `/graph-agent`: Unified extraction agent
- Calls Claude Code CLI with 5-phase system prompt (ORIENT → EXTRACT → RELATE → CAUSE → VERIFY)
- Full MCP tool access via causal-mcp

#### **reconciliation_agent.py** (Phase B)
- POST `/reconciliation-agent`: Reconciliation agent
- Consumes merge candidates + recent extraction reports
- Emits same_as_links or merge decisions

---

## Test Infrastructure (src/test/)

### Setup (setup.ts)
- `testDb`: Raw postgres client to cognitive_test database
- `createTestEntity()`: Factory for seeded entities
- `createTestFact()`: Factory for seeded facts
- `randomEmbedding()`: Generate 768-dim random vector
- `deleteFromTables()`: Parallel-safe cleanup (DELETE not TRUNCATE)
- Extension availability checks (pgvector, pg_trgm)
- ML service health checks

### Test Generators (generators/)
- `entity.ts`: Realistic entity generation with types
- `fact.ts`: Fact generation with predicates
- `memory.ts`: Memory/text generation

### Integration Tests (integration/)
- `database.test.ts`: Connection + schema
- `entity-resolution-convergence.test.ts`: Multi-round entity dedup
- `fact-supersession-chains.test.ts`: Exclusive predicate handling
- `entity-merge-cascade.test.ts`: Merge propagation
- `knowledge-graph.test.ts`: Graph traversal
- `hybrid-search.test.ts`: pgvector + Qdrant integration
- `qdrant.test.ts`: Vector store operations
- `ml-services.test.ts`: Embedding/extraction calls

### Harness Tests (harness/)
- `causal-schema.test.ts`: Graph C tables + triggers
- `causal-service.test.ts`: Write functions (createCausalEdge, traceCauses, projectTrajectory)
- `causal-agent-tools.test.ts`: Tool definitions + handlers (GRAPH_TOOLS array)
- `causal-trigger.test.ts`: Conditional trigger logic
- `causal-mcp.test.ts`: MCP server startup + tool listing
- `causal-quality.test.ts`: End-to-end quality checks
- `causal-chains.test.ts`: Complex causal chains
- `causal-integration.test.ts`: Full pipeline integration
- `frankenstein.test.ts` / `frankenstein-serial.test.ts`: Regression test vs "Frankenstein" novel

---

## Configuration & Deployment

### Environment (config.ts)
- `DATABASE_URL`: PostgreSQL connection (port 5433 in Docker)
- `QDRANT_URL`: Vector store (port 6335)
- `ML_SERVICES_URL`: FastAPI service (port 8000)
- `EMBED_MODEL`: Ollama model (nomic-embed-text, 768-dim)
- `ANTHROPIC_API_KEY`: For Phase B causal agent (optional in dev)
- `NODE_ENV`: development/production/test

### Docker (Dockerfile)
- Development stage: tsx watch src/index.ts
- Builder stage: tsc compilation
- Production stage: node dist/index.js (health checks enabled)
- Port: 3000

### Package.json (pnpm)
**Key dependencies:**
- `hono`: HTTP server
- `drizzle-orm`: PostgreSQL ORM
- `@modelcontextprotocol/sdk`: MCP server implementation
- `@qdrant/js-client-rest`: Vector store client
- `postgres`: Raw SQL client
- `zod`: Config validation

**Key scripts:**
- `pnpm dev`: Watch mode
- `pnpm build`: Compile TypeScript
- `pnpm test`: Vitest runner
- `pnpm db:migrate`: Run SQL migrations
- `pnpm db:push`: Drizzle schema push

---

## Key Design Decisions

### 1. Synchronous Pipeline, No Queue
- Direct function calls: store() → extract() → [optional causal-agent]
- Blocks on each phase (embedding, DB writes, agent invocation)
- Serializes via single drainQueue() worker for `/ingest/queue` endpoint
- **Why:** Maintains temporal ordering; no race conditions on fact dedup

### 2. Store Inline, Extract Lazy
- `store()`: Immediate Qdrant write (fast)
- `extract()`: Deferred entity/fact creation (can be called separately)
- `ingest()`: Both in sequence
- **Why:** Caller chooses: async storage vs full processing

### 3. Causal Agent via Claude Code CLI
- Not SDK-based; spawns subprocess with `claude -p <prompt>`
- Tools exposed via MCP server (causal-mcp.ts)
- **Why:** Model-agnostic; works with any LLM via MCP; easy to swap providers

### 4. Mandatory Reasoning + Source References
- `causal_edges.reasoning TEXT NOT NULL`
- `causal_edges.source_references JSONB NOT NULL`
- No edge created without traceability
- **Why:** Auditability; human-readable justification for every causal link

### 5. Same-As Links vs Merges
- **Merge**: Destructive; facts + aliases re-pointed to survivor; source deleted
- **Same-As**: Non-destructive; identity link preserves both entities with distinct narrative roles
- **Example:** "the stranger" (Walton's description) vs "Victor Frankenstein" (self-narrator)
- **Why:** Captures narrative ambiguity without losing data

### 6. Three-Signal Merge Candidate Detection
1. **Centroid similarity**: pgvector cosine distance of source memory vectors
2. **Memory overlap**: Jaccard similarity of source memory sets
3. **Structural similarity**: Shared outgoing facts (predicate | object)
- **Combined score**: 0.3 × centroid + 0.4 × overlap + 0.3 × structural
- **Why:** Triangulates dedup without false positives

### 7. Apache AGE as Traversal Index
- Cypher queries via `cypher()` function
- Does **not** persist edge properties (silently drops SET)
- Canonical data lives in PostgreSQL; AGE is read-only index
- **Why:** PostgreSQL is source of truth; AGE speeds neighbor discovery

### 8. Bi-temporal Facts
- `valid_at / invalid_at`: When true in reality
- `created_at / expired_at`: When recorded/corrected
- Queries can ask "what was true at point T"
- **Why:** Handles historical corrections; temporal reasoning

---

## File Inventory

### Source Structure (src/)
```
src/
├── index.ts                           # HTTP server (Hono)
├── pipeline.ts                        # Core ingest/store/extract
├── config.ts                          # Environment validation
├── harness.ts                         # Reusable logic for tests
├── db/
│   ├── index.ts                       # Drizzle client
│   ├── schema.ts                      # Table definitions
│   ├── raw.ts                         # Raw SQL helpers
│   ├── migrate.ts                     # Migration runner
│   └── migrations/
│       ├── 001_consolidated.sql       # Graph S (7 tables + AGE setup)
│       ├── 002_causal_graph.sql       # Graph C (3 tables)
│       ├── 003_graph_meta.sql         # Entity meta
│       ├── 004_entity_summary.sql     # Entity summaries
│       └── 005_reconciliation.sql     # Same-as links + reports
├── services/
│   ├── entities.ts                    # Entity CRUD + resolution
│   ├── facts.ts                       # Fact CRUD + supersession
│   ├── causal.ts                      # Graph C write/read
│   ├── graph.ts                       # AGE traversal
│   ├── graph-meta.ts                  # Statistics + merge detection
│   ├── causal-agent.ts                # 18 tool definitions + dispatch
│   ├── causal-mcp.ts                  # MCP server subprocess
│   ├── causal-trigger.ts              # Conditional trigger logic
│   ├── ml-client.ts                   # ML service HTTP client
│   ├── qdrant.ts                      # Vector store client
│   ├── predicates.ts                  # Predicate normalization
│   ├── entity-profile.ts              # Entity summaries
│   ├── entity-reclassification.ts     # Type changes
│   └── graph-mcp.ts                   # (Legacy/placeholder)
├── utils/
│   ├── context-uuid.ts                # Request context tracking
│   ├── format.ts                      # String formatting
│   └── interval-parser.ts             # ISO 8601 duration parsing
└── test/
    ├── setup.ts                       # Test DB + utilities
    ├── global-setup.ts                # Global test hooks
    ├── generators/                    # Entity/fact factories
    ├── fixtures/                      # Test data seeds
    ├── integration/                   # Integration test suite
    ├── harness/                       # Harness test suite (Phase A/B)
    ├── quality/                       # Quality/golden tests
    ├── e2e/                           # End-to-end tests
    └── benchmarks/                    # Performance benchmarks
```

### ML Services Structure (ml-services/)
```
ml-services/
├── app/
│   ├── main.py                        # FastAPI app setup
│   ├── embed.py                       # Embedding endpoint
│   ├── extract_entities.py            # NER endpoint
│   ├── relationships.py               # Relationship extraction
│   ├── causal_reason.py               # Causal reasoning (Phase B)
│   ├── graph_agent.py                 # Unified graph agent (Phase B)
│   ├── reconciliation_agent.py        # Reconciliation agent (Phase B)
│   ├── core/
│   │   ├── llm.py                     # Claude Code CLI provider
│   │   └── concurrency.py             # Thread pool management
│   └── [other services...]
├── requirements.txt
└── Makefile
```

---

## Workflow: How Everything Connects

### Example: Ingest Frankenstein Text

1. **HTTP POST /ingest**
   ```json
   {
     "text": "Robert Walton writes to his sister about meeting a stranger who tells a tragic tale...",
     "source": "frankenstein-letters"
   }
   ```

2. **Store Phase** (pipeline.ts `store()`)
   - Embed text via `ml.embed()` → Ollama (768-dim)
   - Upsert to Qdrant with metadata
   - Return memoryId = "abc-123-def"

3. **Extract Phase** (pipeline.ts `extract()`)
   - Fetch memory from Qdrant
   - Invoke `invokeGraphAgent()` via Claude Code CLI
     - MCP config points to causal-mcp.ts server
     - Agent can call 18 tools via MCP
   - Agent executes:
     - `search_entity_aliases("the stranger")` → May find existing entities
     - `resolve_entity("Robert Walton", "person", context)` → Create or reuse
     - `create_fact(robert_id, "knows", stranger_id, 0.9, ...)` → Stores fact + causal event
     - `update_entity_summary(robert_id, "Narrator of letters...")` → Stores to entity_meta
   - Agent emits MCP results; pipeline collects created entities/facts

4. **Meta + Candidates** (pipeline.ts `extract()` continuation)
   - `updateEntityMeta([entities])`: Compute centroid, spread
   - `detectMergeCandidates([entities])`: Compare against all eligible entities
     - If Robert Walton + R. Walton have >0.7 combined score → candidate created
   - If candidates exist: trigger reconciliation agent (fire-and-forget)

5. **Reconciliation** (optional, pipeline.ts)
   - Reconciliation agent reads candidates + recent extraction reports
   - Calls `create_same_as_link()` or `execute_merge()` or `resolve_candidate()`
   - Results: identity links or destructive merges

6. **Response**
   ```json
   {
     "memoryId": "abc-123-def",
     "entities": [
       { "id": "eid-1", "canonicalName": "Robert Walton", "isNew": false, "confidence": 1.0 },
       { "id": "eid-2", "canonicalName": "the stranger", "isNew": true, "confidence": 0.85 }
     ],
     "facts": [
       { "id": "fid-1", "subject": "Robert Walton", "predicate": "knows", "object": "the stranger", "confidence": 0.9 }
     ],
     "timing": { "graphAgent": 12450, "graphMeta": 340, "reconciliation": 0, "total": 13200 },
     "reconciliation": { "triggered": true, "report": "..." }
   }
   ```

---

## Phase A vs Phase B Status

### Phase A: Graph S Hardening (In Progress)
- ✅ Consolidated 001 migration (7 tables + AGE)
- ✅ Entity resolution with embedding-based dedup
- ✅ Fact supersession for exclusive predicates
- ✅ Merge candidate detection (3-signal)
- ✅ Memory links + entity meta
- ✅ 15 issues tracked in beads
- ⏳ Frankenstein regression test (blocks Phase B)

### Phase B: Graph C Causal Layer (Staged)
- ✅ Causal schema (002 migration: causal_events, causal_edges, causal_patterns)
- ✅ Causal edge write (validatedreasoning + source_references)
- ✅ Causal event creation (sync to AGE, track transitions)
- ✅ Causal query (traceCauses, projectTrajectory recursive CTEs)
- ✅ Graph agent tools (GRAPH_TOOLS: 18 tools, MCP-compatible)
- ✅ Causal MCP server (causal-mcp.ts subprocess)
- ✅ Causal trigger (conditional execution logic)
- ✅ Unified graph agent (invokeGraphAgent via Claude Code CLI)
- ✅ Reconciliation agent (invokeReconciliationAgent)
- ⏳ Frankenstein full pipeline (causal reasoning trace)
- 🔒 **GATE Issue**: Phase B blocked until Phase A passes Frankenstein regression

---

## Known Gotchas

### 1. Apache AGE search_path
- `001_consolidated.sql` sets `SET search_path = ag_catalog, public, "$user"` at session level
- This persists! Don't override in `002_causal_graph.sql`
- New DDL must use explicit `public.` schema qualifiers (e.g., `public.causal_edges`)
- AGE edge properties don't persist via SET; use only node properties for mutations

### 2. Qdrant Vector Dimensions
- Fixed at collection creation: 768-dim (nomic-embed-text)
- Mismatch → upsert fails
- Config maps known models to dimensions; new models need explicit EMBED_DIMENSIONS

### 3. Fact Dedup
- Triple match (subject, predicate, object) → returns existing ID, updates confidence
- **No** automatic merge of higher-confidence versions; confidence MAX used
- Exclusive predicates trigger old fact expiration

### 4. Entity Merges
- Destructive! Source entity deleted, facts/aliases/events re-pointed to target
- Use same_as_link for non-destructive identity relationships
- Merge audit trail in `entity_merges` table

### 5. Test Parallelism
- Use `deleteFromTables()` not `truncate()` for parallel-safe cleanup
- Truncate uses table-level exclusive locks (blocks other tests)
- Delete uses row-level locks (compatible with parallel)

### 6. ML Service Timeouts
- Default 600s for all endpoints
- Retries on 502/503/504 with backoff [500ms, 1000ms]
- 3 attempts max; exhausted → MlClientError

---

## How to Extend

### Add a New Entity Type
1. Insert into `entity_types` table
2. Call `invalidateEntityTypeCache()` in entities.ts
3. Causal agent will recognize on next extraction

### Add a New Predicate
1. Insert into `fact_predicates` with is_exclusive, inverse_predicate, category
2. Tests can use immediately (no cache)
3. Predicate normalization handles aliases automatically

### Add a New Causal Tool
1. Add tool definition to GRAPH_TOOLS array in causal-agent.ts
2. Implement handler in `_handleToolCallInner()` switch
3. Handler must return JSON string (causal-mcp.ts wraps in response)
4. Test with causal-agent-tools.test.ts

### Add a New Migration
1. Create `00N_name.sql` in src/db/migrations/
2. Use explicit `public.` schema qualifiers
3. Run `pnpm db:migrate` to apply
4. Don't change `search_path` if AGE is involved

---

## Performance Considerations

### Hot Paths
- Entity lookup: pgvector HNSW index on embedding
- Fact lookup: Index on (subject_id, predicate, expired_at)
- Memory links: Index on entity_id + memory_id
- Causal query: Recursive CTE with depth limit

### Optimization Opportunities
- Batch entity updates (currently per-entity in updateEntityMeta)
- Cache entity_types in-memory (already 1-minute TTL)
- Parallelize unrelated tool calls in causal agent

### Bottlenecks
- ML service (embed/extract) — slowest; no local fallback
- Causal agent invocation (subprocess spawn) — ~12s overhead
- Qdrant semantic search — scales with collection size

---

## Testing Strategy

### Unit Tests
- Tool definitions: schema validation, required fields
- Handlers: single tool in isolation with test data
- Predicates: normalization, alias resolution

### Integration Tests
- Database: schema, triggers, FK constraints, temporal queries
- Vector store: upsert, search, retrieve
- ML service: embed, extract endpoints
- Graph traversal: Cypher queries, AGE index

### Harness Tests
- Full pipeline: ingest → store → extract → meta → candidates → reconciliation
- Causal reasoning: edge creation, traceability, source refs
- Conditional trigger: conditions (a/b/c) tested independently

### Quality Tests (Frankenstein)
- Real-world text: Frankenstein novel chapters
- Regression: verified entity/fact/causal outputs
- Blocks Phase B until passing

---

## Conclusion

The Mnemo Platform is a **sophisticated, production-grade knowledge extraction system** combining:
- **Temporal reasoning** (bi-temporal facts)
- **Entity deduplication** (multi-signal merge detection)
- **Causal reasoning** (LLM-driven with auditability)
- **Vector-semantic search** (Qdrant + pgvector)
- **Graph traversal** (Apache AGE)
- **Narrative ambiguity handling** (same-as links)

The **dual-graph design** (Graph S + Graph C) cleanly separates state from causality, enabling rich temporal knowledge representation with causal chains fully traceable to source documents.

---

**Document generated:** 2026-04-16  
**Codebase snapshot:** feat/sparse-truth-graph branch  
**Status:** Phase A (hardening) + Phase B (causal layer, blocked by GATE)
