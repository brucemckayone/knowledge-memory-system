# Phase 3+ Work Packets: Gardener System

**Goal:** Autonomous Knowledge Gardening with 9-Agent KARMA Architecture  
**Duration:** ~6-8 weeks  
**Prerequisites:** Phase 2 Complete  
**Last Updated:** 2026-01-24

---

## Overall Status

| Phase | Status | Completion |
|-------|--------|------------|
| Phase 2 (Core Skills) | 🔵 In Progress | 0% |
| Phase 3 (Entity & Temporal) | ⚪ Not Started | 0% |
| Phase 4 (Gardener Agents) | ⚪ Not Started | 0% |
| Phase 5 (Intelligence) | ⚪ Not Started | 0% |

---

## Architecture Overview

Based on [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md), implementing the full KARMA 9-agent architecture:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        KNOWLEDGE GARDENING SYSTEM                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    STORAGE LAYER                                     │   │
│  │  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────┐  │   │
│  │  │   QDRANT     │  │    PostgreSQL    │  │   Ollama (M1 Local)   │   │   │
│  │  │  (Memories)  │  │  + Apache AGE    │  │  llama3 + nomic-embed │   │   │
│  │  │  (Vectors)   │  │  (Entities/Facts │  │  qwen2.5 (reasoning)  │   │   │
│  │  │              │  │   /Graph)        │  │                        │   │   │
│  │  └──────────────┘  └──────────────────┘  └───────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    RETRIEVAL LAYER                                   │   │
│  │   Vector Search ──┬── Graph Traversal ──┬── BM25 Keyword            │   │
│  │                   │                      │                           │   │
│  │                   └──── RRF Fusion ──────┘                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    GARDENER AGENTS (KARMA)                           │   │
│  │                                                                       │   │
│  │  ┌─────────────────────────────────────────────────────────────┐     │   │
│  │  │              1. CENTRAL CONTROLLER                          │     │   │
│  │  │    Priority scheduling, Multi-armed bandit exploration      │     │   │
│  │  └─────────────────────────────────────────────────────────────┘     │   │
│  │       │                                                               │   │
│  │       ▼                                                               │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │   │
│  │  │2.INGEST │→│3.READER │→│4.SUMMAR.│→│5.ENTITY │→│6.RELAT. │        │   │
│  │  │ ION     │ │         │ │ IZER    │ │ EXTRACT │ │ EXTRACT │        │   │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘        │   │
│  │       │                                   │           │               │   │
│  │       │                                   ▼           ▼               │   │
│  │       │                              ┌─────────┐ ┌─────────┐          │   │
│  │       │                              │7.SCHEMA │ │8.CONFLI.│          │   │
│  │       │                              │ ALIGN   │ │ RESOLVE │          │   │
│  │       │                              └─────────┘ └─────────┘          │   │
│  │       │                                   │           │               │   │
│  │       └───────────────────────────────────┴───────────┘               │   │
│  │                                           │                           │   │
│  │                                    ┌──────▼──────┐                    │   │
│  │                                    │9. EVALUATOR │                    │   │
│  │                                    │   Quality   │                    │   │
│  │                                    └─────────────┘                    │   │
│  │                                                                       │   │
│  │  PostgreSQL Job Queue (pg-boss) + State Machine                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Work Packet Index

### Phase 3: Entity & Temporal Foundation

| Packet | Name | Dependencies | Est. Time | Status |
|--------|------|--------------|-----------|--------|
| [W16](./W16-entity-schema.md) | Entity Schema | Phase 2 | 2-3h | ❌ |
| [W17](./W17-bi-temporal-facts.md) | Bi-Temporal Facts | W16 | 3-4h | ❌ |
| [W18](./W18-apache-age.md) | Apache AGE Graph | W16, W17 | 3-4h | ❌ |
| [W19](./W19-hybrid-retrieval.md) | Hybrid Retrieval | W18 | 3-4h | ❌ |
| [W20](./W20-entity-extraction-skill.md) | Entity Extraction Skill | W08, W16 | 2-3h | ❌ |

### Phase 4: Gardener Agents (KARMA)

| Packet | Name | Dependencies | Est. Time | Status |
|--------|------|--------------|-----------|--------|
| [W21](./W21-gardener-scheduler.md) | Central Controller | W16-W20 | 3-4h | ❌ |
| [W22](../phase4/W22-ingestion-agent.md) | Ingestion Agent | W21 | 3h | ❌ |
| [W23](../phase4/W23-reader-agent.md) | Reader Agent | W22 | 3h | ❌ |
| [W24](../phase4/W24-summarizer-agent.md) | Summarizer Agent | W22 | 2h | ❌ |
| [W25](./W25-entity-agent.md) | Entity Extraction Agent | W21 | 3h | ❌ |
| [W26](../phase4/W26-relationship-agent.md) | Relationship Extraction Agent | W25, W17 | 3h | ❌ |
| [W27](../phase4/W27-schema-agent.md) | Schema Alignment Agent | W17, W26 | 2h | ❌ |
| [W28](./W28-conflict-resolution.md) | Conflict Resolution Agent | W17 | 3h | ❌ |
| [W29](../phase4/W29-evaluator-agent.md) | Evaluator Agent | W21, W28 | 2h | ❌ |

### Phase 5: Intelligence & Insights

| Packet | Name | Dependencies | Est. Time | Status |
|--------|------|--------------|-----------|--------|
| [W30](../phase5/W30-community-detection.md) | Community Detection | W18 | 3h | ❌ |
| [W31](../phase5/W31-insight-generation.md) | Insight Generation | W30 | 4h | ❌ |
| [W32](../phase5/W32-morning-briefing.md) | Morning Briefing | W31, W15 | 3h | ❌ |
| [W33](../phase5/W33-contradiction-scheduler.md) | Scheduled Contradiction Detection | W28 | 3h | ❌ |

