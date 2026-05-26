# Graph C — Technical Design

**Status:** Design now, build after Graph S hardening
**Depends on:** [Graph S Hardening](02-graph-s-hardening.md) — all critical bugs fixed
**Architecture context:** [Dual-Graph Architecture](01-dual-graph-architecture.md)

---

## 1. Data Model

### 1.1 Core Tables

Graph C introduces three new PostgreSQL tables alongside the existing `facts`, `entities`, and `fact_predicates` tables.

#### `causal_events` — State Transitions in Graph S

A causal event records that something changed in Graph S. It is the node type of Graph C.

```sql
CREATE TABLE causal_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What changed in Graph S
  fact_id           UUID REFERENCES facts(id),
  transition_type   VARCHAR(20) NOT NULL,  -- created | strengthened | weakened | expired | invalidated
  
  -- Transition metadata
  subject_entity_id UUID REFERENCES entities(id),      -- the entity affected
  predicate         VARCHAR(255),                        -- the relationship that changed
  delta_confidence  FLOAT,                               -- how much confidence changed (signed)
  
  -- Temporal
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when the transition happened
  
  -- Embedding for similarity search
  event_embedding   VECTOR(768),
  
  -- Provenance
  source_memory_id  UUID,                                -- the input that triggered this transition
  source_text       TEXT,                                 -- relevant excerpt
  
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index: temporal lookups
CREATE INDEX idx_causal_events_occurred ON causal_events (occurred_at DESC);

-- Index: by entity (for "what transitions affected entity X?")
CREATE INDEX idx_causal_events_entity ON causal_events (subject_entity_id, occurred_at DESC);

-- Index: by fact (for "what transitions relate to fact X?")
CREATE INDEX idx_causal_events_fact ON causal_events (fact_id);

-- Index: embedding similarity (HNSW)
CREATE INDEX idx_causal_events_embedding ON causal_events
  USING hnsw (event_embedding vector_cosine_ops);
```

**`transition_type` values:**
- `created` — A new fact appeared in Graph S
- `strengthened` — An existing fact's confidence increased (new corroborating evidence)
- `weakened` — An existing fact's confidence decreased (contradicting evidence)
- `expired` — A fact was marked as wrong (transaction time: `expired_at` set)
- `invalidated` — A fact ceased to be true (event time: `invalid_at` set)

```d2
direction: right

graph_s: "Graph S (facts table)" {
  style.fill: "#d4edda"
  style.opacity: 0.4
  f1: "fact: John works_at Acme\n(created 2024-01)"
  f2: "fact: John works_at Acme\n(expired 2024-09)"
  f3: "fact: John works_at GlobalTech\n(created 2024-09)"
}

graph_c: "Graph C" {
  style.fill: "#fff3cd"
  style.opacity: 0.4
  events: "Causal Events (nodes)" {
    e1: "created: John works_at Acme"
    e2: "expired: John works_at Acme"
    e3: "created: John works_at GlobalTech"
  }
  edges: "Causal Edges" {
    style.fill: "#e8f4fd"
  style.opacity: 0.4
    r1: "Boss toxicity → John quit\nstrength: 0.85\nreasoning: 'Boss described as toxic\nin memory xyz, temporal proximity...'\nsources: [memory:abc, fact:def, entity:ghi]"
  }
  events.e1 -> events.e2: "caused_by\n(external)" {style.stroke-dash: 3}
  events.e2 -> events.e3: "caused_by\n(supersession)"
}

graph_s.f1 -> graph_c.events.e1: "transition" {style.stroke-dash: 3}
graph_s.f2 -> graph_c.events.e2: "transition" {style.stroke-dash: 3}
graph_s.f3 -> graph_c.events.e3: "transition" {style.stroke-dash: 3}
```

Each fact change in Graph S creates a causal event node in Graph C. The causal agent then reasons about which events caused which, creating edges with full reasoning and source traceability.

