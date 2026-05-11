# Work Packet W44: Conversation Context Service

**Status:** ❌ Not Started
**Dependencies:** W34 (Source Adapter Framework), W43 (Processing Profiles)
**Estimated Time:** 5–6 hours
**Design Reference:** [Multi-Source Processing Architecture](../../architecture/multi-source-processing.md)

---

## Objective

Implement the Conversation Context Service that manages adaptive sliding windows, pattern-triggered extraction, periodic rollups, and rolling conversation summaries for ongoing conversation streams. This is the core system that enables Level 2 (contextual) and Level 3 (aggregate) meaning extraction.

---

## Architecture

```
Message arrives from conversation stream
    │
    ├── Store + embed (Level 1, always)
    │
    ├── triggerScan(message, profile.triggerPatterns)
    │   ├── MATCH → buildContextWindow() → extract with context (Level 2)
    │   └── NO MATCH → accumulate in rollup buffer
    │
    └── rollupCheck(conversation, profile.rollupInterval)
        └── DUE → buildContextWindow() → rollup extraction (Level 2 + 3)
                   → update conversation summary (Level 3)
                   → update project association scores
```

---

## Implementation

### Conversation State

Create `platform/src/services/conversation-context.ts`:

```typescript
export interface ConversationState {
  conversationId: string;
  platform: string;
  /** Messages accumulated since last rollup */
  rollupBuffer: BufferedMessage[];
  /** Last rollup timestamp */
  lastRollupAt: Date;
  /** Message count since last rollup */
  messagesSinceRollup: number;
}

export interface BufferedMessage {
  memoryId: string;
  content: string;
  senderId: string;
  senderName: string;
  timestamp: Date;
  triggered: boolean;  // Whether this message triggered immediate extraction
}

export interface ConversationSummary {
  conversationId: string;
  title: string;
  currentTopics: string[];
  participants: string[];
  decisions: Array<{ text: string; timestamp: string; participants: string[] }>;
  openActionItems: Array<{ text: string; assignee?: string; dueDate?: string }>;
  projectAssociations: Array<{ projectId: string; confidence: number }>;
  lastUpdated: Date;
  messageCount: number;
  summaryText: string;
}
```

### Database

```sql
-- Migration: 014_conversation_context.sql

CREATE TABLE IF NOT EXISTS conversation_state (
  conversation_id   TEXT PRIMARY KEY,
  platform          TEXT NOT NULL,
  rollup_buffer     JSONB NOT NULL DEFAULT '[]',
  last_rollup_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  messages_since_rollup INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id   TEXT PRIMARY KEY,
  title             TEXT,
  current_topics    TEXT[] NOT NULL DEFAULT '{}',
  participants      TEXT[] NOT NULL DEFAULT '{}',
  decisions         JSONB NOT NULL DEFAULT '[]',
  open_action_items JSONB NOT NULL DEFAULT '[]',
  project_associations JSONB NOT NULL DEFAULT '[]',
  last_updated      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_count     INTEGER NOT NULL DEFAULT 0,
  summary_text      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_conv_summaries_updated ON conversation_summaries(last_updated DESC);
```

### Trigger Scan

```typescript
/**
 * Check if a message matches any trigger patterns from the processing profile.
 * Pure regex — zero LLM cost.
 */
export function triggerScan(content: string, patterns: string[]): boolean {
  const lowerContent = content.toLowerCase();
  return patterns.some(pattern => {
    try {
      return new RegExp(pattern, 'i').test(lowerContent);
    } catch {
      // Invalid regex — treat as literal substring match
      return lowerContent.includes(pattern.toLowerCase());
    }
  });
}
```

### Adaptive Context Window

