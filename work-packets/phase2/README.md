# Phase 2 Work Packets

**Goal:** Core Skills & Processing - Full workflow system with voice, links, and tasks
**Duration:** ~2-3 weeks
**Prerequisites:** Phase 1 Complete ✅
**Last Updated:** 2026-01-24

---

## Overall Status

| Phase | Status | Completion |
|-------|--------|------------|
| Phase 2 (Core Skills) | ✅ Complete | 100% |

---

## Work Packet Index

| Packet | Name | Dependencies | Est. Time | Status |
|--------|------|--------------|-----------|--------|
| [W08](./W08-skill-framework.md) | Skill Framework | None | 2h | ✅ |
| [W09](./W09-llm-router.md) | LLM Router | W08 | 2-3h | ✅ |
| [W10](./W10-voice-transcription.md) | Voice Transcription | None | 2-3h | ✅ |
| [W11](./W11-link-processing.md) | Link Processing | W08, W13 | 2-3h | ✅ |
| [W12](./W12-task-extraction.md) | Task Extraction | W08, W09 | 2-3h | ✅ |
| [W13](./W13-web-scraper.md) | Web Scraper (Python) | None | 1-2h | ✅ |
| [W14](./W14-workflow-engine.md) | Workflow Engine | W08 | 3-4h | ⏭️ Deferred |
| [W15](./W15-enhanced-telegram.md) | Enhanced Telegram | W10, W11, W12 | 2h | ✅ |

---

## Recommended Order

```
     ┌─────────────────────────────────────────────┐
     │                                             │
     ▼                                             │
W08 (Skill Framework) ◄────────────────────────────┤
     │                                             │
     ├──────────────────┐                          │
     ▼                  ▼                          │
W10 (Voice)        W13 (Scraper)                   │
     │                  │                          │
     │                  ▼                          │
     │             W11 (Links)                     │
     │                  │                          │
     ▼                  │                          │
W09 (LLM Router) ◄──────┤                          │
     │                  │                          │
     ▼                  ▼                          │
W12 (Task Extract)     │                           │
     │                  │                          │
     └──────────────────┼──────────────────────────┤
                        ▼                          │
                   W15 (Enhanced Telegram)         │
                        │                          │
                        ▼                          │
                   W14 (Workflow Engine) ◄─────────┘
                        [deferred to Phase 3]
```

**Suggested execution:**
1. W08 (Skill Framework) - Foundation ✅
2. W10 (Voice Transcription) - High user value, independent ✅
3. W13 (Web Scraper) - Pure Python, independent ✅
4. W09 (LLM Router) - Needs W08 ✅
5. W11 (Link Processing) - Needs W08, W13 ✅
6. W12 (Task Extraction) - Needs W08, W09 ✅
7. W15 (Enhanced Telegram) - Integration ✅
8. W14 (Workflow Engine) - Deferred to Phase 3 (YAML workflows)

---

## Architecture Overview

### Before (Phase 1)
```
Telegram → Queue → Embed → Store
```

### After (Phase 2)
```
Telegram → Queue → Router → Workflow → Skills → Store
                      │
                      ├── thought → embed → store
                      ├── link → scrape → summarize → embed → store
                      ├── task → extract → create-task → embed → store
                      └── voice → transcribe → classify → (route above)
```

---

## Key Design Decisions

### 1. Skill Framework
- Skills are modular, reusable units with standard interface
- Each skill receives context with access to services
- Skills can be chained in workflows

### 2. Voice Transcription
- Use faster-whisper for local transcription
- Fall back gracefully with error messages
- Platform integration via existing `getFileUrl()`

### 3. LLM Router
- Use `llama3.2:3b` for speed (~1s latency)
- Return structured JSON with intents
- Route to appropriate workflow

### 4. Workflow Engine
- MVP: Hardcoded TypeScript workflows
- Future: YAML-defined pipelines (Phase 3)

---

## Success Criteria

### Phase 2 Complete When:
- [x] All skills implemented and tested
- [x] LLM router classifies intents
- [x] Voice notes transcribe and save
- [x] Links are fetched, summarized, stored
- [x] Tasks extracted with due dates
- [x] Bot responds with rich feedback
- [x] TypeScript compiles without errors

---

## What Was Implemented

### Skills Created (`platform/src/skills/`)
- `embed.skill.ts` - Generate embeddings
- `store-memory.skill.ts` - Store in Qdrant
- `transcribe.skill.ts` - Voice to text
- `classify.skill.ts` - Intent classification
- `extract-url.skill.ts` - URL extraction
- `fetch-webpage.skill.ts` - Web scraping
- `summarize.skill.ts` - LLM summarization
- `extract-task.skill.ts` - Task parsing
- `create-task.skill.ts` - Database insertion

### Workflows Created (`platform/src/workflows/`)
- `process-link.ts` - Full link processing pipeline
- `process-task.ts` - Full task processing pipeline

### Python Endpoints Added (`ml-services/app/`)
- `/classify` - Intent classification
- `/scrape` - Web content extraction
- `/summarize` - Content summarization
- `/extract-task` - Task detail extraction

### Bot Enhancements (`platform/src/bot/`)
- `/tasks` - View pending tasks
- `/recent` - Show recent memories
- `/stats` - Knowledge statistics
- Rich feedback for all content types
- Voice message processing

---

## Quick Start

```bash
# Rebuild Docker to get new Python dependencies
docker compose build ml-services

# Start services
docker compose up -d

# Test endpoints
curl http://localhost:8000/health
curl http://localhost:3001/health

# Test classification
curl -X POST http://localhost:8000/classify \
  -H "Content-Type: application/json" \
  -d '{"text": "Check out https://example.com"}'
```

---

## Related Documents

- [Phase 1 Work Packets](../phase1/README.md)
- [Phase 3 Work Packets](../phase3/README.md) - Knowledge Graph
- [ARCHITECTURE.md](../../ARCHITECTURE.md) - Section 4 (Skills & Workflows)
- [TECHNICAL_PLAN.md](../../TECHNICAL_PLAN.md) - Section 4 (Phase 2)
