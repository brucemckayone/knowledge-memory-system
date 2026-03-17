# Work Packet W01: Project Scaffold

**Status:** ✅ COMPLETE  
**Completed:** 2026-01-24  
**Dependencies:** None  
**Estimated Time:** 1-2 hours

---

## Implementation Progress

| Item | Status | Notes |
|------|--------|-------|
| Directory structure | ✅ Done | `platform/`, `ml-services/` created |
| platform/package.json | ✅ Done | All dependencies installed |
| platform/tsconfig.json | ✅ Done | |
| platform/src/types/envelope.ts | ✅ Done | Full Envelope interface |
| platform/src/config.ts | ✅ Done | Added `dotenv` for .env loading |
| platform/src/index.ts | ✅ Done | Full app with Hono, queue, Qdrant |
| ml-services/requirements.txt | ✅ Done | Simplified (no faster-whisper) |
| ml-services/app/main.py | ✅ Done | FastAPI with embed/transcribe routers |
| ml-services/app/__init__.py | ✅ Done | |
| .gitignore | ✅ Done | |
| .env.example (root) | ✅ Done | |
| platform/.env.example | ✅ Done | |
| **README.md** | ✅ Done | Full documentation |

### Deviations from Spec
- Added `dotenv/config` import to `config.ts` for .env file loading
- Added additional dependencies: `uuid` types
- Port changed from 3000 to 3001 to avoid conflicts

---

## Objective

Create the directory structure and initialize all package managers for the Cognitive Platform.

---

## Prerequisites

Before starting, ensure you have:
- [ ] Node.js 20+ installed
- [ ] pnpm installed (`npm install -g pnpm`)
- [ ] Python 3.11+ installed
- [ ] Docker Desktop running

---

## Directory Structure

Create the following structure:

```
cognitive-platform/
├── platform/                    # TypeScript core application
│   ├── src/
│   │   ├── index.ts            # Application entry point
│   │   ├── config.ts           # Environment configuration
│   │   ├── types/
│   │   │   └── envelope.ts     # Core type definitions
│   │   ├── db/
│   │   │   └── schema.ts       # Drizzle ORM schema
│   │   ├── services/
│   │   │   ├── qdrant.ts       # Qdrant client
│   │   │   └── ml.ts           # ML services client
│   │   ├── bot/
│   │   │   └── index.ts        # Telegram bot setup
│   │   ├── queue/
│   │   │   └── index.ts        # pg-boss queue setup
│   │   └── workers/
│   │       └── memory-processor.ts
│   ├── package.json
│   ├── tsconfig.json
│   ├── drizzle.config.ts
│   └── .env.example
├── ml-services/                 # Python ML services
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py             # FastAPI entry point
│   │   ├── embed.py            # Embedding endpoint
│   │   └── transcribe.py       # Whisper endpoint
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
├── docker-compose.yml
├── .gitignore
├── .env.example
└── README.md
```

---

## Step 1: Create Directory Structure

```bash
# From knowledge-memory-system directory
mkdir -p platform/src/{types,db,services,bot,queue,workers}
mkdir -p ml-services/app
```

---

## Step 2: Initialize TypeScript Project

### platform/package.json

```json
{
  "name": "@cognitive/platform",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@hono/node-server": "^1.8.0",
    "@qdrant/js-client-rest": "^1.7.0",
    "drizzle-orm": "^0.29.3",
    "grammy": "^1.21.1",
    "hono": "^4.0.0",
    "pg-boss": "^9.0.3",
    "postgres": "^3.4.3",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "drizzle-kit": "^0.20.13",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}
```

### platform/tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Step 3: Create Core Type Definitions

### platform/src/types/envelope.ts

```typescript
/**
 * Core Envelope Schema v1.0
 * 
 * Every message flowing through the system uses this structure.
 * See: ARCHITECTURE.md Section 3
 */

export interface Envelope {
  // Identity
  envelope_version: '1.0';
  trace_id: string;
  created_at: string;

  // Origin
  origin: Origin;

  // Raw input
  raw: RawInput;

  // Accumulated enrichments
  enrichments: Enrichments;

  // Pipeline execution log
  pipeline_log: PipelineEntry[];

  // Routing decisions
  routing: Routing;
}

export interface Origin {
  platform: 'telegram' | 'email' | 'browser' | 'voice' | 'api';

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
    type: 'mobile' | 'desktop' | 'unknown';
    name?: string;
    location?: { lat: number; lng: number };
  };

  platform_data: Record<string, unknown>;
}

export interface RawInput {
  type: 'text' | 'voice' | 'image' | 'file' | 'forward' | 'location';
  content?: string;
  media_url?: string;
  file_name?: string;
  file_type?: string;
  forwarded_from?: {
    sender: string;
    date: string;
  };
}

export interface Enrichments {
  transcribe?: {
    text: string;
    language?: string;
    duration_ms?: number;
  };
  classify?: {
    intents: Intent[];
    primary_intent: string;
  };
  extract_url?: {
    url: string;
    domain: string;
  };
  fetch?: {
    title: string;
    content: string;
    author?: string;
  };
  summarize?: {
    summary: string;
    key_points?: string[];
  };
  extract_task?: {
    action: string;
    due_date?: string;
    priority?: string;
  };
  embed?: {
    vector: number[];
    model: string;
  };
  [key: string]: unknown;
}

export interface Intent {
  type: string;
  confidence: number;
}

export interface PipelineEntry {
  stage: string;
  timestamp: string;
  duration_ms: number;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
}

export interface Routing {
  intents: string[];
  workflows: string[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

// Helper to create a new envelope
export function createEnvelope(params: {
  origin: Origin;
  raw: RawInput;
}): Envelope {
  return {
    envelope_version: '1.0',
    trace_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    origin: params.origin,
    raw: params.raw,
    enrichments: {},
    pipeline_log: [],
    routing: {
      intents: [],
      workflows: [],
      status: 'pending',
    },
  };
}
```

