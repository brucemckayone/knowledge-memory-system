# Work Packet W02: Docker Setup

**Status:** ✅ COMPLETE  
**Completed:** 2026-01-24  
**Dependencies:** W01 (Project Scaffold)  
**Estimated Time:** 1-2 hours

---

## Implementation Progress

| Item | Status | Notes |
|------|--------|-------|
| docker-compose.yml | ✅ Done | All services configured |
| docker-compose.override.yml | ✅ Done | Dev overrides |
| platform/Dockerfile | ✅ Done | Multi-stage build |
| platform/.dockerignore | ✅ Done | |
| ml-services/Dockerfile | ✅ Done | Simplified (no PyAV deps) |
| ml-services/.dockerignore | ✅ Done | |
| Postgres service | ✅ Done | Port 5433 externally |
| Qdrant service | ✅ Done | Port 6335 externally |
| ML Services | ✅ Done | Port 8000 |
| Ollama on host | ✅ Done | Running on localhost:11434 |

### Deviations from Spec
- **Postgres port:** Changed from 5432 to 5433 (external) to avoid conflicts with local Postgres
- **Qdrant port:** Changed from 6333 to 6335 (external) to avoid conflicts
- **ML Services Dockerfile:** Removed PyAV/libav dependencies (Whisper disabled due to build issues)
- **Platform:** Runs locally via `pnpm dev`, not in Docker container (for faster dev iteration)

---

## Objective

Create Docker Compose configuration for all services: Platform, PostgreSQL, Qdrant, and ML Services.

---

## Prerequisites

- [ ] W01 completed (directory structure exists)
- [ ] Docker Desktop installed and running
- [ ] At least 8GB RAM available for Docker

---

## Step 1: Create docker-compose.yml

### docker-compose.yml (root)

```yaml
version: '3.8'

services:
  # ===================
  # TypeScript Platform
  # ===================
  platform:
    build:
      context: ./platform
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      qdrant:
        condition: service_started
    environment:
      - NODE_ENV=development
      - PORT=3000
      - DATABASE_URL=postgres://cognitive:cognitive@postgres:5432/cognitive
      - QDRANT_URL=http://qdrant:6333
      - ML_SERVICES_URL=http://ml-services:8000
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - WEBHOOK_URL=${WEBHOOK_URL:-}
    volumes:
      - ./platform/src:/app/src:ro  # Hot reload in dev
    networks:
      - cognitive-network
    restart: unless-stopped

  # ===================
  # PostgreSQL Database
  # ===================
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_DB=cognitive
      - POSTGRES_USER=cognitive
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-cognitive}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cognitive -d cognitive"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 10s
    networks:
      - cognitive-network
    restart: unless-stopped

  # ===================
  # Qdrant Vector DB
  # ===================
  qdrant:
    image: qdrant/qdrant:v1.7.4
    ports:
      - "6333:6333"
      - "6334:6334"  # gRPC
    volumes:
      - qdrant-data:/qdrant/storage
    environment:
      - QDRANT__SERVICE__GRPC_PORT=6334
    networks:
      - cognitive-network
    restart: unless-stopped

  # ===================
  # Python ML Services
  # ===================
  ml-services:
    build:
      context: ./ml-services
      dockerfile: Dockerfile
    ports:
      - "8000:8000"
    environment:
      - OLLAMA_HOST=http://host.docker.internal:11434
    volumes:
      - ml-models:/models
    networks:
      - cognitive-network
    restart: unless-stopped
    # Note: Ollama runs on host, not in Docker

networks:
  cognitive-network:
    driver: bridge

volumes:
  postgres-data:
  qdrant-data:
  ml-models:
```

---

## Step 2: Create Platform Dockerfile

### platform/Dockerfile

```dockerfile
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build TypeScript
RUN pnpm build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install pnpm for production
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Copy built files
COPY --from=builder /app/dist ./dist

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
```

### platform/.dockerignore

```dockerignore
node_modules
dist
.env
.env.*
*.log
.git
.gitignore
README.md
*.md
.DS_Store
```

---

## Step 3: Create ML Services Dockerfile

### ml-services/Dockerfile

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for faster-whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY app/ ./app/

# Set environment
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD python -c "import httpx; httpx.get('http://localhost:8000/health').raise_for_status()"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### ml-services/.dockerignore

```dockerignore
__pycache__
*.pyc
*.pyo
.env
.venv
venv
*.egg-info
.git
*.md
.DS_Store
```

---

