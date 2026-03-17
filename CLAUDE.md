# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mnemo is a local-first, AI-powered personal knowledge system. Users capture thoughts, links, and conversations via Telegram; messages flow through intelligent pipelines and are stored as searchable memories. The system is implemented across 6 phases — Phases 1-2 are complete, Phases 3-4 are ~80% complete, Phases 5-6 are not started.

## Architecture

Two main services plus infrastructure:

- **platform/** — TypeScript core (Hono HTTP framework, Grammy Telegram bot, Drizzle ORM, pg-boss job queue). Entry point: `src/index.ts`.
- **ml-services/** — Python FastAPI services for embeddings (Ollama/nomic-embed-text), entity extraction, task extraction, classification, and web scraping. Entry point: `app/main.py`.

Infrastructure: PostgreSQL (pgvector + Apache AGE), Qdrant (vector search), Ollama (local embeddings), Z.AI GLM-4.7 (text generation).

### Data Flow

```
Telegram → Bot Handler → pg-boss Queue → Message Processor → ML Services → Qdrant + PostgreSQL
                                                                    ↓
                                                           KARMA Agents (background gardening)
```

### Key Subsystems

- **core/** — Message envelope factory and routing
- **bot/** — Telegram bot handlers and commands
- **workers/** — pg-boss message processor
- **gardener/** — KARMA agent system (7 agents: reader, summarizer, entity-extraction, relationship, conflict-resolution, schema-alignment, context-linker, plus central controller). Typed error hierarchy (`errors.ts`: `AgentError`, `MlServiceError`, `PayloadError`, `DataFetchError`). Controller records metrics directly to `gardener_metrics`.
- **services/** — ML client, Qdrant client, hybrid search (vector + graph)
- **skills/** — Core skill framework for intent routing
- **db/schema.ts** — Drizzle ORM schema (15+ tables including epics, tasks, entities, facts, relationships)

## Build & Development Commands

### Docker (full stack)

```bash
make up          # Start all Docker services (polling mode)
make dev         # Full environment with Cloudflare tunnel
make down        # Stop services
make health      # Check service health
make logs        # Follow Docker logs
make clean       # Stop services and remove volumes
```

### Platform (TypeScript)

All commands run from `platform/`:

```bash
pnpm install     # Install dependencies
pnpm dev         # Start dev server (tsx watch, hot reload)
pnpm build       # TypeScript compilation
pnpm typecheck   # Type check only (tsc --noEmit)
```

### Database

```bash
pnpm db:push     # Push schema changes to database
pnpm db:studio   # Open Drizzle Studio (visual DB editor)
pnpm db:generate # Generate migration files
pnpm db:migrate  # Run migrations
```

### Testing

All test commands run from `platform/`:

```bash
pnpm test                # Run all tests (vitest run)
pnpm test:watch          # Watch mode
pnpm test:integration    # Integration tests only (require PostgreSQL)
pnpm test:agents         # KARMA agent tests (require PostgreSQL + ML Services)
pnpm test:e2e            # End-to-end tests (require all services)
pnpm test:coverage       # Coverage report
```

Run a single test file:
```bash
pnpm vitest run src/test/integration/database.test.ts
```

Tests gracefully skip when dependencies are unavailable (pgvector, ML Services, Qdrant), allowing local development without the full Docker stack.

### Benchmarks

```bash
pnpm benchmark                    # Run performance benchmarks
pnpm benchmark:quality            # Entity extraction quality
pnpm benchmark:stress             # Stress test (heavy scale)
pnpm benchmark:continuous         # 30-minute continuous benchmark
```

## Ports

| Service | Port |
|---------|------|
| Platform | 3001 |
| PostgreSQL | 5433 (external) → 5432 (internal) |
| Qdrant | 6335 (external) → 6333 (internal) |
| ML Services | 8000 |
| Ollama | 11434 (host) |

## Technical Decisions

- **Hono** over Express — lighter, modern HTTP framework
- **Drizzle ORM** — type-safe, lightweight over TypeORM
- **pg-boss** — job queue backed by existing PostgreSQL (no Redis needed)
- **Qdrant** — self-hosted vector DB
- **Apache AGE** — graph queries within PostgreSQL (Phase 3+)
- **Hybrid LLM** — Ollama for embeddings (local, fast), Z.AI GLM-4.7 for text generation

## Conventions

- TypeScript strict mode with `noUnusedLocals` and `noUnusedParameters`
- ESM modules (`"type": "module"` in package.json, ES2022 target)
- Zod for runtime validation of config and API inputs
- Kebab-case filenames, camelCase exports
- Tests colocated in `src/test/` with subdirs: `integration/`, `agents/`, `e2e/`, `services/`
- Test fixtures in `src/test/fixtures/`, generators in `src/test/generators/`, mocks in `src/test/mocks/`

## Documentation

- `docs/INDEX.md` — master entry point, project status, and documentation map
- `docs/architecture/current.md` — detailed system design and data flow
- `docs/work-packets/` — detailed implementation specs per work packet (phase1/ through phase6/)
- `AGENTS.md` — development workflow and issue tracking
