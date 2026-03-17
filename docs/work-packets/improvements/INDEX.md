# Mnemo Improvement Tracker

Systematic domain-by-domain audit and improvement planning for the existing codebase. Each domain gets a dedicated improvement plan with concrete work items, then implementation.

**Started:** 2026-03-12
**Approach:** Audit → Plan → Implement → Verify, one domain at a time.

---

## Domain Progress

| # | Domain | Audit | Plan | Implement | Notes |
|---|--------|:-----:|:----:|:---------:|-------|
| 1 | [ML Services](#1-ml-services) | ✅ | ✅ | ❌ | [Plan](./improvements/ML-SERVICES.md) — 15 work items, ~24.5h |
| 2 | [Telegram Bot](#2-telegram-bot) | ❌ | ❌ | ❌ | Webhook broken (IPv6), no rate limiting, photo/doc stubs |
| 3 | [Message Processing](#3-message-processing) | ❌ | ❌ | ❌ | Photo/doc not processed, no ML timeout handling |
| 4 | [Search & Retrieval](#4-search--retrieval) | ❌ | ❌ | ❌ | Graph search incomplete, Cypher injection risk |
| 5 | [KARMA Agents](#5-karma-agents) | ❌ | ❌ | ❌ | No circuit breaker; MAB removed; 7 agents; error hierarchy added |
| 6 | [Task System](#6-task-system) | ❌ | ❌ | ❌ | Circular deps, dedup incomplete, no learning loop |
| 7 | [Database & Schema](#7-database--schema) | ❌ | ❌ | ❌ | Missing indexes, no migration versioning |
| 8 | [Skills Framework](#8-skills-framework) | ❌ | ❌ | ❌ | No composition/chaining, no error recovery |
| 9 | [Configuration](#9-configuration) | ❌ | ❌ | ❌ | No timeouts, rate limits, feature flags, log levels |
| 10 | [Testing](#10-testing) | ❌ | ❌ | ❌ | No negative tests, simplistic mocks, coverage gaps |

### Completed Feature Plans

| Domain | Plan | Status |
|--------|------|--------|
| [Multi-Source Ingestion](./phase6/README.md) | Phase 6 (W34–W42) | ✅ Documented |

---

## Domain Summaries

### 1. ML Services

**Location:** `ml-services/`
**Current state:** 12 endpoints implemented (embed, transcribe, classify, scrape, summarize, extract-task, chat, extract-task-enhanced, extract-entities, check-contradiction, parse-content, extract-relationships).

**Known issues:**
- CORS wide open (`allow_origins=["*"]`)
- Zero authentication on any endpoint
- No request size limits or timeout enforcement
- Generic error responses (no distinction between bad request and server failure)
- No health check granularity (single `/health` endpoint)

---

### 2. Telegram Bot

**Location:** `platform/src/bot/index.ts`
**Current state:** 9 commands (`/start`, `/help`, `/chat`, `/search`, `/tasks`, `/complete`, `/task`, `/recent`, `/stats`), voice handling, inline search.

**Known issues:**
- Webhook disabled due to IPv6 incompatibility with Cloudflare (using polling)
- No rate limiting on commands
- Photo/document handlers send acknowledgment but don't process
- `/chat` has no knowledge base context (calls LLM blind)
- Minor typo in chat error display (`.Message` vs `.message`)
- `safeSendMessage()` silently suppresses "chat not found" errors

---

### 3. Message Processing

**Location:** `platform/src/workers/message-processor.ts`
**Current state:** Full pipeline for text + voice + links + tasks. Envelope-based tracing. KARMA queue integration.

**Known issues:**
- Photo/document processing queued but not implemented
- No timeout handling for ML service calls
- KARMA queue failure treated as non-fatal (warning only)
- Task workflow result not validated before display
- Inconsistent envelope enrichment on error paths

---

### 4. Search & Retrieval

**Location:** `platform/src/services/hybrid-search.ts`, `graph.ts`, `qdrant.ts`, `task-query.ts`
**Current state:** Hybrid search (vector + graph + keyword) with RRF fusion. Task natural language querying.

**Known issues:**
- Cypher query string interpolation (injection risk)
- Graph traversal max depth hardcoded to 1
- No timeout on Qdrant queries
- Over-fetching (2x limit) without ordering guarantee post-fusion
- No date/source/type filtering on search results

---

### 5. KARMA Agents

**Location:** `platform/src/gardener/agents/`, `platform/src/gardener/controller.ts`, `platform/src/gardener/errors.ts`
**Current state:** 7 agents (reader, summarizer, entity-extraction, relationship, conflict-resolution, schema-alignment, context-linker). Three tiers: realtime, frequent, periodic. Typed error hierarchy (`AgentError`, `MlServiceError`, `PayloadError`, `DataFetchError`). Controller records per-job metrics to `gardener_metrics`. MAB removed. Gardener observability via `gardener_agent_stats` view (migration 012).

**Known issues:**
- No circuit breaker for repeatedly failing agents
- Agent context checkpointing uses JSON.stringify without validation
- Entity extraction doesn't validate ML response schema
- Agent execution dependencies not explicitly documented

---

### 6. Task System

**Location:** `platform/src/services/task-*.ts`
**Current state:** CRUD, fuzzy + semantic dedup, dependency tracking, conflict detection, user preferences.

**Known issues:**
- Circular dependencies not prevented (no DAG validation)
- Within-conversation LLM dedup verification incomplete
- Fuzzy matching O(n^2) Levenshtein (performance risk at scale)
- Conflict detection 2-hour window hardcoded
- User preferences stored but no learning feedback loop

---

### 7. Database & Schema

**Location:** `platform/src/db/schema.ts`
**Current state:** 15+ tables covering epics, tasks, entities, facts, relationships, preferences. Bi-temporal fact model.

**Known issues:**
- Missing indexes on foreign keys
- No migration versioning strategy visible
- `facts` table ambiguity: `object_entity_id` vs `object_value` precedence unclear
- `contextUuidAudit` only tracks 3 columns (insufficient for drift detection)
- jsonb columns use `.$type<T>()` with no runtime validation

---

### 8. Skills Framework

**Location:** `platform/src/skills/`
**Current state:** Registry pattern with 10+ skills (classify, embed, transcribe, extract-task, fetch-webpage, summarize, store-memory, create-task, etc.).

**Known issues:**
- No skill composition/chaining (can't pipe output → input)
- No error recovery within skills
- No structured logging (ad-hoc console.log)
- Skills tightly coupled to ML service client

---

### 9. Configuration

**Location:** `platform/src/config.ts`
**Current state:** Centralized Zod-validated config from env vars.

**Known issues:**
- Missing: ML service timeouts, retry policies, rate limits, feature flags, log levels
- Hard crash on missing env vars (process.exit(1) during startup)
- No URL validation (accepts malformed or internal IPs)
- No config documentation or `.env.example` completeness check

---

### 10. Testing

**Location:** `platform/src/test/`
**Current state:** 21 test files across integration/, agents/, services/, benchmarks/, e2e/. Graceful skip when services unavailable.

**Known issues:**
- No negative/malformed input tests
- ML service mock is simplistic (keyword matching)
- Photo/document handlers have zero test coverage
- No benchmarks for conflict detection or dependency resolution
- phase4-seed.ts may not cover Phase 5 tables

---

## How To Use This Tracker

1. Pick the next domain from the progress table
2. Deep-dive audit: read the actual code, identify all improvements
3. Create an improvement plan (new work packets or inline changes)
4. Implement the improvements
5. Update the progress table: `❌` → `✅`

When all domains are `✅ ✅ ✅`, Mnemo is production-hardened.
