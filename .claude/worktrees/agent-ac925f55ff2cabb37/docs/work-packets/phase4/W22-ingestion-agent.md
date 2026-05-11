# Work Packet W22: Ingestion Agent

> **Status: 🔀 Replaced (2026-03)**
> Chunking responsibilities moved to Reader Agent (W23). Session grouping moved to Context-Linker Agent ([W22b](./W22b-context-linker.md)). See [Phase 4 README](./README.md) for current architecture.

**Status:** 🔀 Replaced
**Dependencies:** W21 (Central Controller)
**Estimated Time:** 3-4 hours

---

## Successor

The ingestion agent was **deleted** from the codebase. Its responsibilities were absorbed by:

- **Reader agent** (`reader.agent.ts`): Content chunking and reassembly via `reassembleContent()` from `services/chunks.ts`
- **Context-linker agent** (`context-linker.agent.ts`): Session grouping via ingestion sessions (migration 011), CO_TEMPORAL fact creation, cross-linking of temporally-close items, and conflict-resolution chaining

The ingestion agent file (`ingestion.agent.ts`) and its test (`ingestion.test.ts`) were deleted.

---

## Original Objective (Historical)

Implement the Ingestion Agent, the first stage of the KARMA pipeline. This agent receives raw memories and prepares them for downstream processing by chunking, validating, and queuing jobs.

---

## Research Reference

From [GARDENER_RESEARCH.md](../../research/gardener-research.md) lines 358-369:
- Real-time ingestion tier
- Chunk long documents
- Queue downstream agents

---

## Implementation

### Agent Implementation

Create `platform/src/gardener/agents/ingestion-agent.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';

export interface IngestionJob {
  memoryId: string;
  content: string;
  type: string;
  source: string;
  metadata: Record<string, unknown>;
}

export interface IngestionResult {
  chunked: boolean;
  chunkCount: number;
  queuedJobs: string[];
}

const MAX_CHUNK_SIZE = 4000;  // Characters
const CHUNK_OVERLAP = 200;

export const ingestionAgent: GardenerAgent<IngestionJob, IngestionResult> = {
  name: 'ingestion',
  tier: 'realtime',
  
  async process(
    job: IngestionJob,
    context: AgentContext
  ): Promise<AgentResult<IngestionResult>> {
    const startTime = Date.now();
    context.logger.info(`Processing ingestion for memory ${job.memoryId}`);
    
    try {
      // Validate content
      if (!job.content || job.content.trim().length === 0) {
        throw new Error('Empty content');
      }
      
      // Chunk if necessary
      const chunks = chunkContent(job.content, MAX_CHUNK_SIZE, CHUNK_OVERLAP);
      const chunked = chunks.length > 1;
      
      if (chunked) {
        context.logger.info(`Chunked into ${chunks.length} pieces`);
        
        // Store chunk metadata
        for (let i = 0; i < chunks.length; i++) {
          await storeChunk(job.memoryId, i, chunks[i]);
        }
      }
      
      // Queue downstream jobs
      const queuedJobs: string[] = [];
      
      // Queue reader job
      const readerJobId = await context.queueJob('reader', {
        memoryId: job.memoryId,
        chunks: chunked ? chunks : [job.content],
        type: job.type,
        source: job.source,
      });
      queuedJobs.push(readerJobId);
      
      // Queue entity extraction
      const entityJobId = await context.queueJob('entity-extraction', {
        memoryId: job.memoryId,
        content: job.content,
      });
      queuedJobs.push(entityJobId);
      
      return {
        success: true,
        data: {
          chunked,
          chunkCount: chunks.length,
          queuedJobs,
        },
        metrics: {
          durationMs: Date.now() - startTime,
          chunkCount: chunks.length,
          jobsQueued: queuedJobs.length,
        },
      };
      
    } catch (error) {
      context.logger.error('Ingestion failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metrics: { durationMs: Date.now() - startTime },
      };
    }
  },
};

/**
 * Chunk content with overlap for context preservation
 */
function chunkContent(
  content: string,
  maxSize: number,
  overlap: number
): string[] {
  if (content.length <= maxSize) {
    return [content];
  }
  
  const chunks: string[] = [];
  let start = 0;
  
  while (start < content.length) {
    let end = start + maxSize;
    
    // Try to break at sentence boundary
    if (end < content.length) {
      const lastPeriod = content.lastIndexOf('.', end);
      const lastNewline = content.lastIndexOf('\n', end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      
      if (breakPoint > start + maxSize / 2) {
        end = breakPoint + 1;
      }
    }
    
    chunks.push(content.slice(start, end).trim());
    start = end - overlap;
  }
  
  return chunks;
}

/**
 * Store chunk reference
 */
async function storeChunk(
  memoryId: string,
  index: number,
  content: string
): Promise<void> {
  // Store in memory_chunks table (or Qdrant metadata)
  await db.execute(sql`
    INSERT INTO memory_chunks (memory_id, chunk_index, content, char_count)
    VALUES (${memoryId}, ${index}, ${content}, ${content.length})
    ON CONFLICT (memory_id, chunk_index) DO UPDATE
    SET content = EXCLUDED.content, char_count = EXCLUDED.char_count
  `);
}
```

### Schema Addition

Add to `platform/src/db/migrations/007_memory_chunks.sql`:

```sql
CREATE TABLE IF NOT EXISTS memory_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(memory_id, chunk_index)
);

CREATE INDEX idx_memory_chunks_memory ON memory_chunks(memory_id);
```

### Register Agent

Update `platform/src/gardener/index.ts`:

```typescript
import { ingestionAgent } from './agents/ingestion-agent.js';

controller.registerAgent(ingestionAgent);
```

---

## Verification

### Automated Tests
Run simple unit tests for ingestion agent.

```bash
# Create platform/src/gardener/agents/__tests__/ingestion.test.ts
import { ingestionAgent } from '../ingestion-agent.js';
import { describe, it, expect, vi } from 'vitest';

describe('Ingestion Agent', () => {
  it('should chunk content', async () => {
    // Run chunkContent() logic test
  });
});
```

### Manual Verification
```bash
# Queue ingestion job
curl -X POST http://localhost:3001/api/gardener/queue \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "ingestion",
    "job": {
      "memoryId": "test-123",
      "content": "Meeting notes from project standup...",
      "type": "note",
      "source": "telegram"
    }
  }'

# Check job status
curl http://localhost:3001/api/gardener/job/test-123
```

---

## Acceptance Criteria

- [ ] Agent processes incoming memories
- [ ] Long content chunked correctly
- [ ] Chunks stored in database
- [ ] Reader job queued
- [ ] Entity extraction job queued
- [ ] Metrics captured

---

## Next Packet

- [W23: Reader Agent](./W23-reader-agent.md) - Parse and classify content