## Step 4: Create Development Compose Override

### docker-compose.override.yml

```yaml
# Development overrides - automatically loaded with docker-compose.yml
version: '3.8'

services:
  platform:
    # Use tsx for hot reload in development
    command: ["pnpm", "dev"]
    volumes:
      - ./platform:/app
      - /app/node_modules  # Exclude node_modules
    environment:
      - NODE_ENV=development

  ml-services:
    # Use uvicorn reload in development
    command: ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
    volumes:
      - ./ml-services/app:/app/app
```

---

## Step 5: Environment File

### .env

```bash
# Copy from .env.example and fill in

# Telegram Bot Token (required)
# Get from @BotFather on Telegram
TELEGRAM_BOT_TOKEN=your_token_here

# Webhook URL (optional)
# Your Tailscale Funnel URL
WEBHOOK_URL=

# Postgres password
POSTGRES_PASSWORD=cognitive
```

---

## Step 6: Verify Ollama is Running

The ML services need Ollama running on your host machine:

```bash
# Check Ollama is running
ollama list

# Should show:
# NAME                       ID              SIZE      MODIFIED     
# llava:latest               8dd30f6b0cb1    4.7 GB    ...    
# nomic-embed-text:latest    0a109f422b47    274 MB    ...    
# llama3:latest              365c0bd3c000    4.7 GB    ...

# If Ollama isn't running:
ollama serve
```

---

## Step 7: Build and Start Services

```bash
# Build all images
docker compose build

# Start all services
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f
```

---

## Step 8: Verify Services

### Check PostgreSQL

```bash
# Connect to database
docker compose exec postgres psql -U cognitive -d cognitive -c "SELECT version();"

# Expected: PostgreSQL 16.x
```

### Check Qdrant

```bash
# Check Qdrant API
curl http://localhost:6333/collections

# Expected: {"result":{"collections":[]},"status":"ok","time":...}
```

### Check ML Services

```bash
# Check health
curl http://localhost:8000/health

# Expected: {"status":"ok","service":"ml-services"}
```

### Check Platform

```bash
# Check health
curl http://localhost:3000/health

# Expected: {"status":"ok","timestamp":"...","version":"0.1.0"}
```

---

## Step 9: Useful Commands

```bash
# Stop all services
docker compose down

# Stop and remove volumes (CAREFUL: deletes data)
docker compose down -v

# Rebuild a single service
docker compose build platform
docker compose up -d platform

# View logs for specific service
docker compose logs -f postgres

# Execute command in container
docker compose exec postgres psql -U cognitive -d cognitive

# Check resource usage
docker stats
```

---

## Troubleshooting

### Postgres won't start

```bash
# Check logs
docker compose logs postgres

# Common fix: remove volume and restart
docker compose down -v
docker compose up -d
```

### Qdrant port conflict

```bash
# Check what's using port 6333
lsof -i :6333

# Kill the process or change the port in docker-compose.yml
```

### ML Services can't reach Ollama

```bash
# Verify Ollama is running on host
curl http://localhost:11434/api/tags

# In Docker, use host.docker.internal
# Already configured in docker-compose.yml
```

---

## Acceptance Criteria

- [x] `docker compose build` completes without errors
- [x] `docker compose up -d` starts all 4 services
- [x] `docker compose ps` shows all services as "healthy" or "running"
- [x] PostgreSQL healthcheck passes
- [x] `curl localhost:6335/collections` returns OK *(port 6335, not 6333)*
- [x] `curl localhost:8000/health` returns OK
- [x] `curl localhost:3001/health` returns OK *(port 3001, not 3000)*
- [x] Logs show no critical errors

---

## Verification Script

```bash
#!/bin/bash
# Save as verify-docker.sh and run

echo "🔍 Checking Docker services..."

echo "PostgreSQL:"
curl -s http://localhost:5432 2>/dev/null || docker compose exec postgres pg_isready -U cognitive && echo "✅ OK" || echo "❌ Failed"

echo "Qdrant:"
curl -s http://localhost:6333/collections | grep -q "ok" && echo "✅ OK" || echo "❌ Failed"

echo "ML Services:"
curl -s http://localhost:8000/health | grep -q "ok" && echo "✅ OK" || echo "❌ Failed"

echo "Platform:"
curl -s http://localhost:3000/health | grep -q "ok" && echo "✅ OK" || echo "❌ Failed"

echo "Done!"
```

---

## Next Packet

After completing W02, proceed to [W03-database-schema.md](./W03-database-schema.md).
