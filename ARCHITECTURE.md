# Cognitive Platform - Architecture

**Version:** 2.0 (Final)  
**Status:** Implementation Ready

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

  Queue: BullMQ + Redis {
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
| **Queue** | BullMQ + Redis | Rate limiting, retries, backpressure |
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
    redis: RedisClient;
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

---

## 7. Background Jobs

### 7.1 Gardener (Nightly, 2am)

```d2
direction: right

Gardener: Nightly Gardener (2am)

Tasks: Task Maintenance {
  Archive: Archive done tasks (7+ days)
  Stale: Flag stale epics (30+ days)
}

Memory: Memory Maintenance {
  Link: Auto-link similar memories
  Clean: Clean orphaned data
}

Insights: Insight Generation {
  Patterns: Detect thought patterns
  Connections: Surface connections
}

Gardener -> Tasks
Gardener -> Memory
Gardener -> Insights
```

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

### 8.2 WebSocket Events

```typescript
// Client subscribes to updates
ws.send({ type: 'subscribe', channels: ['memories', 'tasks'] });

// Server pushes events
{ type: 'memory:created', data: { id, summary, type } }
{ type: 'task:created', data: { id, content, due_date } }
{ type: 'context:updated', data: { id, summary } }
{ type: 'insight:generated', data: { insight } }
```

### 8.3 Security

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
    depends_on: [redis, postgres, qdrant]
    environment:
      - TELEGRAM_BOT_TOKEN=...
      - DATABASE_URL=postgres://...
      - REDIS_URL=redis://redis:6379
      - QDRANT_URL=http://qdrant:6333

  # Queue
  redis:
    image: redis:7-alpine
    volumes: ["redis-data:/data"]

  # Storage
  postgres:
    image: postgres:15
    volumes: ["postgres-data:/var/lib/postgresql/data"]
    environment:
      - POSTGRES_DB=cognitive
      - POSTGRES_PASSWORD=...

  qdrant:
    image: qdrant/qdrant:latest
    volumes: ["qdrant-data:/qdrant/storage"]

  # Python Services
  ml-services:
    build: ./ml-services
    ports: ["8000:8000"]
    volumes: ["./models:/models"]

volumes:
  redis-data:
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
│   │   ├── skills/          # Skill implementations
│   │   ├── plugins/         # Plugin registry
│   │   ├── storage/         # Qdrant + Postgres clients
│   │   ├── queue/           # BullMQ setup
│   │   └── background/      # Gardener, Briefing
│   ├── workflows/           # YAML workflow definitions
│   └── package.json
├── ml-services/             # Python services
│   ├── app/
│   │   ├── embed.py         # Embedding endpoint
│   │   ├── transcribe.py    # Whisper endpoint
│   │   └── scrape.py        # Web scraper
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
  redis_url: ${REDIS_URL}
```

---

## 12. Next Steps

1. **Model Research** – Benchmark embedding/LLM models on M1
2. **Scaffold Project** – Create directory structure, Docker setup
3. **MVP: Text Capture** – Telegram → Queue → Qdrant
4. **MVP: Search** – Natural language query → results
5. **Iterate** – Add voice, links, tasks, context

---

*This architecture is designed for a single user running locally. It prioritizes simplicity and extensibility over distributed scale.*
