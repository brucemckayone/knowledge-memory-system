# Cognitive Platform - Architecture

**Version:** 2.1
**Status:** ✅ Phases 1-4 Substantially Complete
**Last Updated:** 2026-03-16

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| **Message Envelope** | ✅ Implemented | Full `envelope.ts` |
| **Skills & Workflows** | ✅ Implemented | W08-W13, W15 complete; W14 deferred |
| **Plugin System** | 📋 Designed | Phase 2+ |
| **Storage (Qdrant)** | ✅ Implemented | memories collection |
| **Storage (Postgres)** | ✅ Implemented | Phase 1-4 tables implemented |
| **Knowledge Graph** | ✅ Implemented | Entities, facts, Apache AGE (W16-W20) |
| **Background Jobs** | ✅ Implemented | 7 KARMA agents (W21-W28), Intelligence (W30-W33) not started |
| **API Layer** | ⚠️ Partial | `/health`, `/api/search`, `/api/memories` |
| **Telegram Integration** | ✅ Working | Text capture + search via polling |

---

## 1. System Overview

The Cognitive Platform is a **local-first, AI-powered personal knowledge system** that captures thoughts, links, and conversations via Telegram, processes them through intelligent pipelines, and stores them as interconnected, searchable memories.

```d2
direction: right

User: User {
  shape: person
}

Telegram: Telegram API

Platform: Cognitive Platform {
  API: API Layer {
    Webhook: Telegram Webhook
    REST: REST API
    WS: WebSocket
  }

  Queue: pg-boss (Postgres) {
    Jobs: Job Queue
    Workers: Workers
  }

  Core: Processing Core {
    Router: Intent Router
    Orchestrator: Workflow Orchestrator
    Skills: Skill Registry
  }

  Storage: Storage Layer {
    Qdrant: Vector DB
    Postgres: Structured DB
  }

  Background: Background Jobs {
    Gardener: Nightly Gardener
    Briefing: Morning Briefing
    Context: Context Updater
  }
}

Python: Python Services {
  Embed: Embedding API
  Whisper: Transcription API
  Scraper: Web Scraper
}

User -> Telegram
Telegram -> Platform.API.Webhook: Messages
Platform.API.Webhook -> Platform.Queue.Jobs: Enqueue
Platform.Queue.Workers -> Platform.Core.Router: Process
Platform.Core.Router -> Platform.Core.Orchestrator: Dispatch
Platform.Core.Orchestrator -> Platform.Core.Skills: Execute
Platform.Core.Skills -> Python: ML calls
Platform.Core.Skills -> Platform.Storage: Persist
Platform.Storage -> Platform.API.WS: Real-time updates
Platform.API.REST -> User: Dashboard

User.style.fill: "#4A90A4"
Platform.style.fill: "#2D3748"
Platform.API.style.fill: "#4299E1"
Platform.Queue.style.fill: "#ED8936"
Platform.Core.style.fill: "#48BB78"
Platform.Storage.style.fill: "#9F7AEA"
Platform.Background.style.fill: "#F6AD55"
Python.style.fill: "#3776AB"
```

---

## 2. Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **Core Language** | TypeScript | Type safety, your expertise |
| **ML Services** | Python (FastAPI) | Native support for transformers, whisper |
| **Queue** | pg-boss | Postgres-backed queue, retries, scheduling |
| **Vector Store** | Qdrant | Semantic search, filtering |
| **SQL Store** | PostgreSQL | Structured queries, dashboard support |
| **Telegram Bot** | grammy (TypeScript) | Modern, TypeScript-native |
| **API Framework** | Hono or Fastify | Fast, lightweight |
| **Real-time** | WebSocket (via Hono/Fastify) | Dashboard updates |
| **Tunnel** | Tailscale Funnel | Secure webhook access |
| **Container** | Docker Compose | Local orchestration |

---

## 3. Message Envelope Schema

Every message flows through the system as a standardized envelope:

