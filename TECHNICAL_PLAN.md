# Cognitive Platform - Technical Plan

**Version:** 2.0 (Final)  
**Status:** Implementation Roadmap

---

## 1. Overview

This document outlines the phased implementation approach for the Cognitive Platform. Each phase builds on the previous, delivering incremental value while maintaining a solid foundation.

```d2
direction: right

Phase0: Phase 0 - Research {
  Model selection
  Benchmarking
}

Phase1: Phase 1 - Foundation {
  Infrastructure
  Basic capture
}

Phase2: Phase 2 - Core {
  Skills and workflows
  Telegram features
}

Phase3: Phase 3 - Intelligence {
  Context entities
  Gardener
  Briefing
}

Phase4: Phase 4 - Polish {
  Dashboard
  Refinement
}

Phase0 -> Phase1: 1 week
Phase1 -> Phase2: 2 weeks
Phase2 -> Phase3: 2-3 weeks
Phase3 -> Phase4: 3+ weeks

Phase0.style.fill: "#F39C12"
Phase1.style.fill: "#27AE60"
Phase2.style.fill: "#3498DB"
Phase3.style.fill: "#9B59B6"
Phase4.style.fill: "#E74C3C"
```

---

## 2. Phase 0: Research (Current)

**Goal:** Select optimal models for M1 Mac performance

**Duration:** ~1 week

### 2.1 Embedding Model Research

| Model | Dimensions | To Benchmark |
|-------|------------|--------------|
| nomic-embed-text | 768 | Speed, quality |
| mxbai-embed-large | 1024 | Quality, memory |
| all-MiniLM-L6-v2 | 384 | Speed |

**Deliverables:**
- [ ] Benchmark embedding speed on M1
- [ ] Test retrieval quality with sample queries
- [ ] Document recommended model

### 2.2 LLM Model Research

| Use Case | Candidates | To Evaluate |
|----------|------------|-------------|
| **Classification** | Llama 3.2 3B, Mistral 7B | Accuracy, speed |
| **Summarization** | Llama 3.4 8B, Phi-3 | Quality, context length |
| **Task Extraction** | Llama 3.4 8B | Date parsing, action extraction |

**Deliverables:**
- [ ] Test router accuracy with classification prompts
- [ ] Evaluate summarization quality
- [ ] Document prompt templates

### 2.3 Whisper Model Research

| Model | Size | Speed Target |
|-------|------|--------------|
| tiny | 39MB | ~10x realtime |
| small | 244MB | ~4x realtime |
| medium | 769MB | ~1x realtime |

**Deliverables:**
- [ ] Test transcription accuracy on voice notes
- [ ] Benchmark speed on M1
- [ ] Choose best speed/accuracy tradeoff

---

## 3. Phase 1: Foundation

**Goal:** Working infrastructure with basic text capture and retrieval

**Duration:** ~2 weeks

### 3.1 Infrastructure Setup

```d2
direction: down

Docker: docker-compose.yml {
  Platform: TypeScript App (3000)
  Redis: Redis (6379)
  Qdrant: Qdrant (6333)
  Postgres: PostgreSQL (5432)
  ML: Python Services (8000)
}

External: External Services {
  Tailscale: Tailscale Funnel
  Telegram: Telegram Bot API
}

External.Telegram -> Docker.Platform: Webhooks
External.Tailscale -> Docker.Platform: Tunnel
Docker.Platform -> Docker.Redis: Queue
Docker.Platform -> Docker.Qdrant: Vectors
Docker.Platform -> Docker.Postgres: Structured
Docker.Platform -> Docker.ML: Embeddings
```

**Tasks:**
| Task | Description | Blocked By |
|------|-------------|------------|
| Project scaffold | Create TypeScript + Python directory structure | - |
| Docker Compose | Create `docker-compose.yml` with all services | - |
| Postgres schema | Run migrations for tasks, epics, state tables | Docker |
| Qdrant collection | Create `memories` collection with schema | Docker |
| Redis setup | Configure BullMQ queues | Docker |
| Tailscale | Configure Funnel for webhook access | Docker |
| Telegram bot | Create bot via BotFather, set webhook | Tailscale |

