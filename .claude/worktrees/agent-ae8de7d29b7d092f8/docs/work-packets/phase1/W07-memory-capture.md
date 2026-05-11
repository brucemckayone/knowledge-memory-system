# Work Packet W07: Basic Memory Capture

**Status:** ✅ COMPLETE  
**Completed:** 2026-01-24  
**Dependencies:** W05 (ML Services), W06 (Telegram Bot)  
**Estimated Time:** 1-2 hours

---

## Implementation Progress

| Item | Status | Notes |
|------|--------|-------|
| src/core/envelope-factory.ts | ✅ Done | createEnvelope, addEnrichment |
| Envelope creation in processor | ✅ Done | Full origin metadata |
| Embedding generation | ✅ Done | 768-dim via Ollama |
| Qdrant storage | ✅ Done | memories collection |
| /api/search endpoint | ✅ Done | Semantic search works |
| /api/memories endpoint | ✅ Done | Lists stored memories |
| Simple classification | ✅ Done | thought/link/task/question |
| Hashtag extraction | ✅ Done | #tags parsed |
| Voice note handling | ⚠️ Partial | Detected but not transcribed |
| **search: in Telegram** | ✅ Fixed | Now performs semantic search |
| **/search command** | ✅ Fixed | Now performs semantic search |

### Search Implementation (Fixed 2026-01-24)
- Added `performSearch()` function to `src/bot/index.ts`
- Generates embedding for query via ML services
- Searches Qdrant for similar memories
- Returns formatted results with match scores

### What Works
- Text messages → embedding → Qdrant storage pipeline is fully functional
- `/api/search?q=test` returns correct semantic search results  
- `/api/memories` lists all stored memories
- `/search <query>` in Telegram returns semantic search results
- `search: <query>` inline in Telegram returns semantic search results
- Messages are queued and processed correctly

### Deviations from Spec
- Voice transcription skipped (Whisper disabled in W05)

---

## Objective

Complete the MVP: Telegram text message → Embedding → Store in Qdrant → Basic search.

---

## Prerequisites

- [ ] W05 completed (ML services running)
- [ ] W06 completed (Telegram bot working)
- [ ] All Docker services running

---

## Step 1: Create Envelope Factory

### platform/src/core/envelope-factory.ts

```typescript
import { randomUUID } from 'crypto';
import type { Envelope, Origin, RawInput } from '../types/envelope.js';

interface CreateEnvelopeParams {
  platform: Origin['platform'];
  senderId: string;
  senderName: string;
  senderHandle?: string;
  conversationId: string;
  conversationName?: string;
  messageId?: string;
  replyToId?: string;
  rawType: RawInput['type'];
  content?: string;
  mediaUrl?: string;
  forwardedFrom?: { sender: string; date: string };
}

/**
 * Create a new envelope from message data
 */
export function createEnvelope(params: CreateEnvelopeParams): Envelope {
  return {
    envelope_version: '1.0',
    trace_id: randomUUID(),
    created_at: new Date().toISOString(),
    
    origin: {
      platform: params.platform,
      sender: {
        id: params.senderId,
        name: params.senderName,
        handle: params.senderHandle,
      },
      context: {
        conversation_id: params.conversationId,
        conversation_name: params.conversationName,
        message_id: params.messageId,
        reply_to_id: params.replyToId,
      },
      platform_data: {},
    },
    
    raw: {
      type: params.rawType,
      content: params.content,
      media_url: params.mediaUrl,
      forwarded_from: params.forwardedFrom,
    },
    
    enrichments: {},
    pipeline_log: [],
    
    routing: {
      intents: [],
      workflows: [],
      status: 'pending',
    },
  };
}

/**
 * Add enrichment to envelope
 */
export function addEnrichment<T>(
  envelope: Envelope,
  stage: string,
  result: T,
  startTime: number
): void {
  envelope.enrichments[stage] = result;
  
  envelope.pipeline_log.push({
    stage,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: 'success',
  });
}

/**
 * Log pipeline failure
 */
export function logFailure(
  envelope: Envelope,
  stage: string,
  error: string,
  startTime: number
): void {
  envelope.pipeline_log.push({
    stage,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: 'failed',
    error,
  });
}
```

---

## Step 2: Update Message Processor

### platform/src/workers/message-processor.ts

