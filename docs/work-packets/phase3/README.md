# Phase 3+ Work Packets: Gardener System

**Goal:** Autonomous Knowledge Gardening with 7-Agent KARMA Architecture
**Duration:** ~6-8 weeks
**Prerequisites:** Phase 2 Complete
**Last Updated:** 2026-03-16

---

## Overall Status

| Phase | Status | Completion |
|-------|--------|------------|
| Phase 2 (Core Skills) | ✅ Complete | 100% |
| Phase 3 (Entity & Temporal) | ✅ Complete | 80% |
| Phase 4 (Gardener Agents) | ✅ Complete | 85% |
| Phase 5 (Intelligence) | ❌ Not Started | 0% |

### Implementation Notes (Last Reviewed: 2026-01-29)

**✅ Phase 3 - Entity & Temporal Foundation (80% Complete):**
- W16: Entity Schema - ✅ Complete (all 4 tables implemented)
- W17: Bi-Temporal Facts - ✅ Complete (with enhancements)
- W18: Apache AGE - ⚠️ Partial (installed but underutilized)
- W19: Hybrid Retrieval - ✅ Complete (not integrated into workflows)
- W20: Entity Extraction - ✅ Complete (via KARMA agent)
- W21: Gardener Scheduler - ✅ Complete (full implementation)

**✅ Phase 4 - Gardener Agents (~75% Complete):**
- 7 KARMA agents implemented and registered (reader, summarizer, entity-extraction, relationship, conflict-resolution, schema-alignment, context-linker)
- Ingestion agent and evaluator agent deleted — responsibilities absorbed by reader/context-linker and controller respectively
- Controller with simple priority + tier defaults (MAB removed in migration 010)
- Typed error hierarchy: `AgentError`, `MlServiceError`, `PayloadError`, `DataFetchError`
- Controller records per-job metrics directly to `gardener_metrics` table
- pg-boss job queue fully functional
- Comprehensive test coverage

**Deviations from Original Plan:**
- Entity extraction uses KARMA agent architecture instead of skill framework
- Hybrid search exists but not integrated into workflows
- Apache AGE installed but only used by hybrid search service
- Enhanced schema with additional fields beyond original spec

---

## Architecture Overview

Based on [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md), implementing a 7-agent KARMA architecture:

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
│  │  │              CENTRAL CONTROLLER                              │     │   │
│  │  │    Priority scheduling + tier defaults, metrics recording    │     │   │
│  │  └─────────────────────────────────────────────────────────────┘     │   │
│  │       │                                                               │   │
│  │       ▼                                                               │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐                    │   │
│  │  │ READER  │→│ SUMMAR. │ │ ENTITY  │→│ RELAT.  │                    │   │
│  │  │         │ │ IZER    │ │ EXTRACT │ │ EXTRACT │                    │   │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘                    │   │
│  │                                │           │                          │   │
│  │                                ▼           ▼                          │   │
│  │                           ┌─────────┐ ┌─────────┐                    │   │
│  │                           │ SCHEMA  │ │CONFLICT │                    │   │
│  │                           │ ALIGN   │ │ RESOLVE │                    │   │
│  │                           └─────────┘ └─────────┘                    │   │
│  │                                                                       │   │
│  │  ┌─────────────────────────────────────────────────────────────┐     │   │
│  │  │              CONTEXT-LINKER                                  │     │   │
│  │  │    Ingestion sessions, CO_TEMPORAL facts, cross-linking      │     │   │
│  │  └─────────────────────────────────────────────────────────────┘     │   │
│  │                                                                       │   │
│  │  PostgreSQL Job Queue (pg-boss) + Typed Error Hierarchy              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Work Packet Index

### Phase 3: Entity & Temporal Foundation

