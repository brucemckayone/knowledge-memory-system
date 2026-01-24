# Recursive Knowledge Gardening: Implementation Architecture Guide

A personal knowledge management system that autonomously organizes, deduplicates, and synthesizes knowledge requires orchestrating eight interconnected technical domains. This research provides implementation-ready specifications for building the "gardening" layer on your existing Qdrant + PostgreSQL + Ollama stack.

## The core architectural insight

The most successful open-source systems—Graphiti, Cognee, and LightRAG—share a common pattern: **bi-temporal data modeling** combined with **hybrid retrieval** (vector + graph + keyword). Graphiti's architecture is particularly relevant for your use case, achieving **98.2% accuracy** on the Deep Memory Retrieval benchmark while maintaining sub-300ms P95 latency. The key innovation is separating *when facts were true* (event time) from *when you learned them* (ingestion time), enabling proper temporal reasoning without data loss.

---

## Entity resolution: semantic deduplication at scale

Entity resolution represents the largest computational challenge in a knowledge gardening system. Recent 2024-2025 research shows LLM-based approaches achieving **87% F1** on the WDC Products benchmark, with clustering-based methods reducing API calls by **60%** compared to pairwise comparison.

### Algorithm selection by complexity

The optimal approach depends on your entity volume. For personal knowledge bases under **10,000 entities**, a three-stage pipeline works well: embedding-based blocking first (DBSCAN with ε=0.3), followed by similarity scoring using Jaro-Winkler distance, then LLM verification only for ambiguous cases (similarity between 0.75-0.92).

```python
class EntityResolver:
    SIMILARITY_THRESHOLD_HIGH = 0.92   # Auto-merge without LLM
    SIMILARITY_THRESHOLD_MEDIUM = 0.75  # Requires LLM verification
    
    async def resolve_entity(self, mention: str, context: str) -> Entity:
        embedding = await self.embed(f"{mention} {context}")
        candidates = await self.qdrant.search("entity_embeddings", embedding, limit=10)
        
        high_confidence = [c for c in candidates if c.score > self.SIMILARITY_THRESHOLD_HIGH]
        if len(high_confidence) == 1:
            return await self.merge_mention(mention, high_confidence[0])
        
        medium_confidence = [c for c in candidates if c.score > self.SIMILARITY_THRESHOLD_MEDIUM]
        if medium_confidence:
            return await self.llm_resolve(mention, medium_confidence[:5])
        
        return await self.create_entity(mention)
```

### Prompt template for LLM-as-judge deduplication

The most effective pattern uses structured output with explicit decision categories:

```
Given the existing entity and new mention, determine the relationship:

EXISTING ENTITY: {name: "John Smith", type: "person", properties: {role: "CEO", company: "Acme"}}
NEW MENTION: "J. Smith, chief executive of Acme Corp"

Decision options:
1. MERGE - Same entity, combine properties
2. LINK - Related but distinct entities (create relationship)  
3. CREATE - Entirely new entity

Provide JSON: {"decision": "MERGE|LINK|CREATE", "confidence": 0.0-1.0, "reasoning": "..."}
```

### PostgreSQL schema for resolved entities

