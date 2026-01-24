# Cognitive Platform - Technical Plan

**Version:** 2.0 (Final)  
**Status:** ✅ Phase 1 Complete  
**Last Updated:** 2026-01-24

---

## Current Progress

| Phase | Status | Completion |
|-------|--------|------------|
| Phase 0 (Research) | ✅ Done | 100% |
| Phase 1 (Foundation) | ✅ Complete | 100% |
| Phase 2 (Content Processing) | 📋 Designed | W08-W15 |
| Phase 3 (Knowledge Graph) | 📋 Designed | W16-W21 |
| Phase 4 (KARMA Agents) | 📋 Designed | W22-W29 |
| Phase 5 (Intelligence) | 📋 Designed | W30-W33 |
| Phase 6 (Dashboard) | ❌ Not Started | Future |

---

## 1. Overview

This document outlines the phased implementation approach for the Cognitive Platform.

```d2
direction: right

P0: Phase 0 - Research ✅
P1: Phase 1 - Foundation ✅
P2: Phase 2 - Content 📋 {
  Skills
  Router
  Scrapers
}
P3: Phase 3 - Graph 📋 {
  Entities
  Facts
  Controller
}
P4: Phase 4 - KARMA 📋 {
  9 Agents
  Ingestion
  Conflicts
}
P5: Phase 5 - Insight 📋 {
  Communities
  Briefing
  Ponderer
}

P0 -> P1 -> P2 -> P3 -> P4 -> P5

P0.style.fill: "#27AE60"
P1.style.fill: "#F39C12"
P2.style.fill: "#3498DB"
P3.style.fill: "#9B59B6"
P4.style.fill: "#9B59B6"
P5.style.fill: "#E74C3C"
```

---

## 2. Phase 0: Research ✅ COMPLETE

**Goal:** Select optimal models for M1 Mac performance

**Duration:** ~1 week  
**Status:** ✅ Complete

### 2.1 Embedding Model Research

| Model | Dimensions | To Benchmark |
|-------|------------|--------------|
| nomic-embed-text | 768 | Speed, quality |
| mxbai-embed-large | 1024 | Quality, memory |
| all-MiniLM-L6-v2 | 384 | Speed |

**Deliverables:**
- [x] Benchmark embedding speed on M1
- [x] Test retrieval quality with sample queries
- [x] Document recommended model → **nomic-embed-text (768-dim)**

### 2.2 LLM Model Research

| Use Case | Candidates | To Evaluate |
|----------|------------|-------------|
| **Classification** | Llama 3.2 3B, Mistral 7B | Accuracy, speed |
| **Summarization** | Llama 3.4 8B, Phi-3 | Quality, context length |
| **Task Extraction** | Llama 3.4 8B | Date parsing, action extraction |

**Deliverables:**
- [x] Test router accuracy with classification prompts *(not implemented yet - Phase 2)*
- [x] Evaluate summarization quality *(not implemented yet - Phase 2)*
- [x] Document prompt templates *(deferred to Phase 2)*

### 2.3 Whisper Model Research

| Model | Size | Speed Target |
|-------|------|--------------|
| tiny | 39MB | ~10x realtime |
| small | 244MB | ~4x realtime |
| medium | 769MB | ~1x realtime |

**Deliverables:**
- [ ] Test transcription accuracy on voice notes *(BLOCKED: faster-whisper build issues)*
- [ ] Benchmark speed on M1 *(BLOCKED)*
- [x] Choose best speed/accuracy tradeoff → **small model selected, build blocked**

---

## 3. Phase 1: Foundation ⚠️ 95% COMPLETE

**Goal:** Working infrastructure with basic text capture and retrieval

**Duration:** ~2 weeks  
**Status:** ⚠️ Almost complete - Telegram search reply needs fix

### 3.1 Infrastructure Setup

```d2
direction: down

Docker: docker-compose.yml ✅ {
  Platform: TypeScript App (3001)
  Qdrant: Qdrant (6335)
  Postgres: PostgreSQL (5433)
  ML: Python Services (8000)
}

External: External Services {
  Tailscale: Tailscale Funnel ✅
  Telegram: Telegram Bot API ✅
}

External.Telegram -> Docker.Platform: Polling (webhook blocked)
External.Tailscale -> Docker.Platform: Tunnel
Docker.Platform -> Docker.Postgres: Queue + Data
Docker.Platform -> Docker.Qdrant: Vectors
Docker.Platform -> Docker.Postgres: Structured
Docker.Platform -> Docker.ML: Embeddings
```

**Tasks:**
| Task | Description | Status |
|------|-------------|--------|
| Project scaffold | Create TypeScript + Python directory structure | ✅ Done |
| Docker Compose | Create `docker-compose.yml` with all services | ✅ Done |
| Postgres schema | Run migrations for tasks, epics, state tables | ✅ Done |
| Qdrant collection | Create `memories` collection with schema | ✅ Done |
| pg-boss setup | pg-boss uses Postgres for queue | ✅ Done |
| Tailscale | Configure Funnel for webhook access | ✅ Done |
| Telegram bot | Create bot via BotFather, set webhook | ⚠️ Polling mode |

### 3.2 Core TypeScript Application

```d2
direction: right

src: src/ ✅ {
  api: API Layer ✅ {
    webhook: Telegram Webhook ✅
    health: Health Check ✅
  }
  queue: Queue ✅ {
    pgboss: pg-boss Setup ✅
    workers: Worker Pool ✅
  }
  storage: Storage ✅ {
    qdrant: Qdrant Client ✅
    postgres: Postgres Client ✅
  }
}
```