```typescript
import { ml } from '../services/ml-client.js';

interface ContextWindow {
  messages: BufferedMessage[];
  projectBackdrop?: string;
}

/**
 * Build an adaptive context window for a message.
 *
 * Combines:
 * 1. Temporal: recent messages from the same conversation (last 30 min, max 30)
 * 2. Semantic: vector-similar messages from conversation history (catches topic resurgence)
 * 3. Project: rolling summary of associated project (if any)
 */
export async function buildContextWindow(
  message: BufferedMessage,
  conversationId: string,
  conversationSummary?: ConversationSummary,
): Promise<ContextWindow> {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);

  // 1. Temporal: recent messages from DB/buffer
  const temporal = await db.execute(sql`
    SELECT memory_id, content, sender_name, timestamp
    FROM conversation_messages
    WHERE conversation_id = ${conversationId}
      AND timestamp > ${thirtyMinAgo}
    ORDER BY timestamp DESC
    LIMIT 30
  `);

  // 2. Semantic: vector search within this conversation
  const embedding = await ml.embed(message.content);
  const semantic = await searchMemoriesWithFilter(embedding.vector, {
    filter: { conversation_id: conversationId },
    limit: 5,
    minScore: 0.7,
  });

  // Merge and deduplicate (temporal + semantic, prefer temporal ordering)
  const seen = new Set<string>();
  const merged: BufferedMessage[] = [];

  for (const row of temporal.rows as any[]) {
    if (!seen.has(row.memory_id)) {
      seen.add(row.memory_id);
      merged.push({
        memoryId: row.memory_id,
        content: row.content,
        senderId: '',
        senderName: row.sender_name,
        timestamp: new Date(row.timestamp),
        triggered: false,
      });
    }
  }

  for (const hit of semantic) {
    if (!seen.has(hit.id)) {
      seen.add(hit.id);
      merged.push({
        memoryId: hit.id,
        content: hit.payload.content as string,
        senderId: '',
        senderName: hit.payload.sender_name as string || 'Unknown',
        timestamp: new Date(hit.payload.created_at as string),
        triggered: false,
      });
    }
  }

  // Sort by timestamp ascending (chronological for the extraction prompt)
  merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // 3. Project backdrop
  const projectBackdrop = conversationSummary?.summaryText || undefined;

  return { messages: merged, projectBackdrop };
}
```

### Rollup Check & Execution

```typescript
import { resolveProfile } from './ingest/profiles.js';
import { llm_client } from '../services/ml-client.js';

/**
 * Check if a rollup is due for this conversation.
 */
export function isRollupDue(
  state: ConversationState,
  rollupInterval: { messages: number; minutes: number },
): boolean {
  if (rollupInterval.messages === 0 && rollupInterval.minutes === 0) {
    return false; // No rollup for this source type (e.g., standalone Telegram)
  }

  const minutesSinceRollup = (Date.now() - state.lastRollupAt.getTime()) / 60000;

  return (
    state.messagesSinceRollup >= rollupInterval.messages ||
    minutesSinceRollup >= rollupInterval.minutes
  );
}

/**
 * Execute a rollup: extract decisions/actions from accumulated messages,
 * update the rolling conversation summary.
 */
export async function executeRollup(
  conversationId: string,
  buffer: BufferedMessage[],
  existingSummary?: ConversationSummary,
): Promise<ConversationSummary> {
  if (buffer.length === 0) return existingSummary || emptyConversationSummary(conversationId);

  // Format messages for the extraction prompt
  const transcript = buffer
    .map(m => `[${m.senderName}] ${m.content}`)
    .join('\n');

  const existingContext = existingSummary?.summaryText
    ? `\nPrior context:\n${existingSummary.summaryText}\n`
    : '';

  // Single LLM call for the entire rollup
  const result = await ml.chat(
    `${existingContext}\nHere are the latest ${buffer.length} messages:\n\n${transcript}`,
    ROLLUP_SYSTEM_PROMPT,
  );

  // Parse structured extraction from LLM response
  const extracted = parseRollupResponse(result.response);

  // Merge with existing summary
  return mergeIntoSummary(conversationId, existingSummary, extracted, buffer.length);
}

const ROLLUP_SYSTEM_PROMPT = `You are analyzing a conversation stream for a knowledge management system.