```typescript
interface Envelope {
  // === Identity ===
  envelope_version: "1.0";
  trace_id: string;           // UUID v4
  created_at: string;         // ISO 8601
  
  // === Origin (Extensible) ===
  origin: {
    platform: "telegram" | "email" | "browser" | "voice" | "api";
    
    sender: {
      id: string;
      name: string;
      handle?: string;
    };
    
    context: {
      conversation_id: string;
      conversation_name?: string;
      thread_id?: string;
      reply_to_id?: string;
      message_id?: string;
    };
    
    device?: {
      type: "mobile" | "desktop" | "unknown";
      name?: string;
      location?: { lat: number; lng: number };
    };
    
    platform_data: Record<string, unknown>;
  };
  
  // === Raw Input ===
  raw: {
    type: "text" | "voice" | "image" | "file" | "forward" | "location";
    content?: string;
    media_url?: string;
    file_name?: string;
    file_type?: string;
    forwarded_from?: {
      sender: string;
      date: string;
    };
  };
  
  // === Enrichments (Object for fast lookup) ===
  enrichments: {
    transcribe?: { text: string; language?: string; duration_ms?: number };
    classify?: { intents: Intent[]; primary_intent: string };
    extract_url?: { url: string; domain: string };
    fetch?: { title: string; content: string; author?: string };
    summarize?: { summary: string; key_points?: string[] };
    extract_task?: { action: string; due_date?: string; priority?: string };
    embed?: { vector: number[]; model: string };
    [key: string]: unknown;  // Extensible
  };
  
  // === Pipeline Log (Array for ordering) ===
  pipeline_log: PipelineEntry[];
  
  // === Routing ===
  routing: {
    intents: string[];
    workflows: string[];
    status: "pending" | "processing" | "completed" | "failed";
  };
}

interface Intent {
  type: string;
  confidence: number;
}

interface PipelineEntry {
  stage: string;
  timestamp: string;
  duration_ms: number;
  status: "success" | "failed" | "skipped";
  error?: string;
}
```

---

## 4. Skills & Workflows

### 4.1 Skills (Atomic Capabilities)

```typescript
interface Skill<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  version: string;
  
  execute(input: TInput, context: SkillContext): Promise<TOutput>;
}

interface SkillContext {
  envelope: Envelope;
  config: Record<string, unknown>;
  services: {
    qdrant: QdrantClient;
    postgres: PostgresClient;
    boss: PgBoss;
  };
}
```

**Core Skills:**
| Skill | Input | Output | Service |
|-------|-------|--------|---------|
| `transcribe` | audio_url | text | Python (Whisper) |
| `classify` | text | intents[] | Local LLM |
| `extract-url` | text | url, domain | Regex/LLM |
| `fetch-webpage` | url | title, content | Python (Scraper) |
| `summarize` | content | summary | Local LLM |
| `embed` | text | vector | Python (Embeddings) |
| `store-memory` | envelope | memory_id | Qdrant |
| `extract-task` | text | action, due_date | Local LLM |
| `create-task` | task_data | task_id | Postgres |

### 4.2 Workflows (YAML Config)

```yaml
name: process-link
version: "1.0"
description: Process a URL with optional task extraction

triggers:
  - intent:link
  - intent:link+task

config:
  timeout_ms: 30000
  on_error: fail

steps:
  - name: extract-url
    skill: url-extractor
    input:
      text: "{{ envelope.raw.content }}"
    output: enrichments.url

  - name: fetch-content
    skill: web-fetcher
    input:
      url: "{{ enrichments.url.url }}"
    output: enrichments.fetch

  # Parallel execution block
  - parallel:
      - name: summarize
        skill: summarizer
        input:
          content: "{{ enrichments.fetch.content }}"
        output: enrichments.summary

      - name: embed
        skill: embedder
        input:
          text: "{{ enrichments.summary.summary }}"
        output: enrichments.embed

      - name: extract-task
        skill: task-extractor
        condition: "{{ 'task' in routing.intents }}"
        input:
          text: "{{ envelope.raw.content }}"
        output: enrichments.task

  - name: store-memory
    skill: memory-store
    input:
      envelope: "{{ envelope }}"
      vector: "{{ enrichments.embed.vector }}"
    output: memory_id
```

---

## 5. Plugin System

### 5.1 Plugin Contract