```sql
CREATE TABLE entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name VARCHAR(500) NOT NULL,
    entity_type VARCHAR(100),
    properties JSONB DEFAULT '{}',
    merged_from UUID[],  -- Audit trail of merged entity IDs
    confidence FLOAT DEFAULT 1.0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE entity_aliases (
    id SERIAL PRIMARY KEY,
    entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
    alias VARCHAR(500) NOT NULL,
    alias_type VARCHAR(50),  -- 'abbreviation', 'typo', 'nickname'
    UNIQUE(entity_id, alias)
);

CREATE TABLE entity_merges (
    id SERIAL PRIMARY KEY,
    source_entity_id UUID,
    target_entity_id UUID REFERENCES entities(id),
    merge_reason TEXT,
    merged_by VARCHAR(100),  -- 'auto', 'llm', 'manual'
    merged_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Temporal knowledge maintenance: the bi-temporal imperative

Graphiti's temporal architecture, documented in their January 2025 paper (arXiv:2501.13956), provides the gold standard for tracking knowledge evolution. Every fact carries four timestamps enabling point-in-time queries and proper supersession handling.

### The four-timestamp model

| Timestamp | Timeline | Purpose |
|-----------|----------|---------|
| `valid_at` | Event (T) | When the fact became true in reality |
| `invalid_at` | Event (T) | When the fact stopped being true |
| `created_at` | Transaction (T') | When you recorded the fact |
| `expired_at` | Transaction (T') | When you learned the fact was wrong |

### PostgreSQL temporal schema

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE facts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id UUID NOT NULL REFERENCES entities(id),
    predicate VARCHAR(255) NOT NULL,
    object_id UUID REFERENCES entities(id),
    object_value TEXT,
    
    -- Event time (when true in the world)
    valid_at TIMESTAMPTZ,
    invalid_at TIMESTAMPTZ,
    
    -- Transaction time (when recorded in system)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expired_at TIMESTAMPTZ,
    
    -- Provenance
    source_episode_id UUID,
    confidence FLOAT DEFAULT 1.0,
    fact_embedding VECTOR(1024),
    
    -- Prevent overlapping valid periods for same subject-predicate
    CONSTRAINT no_overlapping_facts EXCLUDE USING GIST (
        subject_id WITH =, predicate WITH =,
        tstzrange(valid_at, invalid_at) WITH &&
    ) WHERE (expired_at IS NULL)
);

CREATE INDEX idx_facts_temporal ON facts USING GIST (tstzrange(valid_at, invalid_at));
```

### Supersession detection algorithm

The key insight from Graphiti: when "I work at Acme" arrives after "I work at TechCorp," the system must detect that these facts conflict during overlapping time periods and mark the older one as superseded.

```python
async def detect_superseding_facts(new_fact: Fact) -> List[Fact]:
    # Find semantically similar facts about the same subject
    candidates = await search_facts(
        subject_id=new_fact.subject_id,
        predicate_embedding=new_fact.predicate_embedding,
        similarity_threshold=0.80
    )
    
    superseded = []
    for candidate in candidates:
        # Check temporal overlap
        if not temporal_ranges_overlap(
            (new_fact.valid_at, new_fact.invalid_at),
            (candidate.valid_at, candidate.invalid_at)
        ):
            continue
            
        # LLM verification for ambiguous cases
        if await llm_check_supersession(new_fact.fact_text, candidate.fact_text):
            await invalidate_fact(
                candidate.id,
                invalid_at=new_fact.valid_at,  # Old fact ends when new one begins
                expired_at=datetime.utcnow()
            )
            superseded.append(candidate)
    
    return superseded
```

### Temporal extraction prompt

```
REFERENCE TIMESTAMP: {reference_timestamp}
MESSAGE: "I started my new job at Acme two weeks ago"

Extract temporal information. Use reference timestamp for relative dates.
- valid_at: When the relationship became true
- invalid_at: When it stopped being true (null if ongoing)

Output: {"valid_at": "{reference_timestamp - 14 days}", "invalid_at": null}
```

---

## Autonomous insight generation: the Ponderer architecture

Proactive insight surfacing requires layered processing with different time horizons. The most resource-efficient approach uses a **tiered scheduler** that runs lightweight operations frequently and expensive LLM-based analysis during idle periods.

### Tiered processing architecture

| Tier | Interval | Operations | Max Latency |
|------|----------|------------|-------------|
| Realtime | On save | Entity extraction, quick link detection | 100ms |
| Frequent | 5 minutes | Local contradiction check, recent pattern match | 2 seconds |
| Periodic | 1 hour | Community detection, multi-hop discovery | 10 seconds |
| Deep | Daily | Full graph analysis, LLM insight generation | 60 seconds |

### Contradiction detection algorithm

