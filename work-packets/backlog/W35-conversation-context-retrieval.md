# W35: Conversation Context Retrieval

**Status:** 📋 Backlog
**Priority:** P1 (High)
**Estimated Time:** 2-3 hours
**Phase:** 3 Enhancement
**Dependencies:** W10 (Task Extraction)

---

## Objective

Implement Qdrant query for recent conversation messages to provide contextual awareness to task extraction, enabling tasks to reference recent conversation context (e.g., "call him back" → know who "him" refers to).

---

## Prerequisites

- ✅ Qdrant vector database operational
- ✅ Messages stored with embeddings in Qdrant
- ✅ Task extraction ML service exists
- ⚠️ Stub function at line 346 needs implementation

---

## Implementation Steps

### Step 1: Implement `getRecentContextMessages()` Query (1 hour)

**File:** `platform/src/workflows/process-task.ts`

**Current Stub (line 346):**
```typescript
// TODO: Query Qdrant for recent messages in this conversation
const contextMessages = await getRecentContextMessages(conversationId, 5);
```

**Implementation:**
```typescript
interface ContextMessage {
  id: string;
  content: string;
  created_at: string;
  embedding_id: string;
}

async function getRecentContextMessages(
  conversationId: string,
  limit: number = 5
): Promise<ContextMessage[]> {
  // Option 1: Query by conversation_id filter in Qdrant
  const results = await qdrant.search({
    collection: 'memories',
    vector: await ml.embed(''),  // Search all vectors
    limit: limit,
    filter: {
      must: [
        { key: 'conversation_id', match: { value: conversationId } }
      ]
    },
    with_payload: ['content', 'created_at', 'embedding_id']
  });

  return results.map(r => ({
    id: r.id,
    content: r.payload.content,
    created_at: r.payload.created_at,
    embedding_id: r.payload.embedding_id
  }));
}
```

**Alternative Implementation (PostgreSQL-first):**
```typescript
async function getRecentContextMessages(
  conversationId: string,
  limit: number = 5
): Promise<ContextMessage[]> {
  const messages = await db
    .select({
      id: memories.id,
      content: memories.content,
      created_at: memories.created_at,
      embedding_id: memories.embeddingId
    })
    .from(memories)
    .where(eq(memories.conversationId, conversationId))
    .orderBy(desc(memories.createdAt))
    .limit(limit);

  return messages;
}
```

### Step 2: Build Context String for ML Prompt (30 minutes)

**File:** `platform/src/workflows/process-task.ts`

```typescript
function buildContextString(messages: ContextMessage[]): string {
  if (messages.length === 0) return '';

  const contextLines = messages.map((msg, idx) => {
    const timeAgo = formatTimeAgo(msg.created_at);
    return `[${timeAgo}] ${msg.content}`;
  });

  return `Recent conversation context:\n${contextLines.join('\n')}\n`;
}
```

### Step 3: Inject Context into Task Extraction Prompt (30 minutes)

**File:** `platform/src/workflows/process-task.ts` (task extraction call)

```typescript
const contextString = buildContextString(contextMessages);
const taskExtractionPrompt = `
  User's recent messages:
  ${contextString}

  Current message: ${content}

  Extract any tasks from the current message.
  Use the conversation context to resolve pronouns (he, she, it, them) to specific entities mentioned in recent messages.
`;

const task = await ml.extractTask(taskExtractionPrompt);
```

### Step 4: Handle Context Edge Cases (30 minutes)

**Edge Cases:**
1. No conversation history (first message) → Skip context
2. Conversation ID not available → Skip context
3. Context messages too old (>1 hour) → Filter out
4. Context messages across different conversations → Group by conversation

```typescript
async function getRecentContextMessages(
  conversationId: string,
  limit: number = 5,
  maxAgeMinutes: number = 60
): Promise<ContextMessage[]> {
  const cutoffTime = new Date(Date.now() - maxAgeMinutes * 60 * 1000);

  const messages = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.conversationId, conversationId),
        gte(memories.createdAt, cutoffTime)
      )
    )
    .orderBy(desc(memories.createdAt))
    .limit(limit);

  return messages;
}
```

---

## Testing

### Unit Tests

**File:** `platform/src/test/integration/context-retrieval.test.ts`

```typescript
describe('W35: Conversation Context Retrieval', () => {
  it('should retrieve recent messages from conversation', async () => {
    const messages = await getRecentContextMessages('conv-123', 5);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].content).toBeDefined();
  });

  it('should filter out messages older than max age', async () => {
    const messages = await getRecentContextMessages('conv-123', 5, 30);
    messages.forEach(msg => {
      const age = Date.now() - new Date(msg.created_at).getTime();
      expect(age).toBeLessThan(30 * 60 * 1000);
    });
  });

  it('should build context string for ML prompt', async () => {
    const messages = [
      { content: 'Meeting with John at 3pm', created_at: '2026-01-29T14:00:00Z' }
    ];
    const context = buildContextString(messages);
    expect(context).toContain('Meeting with John');
  });

  it('should handle empty conversation history', async () => {
    const messages = await getRecentContextMessages('new-conv-123', 5);
    expect(messages).toEqual([]);
  });
});
```

### Integration Tests

```typescript
describe('W35: Task Extraction with Context', () => {
  it('should resolve pronouns using conversation context', async () => {
    // Setup: Create messages mentioning "John"
    await createMemory('John Smith is the project manager');
    await createMemory('We need to schedule a meeting with him');

    // Test: Extract task from "call him tomorrow"
    const task = await extractTask('call him tomorrow', conversationId);

    // Verify: Task should reference John Smith
    expect(task.description).toContain('John');
  });
});
```

### Manual Testing

1. Send messages: "John Smith is the contact for Acme project"
2. Send: "call him tomorrow"
3. Verify extracted task: "Call John Smith tomorrow" (not just "Call him")

---

## Success Criteria

- [ ] `getRecentContextMessages()` function implemented
- [ ] Context retrieved from database (PostgreSQL or Qdrant)
- [ ] Context string built and passed to ML service
- [ ] Task extraction resolves pronouns correctly
- [ ] Edge cases handled (no history, old messages, missing conversation ID)
- [ ] Tests pass (unit + integration)
- [ ] Manual testing confirms pronoun resolution works

---

## Files to Modify

1. `platform/src/workflows/process-task.ts` - Implement stub at line 346
2. `platform/src/db/schema.ts` - Verify `memories` table has `conversation_id` column
3. `platform/src/test/integration/context-retrieval.test.ts` - Add tests
4. `ml-services/app/extract_task.py` - Update to accept context parameter (if needed)

---

## Related Work Packets

- **W34**: User Preferences Integration (completes personalization)
- **W37**: Context-Aware Task Deduplication (uses conversation context)
- **W23**: Reader Agent (metadata extraction, includes conversation_id)

---

## Notes

- **Performance:** Recent messages query should be fast (indexed by `conversation_id` + `created_at`)
- **Context Window:** Limit to 5-10 messages to avoid overwhelming ML prompt
- **Pronoun Resolution:** ML model should resolve pronouns based on context; may require prompt engineering
- **Multi-Modal Support:** Context includes text only; voice/image messages need transcription/OCR first

**Future Enhancements:**
- Semantic similarity search for context (not just recent messages)
- Entity-aware context (prioritize messages mentioning same entities)
- Thread-level context (group messages by `thread_id` if available)

---

**Created:** 2026-01-29 (Documentation Synchronization Project, Packet 10)
**Source:** `work-packets/PACKET4_TODO_ANALYSIS.md` (Critical Stub #2)
