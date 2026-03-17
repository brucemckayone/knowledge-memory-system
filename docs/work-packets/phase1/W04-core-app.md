# Work Packet W04: Core Application Skeleton

**Status:** ✅ COMPLETE  
**Completed:** 2026-01-24  
**Dependencies:** W02 (Docker), W03 (Database)  
**Estimated Time:** 1-2 hours

---

## Implementation Progress

| Item | Status | Notes |
|------|--------|-------|
| src/queue/index.ts | ✅ Done | pg-boss with all QUEUES |
| src/services/ml.ts | ✅ Done | embed, transcribe, checkMlHealth |
| src/services/qdrant.ts | ✅ Done | ensureCollections, storeMemory, searchMemories |
| src/workers/message-processor.ts | ✅ Done | Full envelope creation + storage |
| src/index.ts | ✅ Done | Hono app with all endpoints |
| Health check endpoint | ✅ Done | Returns db, qdrant, ml status |
| Telegram webhook endpoint | ✅ Done | Queues messages for processing |
| Graceful shutdown | ✅ Done | SIGTERM/SIGINT handlers |
| Worker registration | ✅ Done | MESSAGE_PROCESSING queue |

### Additional Files Created (beyond spec)
- `src/core/envelope-factory.ts` - Helper for creating envelopes
- `src/bot/index.ts` - Full Telegram bot module
- `src/bot/files.ts` - File download utility

### Deviations from Spec
- Port changed to 3001 (was 3000) to avoid conflicts
- Added `/api/search` and `/api/memories` endpoints (from W07)

---

## Objective

Create the TypeScript application with Hono API, pg-boss queue, database connections, and basic processing pipeline.

---

## Prerequisites

- [ ] W02 completed (Docker running)
- [ ] W03 completed (Database schema applied)

---

## Step 1: Create Queue Setup

### platform/src/queue/index.ts

```typescript
import PgBoss from 'pg-boss';
import { config } from '../config.js';

let boss: PgBoss | null = null;

/**
 * Initialize pg-boss queue
 */
export async function initQueue(): Promise<PgBoss> {
  if (boss) return boss;

  boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    // Queue configuration
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 60 * 60, // 1 hour
    archiveCompletedAfterSeconds: 60 * 60 * 24, // 24 hours
    deleteAfterSeconds: 60 * 60 * 24 * 7, // 7 days
  });

  // Event handlers
  boss.on('error', (error) => {
    console.error('❌ Queue error:', error);
  });

  boss.on('monitor-states', (states) => {
    console.log('📊 Queue states:', states);
  });

  await boss.start();
  console.log('✅ pg-boss queue started');

  return boss;
}

/**
 * Get queue instance (must call initQueue first)
 */
export function getQueue(): PgBoss {
  if (!boss) {
    throw new Error('Queue not initialized. Call initQueue() first.');
  }
  return boss;
}

/**
 * Queue names
 */
export const QUEUES = {
  MESSAGE_PROCESSING: 'message-processing',
  CONTEXT_UPDATE: 'context-update',
  GARDENER: 'gardener',
} as const;

/**
 * Shutdown queue gracefully
 */
export async function shutdownQueue(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30000 });
    boss = null;
    console.log('✅ Queue stopped');
  }
}
```

---

## Step 2: Create ML Service Client

### platform/src/services/ml.ts