### 3.2 Core TypeScript Application

```d2
direction: right

src: src/ {
  api: API Layer {
    webhook: Telegram Webhook
    health: Health Check
  }
  queue: Queue {
    bullmq: BullMQ Setup
    workers: Worker Pool
  }
  storage: Storage {
    qdrant: Qdrant Client
    postgres: Postgres Client
  }
}
```

**Deliverables:**
- [ ] Hono/Fastify API with Telegram webhook endpoint
- [ ] BullMQ queue with worker setup
- [ ] Qdrant + Postgres client wrappers
- [ ] Environment configuration

### 3.3 Python ML Services

```d2
direction: right

ml: FastAPI Services {
  embed: POST /embed
  transcribe: POST /transcribe
  health: GET /health
}
```

**Deliverables:**
- [ ] FastAPI app with embedding endpoint
- [ ] Whisper transcription endpoint
- [ ] Docker setup with model caching

### 3.4 MVP: Text Capture

```d2
direction: right

1: Telegram message
2: Webhook receives
3: Enqueue job
4: Worker picks up
5: Generate embedding
6: Store in Qdrant
7: Silent (no reply)

1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7
```

**Deliverables:**
- [ ] End-to-end text capture flow
- [ ] Envelope creation with origin metadata
- [ ] Test: Send message, verify in Qdrant

### 3.5 MVP: Basic Retrieval

```d2
direction: right

1: User asks question
2: Classify as "search"
3: Embed query
4: Vector search
5: Format results
6: Reply

1 -> 2 -> 3 -> 4 -> 5 -> 6
```

**Deliverables:**
- [ ] Search query detection (keyword or LLM)
- [ ] Vector similarity search
- [ ] Reply formatting
- [ ] Test: Search returns relevant memories

---

## 4. Phase 2: Core Skills & Processing

**Goal:** Full workflow system with voice, links, and tasks

**Duration:** ~2 weeks

### 4.1 Skill Framework

**Deliverables:**
- [ ] Skill interface and registry
- [ ] Skill context (access to storage, config)
- [ ] Base skills: transcribe, classify, summarize, embed

### 4.2 Workflow Engine

**Deliverables:**
- [ ] YAML workflow parser
- [ ] Sequential and parallel step execution
- [ ] Condition evaluation (Jinja-like templating)
- [ ] Error handling and logging

### 4.3 Core Workflows

| Workflow | Trigger | Skills |
|----------|---------|--------|
| process-thought | intent:thought | classify, embed, store |
| process-link | intent:link | extract-url, fetch, summarize, embed, store |
| process-task | intent:task | extract-task, create-task |
| process-voice | raw.type:voice | transcribe, classify, (route to above) |

**Deliverables:**
- [ ] YAML workflow definitions
- [ ] Link processor with web fetching
- [ ] Task extractor with date parsing
- [ ] Voice transcription integration

### 4.4 Intent Router

**Deliverables:**
- [ ] LLM-based intent classification
- [ ] Multi-intent detection
- [ ] Confidence scoring
- [ ] Workflow dispatch

### 4.5 Telegram Features

**Deliverables:**
- [ ] Voice note handling (download + transcribe)
- [ ] Image/file handling (store reference)
- [ ] Forwarded message context
- [ ] Group chat message batching

---

## 5. Phase 3: Intelligence & Automation

**Goal:** Context entities, background jobs, proactive features

**Duration:** 2-3 weeks

### 5.1 Context Entities

```d2
direction: down

Messages: Incoming Messages

Cache: Message Cache {
  Per conversation
  Last 4 messages
}

Analyze: Analysis Job {
  Diff with existing
  Extract significance
}

Context: Context Entity {
  Qdrant: Vector summary
  Postgres: Structured data
}

Messages -> Cache
Cache -> Analyze: Every 4 messages
Analyze -> Context: If significant
```