#### `causal_edges` — Directed Causal Links

A causal edge asserts that one transition caused another. This is the edge type of Graph C.

```sql
CREATE TABLE causal_edges (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The causal relationship
  cause_event_id      UUID NOT NULL REFERENCES causal_events(id),
  effect_event_id     UUID NOT NULL REFERENCES causal_events(id),
  
  -- Causal properties
  strength            FLOAT NOT NULL DEFAULT 0.5,       -- 0-1 confidence
  temporal_span       INTERVAL,                          -- delay between cause and effect
  extraction_method   VARCHAR(20) NOT NULL,              -- llm (Haiku agentic reasoning)
  
  -- Reasoning & traceability (NON-NEGOTIABLE — every edge must be auditable)
  reasoning           TEXT NOT NULL,                      -- Detailed LLM justification for this causal assertion.
                                                          -- Must explain WHY the agent believes cause led to effect.
                                                          -- Not overly verbose but must justify the conclusion.
  source_references   JSONB NOT NULL,                    -- Every source that informed this conclusion:
                                                          -- [{type: 'memory'|'fact'|'entity', id: UUID,
                                                          --   relevance: 'how this source informed the conclusion'}]
                                                          -- Full traceability: from any edge, trace back to
                                                          -- the specific memories, facts, and entities that
                                                          -- caused the agent to draw this conclusion.
  
  -- Pathway (mediator events, if any)
  pathway_event_ids   UUID[],                            -- ordered list of intermediate events
  
  -- Provenance
  source_memory_id    UUID,                              -- the memory whose ingest triggered this edge
  source_text         TEXT,                              -- relevant excerpt from the triggering text
  
  -- Corroboration tracking
  corroboration_count INTEGER NOT NULL DEFAULT 1,
  last_corroborated   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Confidence decay
  initial_strength    FLOAT NOT NULL,                    -- strength at creation
  decay_applied       BOOLEAN NOT NULL DEFAULT false,
  
  -- Pattern membership
  pattern_id          UUID REFERENCES causal_patterns(id),  -- if this edge is part of a known pattern
  pattern_position    INTEGER,                               -- position within the pattern sequence
  
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expired_at          TIMESTAMPTZ,                       -- NULL = active. Set when invalidated.
  expire_reason       TEXT,

  -- No self-loops
  CHECK (cause_event_id != effect_event_id)
);

-- Index: forward traversal (cause → effects)
CREATE INDEX idx_causal_edges_cause ON causal_edges (cause_event_id) WHERE expired_at IS NULL;

-- Index: backward traversal (effect → causes)
CREATE INDEX idx_causal_edges_effect ON causal_edges (effect_event_id) WHERE expired_at IS NULL;

-- Index: by pattern (for pattern frequency queries)
CREATE INDEX idx_causal_edges_pattern ON causal_edges (pattern_id) WHERE pattern_id IS NOT NULL;

-- Index: by strength (for pruning and confidence queries)
CREATE INDEX idx_causal_edges_strength ON causal_edges (strength DESC) WHERE expired_at IS NULL;

-- Prevent exact duplicate causal links
CREATE UNIQUE INDEX idx_causal_edges_unique 
  ON causal_edges (cause_event_id, effect_event_id) 
  WHERE expired_at IS NULL;
```

#### `causal_patterns` — Meta-Causal Archetypes

A causal pattern is a recurring causal chain that has been detected, named, and promoted to a first-class object.

