# Work Packets

Master index for Mnemo implementation work packets.

---

## Status at a Glance

| Phase | Name | Packets | Status |
|-------|------|---------|--------|
| 1 | Foundation | W01–W07 | ✅ Mostly Complete |
| 2 | Core Skills & Processing | W08–W15 | ✅ Complete |
| 3 | Entity & Temporal Foundation | W16–W21 | ✅ Mostly Complete |
| 4 | KARMA Agents | W22–W29 | ✅ Complete |
| 5 | Intelligence & Insights | W30–W33 | ✅ Complete |
| 6 | Multi-Source Ingestion | W34–W45 | ✅ Complete |

---

## Full Packet Index

### Phase 1: Foundation

| Packet | Name | Status |
|--------|------|--------|
| [W01](./phase1/W01-project-scaffold.md) | Project Scaffold | ✅ Complete |
| [W02](./phase1/W02-docker-setup.md) | Docker Setup | ✅ Complete |
| [W03](./phase1/W03-database-schema.md) | Database Schema | ✅ Complete |
| [W04](./phase1/W04-core-app.md) | Core Application | ✅ Complete |
| [W05](./phase1/W05-python-ml-services.md) | Python ML Services | ⚠️ Partial |
| [W06](./phase1/W06-telegram-bot.md) | Telegram Bot Setup | ⚠️ Partial |
| [W07](./phase1/W07-memory-capture.md) | Memory Capture | ✅ Complete |

### Phase 2: Core Skills & Processing

| Packet | Name | Status |
|--------|------|--------|
| [W08](./phase2/W08-skill-framework.md) | Skill Framework | ✅ Complete |
| [W09](./phase2/W09-llm-router.md) | LLM Router | ✅ Complete |
| [W10](./phase2/W10-voice-transcription.md) | Voice Transcription | ✅ Complete |
| [W11](./phase2/W11-link-processing.md) | Link Processing | ✅ Complete |
| [W12](./phase2/W12-task-extraction.md) | Task Extraction | ✅ Complete |
| [W13](./phase2/W13-web-scraper.md) | Web Scraper | ✅ Complete |
| [W14](./phase2/W14-workflow-engine.md) | Workflow Engine | ⏭️ Deferred |
| [W15](./phase2/W15-enhanced-telegram.md) | Enhanced Telegram | ✅ Complete |

### Phase 3: Entity & Temporal Foundation

| Packet | Name | Status |
|--------|------|--------|
| [W16](./phase3/W16-entity-schema.md) | Entity Schema | ✅ Complete |
| [W17](./phase3/W17-bi-temporal-facts.md) | Bi-Temporal Facts | ✅ Complete |
| [W18](./phase3/W18-apache-age.md) | Apache AGE Graph | ✅ Complete |
| [W19](./phase3/W19-hybrid-retrieval.md) | Hybrid Retrieval | ✅ Complete |
| [W20](./phase3/W20-entity-extraction-skill.md) | Entity Extraction Skill | ✅ Complete |
| [W21](./phase3/W21-gardener-scheduler.md) | Gardener Scheduler | ✅ Complete |

### Phase 4: KARMA Agents

| Packet | Name | Status |
|--------|------|--------|
| [W22](./phase4/W22-ingestion-agent.md) | Ingestion Agent | 🔀 Replaced (context-linker + reader) |
| [W23](./phase4/W23-reader-agent.md) | Reader Agent | ✅ Complete |
| [W24](./phase4/W24-summarizer-agent.md) | Summarizer Agent | ✅ Complete |
| [W25](./phase4/W25-entity-agent.md) | Entity Extraction Agent | ✅ Complete |
| [W26](./phase4/W26-relationship-agent.md) | Relationship Extraction Agent | ✅ Complete |
| [W27](./phase4/W27-schema-agent.md) | Schema Alignment Agent | ✅ Complete |
| [W28](./phase4/W28-conflict-resolution.md) | Conflict Resolution Agent | ✅ Complete |
| [W29](./phase4/W29-evaluator-agent.md) | Evaluator Agent | 🔀 Replaced (controller metrics) |
| [W22b](./phase4/W22b-context-linker.md) | Context-Linker Agent | ✅ Complete |

### Phase 5: Intelligence & Insights

| Packet | Name | Status |
|--------|------|--------|
| [W30](./phase5/W30-community-detection.md) | Community Detection | ✅ Complete |
| [W31](./phase5/W31-insight-generation.md) | Insight Generation | ✅ Complete |
| [W32](./phase5/W32-morning-briefing.md) | Morning Briefing | ✅ Complete |
| [W33](./phase5/W33-contradiction-scheduler.md) | Contradiction Detection | ✅ Complete |

### Phase 6: Multi-Source Ingestion

| Packet | Name | Status |
|--------|------|--------|
| [W34](./phase6/W34-source-adapter-framework.md) | Source Adapter Framework | ✅ Complete |
| [W35](./phase6/W35-http-ingest-api.md) | HTTP Ingest API | ✅ Complete |
| [W36](./phase6/W36-file-watcher.md) | File Watcher Service | ✅ Complete |
| [W37](./phase6/W37-document-transcript-ml.md) | Document & Transcript ML Endpoints | ✅ Complete |
| [W38](./phase6/W38-meeting-capture.md) | Meeting Capture (Live + Transcripts + Audio) | ✅ Complete |
| [W39](./phase6/W39-obsidian-read.md) | Obsidian Read Adapter | ✅ Complete |
| [W40](./phase6/W40-obsidian-writeback.md) | Obsidian Write-back Agent | ✅ Complete |
| [W41](./phase6/W41-mnemo-mcp-server.md) | Mnemo MCP Server | ✅ Complete |
| [W42](./phase6/W42-multi-source-integration.md) | Integration & E2E Testing | ✅ Complete |
| [W43](./phase6/W43-processing-profiles.md) | Processing Profile System | ✅ Complete |
| [W44](./phase6/W44-conversation-context.md) | Conversation Context Service | ✅ Complete |
| [W45](./phase6/W45-project-association.md) | Project Association Agent | ✅ Complete |

---

## Cross-Cutting Design Documents

| Document | Scope |
|----------|-------|
| [Multi-Source Processing](../architecture/multi-source-processing.md) | Processing profiles, conversation context, project association, extraction strategy |

---

## Related Documents

- [Architecture](../architecture/current.md) — System design and data flow
- [Documentation Index](../INDEX.md) — Project status and roadmap
- [AGENTS.md](../../AGENTS.md) — Development workflow and issue tracking