```typescript
import { config } from '../config.js';

interface EmbedResponse {
  vector: number[];
  model: string;
  dimensions: number;
}

interface TranscribeResponse {
  text: string;
  language: string;
  duration_ms: number;
}

/**
 * Generate embedding for text
 */
export async function embed(text: string, model = 'nomic-embed-text'): Promise<EmbedResponse> {
  const response = await fetch(`${config.ML_SERVICES_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model }),
  });

  if (!response.ok) {
    throw new Error(`Embedding failed: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Transcribe audio file
 */
export async function transcribe(audioUrl: string): Promise<TranscribeResponse> {
  const response = await fetch(`${config.ML_SERVICES_URL}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl }),
  });

  if (!response.ok) {
    throw new Error(`Transcription failed: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Health check for ML services
 */
export async function checkMlHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
```

---

## Step 3: Create Qdrant Service

### platform/src/services/qdrant.ts

```typescript
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';

// Initialize client
export const qdrant = new QdrantClient({
  url: config.QDRANT_URL,
});

// Collection names
export const COLLECTIONS = {
  MEMORIES: 'memories',
  CONTEXTS: 'contexts',
} as const;

/**
 * Ensure collections exist with correct schema
 */
export async function ensureCollections(): Promise<void> {
  const collections = await qdrant.getCollections();
  const existing = new Set(collections.collections.map((c) => c.name));

  // Memories collection
  if (!existing.has(COLLECTIONS.MEMORIES)) {
    await qdrant.createCollection(COLLECTIONS.MEMORIES, {
      vectors: {
        size: 768, // nomic-embed-text dimensions
        distance: 'Cosine',
      },
    });
    console.log('✅ Created memories collection');
  }

  // Contexts collection
  if (!existing.has(COLLECTIONS.CONTEXTS)) {
    await qdrant.createCollection(COLLECTIONS.CONTEXTS, {
      vectors: {
        size: 768,
        distance: 'Cosine',
      },
    });
    console.log('✅ Created contexts collection');
  }
}

/**
 * Store a memory in Qdrant
 */
export async function storeMemory(memory: {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}): Promise<void> {
  await qdrant.upsert(COLLECTIONS.MEMORIES, {
    points: [
      {
        id: memory.id,
        vector: memory.vector,
        payload: memory.payload,
      },
    ],
  });
}

/**
 * Search memories by vector similarity
 */
export async function searchMemories(
  vector: number[],
  options: {
    limit?: number;
    filter?: Record<string, unknown>;
  } = {}
) {
  const { limit = 5, filter } = options;

  const results = await qdrant.search(COLLECTIONS.MEMORIES, {
    vector,
    limit,
    with_payload: true,
    filter: filter as any,
  });

  return results;
}

/**
 * Get memory by ID
 */
export async function getMemory(id: string) {
  const results = await qdrant.retrieve(COLLECTIONS.MEMORIES, {
    ids: [id],
    with_payload: true,
    with_vector: false,
  });
  return results[0] ?? null;
}

/**
 * Health check
 */
export async function checkQdrantHealth(): Promise<boolean> {
  try {
    await qdrant.getCollections();
    return true;
  } catch {
    return false;
  }
}
```

---

## Step 4: Create Message Processor Worker

### platform/src/workers/message-processor.ts

```typescript
import type { Job } from 'pg-boss';
import { randomUUID } from 'crypto';
import type { Envelope } from '../types/envelope.js';
import { embed } from '../services/ml.js';
import { storeMemory } from '../services/qdrant.js';

interface MessageJobData {
  chatId: number;
  messageId: number;
  senderId: number;
  senderName: string;
  senderUsername?: string;
  text?: string;
  timestamp: string;
}

/**
 * Process incoming Telegram message
 */
export async function processMessage(job: Job<MessageJobData>): Promise<void> {
  const data = job.data;
  console.log(`📝 Processing message ${data.messageId} from ${data.senderName}`);

  // Skip if no text content
  if (!data.text) {
    console.log('⏭️ Skipping: no text content');
    return;
  }

  // 1. Create envelope
  const envelope: Partial<Envelope> = {
    envelope_version: '1.0',
    trace_id: randomUUID(),
    created_at: data.timestamp,
    origin: {
      platform: 'telegram',
      sender: {
        id: String(data.senderId),
        name: data.senderName,
        handle: data.senderUsername,
      },
      context: {
        conversation_id: String(data.chatId),
        message_id: String(data.messageId),
      },
      platform_data: {},
    },
    raw: {
      type: 'text',
      content: data.text,
    },
    enrichments: {},
    pipeline_log: [],
    routing: {
      intents: [],
      workflows: [],
      status: 'processing',
    },
  };

  const startTime = Date.now();

  try {
    // 2. Generate embedding
    console.log('🔢 Generating embedding...');
    const embedding = await embed(data.text);
    
    envelope.enrichments!.embed = {
      vector: embedding.vector,
      model: embedding.model,
    };

    envelope.pipeline_log!.push({
      stage: 'embed',
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'success',
    });

    // 3. Store in Qdrant
    console.log('💾 Storing memory...');
    await storeMemory({
      id: envelope.trace_id!,
      vector: embedding.vector,
      payload: {
        trace_id: envelope.trace_id,
        type: 'thought', // Default for now, router will classify later
        content: data.text,
        summary: data.text.slice(0, 200), // Simple truncation for now
        origin: envelope.origin,
        created_at: envelope.created_at,
        status: 'active',
        tags: [],
        related_to: [],
      },
    });

    envelope.routing!.status = 'completed';
    console.log(`✅ Memory stored: ${envelope.trace_id}`);

  } catch (error) {
    console.error('❌ Processing failed:', error);
    envelope.routing!.status = 'failed';
    throw error; // pg-boss will retry
  }
}
```

---

## Step 5: Update Main Entry Point

### platform/src/index.ts

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { db, checkDatabaseHealth } from './db/index.js';
import { initQueue, getQueue, QUEUES, shutdownQueue } from './queue/index.js';
import { ensureCollections, checkQdrantHealth } from './services/qdrant.js';
import { checkMlHealth } from './services/ml.js';
import { processMessage } from './workers/message-processor.js';

const app = new Hono();

// ============
// Health Check
// ============
app.get('/health', async (c) => {
  const [dbOk, qdrantOk, mlOk] = await Promise.all([
    checkDatabaseHealth(),
    checkQdrantHealth(),
    checkMlHealth(),
  ]);

  const healthy = dbOk && qdrantOk;
  
  return c.json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    services: {
      database: dbOk ? 'ok' : 'error',
      qdrant: qdrantOk ? 'ok' : 'error',
      ml: mlOk ? 'ok' : 'error',
    },
  }, healthy ? 200 : 503);
});