Extract the following from these messages and return as JSON:
{
  "decisions": [{"text": "...", "participants": ["..."]}],
  "action_items": [{"text": "...", "assignee": "...", "due_date": "..."}],
  "topics": ["..."],
  "key_facts": ["..."],
  "summary_update": "2-3 sentence summary of what was discussed"
}

Focus on: decisions made, commitments/action items with assignees, topic shifts,
and any factual claims worth remembering. Skip pleasantries and filler.`;
```

### Integration with Message Processor

The conversation context service hooks into the message processor after Level 1 storage:

```typescript
// In message-processor.ts, after store + embed:

if (profile.rollupInterval.messages > 0) {
  // This is a stream source — use conversation context
  const state = await getConversationState(conversationId);

  // Buffer the message
  await bufferMessage(state, message);

  // Check trigger
  if (triggerScan(textToEmbed, profile.triggerPatterns)) {
    const window = await buildContextWindow(message, conversationId, summary);
    await extractWithContext(message, window, profile);
  }

  // Check rollup
  if (isRollupDue(state, profile.rollupInterval)) {
    const summary = await getConversationSummary(conversationId);
    const updated = await executeRollup(conversationId, state.rollupBuffer, summary);
    await saveConversationSummary(updated);
    await clearRollupBuffer(state);
  }
}
```

---

## Verification

### Automated Tests

```typescript
describe('Conversation Context Service', () => {
  describe('triggerScan', () => {
    it('should match decision patterns', () => {
      expect(triggerScan("let's go with React", TEAMS_TRIGGERS)).toBe(true);
      expect(triggerScan("agreed on the approach", TEAMS_TRIGGERS)).toBe(true);
    });

    it('should match action patterns', () => {
      expect(triggerScan("I'll create the JIRA ticket", TEAMS_TRIGGERS)).toBe(true);
      expect(triggerScan("TODO: update the docs by Friday", TEAMS_TRIGGERS)).toBe(true);
    });

    it('should match artifact patterns', () => {
      expect(triggerScan("see PHOE-1234 for details", TEAMS_TRIGGERS)).toBe(true);
      expect(triggerScan("PR #42 is ready for review", TEAMS_TRIGGERS)).toBe(true);
    });

    it('should not trigger on casual messages', () => {
      expect(triggerScan("haha nice one", TEAMS_TRIGGERS)).toBe(false);
      expect(triggerScan("brb lunch", TEAMS_TRIGGERS)).toBe(false);
    });
  });

  describe('isRollupDue', () => {
    it('should trigger on message count', () => {
      const state = { messagesSinceRollup: 15, lastRollupAt: new Date() };
      expect(isRollupDue(state, { messages: 15, minutes: 10 })).toBe(true);
    });

    it('should trigger on time', () => {
      const tenMinAgo = new Date(Date.now() - 11 * 60 * 1000);
      const state = { messagesSinceRollup: 3, lastRollupAt: tenMinAgo };
      expect(isRollupDue(state, { messages: 15, minutes: 10 })).toBe(true);
    });

    it('should not trigger for standalone sources', () => {
      const state = { messagesSinceRollup: 100, lastRollupAt: new Date(0) };
      expect(isRollupDue(state, { messages: 0, minutes: 0 })).toBe(false);
    });
  });
});
```

---

## Acceptance Criteria

- [ ] `triggerScan()` matches decision, action, artifact, and escalation patterns
- [ ] `buildContextWindow()` combines temporal + semantic + project context
- [ ] Semantic window uses Qdrant filtered search by conversation_id
- [ ] `isRollupDue()` checks both message count and time thresholds
- [ ] `executeRollup()` produces structured extraction from accumulated messages
- [ ] Rolling conversation summary updated at each rollup
- [ ] Conversation summaries stored in Postgres and embedded in Qdrant
- [ ] `conversation_state` and `conversation_summaries` tables created
- [ ] Message processor integration: trigger + buffer + rollup loop
- [ ] Standalone sources (Telegram, email) bypass rollup path entirely

---

## Next Packet

- [W45: Project Association Agent](./W45-project-association.md) — Uses conversation summaries for project linking