```sql
CREATE TABLE causal_patterns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name              VARCHAR(255),                        -- emergent, LLM-named (e.g., "avoidance cascade")
  description       TEXT,
  
  -- Structure template
  template_structure JSONB NOT NULL,                     -- sequence of {transition_type, predicate_category} steps
  template_length   INTEGER NOT NULL,                    -- number of steps in the pattern
  
  -- Pattern topology
  topology_type     VARCHAR(20),                         -- linear | loop | convergent | divergent | complex
  
  -- Embedding for pattern similarity
  pattern_embedding VECTOR(768),
  
  -- Lifecycle (same staging model as predicates)
  status            VARCHAR(20) NOT NULL DEFAULT 'staging',  -- staging | candidate | provisional | canonical
  instance_count    INTEGER NOT NULL DEFAULT 0,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ,
  promoted_at       TIMESTAMPTZ,
  rejected_at       TIMESTAMPTZ,
  rejection_reason  TEXT,
  
  -- Frequency metrics
  avg_temporal_span INTERVAL,                            -- average time from first cause to last effect
  avg_strength      FLOAT,                               -- average edge strength across instances
  activation_count_30d INTEGER DEFAULT 0,                -- instances in last 30 days
  
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index: by status (for evolution agent queries)
CREATE INDEX idx_causal_patterns_status ON causal_patterns (status);

-- Index: embedding similarity
CREATE INDEX idx_causal_patterns_embedding ON causal_patterns
  USING hnsw (pattern_embedding vector_cosine_ops);
```

**`template_structure` example:**
```json
[
  {"step": 1, "transition_type": "created", "predicate_category": "emotional"},
  {"step": 2, "transition_type": "strengthened", "predicate_category": "behavioural"},
  {"step": 3, "transition_type": "created", "predicate_category": "physical"},
  {"step": 4, "transition_type": "weakened", "predicate_category": "social"}
]
```

### 1.2 Apache AGE Projection

A separate AGE graph for causal traversal:

```sql
-- Create the causal graph (alongside existing knowledge_graph)
SELECT * FROM ag_catalog.create_graph('causal_graph');

-- Helper: Sync causal event to graph
CREATE OR REPLACE FUNCTION sync_causal_event_to_graph()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM ag_catalog.cypher('causal_graph', format(
    'MERGE (e:Transition {event_id: %L})
     SET e.fact_id = %L,
         e.transition_type = %L,
         e.entity_id = %L,
         e.predicate = %L,
         e.occurred_at = %L',
    NEW.id, NEW.fact_id, NEW.transition_type,
    NEW.subject_entity_id, NEW.predicate,
    NEW.occurred_at::text
  ));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Helper: Sync causal edge to graph
CREATE OR REPLACE FUNCTION sync_causal_edge_to_graph()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM ag_catalog.cypher('causal_graph', format(
    'MATCH (cause:Transition {event_id: %L}),
           (effect:Transition {event_id: %L})
     MERGE (cause)-[r:CAUSED]->(effect)
     SET r.strength = %s,
         r.method = %L,
         r.pattern_id = %L',
    NEW.cause_event_id, NEW.effect_event_id,
    NEW.strength, NEW.extraction_method,
    NEW.pattern_id
  ));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers
CREATE TRIGGER trigger_sync_causal_event
  AFTER INSERT OR UPDATE ON causal_events
  FOR EACH ROW EXECUTE FUNCTION sync_causal_event_to_graph();

CREATE TRIGGER trigger_sync_causal_edge
  AFTER INSERT ON causal_edges
  FOR EACH ROW
  WHEN (NEW.expired_at IS NULL)
  EXECUTE FUNCTION sync_causal_edge_to_graph();
```

### 1.3 Cross-Graph References

Graph C references Graph S via foreign keys:
- `causal_events.fact_id` → `facts.id` (which transition in Graph S)
- `causal_events.subject_entity_id` → `entities.id` (which entity was affected)
- `causal_events.source_memory_id` → Qdrant memory ID (provenance)

Graph C references itself:
- `causal_edges.cause_event_id` → `causal_events.id`
- `causal_edges.effect_event_id` → `causal_events.id`
- `causal_edges.pattern_id` → `causal_patterns.id`
- `causal_edges.pathway_event_ids` → array of `causal_events.id`

---

## 2. Causal Extraction Pipeline

### 2.1 When Causal Events Are Created

A `causal_event` is created whenever Graph S changes. This is triggered by:

