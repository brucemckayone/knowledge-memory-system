# W37: Context-Aware Task Deduplication

**Status:** 📋 Backlog
**Priority:** P1 (High)
**Estimated Time:** 2-3 hours
**Phase:** 3 Enhancement
**Dependencies:** W35 (Conversation Context Retrieval)

---

## Objective

Implement `getPendingTasksInContext()` query to prevent duplicate tasks within the same conversation context, reducing task noise and improving user experience.

---

## Prerequisites

- ✅ `tasks` table exists with `context_id` or `conversation_id` column
- ✅ `memories` table has `conversation_id` column
- ✅ Task extraction working
- ⚠️ Stub function at line 355 needs implementation

---

## Implementation Steps

### Step 1: Implement `getPendingTasksInContext()` Query (1 hour)

**File:** `platform/src/workflows/process-task.ts`

**Current Stub (line 355):**
```typescript
// TODO: Query pending tasks in this context
const existingTasks = await getPendingTasksInContext(conversationId, contextWindow);
```

**Implementation:**
```typescript
interface PendingTask {
  id: string;
  action: string;
  due_date: string | null;
  created_at: string;
}

async function getPendingTasksInContext(
  conversationId: string,
  contextWindow: number = 10  // number of recent messages to check
): Promise<PendingTask[]> {
  // Get recent message timestamps in this conversation
  const recentMessages = await db
    .select({ createdAt: memories.createdAt })
    .from(memories)
    .where(eq(memories.conversationId, conversationId))
    .orderBy(desc(memories.createdAt))
    .limit(contextWindow);

  if (recentMessages.length === 0) {
    return [];
  }

  const oldestTimestamp = recentMessages[recentMessages.length - 1].createdAt;

  // Query tasks created since oldest message
  const tasks = await db
    .select({
      id: tasks.id,
      action: tasks.action,
      dueDate: tasks.dueDate,
      createdAt: tasks.createdAt
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'pending'),
        gte(tasks.createdAt, oldestTimestamp)
        // Optionally: eq(tasks.conversationId, conversationId)
      )
    )
    .orderBy(desc(tasks.createdAt));

  return tasks;
}
```

### Step 2: Implement Task Deduplication Logic (1 hour)

**File:** `platform/src/workflows/process-task.ts`

```typescript
function isDuplicateTask(
  newTask: string,
  existingTasks: PendingTask[]
): boolean | { id: string; action: string } {
  const normalizedNew = normalizeTaskString(newTask);

  for (const existing of existingTasks) {
    const normalizedExisting = normalizeTaskString(existing.action);

    // Exact match
    if (normalizedNew === normalizedExisting) {
      return { id: existing.id, action: existing.action };
    }

    // Similarity check (simple for now, could use ML)
    if (calculateSimilarity(normalizedNew, normalizedExisting) > 0.85) {
      return { id: existing.id, action: existing.action };
    }
  }

  return false;
}

function normalizeTaskString(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^\w\s]/g, '')  // Remove punctuation
    .replace(/\s+/g, ' ')       // Normalize whitespace
    .trim();
}

function calculateSimilarity(str1: string, str2: string): number {
  // Simple Jaccard similarity for now
  const words1 = new Set(str1.split(' '));
  const words2 = new Set(str2.split(' '));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}
```

### Step 3: Integrate into Task Processing (30 minutes)

**File:** `platform/src/workflows/process-task.ts`

```typescript
// After extracting task from message
const extractedTask = await ml.extractTask(content);

if (extractedTask.action) {
  // Check for duplicate tasks in context
  const existingTasks = await getPendingTasksInContext(conversationId, 10);
  const duplicate = isDuplicateTask(extractedTask.action, existingTasks);

  if (duplicate) {
    logger.info(`Duplicate task detected: "${extractedTask.action}" matches existing task ${duplicate.id}`);

    // Skip creating new task
    await bot.api.sendMessage(chatId, `ℹ️ This task already exists:\n"${duplicate.action}"`);

    return; // Don't create new task
  }

  // No duplicate, proceed with task creation
  await createTask(extractedTask);
}
```

### Step 4: Add ML-Based Similarity Detection (optional, 30 minutes)

**Enhanced deduplication using embeddings:**

```typescript
async function isDuplicateTaskML(
  newTask: string,
  existingTasks: PendingTask[]
): Promise<boolean | { id: string; action: string }> {
  // Get embedding for new task
  const newEmbedding = await ml.embed(newTask);

  for (const existing of existingTasks) {
    // Get embedding for existing task
    const existingEmbedding = await ml.embed(existing.action);

    // Calculate cosine similarity
    const similarity = cosineSimilarity(newEmbedding, existingEmbedding);

    if (similarity > 0.90) {  // High similarity threshold
      return { id: existing.id, action: existing.action };
    }
  }

  return false;
}

function cosineSimilarity(vec1: number[], vec2: number[]): number {
  const dotProduct = vec1.reduce((sum, a, i) => sum + a * vec2[i], 0);
  const magnitude1 = Math.sqrt(vec1.reduce((sum, a) => sum + a * a, 0));
  const magnitude2 = Math.sqrt(vec2.reduce((sum, a) => sum + a * a, 0));

  return dotProduct / (magnitude1 * magnitude2);
}
```