**Deliverables:**
- [ ] Message caching per conversation
- [ ] Context creation on new chat_id
- [ ] Summary regeneration logic
- [ ] Task extraction from conversations
- [ ] Dual storage (Qdrant + Postgres)

### 5.2 Memory Linking

**Deliverables:**
- [ ] Auto-linking similar memories (>0.85 similarity)
- [ ] Temporal linking (adjacent messages)
- [ ] `related_to` field population

### 5.3 The Gardener

**Schedule:** 2am daily

**Deliverables:**
- [ ] Archive done tasks (7+ days)
- [ ] Flag stale epics (30+ days inactive)
- [ ] Clean orphaned data (failed processing)
- [ ] Generate insights (pattern detection)

### 5.4 Morning Briefing

**Schedule:** 8am daily

**Deliverables:**
- [ ] Query tasks due today
- [ ] Identify stale projects
- [ ] Random memory rediscovery
- [ ] Formatted Telegram message

---

## 6. Phase 4: Dashboard & Polish

**Goal:** Visual interface and refinement

**Duration:** 3+ weeks

### 6.1 REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/memories` | GET | Search memories |
| `/memories/:id` | GET | Get memory details |
| `/tasks` | GET/POST | List/create tasks |
| `/tasks/:id` | PATCH | Update task |
| `/epics` | GET | List epics |
| `/contexts` | GET | List conversations |
| `/briefing` | GET | Get today's briefing |

### 6.2 WebSocket API

**Deliverables:**
- [ ] Real-time event streaming
- [ ] Channel subscriptions
- [ ] Memory/task/context updates

### 6.3 Desktop Dashboard (Future)

**Technology:** TBD (Tauri? Electron? Web?)

**Features:**
- Knowledge graph visualization
- Task kanban board
- Search interface
- Insight feed

---

## 7. Plugin System (Ongoing)

As the system matures, add plugins for new content types:

| Plugin | Trigger | Skills Needed |
|--------|---------|---------------|
| YouTube | youtube.com URLs | transcript-fetch, summarize |
| Podcast | podcast URLs | audio-download, transcribe |
| PDF | .pdf files | pdf-extract, summarize |
| Research | intent:question | web-search, synthesize |

---

## 8. Success Criteria

### Phase 1 Complete
- [ ] Docker Compose runs all services
- [ ] Text messages capture to Qdrant
- [ ] Basic search returns relevant results

### Phase 2 Complete
- [ ] Router classifies 90%+ correctly
- [ ] Voice notes transcribe accurately
- [ ] Links summarize and store
- [ ] Tasks create with due dates

### Phase 3 Complete
- [ ] Context entities update per conversation
- [ ] Memories auto-link by similarity
- [ ] Gardener runs nightly
- [ ] Briefing sends at 8am

### Phase 4 Complete
- [ ] REST API fully functional
- [ ] WebSocket streaming works
- [ ] Dashboard shows knowledge graph
- [ ] System feels like a "second brain"

---

## 9. Technology Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Core language | TypeScript | Type safety, familiarity |
| ML services | Python (FastAPI) | Native transformers/whisper |
| Queue | BullMQ + Redis | Rate limiting, retries |
| Vector DB | Qdrant | Filtering, performance |
| SQL DB | PostgreSQL | Dashboard queries |
| Bot framework | grammy | TypeScript native |
| API framework | Hono or Fastify | Fast, lightweight |
| Container | Docker Compose | Local orchestration |

---

## 10. Immediate Next Steps

1. **Complete Phase 0:** Model research and benchmarking
2. **Scaffold project:** Create directory structure
3. **Docker setup:** Write docker-compose.yml
4. **First endpoint:** Telegram webhook → console.log

---

*Build incrementally. Test continuously. Ship early.*