1. **`createFact()` in `services/facts.ts`** — Inserts a new `causal_event` with `transition_type = 'created'`
2. **`expireFact()` in `services/facts.ts`** — Inserts a `causal_event` with `transition_type = 'expired'`
3. **`invalidateFact()` in `services/facts.ts`** — Inserts a `causal_event` with `transition_type = 'invalidated'`
4. **Confidence updates** (if implemented) — Inserts `strengthened` or `weakened` events

This can be implemented as PostgreSQL triggers on the `facts` table or as explicit calls in the service functions. Triggers are cleaner but harder to include rich context. Explicit calls allow passing `source_memory_id` and `source_text` directly.

**Recommended: Explicit calls** in the facts service, so the full context (memory ID, source text) is available for the causal event.

### 2.2 The Causal Agent — Haiku with Tool-Use

The causal agent is NOT a simple extraction call. It is an **agentic LLM** (Claude Code via `-p` with MCP tools) that actively queries Graph S, Qdrant, and Graph C to reason about causality. It does not operate on the current input text alone — it gathers its own context from the full history.

**Trigger:** The agent runs after `extract()` completes in `pipeline.ts`, if the extraction produced any Graph S changes. Changes from a single input are batched — the agent receives the full delta from one `ingest()` call.

**Input — the delta:**
```typescript
interface CausalAgentInput {
  sourceMemoryId: string;              // The memory that triggered these changes
  sourceText: string;                  // The raw text (for the agent's reference)
  newEntities: Array<{ id: string; canonicalName: string; entityType: string }>;
  newFacts: Array<{
    id: string; subjectEntityId: string; subjectName: string;
    predicate: string; objectEntityId?: string; objectName?: string;
    objectValue?: string; confidence: number; validAt: Date; invalidAt?: Date;
  }>;
  modifiedFacts: Array<{ id: string; change: 'superseded' | 'expired'; reason: string }>;
}
```

**Tools — 7 functions the agent can call:**

| Tool | Description | Maps To |
|------|-------------|---------|
| `query_entity_facts` | Get all active bi-temporal facts for an entity (subject or object). Returns facts with subject, predicate, object, validAt, invalidAt, confidence, sourceText. | `services/facts.ts:getEntityFacts()` |
| `query_entity_neighbours` | Traverse the knowledge graph (AGE) to find connected entities. Optional depth and relationship type filter. | `services/graph.ts:findConnectedEntities()` |
| `search_similar_entities` | Semantic similarity search over entities via pgvector. Find entities whose embeddings are close to a query text. | `services/entities.ts:findSimilarEntities()` |
| `search_memories` | Semantic search over source texts in Qdrant. Find past inputs semantically related to a query. Returns content, similarity, metadata. | `services/qdrant.ts:searchMemories()` |
| `get_memory_text` | Retrieve the full source text of a specific memory by ID. | `services/qdrant.ts:getMemory()` |
| `get_causal_history` | Get existing causal chains involving an entity from Graph C. Returns causal events and edges with reasoning, strength, source references. | `services/causal.ts:getEntityCausalHistory()` |
| `create_causal_edge` | Assert a causal link between two transitions with reasoning and source references. See schema below. | `services/causal.ts:createCausalEdge()` |

**The `create_causal_edge` tool input:**
```typescript
{
  causeEventId: string;              // The causal event that is the cause
  effectEventId: string;             // The causal event that is the effect
  strength: number;                  // 0.0-1.0 confidence in the causal link
  reasoning: string;                 // Detailed justification. Must explain WHY the agent
                                     // believes cause led to effect. Not overly verbose
                                     // but must justify the conclusion.
  sourceReferences: Array<{          // EVERY source that informed this conclusion
    type: 'memory' | 'fact' | 'entity';
    id: string;                      // UUID of the memory, fact, or entity
    relevance: string;               // How this source informed the causal conclusion
  }>;
  temporalSpan?: string;             // Estimated delay (ISO 8601 duration, e.g., "P3D")
}
```