| Packet | Name | Dependencies | Est. Time | Status | Implementation |
|--------|------|--------------|-----------|--------|----------------|
| [W16](./W16-entity-schema.md) | Entity Schema | Phase 2 | 2-3h | ✅ | 4 tables + service ✓ |
| [W17](./W17-bi-temporal-facts.md) | Bi-Temporal Facts | W16 | 3-4h | ✅ | Temporal queries ✓ |
| [W18](./W18-apache-age.md) | Apache AGE Graph | W16, W17 | 3-4h | ⚠️ | Installed, underutilized |
| [W19](./W19-hybrid-retrieval.md) | Hybrid Retrieval | W18 | 3-4h | ✅ | Service exists, not integrated |
| [W20](./W20-entity-extraction-skill.md) | Entity Extraction Skill | W08, W16 | 2-3h | ✅ | Via KARMA agent ✓ |
| [W21](./W21-gardener-scheduler.md) | Gardener Scheduler | W16-W20 | 3-4h | ✅ | Priority + tier defaults ✓ |

### Phase 4: Gardener Agents (KARMA)

| Packet | Name | Dependencies | Est. Time | Status | Implementation |
|--------|------|--------------|-----------|--------|----------------|
| [W21](./W21-gardener-scheduler.md) | Central Controller | W16-W20 | 3-4h | ✅ | Priority + tier defaults, metrics recording ✓ |
| [W22](../phase4/W22-ingestion-agent.md) | ~~Ingestion Agent~~ | W21 | 3h | 🔀 | Replaced: chunking → reader, sessions → context-linker |
| [W23](../phase4/W23-reader-agent.md) | Reader Agent | W21 | 3h | ✅ | Chunk reassembly + metadata extraction ✓ |
| [W24](../phase4/W24-summarizer-agent.md) | Summarizer Agent | W23 | 2h | ✅ | Multi-granularity ✓ |
| [W25](../phase4/W25-entity-agent.md) | Entity Extraction Agent | W21 | 3h | ✅ | LLM-based NER ✓ |
| [W26](../phase4/W26-relationship-agent.md) | Relationship Extraction Agent | W25, W17 | 3h | ✅ | Bi-temporal facts ✓ |
| [W27](../phase4/W27-schema-agent.md) | Schema Alignment Agent | W17, W26 | 2h | ✅ | Ontology alignment ✓ |
| [W28](../phase4/W28-conflict-resolution.md) | Conflict Resolution Agent | W17 | 3h | ⚠️ | Detection working, LLM debate TODO |
| [W29](../phase4/W29-evaluator-agent.md) | ~~Evaluator Agent~~ | W21 | 2h | 🔀 | Replaced: controller records metrics directly |
| — | Context-Linker Agent | W21 | — | ✅ | Ingestion sessions, CO_TEMPORAL facts ✓ |

### Phase 5: Intelligence & Insights

| Packet | Name | Dependencies | Est. Time | Status |
|--------|------|--------------|-----------|--------|
| [W30](../phase5/W30-community-detection.md) | Community Detection | W18 | 3h | ❌ |
| [W31](../phase5/W31-insight-generation.md) | Insight Generation | W30 | 4h | ❌ |
| [W32](../phase5/W32-morning-briefing.md) | Morning Briefing | W31, W15 | 3h | ❌ |
| [W33](../phase5/W33-contradiction-scheduler.md) | Scheduled Contradiction Detection | W28 | 3h | ❌ |

---

## The Seven KARMA Agents

### Central Controller
**Purpose:** Priority scheduling and metrics recording
**Tier:** Always running
**Responsibilities:**
- Schedule jobs based on priority and tier defaults (realtime/frequent/periodic)
- Record per-job metrics directly to `gardener_metrics` table
- Manage checkpointing for long-running operations
- Typed error handling: retry `MlServiceError`/`DataFetchError`, terminal on `PayloadError`

### Reader Agent
**Purpose:** Content parsing, chunk reassembly, relevance scoring
**Tier:** Realtime
**Responsibilities:**
- Reassemble chunked content via `reassembleContent()`
- Score relevance to existing knowledge
- Identify document structure (headings, lists, quotes)
- Extract metadata (dates, authors, sources)

### Summarizer Agent
**Purpose:** Content condensation preserving entities
**Tier:** Frequent
**Responsibilities:**
- Generate summaries at multiple granularities
- Preserve entity mentions in summaries
- Create context summaries for conversations
- Update summaries as new information arrives