```typescript
import type { Job } from 'pg-boss';
import { createEnvelope, addEnrichment, logFailure } from '../core/envelope-factory.js';
import { embed } from '../services/ml.js';
import { storeMemory, searchMemories } from '../services/qdrant.js';
import { bot } from '../bot/index.js';

interface MessageJobData {
  chatId: number;
  messageId: number;
  senderId: number;
  senderName: string;
  senderUsername?: string;
  text?: string;
  voice?: {
    fileId: string;
    duration: number;
  };
  timestamp: string;
}

/**
 * Main message processing worker
 */
export async function processMessage(job: Job<MessageJobData>): Promise<void> {
  const data = job.data;
  const startTime = Date.now();
  
  console.log(`\n📝 Processing message ${data.messageId} from ${data.senderName}`);

  // Skip if no processable content
  if (!data.text && !data.voice) {
    console.log('⏭️ Skipping: no processable content');
    return;
  }

  // Check if this is a search query
  if (data.text?.toLowerCase().startsWith('search:')) {
    await handleSearch(data.chatId, data.text.slice(7).trim());
    return;
  }

  // Create envelope
  const envelope = createEnvelope({
    platform: 'telegram',
    senderId: String(data.senderId),
    senderName: data.senderName,
    senderHandle: data.senderUsername,
    conversationId: String(data.chatId),
    messageId: String(data.messageId),
    rawType: data.voice ? 'voice' : 'text',
    content: data.text,
    mediaUrl: data.voice?.fileId,
  });

  console.log(`🆔 Trace ID: ${envelope.trace_id}`);

  try {
    // Process text content
    let textToEmbed = data.text;

    // If voice, transcribe first (future enhancement)
    if (data.voice) {
      console.log('🎤 Voice note detected - transcription pending');
      // TODO: Implement voice transcription in future packet
      return;
    }

    if (!textToEmbed) {
      console.log('⏭️ No text to process');
      return;
    }

    // Generate embedding
    console.log('🔢 Generating embedding...');
    const embedStart = Date.now();
    const embeddingResult = await embed(textToEmbed);
    
    addEnrichment(envelope, 'embed', {
      vector: embeddingResult.vector,
      model: embeddingResult.model,
    }, embedStart);
    
    console.log(`✅ Embedding generated (${embeddingResult.dimensions} dims)`);

    // Determine memory type (simple heuristic for now)
    const memoryType = classifySimple(textToEmbed);
    
    // Store in Qdrant
    console.log('💾 Storing memory...');
    const storeStart = Date.now();
    
    await storeMemory({
      id: envelope.trace_id,
      vector: embeddingResult.vector,
      payload: {
        // Core fields
        trace_id: envelope.trace_id,
        type: memoryType,
        content: textToEmbed,
        summary: textToEmbed.slice(0, 200),
        
        // Origin
        origin: envelope.origin,
        
        // Metadata
        created_at: envelope.created_at,
        status: 'active',
        tags: extractHashtags(textToEmbed),
        related_to: [],
        
        // For filtering
        platform: envelope.origin.platform,
        sender_id: envelope.origin.sender.id,
        conversation_id: envelope.origin.context.conversation_id,
      },
    });

    addEnrichment(envelope, 'store', { memory_id: envelope.trace_id }, storeStart);
    
    envelope.routing.status = 'completed';
    
    const totalTime = Date.now() - startTime;
    console.log(`✅ Memory stored: ${envelope.trace_id} (${totalTime}ms total)`);

  } catch (error) {
    console.error('❌ Processing failed:', error);
    logFailure(envelope, 'processing', String(error), startTime);
    envelope.routing.status = 'failed';
    throw error; // pg-boss will retry
  }
}

/**
 * Handle search queries
 */
async function handleSearch(chatId: number, query: string): Promise<void> {
  console.log(`🔍 Searching for: "${query}"`);

  try {
    // Generate query embedding
    const queryEmbedding = await embed(query);
    
    // Search Qdrant
    const results = await searchMemories(queryEmbedding.vector, { limit: 5 });
    
    if (results.length === 0) {
      await bot.api.sendMessage(chatId, '🔍 No memories found for your query.');
      return;
    }

    // Format results
    const formatted = results.map((r, i) => {
      const payload = r.payload as Record<string, any>;
      const score = (r.score * 100).toFixed(1);
      const content = payload.content?.slice(0, 100) || 'No content';
      const date = new Date(payload.created_at).toLocaleDateString();
      
      return `${i + 1}. [${score}%] ${content}...\n   📅 ${date}`;
    }).join('\n\n');

    await bot.api.sendMessage(
      chatId,
      `🔍 **Found ${results.length} memories:**\n\n${formatted}`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Search failed:', error);
    await bot.api.sendMessage(chatId, '❌ Search failed. Please try again.');
  }
}

/**
 * Simple content classification (placeholder for LLM router)
 */
function classifySimple(text: string): string {
  const lowerText = text.toLowerCase();
  
  // URL detection
  if (lowerText.includes('http://') || lowerText.includes('https://')) {
    return 'link';
  }
  
  // Task indicators
  if (lowerText.includes('remind') || lowerText.includes('todo') || 
      lowerText.includes('need to') || lowerText.includes('don\'t forget')) {
    return 'task';
  }
  
  // Question detection
  if (text.endsWith('?') || lowerText.startsWith('how') || 
      lowerText.startsWith('what') || lowerText.startsWith('why')) {
    return 'question';
  }
  
  // Default to thought
  return 'thought';
}

/**
 * Extract hashtags from text
 */
function extractHashtags(text: string): string[] {
  const matches = text.match(/#\w+/g);
  return matches ? matches.map(tag => tag.slice(1).toLowerCase()) : [];
}
```