**Reasoning and source traceability are non-negotiable.** Every causal edge must be fully auditable — you must be able to trace from any edge back to the specific memories, facts, and entities that caused the agent to draw that conclusion. This is essential for:
- Tracking and revising causal chains as new information arrives
- Debugging false positives (the reasoning explains what went wrong)
- Building trust in the graph (well-sourced edges are more reliable)
- Enabling future agents to evaluate the quality of existing links

**System prompt summary:**
1. Examine the delta — understand what changed in Graph S
2. Gather context — use tools to query related entities, historical facts, past source texts, and existing causal chains. Do NOT reason from the current text alone.
3. Reason about causality — consider explicit causal language, temporal patterns, existing chain extensions, and indirect causes
4. Assert causal edges — call `create_causal_edge` with strength, reasoning, and complete source references
5. Do not hallucinate causality — if uncertain, do not create an edge. More data will arrive.

**LLM provider:** Claude Code invoked via `-p` flag with MCP tools. The 7 causal tools are exposed as an MCP server. Claude Code manages the tool-use loop internally — no hand-rolled loop required. The MCP interface is vendor-agnostic.

### 2.3 Integration with Pipeline

In the sparse branch, the causal agent is called directly from `pipeline.ts` — no KARMA agent framework, no pg-boss queue:

```
store(text) → Qdrant
    → extract(memoryId) → entities + facts → AGE sync
        → collectDelta(extractResult) → causal events created
            → runCausalAgent(delta) → Haiku reasons + creates causal edges → causal_graph sync
```

All synchronous function calls. The full pipeline runs in one `await ingest(text)`.

### 2.4 How the Agent Reasons (Not Just Parsing)

The causal agent's reasoning is fundamentally different from simple causal language detection. Consider ingesting: "I've been sleeping badly this week."

A regex parser finds no causal language and creates no edges. The agentic approach:

1. Agent receives the delta: new fact `(User) -[experiences]-> (poor_sleep)` with `valid_at = this week`
2. Agent calls `query_entity_facts('User')` — sees existing fact `(User) -[started_at]-> (new_job)` from 2 weeks ago
3. Agent calls `search_memories('sleep problems stress work')` — finds a memory from last month: "I always sleep badly when I'm stressed about work"
4. Agent calls `get_causal_history('User')` — finds an existing causal edge: `new_job_start → increased_stress` from a previous ingest
5. Agent reasons: the user has a documented pattern of sleep disruption during work stress, a recent job start, and an existing causal chain linking new job → stress. It creates a causal edge: `increased_stress → poor_sleep` with strength 0.6, reasoning that cites the specific memory about sleep-stress patterns, the existing job→stress chain, and the temporal proximity.

```d2
direction: down

input: "Input: 'I've been sleeping badly this week'" {
  shape: document
}

delta: "Delta: new fact\n(User) -[experiences]-> (poor_sleep)" {
  shape: step
}

tool1: "Tool: query_entity_facts('User')" {
  shape: step
}

found1: "Found: (User) -[started_at]-> (new_job)\n2 weeks ago" {
  shape: document
}

tool2: "Tool: search_memories('sleep stress work')" {
  shape: step
}

found2: "Found: Memory from last month:\n'I always sleep badly when stressed about work'" {
  shape: document
}

tool3: "Tool: get_causal_history('User')" {
  shape: step
}

found3: "Found: existing edge\nnew_job_start → increased_stress" {
  shape: document
}

reason: "Agent reasons:\njob start → stress (existing chain)\n+ stress → sleep disruption (documented pattern)\n+ temporal proximity (2 weeks)" {
  shape: step
}

edge: "Tool: create_causal_edge\ncause: increased_stress\neffect: poor_sleep\nstrength: 0.6\nreasoning: 'documented sleep-stress pattern...'\nsources: [memory:xyz, fact:abc, edge:def]" {
  shape: step
}

input -> delta
delta -> tool1
tool1 -> found1
found1 -> tool2
tool2 -> found2
found2 -> tool3
tool3 -> found3
found3 -> reason
reason -> edge
```