### Entity Extraction Agent
**Purpose:** LLM-based NER with ontology filtering
**Tier:** Realtime
**Responsibilities:**
- Extract named entities (people, places, projects, concepts)
- Classify entity types
- Resolve entities to canonical forms
- Link entities to memories (returns entity details)

### Relationship Extraction Agent
**Purpose:** Multi-label relationship classification
**Tier:** Frequent
**Responsibilities:**
- Extract relationships between entities
- Create bi-temporal fact triples (factSummaries)
- Detect temporal relationships (before, after, during)
- Identify causal relationships

### Schema Alignment Agent
**Purpose:** Novel entity mapping to existing schema
**Tier:** Periodic
**Responsibilities:**
- Map new entities to existing types
- Suggest new entity types when needed
- Align properties across entity types
- Maintain ontology consistency

### Conflict Resolution Agent
**Purpose:** Contradiction detection and supersession
**Tier:** Periodic
**Responsibilities:**
- Detect contradicting facts (accepts `factSummaries` from relationship agent)
- Determine which fact supersedes
- Handle temporal supersession
- Flag ambiguous cases for review
- (LLM debate not yet implemented)

### Context-Linker Agent
**Purpose:** Ingestion session processing and temporal linking
**Tier:** Frequent
**Responsibilities:**
- Process expired ingestion sessions (2+ members)
- Compute entity overlap from `memory_entities`
- Generate context summaries via LLM and re-embed members
- Create CO_TEMPORAL knowledge graph edges
- Propagate shared tags and cross-link in Qdrant

---

## Tiered Processing Schedule

| Tier | Interval | Agents |
|------|----------|--------|
| **Realtime** | On save | Reader, Entity Extraction |
| **Frequent** | Configurable (default 5 min) | Summarizer, Relationship, Context-Linker |
| **Periodic** | Configurable (default 1 hour) | Schema Alignment, Conflict Resolution |

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

Each agent follows this structure (defined in `gardener/controller.ts`):

```typescript
// platform/src/gardener/agents/[agent-name].agent.ts
export interface AgentContext {
  job: PgBoss.Job<unknown>;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  checkpoint: (state: unknown) => Promise<void>;
  restoreCheckpoint: () => Promise<unknown | null>;
  traceId: string | null;
  config: Config;
  services: { ml: MlClient; controller: GardenerController };
  signal: AbortSignal;
}

export interface JobResult {
  success: boolean;
  outputs?: Record<string, unknown>;
  nextJobs?: GardenerJob[];
  metrics?: { confidence: number; itemsProcessed: number };
}

export interface GardenerAgent {
  name: string;
  tier: 'realtime' | 'frequent' | 'periodic';
  execute: (context: AgentContext) => Promise<JobResult>;
}
```

Errors are typed (`gardener/errors.ts`): throw `PayloadError` for bad input (terminal), `MlServiceError` for ML failures (retryable), `DataFetchError` for DB/Qdrant failures (retryable).

---

## Success Criteria

### Phase 3 Complete When:
- [x] Entity schema implemented (4 tables)
- [x] Bi-temporal facts working
- [x] Apache AGE installed (underutilized — partial)
- [x] Hybrid retrieval (vector + graph + keyword) working
- [x] Entity extraction on all messages

### Phase 4 Complete When:
- [x] 7 agents implemented and registered
- [x] Tiered scheduling working (realtime/frequent/periodic)
- [x] Typed error hierarchy in place
- [x] Controller-level metrics recording
- [ ] Contradiction detection LLM debate (W28 partial)

### Phase 5 Complete When:
- [ ] Community detection working
- [ ] Insights surfaced proactively
- [ ] Morning briefing generated
- [ ] System runs autonomously

---

## Related Documents

- [Phase 2 Work Packets](../phase2/README.md)
- [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) - Source research
- [ARCHITECTURE.md](../../ARCHITECTURE.md)
- [TECHNICAL_PLAN.md](../../TECHNICAL_PLAN.md)