---

## Step 3: Update Queue Registration

### platform/src/index.ts (update worker registration)

```typescript
import { processMessage } from './workers/message-processor.js';

// In startup function, update worker registration:
await boss.work(
  QUEUES.MESSAGE_PROCESSING,
  {
    teamConcurrency: config.QUEUE_CONCURRENCY,
    teamSize: 1,
  },
  processMessage
);
```

---

## Step 4: Create Search Endpoint (API)

### platform/src/index.ts (add search endpoint)

```typescript
// Add search API endpoint
app.get('/api/search', async (c) => {
  const query = c.req.query('q');
  
  if (!query) {
    return c.json({ error: 'Missing query parameter' }, 400);
  }

  try {
    const queryEmbedding = await embed(query);
    const results = await searchMemories(queryEmbedding.vector, { limit: 10 });
    
    return c.json({
      query,
      count: results.length,
      results: results.map(r => ({
        id: r.id,
        score: r.score,
        payload: r.payload,
      })),
    });
  } catch (error) {
    return c.json({ error: 'Search failed' }, 500);
  }
});

// Add memories list endpoint
app.get('/api/memories', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  
  try {
    // Get recent memories by scrolling
    const results = await qdrant.scroll(COLLECTIONS.MEMORIES, {
      limit,
      with_payload: true,
      with_vector: false,
    });
    
    return c.json({
      count: results.points.length,
      memories: results.points.map(p => ({
        id: p.id,
        payload: p.payload,
      })),
    });
  } catch (error) {
    return c.json({ error: 'Failed to list memories' }, 500);
  }
});
```

---

## Step 5: Test End-to-End

### 5.1 Start All Services

```bash
# Terminal 1: Docker services
docker compose up -d

# Terminal 2: Platform
cd platform
pnpm dev

# Terminal 3: Tailscale (if using webhook)
tailscale funnel 3000
```

### 5.2 Send Test Messages

1. Open Telegram, find your bot
2. Send: "I'm thinking about using event sourcing for the new project"
3. Check console for processing logs
4. Send: "search: event sourcing"
5. Verify bot returns the saved memory

### 5.3 API Testing

```bash
# Search via API
curl "http://localhost:3000/api/search?q=event%20sourcing"

# List all memories
curl "http://localhost:3000/api/memories"

# Check Qdrant directly
curl http://localhost:6333/collections/memories/points/scroll
```

---

## Step 6: Verify in Qdrant Dashboard

1. Open http://localhost:6333/dashboard
2. Navigate to "memories" collection
3. Verify points exist with correct payloads
4. Use the search feature to test vector similarity

---

## Acceptance Criteria

- [x] Text messages are queued for processing
- [x] Embeddings are generated via ML service
- [x] Memories are stored in Qdrant with full payload
- [x] `search: query` returns relevant memories ✅
- [x] `/search query` command returns relevant memories ✅
- [x] `/api/search` endpoint works
- [x] `/api/memories` endpoint works
- [x] Qdrant dashboard shows stored memories
- [x] Multiple messages can be processed
- [x] Hashtags are extracted as tags
- [x] Simple classification works (thought/link/task/question)

---

## End-to-End Test Script

```bash
#!/bin/bash
echo "🧪 Testing Cognitive Platform MVP"

# 1. Health check
echo "\n1. Health check..."
curl -s http://localhost:3000/health | jq .

# 2. List initial memories
echo "\n2. Initial memories..."
curl -s http://localhost:3000/api/memories | jq .count

# 3. Send test message via Telegram
echo "\n3. Send a test message in Telegram..."
echo "   Message: 'Testing the memory system with event sourcing'"
read -p "   Press Enter after sending..."

# 4. Wait for processing
echo "\n4. Waiting for processing..."
sleep 3

# 5. Search
echo "\n5. Searching for 'event'..."
curl -s "http://localhost:3000/api/search?q=event" | jq .

# 6. List memories
echo "\n6. Listing all memories..."
curl -s http://localhost:3000/api/memories | jq .

echo "\n✅ Test complete!"
```

---

## What's Next

Congratulations! 🎉 You've completed Phase 1 MVP.

The system now:
- ✅ Receives Telegram messages
- ✅ Generates embeddings
- ✅ Stores in vector database
- ✅ Supports semantic search

**Next phases will add:**
- Voice note transcription
- LLM-based intent classification
- Link processing (fetch, summarize)
- Task extraction (dates, priorities)
- Context entities (conversation summaries)
- Morning briefing
- The Gardener (maintenance)

See [Documentation Index](../../INDEX.md) for the full roadmap.