This is why the agent needs the full toolkit — causality often isn't stated explicitly. It emerges from patterns across multiple inputs, entities, and time periods. The agent's ability to query the graph and vector store is what makes this possible.

---

## 3. Pattern Detection

### 3.1 Detection Mechanism

Pattern detection is a separate process that runs AFTER the causal agent has created edges. Patterns emerge from the agent's repeated assertions — they are not designed upfront or detected during causal extraction. The agent creates individual edges; the pattern detector finds recurring structures across those edges.

A periodic function (not a KARMA agent — just a function call, either manual or scheduled) scans Graph C:

1. **Collect recent causal chains** — Walk Graph C from recent events, collecting chains of length 2-6 edges
2. **Normalise chains** — Replace specific entity/predicate references with their types/categories to create abstract templates
3. **Cluster templates** — Group by structural similarity (same sequence of transition types and predicate categories)
4. **Frequency threshold** — Clusters that appear 3+ times enter `staging` in `causal_patterns`
5. **LLM classification** — For staged patterns meeting the review threshold, call Haiku to generate a name and description
6. **Promotion** — Same lifecycle as predicates: staging → candidate → provisional → canonical

Deterministic causal patterns will become apparent as we build the graphs out — they are a consequence of the agent's reasoning, not a precursor to it.

### 3.2 Pattern Matching During Extraction

When a new causal edge is created, the system checks if it could be the start or continuation of a known pattern:

```sql
-- Find patterns whose template starts with this transition type + predicate category
SELECT cp.* FROM causal_patterns cp
WHERE cp.status IN ('provisional', 'canonical')
  AND cp.template_structure->0->>'transition_type' = ?
  AND cp.template_structure->0->>'predicate_category' = ?
```

If matched, the system watches for subsequent transitions that match the next steps in the template. When a full pattern instance is detected, it's recorded with all its edges annotated.

### 3.3 Pattern Evolution

Patterns are not static. Their templates can evolve as new instances reveal variations:
- If 80% of instances follow the canonical template but 20% have an additional step, the template may be extended
- If a pattern's frequency drops to zero for 30+ days, it's demoted back to `staging`
- If two patterns have overlapping templates (one is a subset of the other), the system may merge or relate them

---

## 4. Query Interface

### 4.1 Service Functions (`services/causal.ts`)

```typescript
// Backward trace: why does this state exist?
async function traceCauses(
  factId: string,
  options: { maxDepth?: number; minStrength?: number }
): Promise<CausalChain[]>

// Forward projection: where is this heading?
async function projectTrajectory(
  factId: string,
  options: { maxDepth?: number; minStrength?: number }
): Promise<CausalChain[]>

// Delta report: what changed and why?
async function causalDelta(
  from: Date,
  to: Date,
  options: { entityId?: string; minStrength?: number }
): Promise<CausalDeltaReport>

// Pattern query: what patterns are active?
async function activePatterns(
  options: { entityId?: string; status?: string[] }
): Promise<PatternInstance[]>

// Ghost detection: what causal links are missing?
async function findCausalGhosts(
  entityId: string,
  options: { minExpectedStrength?: number }
): Promise<MissingCausalLink[]>
```

**Production wiring (bead nmemo-2yv.25):** `traceCauses`, `projectTrajectory`, and `getCausalDelta` are exposed to the reasoning agent as MCP tools (`trace_causes`, `project_trajectory`, `get_causal_delta`) on the unified `mnemo-graph` MCP server (`services/graph-mcp.ts`). Dispatch lives in `causal-agent.ts` next to the existing read-only causal tools. All three are read-only (`mutates: false`) so they run outside the write-serialisation queue. The reasoning agent uses them to ask "why did this fact become true?" (`trace_causes`), "what does this fact lead to?" (`project_trajectory`), and "what changed causally in this window?" (`get_causal_delta`). The signatures match §4.1 verbatim — input is the existing service-function arguments, output is a JSON serialisation of the existing return shape. No new domain logic; this bead is the wiring.