```typescript
interface ProcessorPlugin {
  name: string;
  version: string;
  description: string;
  
  /**
   * Routing function - returns confidence score (0-1) or false
   * Highest score wins when multiple plugins match
   */
  canHandle(envelope: Envelope): number | false;
  
  /**
   * Workflow configuration
   */
  workflow: WorkflowConfig;
  
  /**
   * Required skills
   */
  requires: string[];
  
  /**
   * Lifecycle hooks
   */
  onRegister?(): Promise<void>;
  onShutdown?(): Promise<void>;
}
```

### 5.2 Plugin Registration

```typescript
// plugins/podcast.plugin.ts
export const podcastPlugin: ProcessorPlugin = {
  name: 'podcast-processor',
  version: '1.0.0',
  description: 'Process podcast episodes',
  
  canHandle(envelope) {
    const url = envelope.enrichments?.extract_url?.url;
    if (!url) return false;
    
    const hosts = ['podcasts.apple.com', 'open.spotify.com/episode'];
    return hosts.some(h => url.includes(h)) ? 0.95 : false;
  },
  
  requires: ['audio-downloader', 'transcribe', 'summarize'],
  workflow: loadWorkflow('./podcast.workflow.yaml')
};
```

---

## 6. Storage Architecture

### 6.1 Dual Storage Strategy

```d2
direction: down

Input: Processed Envelope

Qdrant: Qdrant (Vectors) {
  Memories: Atomic Memories
  Contexts: Context Entities
}

Postgres: PostgreSQL (Structured) {
  Tasks: Tasks & Epics
  State: Processing State
  Contexts: Context Summaries
}

Input -> Qdrant.Memories: Vector + payload
Input -> Postgres.Tasks: If task extracted
Input -> Postgres.State: Processing status

Qdrant.style.fill: "#9F7AEA"
Postgres.style.fill: "#4299E1"
```

### 6.2 Qdrant Schema

**Collection: `memories`**
```json
{
  "id": "uuid-v4",
  "vector": [/* 768-dim */],
  "payload": {
    "trace_id": "...",
    "type": "thought | link | research | image",
    "content": "Searchable text",
    "summary": "Short summary",
    "full_text": "Original full content for RAG",
    
    "origin": { /* sender, context, device */ },
    "enrichments": { /* all enrichments */ },
    
    "project": "Project Phoenix",
    "tags": ["architecture"],
    "status": "active | archived",
    "related_to": ["uuid-1", "uuid-2"],
    "context_id": "conversation-context-uuid",
    
    "created_at": "ISO-8601",
    "updated_at": "ISO-8601"
  }
}
```

**Collection: `contexts`**
```json
{
  "id": "uuid-v4",
  "vector": [/* embedding of summary */],
  "payload": {
    "type": "conversation | epic",
    "name": "Phoenix Planning Chat",
    "conversation_id": "telegram-123456",
    "participants": ["Bruce", "John"],
    
    "summary": "Living summary, auto-updated...",
    "message_count": 247,
    "last_message_at": "ISO-8601",
    
    "active_tasks": ["task-uuid-1"],
    "key_memories": ["memory-uuid-1"],
    "insights": ["Pattern: John prefers async"]
  }
}
```

### 6.3 PostgreSQL Schema

```sql
-- Tasks
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID,
  content TEXT NOT NULL,
  due_date TIMESTAMPTZ,
  priority VARCHAR(10) DEFAULT 'medium',
  status VARCHAR(20) DEFAULT 'pending',
  epic_id UUID REFERENCES epics(id),
  context_id UUID,
  memory_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Epics (Projects)
CREATE TABLE epics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'active',
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Context Summaries (for dashboard queries)
CREATE TABLE context_summaries (
  id UUID PRIMARY KEY,
  conversation_id VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  summary TEXT,
  message_count INT DEFAULT 0,
  last_analyzed_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Processing State
CREATE TABLE processing_state (
  conversation_id VARCHAR(255) PRIMARY KEY,
  pending_messages JSONB DEFAULT '[]',
  last_processed_at TIMESTAMPTZ,
  next_analysis_at TIMESTAMPTZ
);
```

### 6.4 Knowledge Graph Schema (Phase 3)

See [W16-entity-schema.md](./work-packets/phase3/W16-entity-schema.md), [W17-bi-temporal-facts.md](./work-packets/phase3/W17-bi-temporal-facts.md)