---

## The Nine KARMA Agents

### 1. Central Controller
**Purpose:** Priority scheduling using multi-armed bandit exploration  
**Tier:** Always running  
**Responsibilities:**
- Schedule jobs based on priority and resource availability
- Balance exploration (new connections) vs exploitation (known patterns)
- Monitor agent health and retry failed jobs
- Manage checkpointing for long-running operations

### 2. Ingestion Agent
**Purpose:** Document retrieval and format normalization  
**Tier:** Realtime  
**Responsibilities:**
- Handle incoming messages from all sources
- Normalize format (voice → text, HTML → markdown)
- Create initial envelope structure
- Route to appropriate processing pipeline

### 3. Reader Agent
**Purpose:** Text parsing with relevance scoring  
**Tier:** Realtime  
**Responsibilities:**
- Chunk long documents intelligently
- Score relevance to existing knowledge
- Identify document structure (headings, lists, quotes)
- Extract metadata (dates, authors, sources)

### 4. Summarizer Agent
**Purpose:** Content condensation preserving entities  
**Tier:** Frequent (5 min)  
**Responsibilities:**
- Generate summaries at multiple granularities
- Preserve entity mentions in summaries
- Create context summaries for conversations
- Update summaries as new information arrives

### 5. Entity Extraction Agent
**Purpose:** LLM-based NER with ontology filtering  
**Tier:** Realtime  
**Responsibilities:**
- Extract named entities (people, places, projects, concepts)
- Classify entity types
- Resolve entities to canonical forms
- Merge duplicate entities (with LLM verification)

### 6. Relationship Extraction Agent
**Purpose:** Multi-label relationship classification  
**Tier:** Frequent (5 min)  
**Responsibilities:**
- Extract relationships between entities
- Create bi-temporal fact triples
- Detect temporal relationships (before, after, during)
- Identify causal relationships

### 7. Schema Alignment Agent
**Purpose:** Novel entity mapping to existing schema  
**Tier:** Periodic (1 hour)  
**Responsibilities:**
- Map new entities to existing types
- Suggest new entity types when needed
- Align properties across entity types
- Maintain ontology consistency

### 8. Conflict Resolution Agent
**Purpose:** LLM-based debate for contradictions  
**Tier:** Periodic (1 hour)  
**Responsibilities:**
- Detect contradicting facts
- Determine which fact supersedes
- Handle temporal supersession
- Flag ambiguous cases for review

### 9. Evaluator Agent
**Purpose:** Confidence scoring across pipeline  
**Tier:** Frequent (5 min)  
**Responsibilities:**
- Score entity resolution confidence
- Score fact extraction confidence
- Measure knowledge graph quality
- Identify areas needing attention

---

## Tiered Processing Schedule

| Tier | Interval | Agents | Max Latency |
|------|----------|--------|-------------|
| **Realtime** | On save | 2, 3, 5 | 100ms |
| **Frequent** | 5 min | 4, 6, 9 | 2 sec |
| **Periodic** | 1 hour | 7, 8 | 10 sec |
| **Deep** | Daily | Community detection, Full graph analysis | 60 sec |

---

## Database Schema Overview

### New Tables (Phase 3)

```sql
-- Entities
entities                -- Canonical entities (people, places, concepts)
entity_aliases          -- Alternative names for entities
entity_merges          -- Audit trail of merged entities

-- Facts (Bi-temporal)
facts                   -- Subject-predicate-object triples with 4 timestamps

-- Links
memory_entities        -- Many-to-many: memories ↔ entities

-- Gardener
gardener_jobs          -- Extended job queue with checkpointing
knowledge_quality      -- Quality metrics over time
```

### Extensions Required

```sql
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS age;        -- Apache AGE for graph
CREATE EXTENSION IF NOT EXISTS btree_gist; -- For temporal exclusion
```

---

## Quick Reference

### Starting Phase 3

```bash
# After Phase 2 complete
cat work-packets/phase3/W16-entity-schema.md

# Install extensions
psql -d cognitive -c "CREATE EXTENSION vector; CREATE EXTENSION age;"
```

### Agent Implementation Pattern

Each agent follows this structure:

```typescript
// platform/src/gardener/agents/[agent-name].agent.ts
export interface AgentContext {
  envelope?: Envelope;
  job: Job;
  services: GardenerServices;
}

export interface AgentResult {
  success: boolean;
  outputs: Record<string, unknown>;
  nextJobs?: NewJob[];
  metrics?: Metrics;
}

export abstract class GardenerAgent {
  abstract name: string;
  abstract tier: 'realtime' | 'frequent' | 'periodic' | 'deep';
  
  abstract execute(context: AgentContext): Promise<AgentResult>;
  
  async checkpoint(state: unknown): Promise<void>;
  async restore(): Promise<unknown>;
}
```

---

## Success Criteria

### Phase 3 Complete When:
- [ ] Entity schema implemented
- [ ] Bi-temporal facts working
- [ ] Apache AGE installed and tested
- [ ] Hybrid retrieval (vector + graph) working
- [ ] Entity extraction on all messages

### Phase 4 Complete When:
- [ ] All 9 agents implemented
- [ ] Tiered scheduling working
- [ ] Contradiction detection working
- [ ] Entity resolution >90% F1

### Phase 5 Complete When:
- [ ] Community detection working
- [ ] Insights surfaced proactively
- [ ] Morning briefing generated
- [ ] System runs autonomously

---

## Related Documents

- [Phase 2 Work Packets](./README.md)
- [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) - Source research
- [ARCHITECTURE.md](../ARCHITECTURE.md)
- [TECHNICAL_PLAN.md](../TECHNICAL_PLAN.md)