### 4.2 Cypher Queries in `causal_graph`

```cypher
-- Backward trace (max 10 hops)
MATCH path = (effect:Transition {fact_id: $factId})<-[:CAUSED*1..10]-(root)
WHERE ALL(r IN relationships(path) WHERE r.strength > $minStrength)
RETURN path
ORDER BY length(path) ASC

-- Forward projection (max 5 hops)
MATCH path = (cause:Transition {fact_id: $factId})-[:CAUSED*1..5]->(downstream)
WHERE ALL(r IN relationships(path) WHERE r.strength > $minStrength)
RETURN downstream, length(path) as distance
ORDER BY distance ASC

-- Find all instances of a pattern
MATCH path = (start:Transition)-[:CAUSED*]->(end:Transition)
WHERE ALL(r IN relationships(path) WHERE r.pattern_id = $patternId)
RETURN path
```

---

## 5. Consistency Model

### 5.1 Synchronous Consistency

In the sparse branch, Graph C is updated **synchronously** within the same `ingest()` call as Graph S. The pipeline runs: `store()` → `extract()` → `invokeGraphAgent()` (the unified graph agent, which performs entity / relationship / fact extraction AND causal reasoning inline). There is no async queue, no eventual consistency window — when `ingest()` returns, both graphs reflect the new data.

The unified graph agent runs **unconditionally** on every ingest. The earlier sparse-branch design described a separate conditional causal agent gated by:
- New facts involving entities with existing causal history, OR
- Total fact count above a threshold, OR
- Explicit causal language in the source text

That standalone path (`invokeCausalAgent`, `shouldRunCausalAgent`, `containsCausalLanguage`) has been removed. Instead, `invokeGraphAgent` exposes a CAUSE phase as part of its agentic loop and the model itself decides whether to emit causal edges. When the input lacks causal signal — a flat factual statement with no temporal or motivational context — the LLM simply emits no `create_causal_edge` tool calls and the pipeline returns with Graph C unchanged. The skip is implicit (the agent chooses), not gated (no regex / threshold prefilter).

This consolidation removes the regex-based prefilter as a source of false negatives (causal relationships that lack the canonical English markers) and the entity-history check as a source of false positives (familiar entities reasoning over inputs with no new causal content). The trade-off is one extra LLM round-trip on low-signal inputs; in practice the agent terminates quickly when no causal reasoning is warranted.

### 5.1.1 Future: Deep Analysis Gardener

A separate concept (not part of the current implementation) is a scheduled deep-analysis agent that runs periodically (e.g., nightly) to:
- Review the full day's graph changes with deeper cross-referencing than the per-ingest agent can do
- Strengthen or weaken existing causal edges based on accumulated evidence
- Find causal connections that were missed by individual ingest-time analyses
- Clean up noise, reorder chains, and consolidate patterns
- Perform graph-wide consistency checks

This gardener would operate on a fundamentally different timescale — it sees the forest, not individual trees. It is future work and not part of the sparse branch implementation.

### 5.2 Cascading Invalidation

When a fact in Graph S is expired (marked as wrong), the corresponding causal events and edges must be updated:

1. Mark the `causal_event` as expired
2. Mark all `causal_edges` where this event is cause or effect as expired
3. Re-evaluate downstream events that depended on the expired edge
4. Update pattern instance counts

This cascading invalidation maintains Graph C's integrity when Graph S corrections occur.

### 5.3 Confidence Decay

Inferred causal edges that lack corroboration should decay over time:

```sql
-- Periodic decay job (nightly or weekly)
UPDATE causal_edges
SET strength = GREATEST(strength * 0.95, 0.1),  -- 5% decay per period, floor at 0.1
    decay_applied = true
WHERE extraction_method = 'inferred'
  AND corroboration_count <= 1
  AND last_corroborated < NOW() - INTERVAL '30 days'
  AND expired_at IS NULL
  AND strength > 0.1;

-- Expire very low confidence edges
UPDATE causal_edges
SET expired_at = NOW(),
    expire_reason = 'confidence decay below threshold'
WHERE strength <= 0.1
  AND expired_at IS NULL;
```

Explicitly stated causal links (`extraction_method = 'explicit'`) do not decay — they represent what the source actually said, regardless of subsequent corroboration.

---

## 6. Future: Hierarchical Temporal Abstraction

### 6.1 Compaction Strategy

When the system operates at decade scale, fine-grained causal events accumulate to volumes that are expensive to query. The compaction strategy uses **causal significance** as the criterion:

**Preserve at all resolutions:**
- Causal events that are part of canonical patterns
- Causal edges with corroboration count > N
- Events that mark epoch boundaries (regime changes)

**Compress at medium resolution (months):**
- Replace clusters of related events with a summary event
- Merge parallel causal edges into aggregate edges with combined strength
- Preserve the pattern-level structure, compress the instance-level detail

**Compress at coarse resolution (years):**
- Only canonical patterns and their aggregate metrics survive
- Individual events and edges are replaced by pattern activation counts
- Epoch boundaries and cross-epoch causal bridges preserved

### 6.2 Epoch Detection

Epoch boundaries are detected from Graph C dynamics:

```sql
-- Detect regime changes: periods where new pattern types appear rapidly
SELECT
  date_trunc('month', cp.first_seen_at) as month,
  COUNT(*) as new_patterns
FROM causal_patterns cp
WHERE cp.status IN ('provisional', 'canonical')
GROUP BY date_trunc('month', cp.first_seen_at)
HAVING COUNT(*) > (
  SELECT AVG(monthly_count) * 2 FROM (
    SELECT COUNT(*) as monthly_count
    FROM causal_patterns
    GROUP BY date_trunc('month', first_seen_at)
  ) avg_table
);
```

Months with 2x the average rate of new pattern emergence are candidates for epoch boundaries. LLM classification can name the epochs.

### 6.3 Cross-Epoch Causal Bridges

The most valuable causal edges in a lifetime-scale system are those that span epochs — formative experiences causing patterns decades later. These edges:
- Have very long `temporal_span` values
- Often connect entities from different ontological vocabularies (cross-epoch alignment via semantic vectors)
- Are almost always `inferred` rather than `explicit`
- Are the highest-priority edges for preservation during compaction

---

## 7. Migration Path

### Phase 1: Schema (after Graph S hardening)
- Create `causal_events`, `causal_edges`, `causal_patterns` tables
- Create `causal_graph` in Apache AGE
- Add triggers for graph sync
- Add causal event creation to `createFact()`, `expireFact()`, `invalidateFact()`

### Phase 2: Explicit Extraction
- Create `causal-extraction.agent.ts`
- Create `/extract-causality` ML endpoint
- Wire into KARMA pipeline after relationship extraction
- Parse causal language markers for explicit edges

### Phase 3: Inferred Extraction
- Add temporal co-occurrence analysis
- Add LLM causal reasoning over Graph S deltas
- Implement corroboration and decay logic

### Phase 4: Pattern Detection
- Implement subgraph matching for recurring chains
- Create pattern staging lifecycle
- Create `/classify-causal-pattern` ML endpoint
- Wire pattern matching into extraction pipeline

### Phase 5: Query Operations
- Implement `services/causal.ts` query functions
- Integrate causal context into conflict resolution agent
- Build causal delta report generation

### Phase 6: Temporal Abstraction (future)
- Implement compaction logic
- Implement epoch detection
- Build variable-resolution query interface
