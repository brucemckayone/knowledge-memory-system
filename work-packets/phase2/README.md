# Phase 2 Work Packets

**Goal:** Core Skills & Processing - Full workflow system with voice, links, and tasks  
**Duration:** ~2-3 weeks  
**Prerequisites:** Phase 1 Complete ✅  
**Last Updated:** 2026-01-24

---

## Overall Status

| Phase | Status | Completion |
|-------|--------|------------|
| Phase 2 (Core Skills) | 🔴 Not Started | 0% |

---

## Work Packet Index

| Packet | Name | Dependencies | Est. Time | Status |
|--------|------|--------------|-----------|--------|
| [W08](./W08-skill-framework.md) | Skill Framework | None | 2h | ❌ |
| [W09](./W09-llm-router.md) | LLM Router | W08 | 2-3h | ❌ |
| [W10](./W10-voice-transcription.md) | Voice Transcription | None | 2-3h | ❌ |
| [W11](./W11-link-processing.md) | Link Processing | W08, W13 | 2-3h | ❌ |
| [W12](./W12-task-extraction.md) | Task Extraction | W08, W09 | 2-3h | ❌ |
| [W13](./W13-web-scraper.md) | Web Scraper (Python) | None | 1-2h | ❌ |
| [W14](./W14-workflow-engine.md) | Workflow Engine | W08 | 3-4h | ❌ |
| [W15](./W15-enhanced-telegram.md) | Enhanced Telegram | W10, W11, W12 | 2h | ❌ |

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
                        [optional]
```

**Suggested execution:**
1. W08 (Skill Framework) - Foundation
2. W10 (Voice Transcription) - High user value, independent
3. W13 (Web Scraper) - Pure Python, independent
4. W09 (LLM Router) - Needs W08
5. W11 (Link Processing) - Needs W08, W13
6. W12 (Task Extraction) - Needs W08, W09
7. W15 (Enhanced Telegram) - Integration
8. W14 (Workflow Engine) - Optional for Phase 2

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
- Use Groq API as primary (free, reliable)
- Fall back to local Whisper when available
- Platform integration via existing `getFileUrl()`

### 3. LLM Router  
- Use `llama3.2:3b` for speed (~1s latency)
- Return structured JSON with intents
- Route to appropriate workflow

### 4. Workflow Engine
- MVP: Hardcoded TypeScript workflows
- Future: YAML-defined pipelines

---

## Success Criteria

### Phase 2 Complete When:
- [ ] All skills implemented and tested
- [ ] LLM router classifies 90%+ correctly
- [ ] Voice notes transcribe and save
- [ ] Links are fetched, summarized, stored
- [ ] Tasks extracted with due dates
- [ ] Bot responds with rich feedback

---

## Quick Start

```bash
# After Phase 1 is working
# Start with W08
cat work-packets/W08-skill-framework.md
```

---

## Related Documents

- [Phase 1 Work Packets](./README.md)
- [ARCHITECTURE.md](../ARCHITECTURE.md) - Section 4 (Skills & Workflows)
- [TECHNICAL_PLAN.md](../TECHNICAL_PLAN.md) - Section 4 (Phase 2)