// ================
// Telegram Webhook
// ================
app.post('/webhook/telegram', async (c) => {
  const body = await c.req.json();
  
  // Extract message
  const message = body.message;
  if (!message) {
    return c.json({ ok: true }); // Ignore non-message updates
  }

  // Queue for processing
  const boss = getQueue();
  await boss.send(QUEUES.MESSAGE_PROCESSING, {
    chatId: message.chat.id,
    messageId: message.message_id,
    senderId: message.from.id,
    senderName: message.from.first_name + (message.from.last_name ? ` ${message.from.last_name}` : ''),
    senderUsername: message.from.username,
    text: message.text,
    timestamp: new Date(message.date * 1000).toISOString(),
  });

  console.log(`📨 Queued message from ${message.from.first_name}`);
  return c.json({ ok: true });
});

// =========
// Startup
// =========
async function start() {
  console.log('🚀 Starting Cognitive Platform...');

  // Initialize database (verify connection)
  console.log('📦 Connecting to database...');
  await checkDatabaseHealth();
  console.log('✅ Database connected');

  // Initialize Qdrant collections
  console.log('🔍 Setting up Qdrant...');
  await ensureCollections();
  console.log('✅ Qdrant ready');

  // Initialize queue
  console.log('📋 Starting queue...');
  const boss = await initQueue();

  // Register workers
  await boss.work(
    QUEUES.MESSAGE_PROCESSING,
    { teamConcurrency: config.QUEUE_CONCURRENCY },
    processMessage
  );
  console.log('✅ Workers registered');

  // Start HTTP server
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`\n🌐 Cognitive Platform running on port ${info.port}`);
    console.log(`   Health: http://localhost:${info.port}/health`);
    console.log(`   Webhook: http://localhost:${info.port}/webhook/telegram\n`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n📴 Received ${signal}, shutting down...`);
    await shutdownQueue();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('❌ Failed to start:', error);
  process.exit(1);
});
```

---

## Step 6: Verify Compilation

```bash
cd platform
pnpm typecheck
```

Should complete with no errors.

---

## Step 7: Test Locally

```bash
# Start services
docker compose up -d postgres qdrant ml-services

# Start platform in dev mode
cd platform
pnpm dev
```

Test health endpoint:
```bash
curl http://localhost:3000/health
```

Expected:
```json
{
  "status": "ok",
  "timestamp": "...",
  "version": "0.1.0",
  "services": {
    "database": "ok",
    "qdrant": "ok",
    "ml": "ok"
  }
}
```

---

## Acceptance Criteria

- [x] `queue/index.ts` compiles without errors
- [x] `services/ml.ts` compiles without errors
- [x] `services/qdrant.ts` compiles without errors
- [x] `workers/message-processor.ts` compiles without errors
- [x] `index.ts` compiles without errors
- [x] `pnpm dev` starts the server
- [x] `/health` returns status with all services
- [x] pg-boss tables created in database
- [x] Qdrant collections created

---

## Next Packet

After completing W04, proceed to [W05-python-ml-services.md](./W05-python-ml-services.md).