---

## Testing

### Unit Tests

**File:** `platform/src/test/integration/task-deduplication.test.ts`

```typescript
describe('W37: Context-Aware Task Deduplication', () => {
  it('should retrieve pending tasks in conversation context', async () => {
    const tasks = await getPendingTasksInContext('conv-123', 10);
    expect(Array.isArray(tasks)).toBe(true);
  });

  it('should detect exact duplicate tasks', async () => {
    const existingTasks = [
      { id: '1', action: 'Call John tomorrow', due_date: null, created_at: '2026-01-29T10:00:00Z' }
    ];

    const duplicate = isDuplicateTask('call John tomorrow', existingTasks);
    expect(duplicate).toBeTruthy();
    expect(duplicate.id).toBe('1');
  });

  it('should detect similar tasks', async () => {
    const existingTasks = [
      { id: '1', action: 'Call John tomorrow at 10am', due_date: null, created_at: '2026-01-29T10:00:00Z' }
    ];

    const duplicate = isDuplicateTask('call John tomorrow', existingTasks);
    // Should detect as similar (85%+ similarity threshold)
    expect(duplicate).toBeTruthy();
  });

  it('should not flag different tasks as duplicates', async () => {
    const existingTasks = [
      { id: '1', action: 'Call John tomorrow', due_date: null, created_at: '2026-01-29T10:00:00Z' }
    ];

    const duplicate = isDuplicateTask('Email Sarah today', existingTasks);
    expect(duplicate).toBeFalsy();
  });

  it('should calculate task similarity correctly', async () => {
    const similarity = calculateSimilarity('call john tomorrow', 'call john tomorrow at 10am');
    expect(similarity).toBeGreaterThan(0.85);
  });
});
```

### Integration Tests

```typescript
describe('W37: End-to-End Deduplication', () => {
  it('should prevent duplicate task creation', async () => {
    // Setup: Create existing task
    await createTask('Call John tomorrow', conversationId);

    // Test: Try to create duplicate
    const result = await processMessage('Call John tomorrow', conversationId);

    // Verify: No new task created
    expect(result.taskCreated).toBeFalsy();
    expect(result.message).toContain('already exists');
  });

  it('should allow different tasks in same context', async () => {
    await createTask('Call John tomorrow', conversationId);

    const result = await processMessage('Email Sarah today', conversationId);

    expect(result.taskCreated).toBeTruthy();
  });
});
```

### Manual Testing

1. Send message: "Remind me to call John tomorrow"
2. Send message: "Remind me to call John tomorrow" (duplicate)
3. Verify: Second message rejected, notification: "This task already exists"
4. Send message: "Remind me to email Sarah today"
5. Verify: Task created successfully

---

## Success Criteria

- [ ] `getPendingTasksInContext()` function implemented
- [ ] Tasks retrieved from database based on conversation context
- [ ] Duplicate detection working (exact match)
- [ ] Similarity detection working (85%+ threshold)
- [ ] ML-based similarity detection working (optional, 90%+ threshold)
- [ ] Duplicate tasks rejected with user notification
- [ ] Different tasks allowed in same context
- [ ] Tests pass (unit + integration)
- [ ] Manual testing confirms deduplication works

---

## Files to Modify

1. `platform/src/workflows/process-task.ts` - Implement stub at line 355
2. `platform/src/db/schema.ts` - Verify `tasks` table has `conversation_id` or `context_id`
3. `platform/src/test/integration/task-deduplication.test.ts` - Add tests
4. `platform/src/services/ml.ts` - Verify `embed()` function exists (for ML similarity)

---

## Related Work Packets

- **W35**: Conversation Context Retrieval (provides context for deduplication)
- **W36**: Resource Conflict Detection (complementary feature)
- **W10**: Task Extraction (upstream dependency)

---

## Notes

- **Context Window:** Default to 10 recent messages; configurable based on user preference
- **Similarity Thresholds:** 85% for string-based, 90% for ML-based
- **User Feedback:** Consider allowing users to confirm duplicates (not auto-reject)
- **Cross-Conversation:** Currently only checks within same conversation; could expand to global deduplication

**Future Enhancements:**
- ML-based semantic similarity (embeddings)
- Global deduplication across all conversations
- User confirmation flow ("Did you mean...?")
- Automatic task merging (combine details from duplicate tasks)

---

**Created:** 2026-01-29 (Documentation Synchronization Project, Packet 10)
**Source:** `work-packets/PACKET4_TODO_ANALYSIS.md` (Critical Stub #3)
