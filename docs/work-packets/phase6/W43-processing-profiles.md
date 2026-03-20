# Work Packet W43: Processing Profile System

**Status:** ❌ Not Started
**Dependencies:** W34 (Source Adapter Framework)
**Estimated Time:** 3–4 hours
**Design Reference:** [Multi-Source Processing Architecture](../../architecture/multi-source-processing.md)

---

## Objective

Implement the three-layer processing profile system that determines what extractors run, what prompts they use, and how content is chunked for each source. Profiles resolve from source-type defaults → channel refinements → project context boost.

---

## Implementation

### Profile Types

Create `platform/src/services/ingest/profiles.ts`:

```typescript
import { IngestPlatform, IngestRawType } from './types.js';

export interface ExtractorConfig {
  name: string;
  enabled: boolean;
  weight: number;       // 0.0-1.0, controls extraction sensitivity
  promptHints?: string; // Additional context for extraction prompt
}

export interface ProcessingProfile {
  /** Source type this profile applies to */
  sourceType: IngestRawType;
  /** How to chunk content for processing */
  chunkingStrategy: 'standard' | 'by-speaker-turn' | 'by-section' | 'per-message';
  /** Which extractors to run and how */
  extractors: ExtractorConfig[];
  /** Trigger patterns for immediate extraction (regex strings) */
  triggerPatterns: string[];
  /** Rollup interval: messages or minutes, whichever first */
  rollupInterval: { messages: number; minutes: number };
  /** Additional prompt context (from Layer 2/3) */
  promptContext?: string;
}

/**
 * Layer 1: Static defaults per source type.
 */
const SOURCE_DEFAULTS: Record<string, ProcessingProfile> = {
  'telegram-text': {
    sourceType: 'text',
    chunkingStrategy: 'standard',
    extractors: [
      { name: 'entities', enabled: true, weight: 1.0 },
      { name: 'relationships', enabled: true, weight: 1.0 },
      { name: 'tasks', enabled: true, weight: 1.0 },
      { name: 'classification', enabled: true, weight: 1.0 },
    ],
    triggerPatterns: [],  // Telegram messages are always fully processed
    rollupInterval: { messages: 0, minutes: 0 },  // No rollup (standalone messages)
  },

  'teams-chat': {
    sourceType: 'text',
    chunkingStrategy: 'by-speaker-turn',
    extractors: [
      { name: 'decisions', enabled: true, weight: 1.0 },
      { name: 'action-items', enabled: true, weight: 1.0 },
      { name: 'mentions', enabled: true, weight: 0.8 },
      { name: 'topics', enabled: true, weight: 0.7 },
      { name: 'entities', enabled: true, weight: 0.6 },
    ],
    triggerPatterns: [
      "let's go with", "agreed", "decided", "approved", "confirmed", "we'll use",
      "I'll", "will create", "action item", "TODO", "by (monday|tuesday|wednesday|thursday|friday|tomorrow|eod|end of)",
      "JIRA", "\\b[A-Z]+-\\d+\\b", "PR #", "ticket", "RFC",
      "blocker", "deadline", "urgent", "FYI", "heads up",
    ],
    rollupInterval: { messages: 15, minutes: 10 },
  },

  'email': {
    sourceType: 'text',
    chunkingStrategy: 'per-message',
    extractors: [
      { name: 'summary', enabled: true, weight: 1.0 },
      { name: 'follow-ups', enabled: true, weight: 1.0 },
      { name: 'commitments', enabled: true, weight: 0.9 },
      { name: 'entities', enabled: true, weight: 0.7 },
    ],
    triggerPatterns: [],  // Emails are always fully processed
    rollupInterval: { messages: 0, minutes: 0 },
  },

  'transcript': {
    sourceType: 'transcript',
    chunkingStrategy: 'by-speaker-turn',
    extractors: [
      { name: 'summary', enabled: true, weight: 1.0 },
      { name: 'action-items', enabled: true, weight: 1.0 },
      { name: 'decisions', enabled: true, weight: 1.0 },
      { name: 'attendees', enabled: true, weight: 0.9 },
      { name: 'topics', enabled: true, weight: 0.8 },
      { name: 'entities', enabled: true, weight: 0.7 },
    ],
    triggerPatterns: [],  // Transcripts are batch-processed whole
    rollupInterval: { messages: 0, minutes: 0 },
  },

  'document': {
    sourceType: 'document',
    chunkingStrategy: 'by-section',
    extractors: [
      { name: 'summary', enabled: true, weight: 1.0 },
      { name: 'key-facts', enabled: true, weight: 0.9 },
      { name: 'references', enabled: true, weight: 0.7 },
      { name: 'entities', enabled: true, weight: 0.7 },
    ],
    triggerPatterns: [],
    rollupInterval: { messages: 0, minutes: 0 },
  },

  'markdown': {
    sourceType: 'markdown',
    chunkingStrategy: 'by-section',
    extractors: [
      { name: 'summary', enabled: true, weight: 1.0 },
      { name: 'wikilink-entities', enabled: true, weight: 1.0 },
      { name: 'tags', enabled: true, weight: 0.9 },
      { name: 'entities', enabled: true, weight: 0.6 },
    ],
    triggerPatterns: [],
    rollupInterval: { messages: 0, minutes: 0 },
  },
};
```