---

## Step 4: Create Configuration

### platform/src/config.ts

```typescript
import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().url(),

  // Qdrant
  QDRANT_URL: z.string().url().default('http://localhost:6333'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  WEBHOOK_URL: z.string().url().optional(),

  // ML Services
  ML_SERVICES_URL: z.string().url().default('http://localhost:8000'),

  // Queue
  QUEUE_CONCURRENCY: z.coerce.number().default(2),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
```

### platform/.env.example

```bash
# Server
PORT=3000
NODE_ENV=development

# Database (pg-boss uses this for queue too)
DATABASE_URL=postgres://cognitive:cognitive@localhost:5432/cognitive

# Qdrant
QDRANT_URL=http://localhost:6333

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_here
WEBHOOK_URL=https://your-tailscale-url.ts.net

# ML Services
ML_SERVICES_URL=http://localhost:8000

# Queue
QUEUE_CONCURRENCY=2
```

---

## Step 5: Create Entry Point

### platform/src/index.ts

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';

const app = new Hono();

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  });
});

// Placeholder webhook
app.post('/webhook/telegram', async (c) => {
  const body = await c.req.json();
  console.log('📨 Webhook received:', JSON.stringify(body, null, 2));
  return c.json({ ok: true });
});

// Start server
serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`🚀 Cognitive Platform running on port ${info.port}`);
  console.log(`   Health: http://localhost:${info.port}/health`);
});
```

---

## Step 6: Python ML Services Setup

### ml-services/requirements.txt

```
fastapi==0.109.0
uvicorn[standard]==0.27.0
pydantic==2.5.3
ollama==0.1.6
faster-whisper==0.10.0
python-multipart==0.0.6
httpx==0.26.0
```

### ml-services/app/main.py

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="Cognitive ML Services",
    version="0.1.0",
    description="Embedding and transcription services for Cognitive Platform"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok", "service": "ml-services"}

# Routes will be added in W05
```

### ml-services/app/__init__.py

```python
# Cognitive ML Services
```

---

## Step 7: Root Configuration Files

### .gitignore

```gitignore
# Dependencies
node_modules/
__pycache__/
*.pyc
.venv/
venv/

# Build
dist/
build/
*.egg-info/

# Environment
.env
.env.local
.env.*.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
logs/

# Docker
.docker/

# Database
*.db
*.sqlite

# Qdrant data (if local)
qdrant_storage/
```

### .env.example (root)

```bash
# Copy to .env and fill in values

# Telegram (required)
TELEGRAM_BOT_TOKEN=

# Tailscale webhook URL (optional, for webhook mode)
WEBHOOK_URL=

# Postgres password (for docker-compose)
POSTGRES_PASSWORD=cognitive
```

### README.md

```markdown
# Cognitive Platform

> Your thoughts deserve better than dying in a notes app.

A local-first, AI-powered personal knowledge system.

## Quick Start

1. Copy environment files:
   ```bash
   cp .env.example .env
   cp platform/.env.example platform/.env
   ```

2. Add your Telegram bot token to `.env`

3. Start services:
   ```bash
   docker compose up -d
   ```

4. Start development:
   ```bash
   cd platform && pnpm dev
   ```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full system design.

## Documentation

- [Product Concept](./PRODUCT_CONCEPT.md)
- [Technical Plan](./TECHNICAL_PLAN.md)
- [Model Research](./MODEL_RESEARCH.md)
```

---

## Step 8: Install Dependencies

```bash
# Install TypeScript dependencies
cd platform
pnpm install

# Verify TypeScript compiles
pnpm typecheck

# Go back to root
cd ..
```

---

## Acceptance Criteria

- [x] All directories created as specified
- [x] `platform/package.json` exists with all dependencies
- [x] `pnpm install` completes without errors
- [x] `pnpm typecheck` passes with no errors
- [x] `platform/src/types/envelope.ts` compiles correctly
- [x] `platform/src/config.ts` compiles correctly
- [x] `platform/src/index.ts` compiles correctly
- [x] `ml-services/requirements.txt` exists
- [x] `ml-services/app/main.py` exists
- [x] `.gitignore` exists
- [x] `README.md` exists ✅

---

## Verification

```bash
# Verify structure
find . -type f -name "*.ts" -o -name "*.py" -o -name "*.json" | head -20

# Verify TypeScript
cd platform && pnpm typecheck

# Verify Python syntax
cd ../ml-services && python -m py_compile app/main.py
```

---

## Next Packet

After completing W01, proceed to [W02-docker-setup.md](./W02-docker-setup.md).