```sql
-- Entity Tracking (W16)
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name VARCHAR(500) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,  -- person, organization, concept, etc.
  description TEXT,
  embedding VECTOR(768),               -- pgvector
  confidence FLOAT DEFAULT 1.0,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE entity_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  alias VARCHAR(500) NOT NULL,
  source VARCHAR(100),                 -- extraction, user_input, merge
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE entity_merges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID NOT NULL,
  target_entity_id UUID REFERENCES entities(id),
  merged_at TIMESTAMPTZ DEFAULT NOW(),
  merged_by VARCHAR(100) DEFAULT 'system'
);

CREATE TABLE memory_entities (
  memory_id UUID NOT NULL,
  entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  mention_text VARCHAR(500),
  mention_context TEXT,
  confidence FLOAT DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (memory_id, entity_id)
);

-- Bi-Temporal Facts (W17)
CREATE TABLE fact_predicates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  predicate VARCHAR(200) UNIQUE NOT NULL,
  description TEXT,
  inverse_predicate VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_entity_id UUID REFERENCES entities(id),
  predicate_id UUID REFERENCES fact_predicates(id),
  object_entity_id UUID REFERENCES entities(id),
  object_value TEXT,                    -- For non-entity objects
  
  -- Bi-temporal timestamps
  valid_at TIMESTAMPTZ NOT NULL,        -- When fact became true
  invalid_at TIMESTAMPTZ,               -- When fact stopped being true
  created_at TIMESTAMPTZ DEFAULT NOW(), -- When we learned this
  expired_at TIMESTAMPTZ,               -- When superseded by new info
  
  source_memory_id UUID,
  confidence FLOAT DEFAULT 1.0,
  embedding VECTOR(768)
);

-- Indexes for temporal queries
CREATE INDEX idx_facts_temporal ON facts (valid_at, invalid_at, created_at, expired_at);
CREATE INDEX idx_facts_subject ON facts (subject_entity_id);
CREATE INDEX idx_facts_object ON facts (object_entity_id);
```

### 6.5 Gardener Infrastructure Schema (Phase 3-4)

See [W21-gardener-scheduler.md](./work-packets/phase3/W21-gardener-scheduler.md)

```sql
-- Job Metadata (W21)
CREATE TABLE gardener_job_meta (
  job_type VARCHAR(100) PRIMARY KEY,
  tier VARCHAR(20) NOT NULL,            -- realtime, frequent, periodic, deep
  priority INT DEFAULT 50,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  avg_duration_ms INT,
  success_rate FLOAT DEFAULT 1.0,
  enabled BOOLEAN DEFAULT true
);

-- Performance Metrics (W21)
CREATE TABLE gardener_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type VARCHAR(100) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  success BOOLEAN,
  error_message TEXT,
  items_processed INT DEFAULT 0,
  duration_ms INT
);

-- Note: MAB (mab_state) table was removed in migration 010.
-- Scheduling now uses simple priority + tier defaults.

-- Ingestion Chunks (W22)
CREATE TABLE memory_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  token_count INT,
  embedding VECTOR(768),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.6 Intelligence Layer Schema (Phase 5)

See [W30-community-detection.md](./work-packets/phase5/W30-community-detection.md), [W31-insight-generation.md](./work-packets/phase5/W31-insight-generation.md), [W32-morning-briefing.md](./work-packets/phase5/W32-morning-briefing.md), [W33-contradiction-scheduler.md](./work-packets/phase5/W33-contradiction-scheduler.md)

```sql
-- Community Detection (W30)
CREATE TABLE communities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  description TEXT,
  entity_ids UUID[] NOT NULL,
  centroid_entity_id UUID REFERENCES entities(id),
  cohesion_score FLOAT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insight Generation (W31)
CREATE TABLE insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_type VARCHAR(50) NOT NULL,    -- connection, trend, gap, pattern
  title VARCHAR(500) NOT NULL,
  description TEXT,
  entity_ids UUID[],
  community_id UUID REFERENCES communities(id),
  confidence FLOAT DEFAULT 1.0,
  surfaced BOOLEAN DEFAULT false,
  surfaced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Morning Briefings (W32)