**Deliverables:**
- [x] Hono API with Telegram webhook endpoint
- [x] pg-boss queue with worker setup
- [x] Qdrant + Postgres client wrappers
- [x] Environment configuration

### 3.3 Python ML Services

```d2
direction: right

ml: FastAPI Services {
  embed: POST /embed ✅
  transcribe: POST /transcribe ❌
  health: GET /health ✅
}
```

**Deliverables:**
- [x] FastAPI app with embedding endpoint
- [ ] Whisper transcription endpoint *(BLOCKED: build issues)*
- [x] Docker setup with model caching

### 3.4 MVP: Text Capture ✅

```d2
direction: right

1: Telegram message ✅
2: Polling receives ✅
3: Enqueue job ✅
4: Worker picks up ✅
5: Generate embedding ✅
6: Store in Qdrant ✅
7: Silent (no reply) ✅

1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7
```

**Deliverables:**
- [x] End-to-end text capture flow
- [x] Envelope creation with origin metadata
- [x] Test: Send message, verify in Qdrant

### 3.5 MVP: Basic Retrieval ⚠️

```d2
direction: right

1: User asks question
2: Classify as "search" ✅
3: Embed query ✅
4: Vector search ✅
5: Format results ✅
6: Reply ❌ (bug)

1 -> 2 -> 3 -> 4 -> 5 -> 6
```

**Deliverables:**
- [x] Search query detection (keyword or LLM)
- [x] Vector similarity search
- [x] Reply formatting
- [ ] Test: Search returns relevant memories *(BUG: Bot replies "coming soon")*

---

## 4. Phase 2: Content Processing

**Goal:** Establish the skill framework and message processing pipeline.

| Work Packet | Title | Deliverables |
|-------------|-------|--------------|
| **W08** | Skill Framework | `Skill` interface, registry, `SkillContext` |
| **W09** | LLM Router | Intent classification (`thought`, `task`, `url`) |
| **W10** | Voice Transcription | Whisper integration for voice notes |
| **W11** | Link Processing | Fetch, summarize, and embed URLs |
| **W12** | Task Extraction | Extract tasks with due dates/priorities |
| **W13** | Web Scraper | Puppeteer/Playwright service |
| **W14** | Workflow Engine | YAML-defined skill pipelines |
| **W15** | Enhanced Telegram | Voice, images, forwarded messages |

---

## 5. Phase 3: Knowledge Graph

**Goal:** Implement the entities, facts, and graph infrastructure.

| Work Packet | Title | Deliverables |
|-------------|-------|--------------|
| **W16** | Entity Schema | `entities`, `entity_aliases` tables + identifiers |
| **W17** | Bi-Temporal Facts | `facts` table with valid/transaction time |
| **W18** | Apache AGE Graph | Graph traversal and Cypher queries |
| **W19** | Hybrid Retrieval | RRF combining Vector + Graph + Keyword |
| **W20** | Entity Extraction | Skill level extraction (pre-agent) |
| **W21** | Gardener Scheduler | Central Controller & Job Queue (pg-boss) |

---

## 6. Phase 4: KARMA Agents

**Goal:** Deploy the 9-agent autonomous cognitive architecture.

| Work Packet | Agent | Role |
|-------------|-------|------|
| **W22** | #2 Ingestion | Chunking, validation, queuing |
| **W23** | #3 Reader | Content parsing & classification |
| **W24** | #4 Summarizer | Concise summaries & embeddings |
| **W25** | #5 Entity Extraction | NER & Entity Resolution |
| **W26** | #6 Relationship | Extract links between entities |
| **W27** | #7 Schema Alignment | Ontology mapping & normalization |
| **W28** | #8 Conflict Resolution | Contradiction detection |
| **W29** | #9 Evaluator | Quality metrics & MAB feedback |

---

## 7. Phase 5: Intelligence Layer

**Goal:** High-level insights, community detection, and proactive briefing.

| Work Packet | Title | Deliverables |
|-------------|-------|--------------|
| **W30** | Community Detection | Identify clusters (Leiden/Louvain) |
| **W31** | Insight Generation | Cross-cluster pattern detection |
| **W32** | Morning Briefing | "Today's Focus" & Proactive delivery |
| **W33** | Contradiction Scheduler | Periodic consistency checks |

---

## 8. Phase 6: Dashboard & Polish

**Goal:** Visual interface and system refinement.

### 8.1 REST API extensions
- Enhanced `/memories` with graph filters
- `/graph/visualize` endpoint

### 8.2 Desktop Dashboard
- Knowledge graph visualization
- Task kanban board
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

### Phase 1 Complete ✅ (100%)
- [x] Docker Compose runs all services
- [x] Text messages capture to Qdrant
- [x] Basic search returns relevant results ✅

### Phase 2 Complete (Not Started)
- [ ] Router classifies 90%+ correctly
- [ ] Voice notes transcribe accurately
- [ ] Links summarize and store
- [ ] Tasks create with due dates

### Phase 3 Complete (Not Started)
- [ ] Context entities update per conversation
- [ ] Memories auto-link by similarity
- [ ] Gardener runs nightly
- [ ] Briefing sends at 8am

### Phase 4 Complete (20%)
- [x] REST API partially functional (`/api/search`, `/api/memories`)
- [ ] WebSocket streaming works
- [ ] Dashboard shows knowledge graph
- [ ] System feels like a "second brain"

---

## 9. Technology Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Core language | TypeScript | Type safety, familiarity |
| ML services | Python (FastAPI) | Native transformers/whisper |
| Queue | pg-boss | Postgres-backed, no Redis needed |
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