The ALICE framework (Springer 2024) achieves **60% detection rate** by combining formal logic patterns with LLM verification. Contradictions fall into five categories:

1. **Antonym**: Direct opposites (employed ↔ unemployed)
2. **Numeric**: Incompatible numbers (2 children vs 3 children)
3. **Negation**: Explicit negation (works at X vs doesn't work at X)
4. **Structural**: Incompatible relationships
5. **Temporal**: Same fact with conflicting time periods

```python
async def detect_contradictions(new_fact: Fact) -> List[Contradiction]:
    # Semantic similarity search for related facts
    candidates = await vector_search(new_fact.embedding, threshold=0.85)
    
    # Filter to temporally overlapping facts
    overlapping = [f for f in candidates if temporal_overlap(new_fact, f)]
    
    contradictions = []
    for candidate in overlapping:
        # Quick checks first (avoid LLM for obvious cases)
        if is_antonym_pair(new_fact.predicate, candidate.predicate):
            contradictions.append(Contradiction(candidate, "antonym"))
            continue
            
        # LLM for subtle contradictions
        result = await llm_check_contradiction(new_fact, candidate)
        if result.is_contradiction:
            contradictions.append(Contradiction(candidate, result.type))
    
    return contradictions
```

### Serendipity scoring for insight ranking

The SerenQA framework (arXiv 2511.12472) defines insight value as **Relevance × Novelty × Surprise**:

```python
def score_insight(source, target, path, user_history):
    # Relevance: alignment with user's recent focus
    relevance = cosine_similarity(path.embedding, user_history.focus_embedding)
    
    # Novelty: not previously encountered
    novelty = 1 - compute_familiarity(path, user_history.seen_connections)
    
    # Surprise: unexpectedness given knowledge structure
    expected = predict_likely_paths(source, target)
    surprise = 1 - max_similarity(path, expected)
    
    return relevance * novelty * surprise
```

---

## Graph + vector hybrid architecture: integration patterns

The comparison of GraphRAG, LightRAG, Cognee, and Graphiti reveals distinct tradeoffs. For your existing Qdrant + PostgreSQL setup, **LightRAG's approach** offers the best cost/performance balance, while **Apache AGE** (PostgreSQL graph extension) provides the simplest integration path.

### Framework comparison

| Feature | GraphRAG | LightRAG | Cognee | Graphiti |
|---------|----------|----------|--------|----------|
| Update pattern | Batch rebuild | Incremental | Modular pipelines | Real-time |
| Token cost/query | ~610K | <100 | Variable | Zero at retrieval |
| Temporal support | None | None | None | **Bi-temporal** |
| Best for | Global summarization | Cost-effective RAG | AI memory | Agent memory |

### Hybrid retrieval implementation

The optimal pattern executes vector and graph searches in parallel, then fuses results using Reciprocal Rank Fusion (RRF):

```python
async def hybrid_search(query_embedding: List[float], query_entities: List[str], top_k: int = 10):
    # Parallel execution
    vector_task = qdrant.search("notes", query_embedding, limit=top_k * 2)
    graph_task = age_query(f"""
        MATCH (e:Entity)-[*1..2]->(n:Note)
        WHERE e.name IN {query_entities}
        RETURN DISTINCT n.id, count(e) as relevance
        ORDER BY relevance DESC LIMIT {top_k * 2}
    """)
    
    vector_results, graph_results = await asyncio.gather(vector_task, graph_task)
    
    # RRF fusion (k=60 is the standard constant)
    return reciprocal_rank_fusion(vector_results, graph_results, k=60)[:top_k]

def reciprocal_rank_fusion(*result_lists, k=60):
    scores = {}
    for results in result_lists:
        for rank, item in enumerate(results):
            scores[item.id] = scores.get(item.id, 0) + 1 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)
```

### Apache AGE integration with existing PostgreSQL

```sql
-- Install on existing PostgreSQL
CREATE EXTENSION age;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;

-- Create knowledge graph
SELECT create_graph('knowledge_graph');

-- Combined SQL + Cypher query
SELECT n.title, e.name as related_entity
FROM notes n
JOIN LATERAL (
    SELECT * FROM cypher('knowledge_graph', $$
        MATCH (note:Note {id: $1})-[:MENTIONS]->(e:Entity)
        RETURN e.name
    $$, ARRAY[n.id]) as (name agtype)
) e ON true;
```

### Community detection with Leiden algorithm

The Leiden algorithm (O(n log n) average case) produces better-connected communities than Louvain while maintaining similar speed. Use resolution parameter γ to control granularity:

```python
import leidenalg as la
import igraph as ig

# Lower γ = larger communities (broader topics)
partition = la.find_partition(
    ig.Graph.from_networkx(knowledge_graph),
    la.CPMVertexPartition,
    resolution_parameter=0.05
)

communities = partition.membership
```

---

## Benchmarks and evaluation metrics

The most relevant benchmarks for personal knowledge systems are **LongMemEval** (temporal reasoning across sessions) and **Deep Memory Retrieval** (fact retrieval from conversation history).

### LongMemEval results (ICLR 2025)

| System | Accuracy | Notes |
|--------|----------|-------|
| GPT-4o full context | 60-64% | Lost-in-the-middle effects |
| Naive RAG | 52% | Simple turn retrieval |
| **Zep/Graphiti** | **71.2%** | +15% vs full context |
| EmergenceMem | 86% | SOTA with 5.65s latency |

### Key metrics for your system

| Task | Primary Metric | Target |
|------|----------------|--------|
| Retrieval | Recall@10 | >90% |
| Answer accuracy | F1 (HotpotQA) | >80% |
| Entity resolution | Pairwise F1 | >90% |
| Temporal reasoning | Accuracy by category | >80% |
| Faithfulness | Statement verification | >95% |

### LLM-as-judge evaluation

Research shows GPT-4 achieves **97%+ agreement** with human judges, exceeding human-to-human agreement (81%). The key is using discrete scales with clear rubrics:

```python
JUDGE_PROMPT = """
Evaluate this response on three criteria:
1. Factual accuracy (0-2 points)
2. Completeness (0-2 points)
3. Relevance (0-1 point)

Response: {response}
Question: {question}
Reference context: {context}

First analyze each criterion, then provide final score (0-5).
"""
```

---

## Local M1 implementation specifications

Running everything locally on M1 Mac requires careful model selection. The primary constraint is unified memory bandwidth—performance scales linearly with memory bandwidth, making quantization essential.

### Model recommendations

| Task | Model | Size (Q4_K_M) | Tokens/sec (M1 Pro) | Quality |
|------|-------|---------------|---------------------|---------|
| Entity extraction | **Llama 3.2 3B** | 2.0GB | 35-40 t/s | Good (esp. People) |
| Embedding | **nomic-embed-text** | 274MB | Fast | 81% on Banking77 |
| Complex reasoning | Qwen 2.5 7B | 4.7GB | 20-24 t/s | Strong (73% MMLU) |
| Transcription | whisper.cpp medium | 1.5GB | 2-3 min/10min audio | 3.9% WER |

### Memory requirements by configuration

| Configuration | RAM Needed | Models |
|---------------|------------|--------|
| **Minimal** (M1 8GB) | ~4GB | Llama 3.2 1B + MiniLM |
| **Recommended** (M1 Pro 16GB) | ~6GB | Llama 3.2 3B + nomic-embed |
| **High-performance** (M1 Max 64GB) | ~12GB | Qwen 2.5 7B + bge-m3 |

### Ollama optimization settings

```bash
export OLLAMA_METAL_ENABLED=1
export OLLAMA_KV_CACHE_TYPE=q8_0  # Reduces memory, slight quality tradeoff
export OLLAMA_KEEP_ALIVE=5m       # Model persistence
```

### Graph database selection

| Option | Memory | Best For |
|--------|--------|----------|
| **Apache AGE** | Shared with PostgreSQL | You already have PostgreSQL |
| **FalkorDB** | ~200MB | Dedicated graph workloads |
| **SQLite + CTE** | ~10MB | Simple hierarchies |

---

## Open-source implementation patterns

The most valuable patterns from Cognee, Graphiti, and LightRAG center on three abstractions: **storage factory pattern**, **pipeline composition**, and **hybrid retrieval**.

### Storage abstraction pattern (from LightRAG)

```python
from abc import ABC, abstractmethod

class BaseStorage(ABC):
    @abstractmethod
    async def initialize(self): ...
    
    @abstractmethod
    async def finalize(self): ...

STORAGE_REGISTRY = {}

def register_storage(name: str):
    def decorator(cls):
        STORAGE_REGISTRY[name] = cls
        return cls
    return decorator

@register_storage("qdrant")
class QdrantStorage(BaseStorage):
    async def upsert(self, vectors: List[dict]): ...
    async def query(self, embedding: List[float], top_k: int): ...
```

### ECL pipeline pattern (from Cognee)

```python
async def knowledge_pipeline(documents: List[str]):
    # Extract: Parse and chunk documents
    chunks = await extract_chunks(documents, chunk_size=500)
    
    # Cognify: Build knowledge graph
    entities, relations = await extract_entities_and_relations(chunks)
    await graph.add_nodes(entities)
    await graph.add_edges(relations)
    
    # Load: Store embeddings for retrieval
    embeddings = await embed_batch(chunks)
    await vector_store.upsert(embeddings)
```

### Graphiti's temporal edge structure

```python
@dataclass
class TemporalEdge:
    uuid: str
    source_node_uuid: str
    target_node_uuid: str
    fact: str  # "Alice works at Acme Corp"
    fact_embedding: List[float]
    valid_at: datetime      # When fact became true
    invalid_at: Optional[datetime]  # When it became false
    created_at: datetime    # When we recorded it
    expired_at: Optional[datetime]  # When we learned it was wrong
    episodes: List[str]     # Source provenance
```

---

## The Gardener pattern: autonomous maintenance

The KARMA framework (arXiv:2502.06472) provides a proven multi-agent architecture achieving **83.1% LLM-verified correctness** on knowledge extraction. For local deployment, a PostgreSQL-backed job queue (PGQueuer or Procrastinate) eliminates external dependencies.

### Nine-agent KARMA architecture

1. **Central Controller** - Priority scheduling using multi-armed bandit exploration
2. **Ingestion** - Document retrieval and format normalization
3. **Reader** - Text parsing with relevance scoring
4. **Summarizer** - Content condensation preserving entities
5. **Entity Extraction** - LLM-based NER with ontology filtering
6. **Relationship Extraction** - Multi-label classification
7. **Schema Alignment** - Novel entity mapping to existing schema
8. **Conflict Resolution** - LLM-based debate for contradictions
9. **Evaluator** - Confidence scoring across pipeline

### PostgreSQL job queue schema

```sql
CREATE TABLE gardener_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type VARCHAR(50) NOT NULL,  -- 'entity_refresh', 'conflict_resolve'
    priority INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',
    payload JSONB NOT NULL,
    
    -- Scheduling
    scheduled_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    
    -- Retry handling
    attempt_count INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    last_error TEXT,
    
    -- Checkpointing for long-running jobs
    checkpoint JSONB,
    
    -- Idempotency
    idempotency_key VARCHAR(255) UNIQUE,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_jobs_dequeue ON gardener_jobs(status, priority DESC, scheduled_at)
    WHERE status = 'pending';
```

### State machine for knowledge items

```python
class KnowledgeState(Enum):
    DRAFT = "draft"
    VALIDATING = "validating"
    NEEDS_REVIEW = "needs_review"
    ENRICHING = "enriching"
    ACTIVE = "active"
    STALE = "stale"
    DEPRECATED = "deprecated"

TRANSITIONS = [
    (DRAFT, "submit", VALIDATING),
    (VALIDATING, "pass", NEEDS_REVIEW),
    (VALIDATING, "fail", DRAFT),
    (NEEDS_REVIEW, "approve", ENRICHING),
    (ENRICHING, "complete", ACTIVE),
    (ACTIVE, "mark_stale", STALE),
    (STALE, "refresh", VALIDATING),
    (STALE, "deprecate", DEPRECATED),
]
```

### Recursive refinement loop (OODA-based)

```python
async def run_refinement_cycle(target_scope: str):
    # OBSERVE: Measure current quality
    metrics_before = await measure_quality(target_scope)
    problems = identify_problems(metrics_before)
    
    # ORIENT: Analyze patterns vs historical performance
    analysis = await analyze_patterns(metrics_before, get_historical())
    
    # DECIDE: Select strategies based on available resources
    strategies = await select_strategies(analysis, risk_tolerance=0.3)
    
    # ACT: Execute with checkpointing
    for strategy in strategies:
        checkpoint = await create_checkpoint(strategy)
        try:
            await execute_strategy(strategy)
            await commit_checkpoint(checkpoint)
        except Exception:
            await rollback_to_checkpoint(checkpoint)
    
    # LEARN: Update meta-parameters
    metrics_after = await measure_quality(target_scope)
    lessons = extract_lessons(metrics_before, metrics_after, strategies)
    await update_meta_parameters(lessons)
```

---

## Complete system architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Knowledge Gardening System                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐ │
│  │   QDRANT     │  │ PostgreSQL   │  │     Ollama (M1 Local)      │ │
│  │   (Vectors)  │  │ + Apache AGE │  │ llama3.2:3b + nomic-embed  │ │
│  └──────────────┘  └──────────────┘  └────────────────────────────┘ │
│         │                │                        │                  │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                    Hybrid Retrieval Layer                       ││
│  │   Vector Search ──┬── Graph Traversal ──┬── BM25 Keyword       ││
│  │                   │                      │                      ││
│  │                   └──── RRF Fusion ──────┘                      ││
│  └─────────────────────────────────────────────────────────────────┘│
│                              │                                       │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                    Gardener Background Jobs                     ││
│  │  ┌────────────┐ ┌──────────────┐ ┌───────────────┐             ││
│  │  │ Entity     │ │ Temporal     │ │ Insight       │             ││
│  │  │ Resolution │ │ Maintenance  │ │ Generation    │             ││
│  │  └────────────┘ └──────────────┘ └───────────────┘             ││
│  │                       │                                         ││
│  │  PostgreSQL Job Queue (PGQueuer) + State Machine               ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation roadmap

**Phase 1: Temporal Foundation (2-3 weeks)**
- Implement bi-temporal fact table with PostgreSQL
- Add Apache AGE for graph queries
- Build entity resolution pipeline with Qdrant similarity search

**Phase 2: Gardener Infrastructure (2-3 weeks)**  
- Set up PGQueuer job queue
- Implement state machine for knowledge items
- Build checkpointing for long-running operations

**Phase 3: Autonomous Operations (3-4 weeks)**
- Entity extraction agent (Llama 3.2 3B)
- Contradiction detection with LLM verification
- Supersession handling for temporal facts

**Phase 4: Insight Generation (2-3 weeks)**
- Community detection (Leiden algorithm)
- Multi-hop connection discovery
- Serendipity scoring and insight ranking

**Phase 5: Evaluation & Refinement (ongoing)**
- LongMemEval-style test set construction
- LLM-as-judge automated evaluation
- Recursive refinement loop with metrics tracking

This architecture provides a complete foundation for autonomous knowledge gardening while running entirely on local M1 Mac hardware. The bi-temporal model ensures no information is ever lost, the hybrid retrieval combines the strengths of vector and graph approaches, and the Gardener pattern enables continuous autonomous improvement without manual intervention.