CREATE TABLE briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  briefing_date DATE NOT NULL UNIQUE,
  content JSONB NOT NULL,               -- {tasks, events, insights, rediscoveries}
  delivered BOOLEAN DEFAULT false,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE memories_meta (
  memory_id UUID PRIMARY KEY,
  last_surfaced_at TIMESTAMPTZ,
  surface_count INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Contradiction Reviews (W33)
CREATE TABLE contradiction_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id_1 UUID REFERENCES facts(id),
  fact_id_2 UUID REFERENCES facts(id),
  contradiction_type VARCHAR(50),       -- direct, temporal, semantic
  severity VARCHAR(20),                 -- low, medium, high, critical
  auto_resolved BOOLEAN DEFAULT false,
  resolution VARCHAR(50),               -- superseded, merged, flagged
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 7. Background Jobs

### 7.1 Gardener System (KARMA Architecture)

Based on [GARDENER_RESEARCH.md](../research/gardener-research.md), the Gardener implements a 7-agent KARMA architecture for autonomous knowledge maintenance:

```d2
direction: down

Controller: Central Controller {
  Scheduler: Priority Scheduler
  Metrics: gardener_metrics
}

Reader: Reader Agent
Summarizer: Summarizer Agent
EntityExt: Entity Extraction
RelExt: Relationship Extraction
Schema: Schema Alignment
Conflict: Conflict Resolution
CtxLinker: Context-Linker Agent

Controller -> Reader: dispatch
Reader -> Summarizer
Reader -> EntityExt
EntityExt -> RelExt
EntityExt -> Schema
RelExt -> Conflict
CtxLinker -> Controller: sessions
Controller -> CtxLinker: scheduled
```

#### The Seven Agents

| Agent | Tier | Purpose |
|-------|------|---------|
| Reader | Realtime | Content parsing, chunk reassembly, relevance scoring |
| Summarizer | Frequent | Content condensation |
| Entity Extraction | Realtime | LLM-based NER, entity resolution |
| Relationship Extraction | Frequent | Multi-label relation classification, bi-temporal facts |
| Schema Alignment | Periodic | Novel entity mapping to ontology |
| Conflict Resolution | Periodic | Contradiction detection, supersession |
| Context-Linker | Frequent | Ingestion session processing, CO_TEMPORAL facts, cross-linking |

The **Central Controller** manages priority scheduling (simple priority + tier defaults), job orchestration, and records per-job metrics directly to `gardener_metrics`. MAB (Multi-Armed Bandit) scheduling was removed in favour of this simpler approach.

#### Error Hierarchy

Agents use a typed error hierarchy (`gardener/errors.ts`) that the controller inspects to decide retry behaviour:

| Error Class | Retryable | Use Case |
|-------------|-----------|----------|
| `AgentError` | configurable | Base class |
| `MlServiceError` | yes | ML service timeouts, 5xx, network |
| `PayloadError` | no | Bad/missing job payload — terminal |
| `DataFetchError` | yes | DB/Qdrant fetch failures |

#### AgentContext Interface

```typescript
interface AgentContext {
  job: PgBoss.Job<unknown>;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  checkpoint: (state: unknown) => Promise<void>;
  restoreCheckpoint: () => Promise<unknown | null>;
  traceId: string | null;
  config: Config;
  services: { ml: MlClient; controller: GardenerController };
  signal: AbortSignal;
}
```

#### Tiered Processing

| Tier | Interval | Agents |
|------|----------|--------|
| Realtime | On save | Reader, Entity Extraction |
| Frequent | Configurable (default 5 min) | Summarizer, Relationship, Context-Linker |
| Periodic | Configurable (default 1 hour) | Schema Alignment, Conflict Resolution |

See [work-packets/phase3/](./work-packets/phase3/) for implementation details.

### 7.2 Context Updater (Timer-based)

**Trigger:** Every ~4 new messages in a conversation

**Logic:**
1. Cache incoming messages
2. Every 4 messages, analyze the batch
3. If significant: update context summary, extract tasks
4. If trivial: skip, wait for more messages

### 7.3 Morning Briefing (8am)

**Content:**
- Tasks due today
- Stale projects needing attention
- Pattern observations from Ponderer
- Random rediscovery from old memories

---

## 8. API Layer

### 8.1 REST Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | System health check |
| `/memories` | GET | Search/list memories |
| `/memories/:id` | GET | Get single memory |
| `/tasks` | GET/POST | List/create tasks |
| `/tasks/:id` | PATCH | Update task |
| `/epics` | GET | List epics/projects |
| `/contexts` | GET | List conversation contexts |
| `/contexts/:id` | GET | Get context details |
| `/briefing` | GET | Get today's briefing |
| `/search/hybrid` | POST | Hybrid search (vector + graph + keyword) (W19) |
| `/entities` | GET | List/search entities (W16) |
| `/entities/:id` | GET | Get entity with relationships |
| `/facts` | GET | Query bi-temporal facts (W17) |
| `/graph/paths` | POST | Find paths between entities (W18) |
| `/insights` | GET | List surfaced insights (W31) |

### 8.2 ML Service Endpoints (Python FastAPI)

Internal endpoints consumed by the TypeScript platform. See [ml-services/](./ml-services/).

| Endpoint | Method | Work Packet | Description |
|----------|--------|-------------|-------------|
| `/embed` | POST | - | Generate 768-dim embeddings |
| `/transcribe` | POST | W10 | Voice-to-text via Whisper |
| `/scrape` | POST | W13 | Web content extraction |
| `/extract-entities` | POST | W25 | LLM-based Named Entity Recognition |
| `/resolve-entity` | POST | W25 | Resolve alias to canonical entity |
| `/parse-content` | POST | W23 | Content type classification |
| `/summarize` | POST | W24 | Generate concise summaries |
| `/extract-relationships` | POST | W26 | Extract entity relationships |
| `/check-contradiction` | POST | W28 | Detect fact contradictions |

### 8.3 Hybrid Retrieval (W19)

Combines three search strategies using **Reciprocal Rank Fusion (RRF)**:

```
score(d) = Σ 1/(k + rank_i(d))   where k=60
```

| Strategy | Source | Strength |
|----------|--------|----------|
| **Vector Search** | Qdrant cosine similarity | Semantic understanding |
| **Graph Traversal** | Apache AGE path finding | Relationship discovery |
| **Keyword Search** | Qdrant metadata filtering | Exact term matching |

See [W19-hybrid-retrieval.md](./work-packets/phase3/W19-hybrid-retrieval.md) for implementation.

### 8.4 WebSocket Events

```typescript
// Client subscribes to updates
ws.send({ type: 'subscribe', channels: ['memories', 'tasks'] });

// Server pushes events
{ type: 'memory:created', data: { id, summary, type } }
{ type: 'task:created', data: { id, content, due_date } }
{ type: 'context:updated', data: { id, summary } }
{ type: 'insight:generated', data: { insight } }
```

### 8.5 Security

- **Telegram webhook:** Signature verification using bot token
- **Local API:** Bearer token authentication (generated on first run)
- **WebSocket:** Same token-based auth

---

## 9. Telegram Integration

### 9.1 Behavior

| Message Type | Behavior |
|--------------|----------|
| **DM to bot** | Process immediately, queue if busy |
| **Group chat** | Batch messages, analyze on timer |
| **@mention** | Respond to query |
| **Voice note** | Transcribe → process as text |
| **Forwarded** | Include forwarded_from context |
| **File/Image** | Store reference, process if supported |

### 9.2 Response Policy

- **Capture:** Silent (no reply unless error)
- **Query:** Reply with results
- **Error:** Reply with error message
- **Briefing:** Proactive at 8am

### 9.3 Natural Language Only

No slash commands. All interaction via natural language:
- "find my notes about Kubernetes"
- "what did John say about the deadline"
- "remind me to call Bob tomorrow"

---

## 10. Deployment

### 10.1 Docker Compose

```yaml
services:
  # Core
  platform:
    build: ./platform
    ports: ["3000:3000"]
    depends_on:
      postgres:
        condition: service_healthy
      qdrant:
        condition: service_started
    environment:
      - TELEGRAM_BOT_TOKEN=...
      - DATABASE_URL=postgres://cognitive:cognitive@postgres:5432/cognitive
      - QDRANT_URL=http://qdrant:6333

  # Storage
  postgres:
    image: postgres:16-alpine
    volumes: ["postgres-data:/var/lib/postgresql/data"]
    environment:
      - POSTGRES_DB=cognitive
      - POSTGRES_USER=cognitive
      - POSTGRES_PASSWORD=cognitive
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cognitive"]
      interval: 5s
      timeout: 5s
      retries: 5

  qdrant:
    image: qdrant/qdrant:v1.7.4
    volumes: ["qdrant-data:/qdrant/storage"]
    ports: ["6333:6333"]

  # Python Services
  ml-services:
    build: ./ml-services
    ports: ["8000:8000"]

volumes:
  postgres-data:
  qdrant-data:
```

### 10.2 Directory Structure

```
cognitive-platform/
├── platform/                 # TypeScript core
│   ├── src/
│   │   ├── api/             # REST + WebSocket
│   │   ├── bot/             # Telegram integration
│   │   ├── core/            # Router, Orchestrator
│   │   ├── skills/          # Skill implementations (W08, W10-W13, W20)
│   │   ├── plugins/         # Plugin registry
│   │   ├── storage/         # Qdrant + Postgres clients
│   │   ├── queue/           # pg-boss queue setup
│   │   ├── services/        # Domain services (NEW)
│   │   │   ├── entity.ts    # Entity management (W16)
│   │   │   ├── facts.ts     # Bi-temporal facts (W17)
│   │   │   ├── graph.ts     # Apache AGE integration (W18)
│   │   │   ├── graph-sync.ts # Graph synchronization (W18)
│   │   │   └── hybrid.ts    # Hybrid retrieval (W19)
│   │   ├── gardener/        # KARMA Agent System
│   │   │   ├── controller.ts # Central Controller (W21)
│   │   │   ├── errors.ts     # Typed error hierarchy
│   │   │   ├── agents/
│   │   │   │   ├── index.ts           # Agent registration
│   │   │   │   ├── reader.agent.ts    # Reader (W23)
│   │   │   │   ├── summarizer.agent.ts # Summarizer (W24)
│   │   │   │   ├── entity-extraction.agent.ts # Entity Extraction (W25)
│   │   │   │   ├── relationship.agent.ts # Relationship (W26)
│   │   │   │   ├── schema-alignment.agent.ts # Schema Alignment (W27)
│   │   │   │   ├── conflict-resolution.agent.ts # Conflict Resolution (W28)
│   │   │   │   └── context-linker.agent.ts # Context-Linker
│   │   │   └── jobs/
│   │   │       ├── community.ts   # Community detection (W30)
│   │   │       ├── insight.ts     # Insight generation (W31)
│   │   │       ├── briefing.ts    # Morning briefing (W32)
│   │   │       └── contradiction.ts # Contradiction scheduler (W33)
│   │   └── background/      # Legacy: Context Updater
│   ├── workflows/           # YAML workflow definitions (W14)
│   └── package.json
├── ml-services/             # Python FastAPI services
│   ├── app/
│   │   ├── main.py          # FastAPI app setup
│   │   ├── embed.py         # /embed endpoint
│   │   ├── transcribe.py    # /transcribe endpoint (W10)
│   │   ├── scrape.py        # /scrape endpoint (W13)
│   │   ├── entities.py      # /extract-entities, /resolve-entity (W25)
│   │   ├── reader.py        # /parse-content (W23)
│   │   ├── summarize.py     # /summarize (W24)
│   │   ├── relationships.py # /extract-relationships (W26)
│   │   └── conflict.py      # /check-contradiction (W28)
│   └── requirements.txt
├── docker-compose.yml
└── .env
```

---

## 11. Configuration

```yaml
# config.yaml
telegram:
  bot_token: ${TELEGRAM_BOT_TOKEN}
  webhook_secret: ${TELEGRAM_WEBHOOK_SECRET}

queue:
  concurrency: 2
  rate_limit:
    max: 10
    duration: 1000

processing:
  context_check_interval: 4  # messages
  context_batch_timeout: 300  # seconds

gardener:
  schedule: "0 2 * * *"  # 2am daily
  stale_threshold_days: 30
  archive_after_days: 7

briefing:
  schedule: "0 8 * * *"  # 8am daily
  timezone: "UTC"

models:
  embedding: "nomic-embed-text"
  llm: "llama3.2:3b"
  whisper: "small"

storage:
  qdrant_url: ${QDRANT_URL}
  postgres_url: ${DATABASE_URL}
```

---

## 12. Testing Architecture

The platform uses **Vitest 4** with a module boundary testing strategy that validates integration points between components.

### 12.1 Test Structure

```
platform/src/test/
├── global-setup.ts      # Database initialization, extension detection
├── setup.ts             # Per-file setup, utilities, extension flags
├── generators/          # Test data factories
│   ├── entity.ts        # Entity test data
│   └── fact.ts          # Fact test data
├── integration/         # Module boundary tests
│   ├── database.test.ts # Platform ↔ PostgreSQL (DB-001 to DB-010)
│   ├── qdrant.test.ts   # Platform ↔ Qdrant (QD-001 to QD-007)
│   ├── ml-services.test.ts  # Platform ↔ ML Services (ML-001 to ML-010)
│   ├── knowledge-graph.test.ts  # Entities ↔ Facts ↔ Graph (KG-001 to KG-007)
│   ├── hybrid-search.test.ts    # Hybrid retrieval (HS-001 to HS-007)
│   └── gardener.test.ts         # Gardener controller (GC-001 to GC-010)
├── agents/              # KARMA agent tests
│   ├── entity-extraction.test.ts  # Agent #5
│   └── conflict-resolution.test.ts # Agent #8
└── e2e/                 # End-to-end pipeline tests
    └── message-pipeline.test.ts
```

### 12.2 Test Naming Convention

Tests are numbered by module boundary:
- **DB-XXX**: Database integration (entities, facts, bi-temporal queries)
- **QD-XXX**: Qdrant vector storage
- **ML-XXX**: ML Services (embeddings, NER, summarization)
- **KG-XXX**: Knowledge graph coherence
- **HS-XXX**: Hybrid search/retrieval
- **GC-XXX**: Gardener controller and scheduling

### 12.3 Graceful Degradation

The test infrastructure detects missing PostgreSQL extensions and external services at startup:

```typescript
// global-setup.ts tracks extension availability
const extensionAvailability = {
  vector: false,   // pgvector for embeddings
  pg_trgm: false,  // Trigram for fuzzy search
  uuid_ossp: true, // UUID generation
};

// Tests use skipIf for conditional execution
describe('DB-002: Entity deduplication', () => {
  it.skipIf(!hasVectorExtension)('should identify similar entities', async () => {
    // Vector similarity test - skipped if pgvector unavailable
  });
});
```

**Extension Behavior:**

| Extension | Required For | Fallback |
|-----------|--------------|----------|
| `uuid-ossp` | UUID generation | Required, no fallback |
| `vector` | Embedding similarity | Tests skip, tables created without vector columns |
| `pg_trgm` | Fuzzy text matching | Tests skip, basic btree indexes used |

**Service Behavior:**

| Service | Required For | Detection |
|---------|--------------|-----------|
| PostgreSQL | All tests | Connection check at startup |
| Qdrant | Vector search tests | Health endpoint check |
| ML Services | Entity extraction, embeddings | Health endpoint check |

### 12.4 Running Tests

```bash
# Full test suite (services may skip if unavailable)
pnpm test

# Specific module boundary
pnpm test src/test/integration/database.test.ts

# With coverage
pnpm test --coverage

# Watch mode
pnpm test:watch
```

### 12.5 Test Database

Tests use a dedicated `cognitive_test` database that is:
- Created automatically on first test run
- Schema created from global-setup.ts (mirrors production)
- Truncated between tests for isolation
- Not dropped after tests (for debugging failed tests)

To reset the test database:
```bash
PGPASSWORD=postgres psql -U postgres -h localhost -c "DROP DATABASE cognitive_test;"
```

---

## 13. Next Steps

1. **Model Research** – Benchmark embedding/LLM models on M1
2. **Scaffold Project** – Create directory structure, Docker setup
3. **MVP: Text Capture** – Telegram → Queue → Qdrant
4. **MVP: Search** – Natural language query → results
5. **Iterate** – Add voice, links, tasks, context

---

*This architecture is designed for a single user running locally. It prioritizes simplicity and extensibility over distributed scale.*