### Layer 2: Channel Profile Storage

```sql
-- Migration: 013_channel_profiles.sql
CREATE TABLE IF NOT EXISTS channel_profiles (
  channel_id     TEXT PRIMARY KEY,
  platform       TEXT NOT NULL,
  display_name   TEXT,
  profile_overrides JSONB NOT NULL DEFAULT '{}',
  observed_patterns JSONB NOT NULL DEFAULT '{}',
  user_hints     JSONB NOT NULL DEFAULT '{}',
  message_count  INTEGER NOT NULL DEFAULT 0,
  last_updated   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Profile Resolution

```typescript
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';

/**
 * Resolve the processing profile for a message.
 * Layer 1 (source default) → Layer 2 (channel) → Layer 3 (project)
 */
export async function resolveProfile(
  platform: IngestPlatform,
  rawType: IngestRawType,
  channelId?: string,
): Promise<ProcessingProfile> {
  // Layer 1: source-type default
  const sourceKey = platform === 'telegram' ? `telegram-${rawType}` : rawType;
  const base = SOURCE_DEFAULTS[sourceKey] || SOURCE_DEFAULTS['telegram-text']!;
  const profile = structuredClone(base);

  if (!channelId) return profile;

  // Layer 2: channel refinements
  const channelRow = await db.execute(sql`
    SELECT profile_overrides, observed_patterns, user_hints
    FROM channel_profiles
    WHERE channel_id = ${channelId}
  `);

  if (channelRow.rows.length > 0) {
    const row = channelRow.rows[0] as {
      profile_overrides: Record<string, unknown>;
      observed_patterns: Record<string, number>;
      user_hints: Record<string, unknown>;
    };

    // Merge observed pattern weights into extractors
    for (const extractor of profile.extractors) {
      const observedWeight = row.observed_patterns[extractor.name];
      if (typeof observedWeight === 'number') {
        extractor.weight = Math.min(1.0, extractor.weight + observedWeight * 0.3);
      }
    }

    // Apply user hints (override extractor enable/disable)
    if (row.user_hints.disabledExtractors) {
      const disabled = row.user_hints.disabledExtractors as string[];
      for (const ext of profile.extractors) {
        if (disabled.includes(ext.name)) ext.enabled = false;
      }
    }
  }

  // Layer 3: project context boost (injected by caller when project association exists)
  // profile.promptContext is set externally after project resolution

  return profile;
}
```

### Pattern Observation (Channel Learning)

```typescript
/**
 * After processing a batch of messages from a channel,
 * update observed patterns based on what was found.
 */
export async function updateChannelObservations(
  channelId: string,
  platform: string,
  observations: Record<string, number>, // e.g. { 'jira-refs': 5, 'action-items': 3 }
  messageCount: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO channel_profiles (channel_id, platform, observed_patterns, message_count)
    VALUES (
      ${channelId}, ${platform},
      ${JSON.stringify(observations)}::jsonb,
      ${messageCount}
    )
    ON CONFLICT (channel_id) DO UPDATE SET
      observed_patterns = channel_profiles.observed_patterns || ${JSON.stringify(observations)}::jsonb,
      message_count = channel_profiles.message_count + ${messageCount},
      last_updated = NOW()
  `);
}
```

---

## Verification

### Automated Tests

```typescript
// platform/src/test/services/profiles.test.ts
import { describe, it, expect } from 'vitest';
import { resolveProfile } from '../../services/ingest/profiles.js';

describe('Processing Profiles', () => {
  it('should return teams-chat defaults for teams platform', async () => {
    const profile = await resolveProfile('teams', 'text');
    expect(profile.chunkingStrategy).toBe('by-speaker-turn');
    expect(profile.extractors.find(e => e.name === 'decisions')?.enabled).toBe(true);
    expect(profile.triggerPatterns.length).toBeGreaterThan(0);
  });

  it('should return telegram defaults for telegram platform', async () => {
    const profile = await resolveProfile('telegram', 'text');
    expect(profile.chunkingStrategy).toBe('standard');
    expect(profile.triggerPatterns.length).toBe(0); // Always fully processed
  });

  it('should return transcript profile for transcript rawType', async () => {
    const profile = await resolveProfile('file', 'transcript');
    expect(profile.extractors.find(e => e.name === 'attendees')?.enabled).toBe(true);
  });
});
```

---

## Acceptance Criteria

- [ ] Layer 1 defaults defined for all source types (telegram, teams-chat, email, transcript, document, markdown)
- [ ] `resolveProfile()` merges Layer 1 + Layer 2 + Layer 3
- [ ] `channel_profiles` table created with overrides, observations, and user hints
- [ ] `updateChannelObservations()` updates channel patterns after processing
- [ ] Trigger patterns defined for teams-chat (decisions, actions, artifacts, escalations)
- [ ] Rollup intervals configurable per source type
- [ ] Existing Telegram flow unaffected (no rollup, always fully processed)

---

## Next Packet

- [W44: Conversation Context Service](./W44-conversation-context.md) — Uses profiles for extraction decisions
