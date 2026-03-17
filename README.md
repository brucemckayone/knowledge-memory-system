# Knowledge Memory System

> **Your thoughts deserve better than dying in a notes app.**

A local-first, AI-powered personal knowledge system that captures thoughts, links, and conversations via Telegram, processes them through intelligent pipelines, and stores them as searchable memories.

---

## ✅ Status: Phase 1 Complete

| Component | Status |
|-----------|--------|
| Text capture via Telegram | ✅ Working |
| Semantic search | ✅ Working |
| Embeddings (nomic-embed-text) | ✅ Working |
| Vector storage (Qdrant) | ✅ Working |
| API endpoints | ✅ Working |
| Voice transcription | ⚠️ Disabled |

---

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 20+ with pnpm
- Ollama running locally with `nomic-embed-text` model
- Telegram bot token (from [@BotFather](https://t.me/BotFather))

### 1. Clone & Setup

```bash
git clone https://github.com/yourusername/knowledge-memory-system.git
cd knowledge-memory-system
```

### 2. Configure Environment

```bash
# Copy example env files
cp .env.example .env
cp platform/.env.example platform/.env

# Edit platform/.env with your Telegram bot token
nano platform/.env
```

### 3. Start Services

```bash
# Start Postgres, Qdrant, ML Services
docker compose up -d

# Verify services are healthy
docker compose ps
```

### 4. Run Platform

```bash
cd platform
pnpm install
pnpm dev
```

### 5. Test

```bash
# Health check
curl http://localhost:3001/health

# Search API
curl "http://localhost:3001/api/search?q=test"

# List memories
curl http://localhost:3001/api/memories
```

### 6. Chat with the Bot

Open Telegram and message your bot (@YourBotName):
- Send any text → stored as memory
- `/search kubernetes` → semantic search
- `search: your query` → inline semantic search

---

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Telegram   │────▶│   Platform   │────▶│   Qdrant    │
│    Bot      │     │  (TypeScript)│     │  (Vectors)  │
└─────────────┘     └──────┬───────┘     └─────────────┘
                           │
                    ┌──────▼───────┐     ┌─────────────┐
                    │  ML Services │────▶│   Ollama    │
                    │   (Python)   │     │ (Embeddings)│
                    └──────────────┘     └─────────────┘
                           │
                    ┌──────▼───────┐
                    │  PostgreSQL  │
                    │   (Queue)    │
                    └──────────────┘
```

---

## Project Structure

```
knowledge-memory-system/
├── platform/           # TypeScript core application
│   ├── src/
│   │   ├── bot/       # Telegram bot handlers
│   │   ├── core/      # Envelope factory
│   │   ├── db/        # Database schema (Drizzle)
│   │   ├── queue/     # pg-boss queue
│   │   ├── services/  # ML & Qdrant clients
│   │   └── workers/   # Message processor
│   └── package.json
├── ml-services/        # Python ML services
│   ├── app/
│   │   ├── embed.py   # Embedding endpoint
│   │   ├── transcribe.py
│   │   └── main.py    # FastAPI app
│   └── requirements.txt
├── docs/              # All documentation
│   ├── INDEX.md       # Master entry point
│   ├── architecture/  # System design
│   ├── work-packets/  # Implementation specs
│   ├── vision/        # Product direction
│   └── research/      # Technical research
├── docker-compose.yml
└── README.md
```

---

## Documentation

| Document | Purpose |
|----------|---------|
| [docs/INDEX.md](./docs/INDEX.md) | Master index, project status & roadmap |
| [docs/architecture/current.md](./docs/architecture/current.md) | System design & data flow |
| [docs/vision/product-concept.md](./docs/vision/product-concept.md) | Vision & features |
| [docs/research/model-research.md](./docs/research/model-research.md) | ML model selection |
| [docs/work-packets/](./docs/work-packets/) | Implementation specifications |

---

## Ports

| Service | Port | Description |
|---------|------|-------------|
| Platform | 3001 | Main API & Telegram webhook |
| PostgreSQL | 5433 | Database (external) |
| Qdrant | 6335 | Vector DB (external) |
| ML Services | 8000 | Embedding API |
| Ollama | 11434 | LLM (host) |

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | System health check |
| `/api/search?q=query` | GET | Semantic memory search |
| `/api/memories` | GET | List all memories |
| `/webhook/telegram` | POST | Telegram updates |

---

## Telegram Commands

| Command | Action |
|---------|--------|
| `/start` | Welcome message |
| `/help` | Usage instructions |
| `/search <query>` | Search memories |
| `search: <query>` | Inline search |

---

## Development

```bash
# Platform
cd platform
pnpm dev          # Start dev server
pnpm typecheck    # Type check
pnpm db:push      # Push schema changes
pnpm db:studio    # Open Drizzle Studio

# ML Services
docker compose logs -f ml-services
```

---

## Testing

The platform uses **Vitest** for testing with a layered test architecture that supports graceful degradation when optional services are unavailable.

```bash
cd platform
pnpm test         # Run all tests
pnpm test:watch   # Watch mode
```

### Test Categories

| Category | Path | Dependencies | Purpose |
|----------|------|--------------|---------|
| **Integration** | `src/test/integration/` | PostgreSQL | Module boundary tests |
| **Agent** | `src/test/agents/` | PostgreSQL, ML Services | KARMA agent behavior |
| **E2E** | `src/test/e2e/` | All services | Full pipeline flows |

### Graceful Degradation

Tests automatically skip when dependencies are unavailable:

- **pgvector** - Vector similarity tests skip if extension not installed
- **pg_trgm** - Fuzzy search tests skip if extension not installed
- **ML Services** - Entity extraction tests skip if service not running
- **Qdrant** - Hybrid search tests skip if not available

This allows running tests locally without the full Docker stack.

---

## Roadmap

- [x] **Phase 0:** Model research
- [x] **Phase 1:** Foundation (text capture + search)
- [ ] **Phase 2:** Core skills (voice, links, tasks)
- [ ] **Phase 3:** Intelligence (context, gardener, briefings)
- [ ] **Phase 4:** Dashboard

---

## License

MIT

---

*Built with ❤️ for personal knowledge management*
