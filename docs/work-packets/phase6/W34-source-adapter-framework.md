# Work Packet W34: Source Adapter Framework

**Status:** ❌ Not Started
**Dependencies:** None
**Estimated Time:** 4–5 hours

---

## Objective

Define and implement the `SourceAdapter` interface, a generalized `IngestJobData` type, an `IngestRouter` that deduplicates and dispatches to pg-boss, and the database tables to support multi-source ingestion. Refactor the existing Telegram path to be the first adapter implementation.

---

## Implementation

### SourceAdapter Interface

Create `platform/src/services/ingest/types.ts`:

```typescript
import { z } from 'zod';

/**
 * Platform values for envelope origin.
 * Existing: 'telegram'
 * New: 'file', 'obsidian', 'teams', 'api'
 */
export const IngestPlatform = z.enum([
  'telegram', 'file', 'obsidian', 'teams', 'api',
]);
export type IngestPlatform = z.infer<typeof IngestPlatform>;

/**
 * Raw content type.
 * Existing: 'text', 'voice', 'link'
 * New: 'transcript', 'markdown', 'document', 'audio'
 */
export const IngestRawType = z.enum([
  'text', 'voice', 'link', 'transcript', 'markdown', 'document', 'audio',
]);
export type IngestRawType = z.infer<typeof IngestRawType>;

/**
 * Generalized ingest job — what every source adapter produces.
 * Replaces the Telegram-specific MessageJobData at the adapter boundary.
 */
export interface IngestJobData {
  /** Unique ID for this ingest event */
  traceId: string;
  /** Which source produced this */
  platform: IngestPlatform;
  /** Content type */
  rawType: IngestRawType;
  /** The primary text content (or file path for binary) */
  content: string;
  /** SHA-256 of content for dedup */
  contentHash: string;
  /** Source-specific metadata (Telegram chat ID, filename, vault path, etc.) */
  metadata: Record<string, unknown>;
  /** ISO timestamp of original content creation */
  createdAt: string;
}

/**
 * Every source implements this interface.
 */
export interface SourceAdapter {
  /** Unique name for this source (e.g. 'telegram', 'file-watcher', 'http-api') */
  readonly name: string;
  /** Which platform value this adapter produces */
  readonly platform: IngestPlatform;
  /** Start listening / polling (called once at startup) */
  start(): Promise<void>;
  /** Graceful shutdown */
  stop(): Promise<void>;
}

/**
 * Optional interface for adapters that support on-demand ingestion
 * (e.g. HTTP API, MCP server) rather than push/watch.
 */
export interface OnDemandAdapter extends SourceAdapter {
  ingest(content: string, metadata?: Record<string, unknown>): Promise<{ traceId: string }>;
}
```

### IngestRouter

Create `platform/src/services/ingest/router.ts`:

```typescript
import { createHash } from 'crypto';
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import { IngestJobData } from './types.js';

/**
 * Central router: dedup check → pg-boss dispatch.
 * All source adapters call this to submit content.
 */
export class IngestRouter {
  constructor(private readonly queueJob: (name: string, data: unknown) => Promise<string>) {}

  /**
   * Route an ingest job. Returns trace ID if queued, null if duplicate.
   */
  async route(job: IngestJobData): Promise<{ traceId: string; duplicate: boolean }> {
    // Check content hash for dedup
    const isDuplicate = await this.checkDuplicate(job.contentHash);
    if (isDuplicate) {
      return { traceId: job.traceId, duplicate: true };
    }

    // Record the hash
    await this.recordHash(job);

    // Dispatch to pg-boss
    await this.queueJob('process-message', job);

    return { traceId: job.traceId, duplicate: false };
  }

  private async checkDuplicate(hash: string): Promise<boolean> {
    const result = await db.execute(sql`
      SELECT 1 FROM content_hashes WHERE hash = ${hash} LIMIT 1
    `);
    return result.rows.length > 0;
  }

  private async recordHash(job: IngestJobData): Promise<void> {
    await db.execute(sql`
      INSERT INTO content_hashes (hash, platform, trace_id, created_at)
      VALUES (${job.contentHash}, ${job.platform}, ${job.traceId}, NOW())
      ON CONFLICT (hash) DO NOTHING
    `);
  }
}

/**
 * Compute SHA-256 content hash.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
```

### Notifier Abstraction

Create `platform/src/services/ingest/notifier.ts`:

```typescript
/**
 * Source-specific notification channel.
 * Telegram sends messages back; file/API sources are no-op.
 */
export interface IngestNotifier {
  /** Notify the source that processing started */
  onQueued(traceId: string): Promise<void>;
  /** Notify the source of processing result */
  onComplete(traceId: string, success: boolean, summary?: string): Promise<void>;
  /** Notify the source of an error */
  onError(traceId: string, error: string): Promise<void>;
}

/**
 * No-op notifier for sources that don't support push notifications
 * (file watcher, HTTP API, Obsidian).
 */
export const silentNotifier: IngestNotifier = {
  async onQueued() {},
  async onComplete() {},
  async onError() {},
};
```

### TelegramAdapter (Refactor Existing Path)

Create `platform/src/services/ingest/adapters/telegram.ts`:

```typescript
import { SourceAdapter, IngestJobData, IngestPlatform } from '../types.js';
import { computeContentHash } from '../router.js';
import { randomUUID } from 'crypto';

/**
 * Wraps the existing Telegram bot handler as a SourceAdapter.
 * The bot handler calls toIngestJob() when a message arrives,
 * then passes the result to IngestRouter.route().
 */
export class TelegramAdapter implements SourceAdapter {
  readonly name = 'telegram';
  readonly platform: IngestPlatform = 'telegram';

  async start(): Promise<void> {
    // Bot is started separately — this adapter just provides the conversion.
  }

  async stop(): Promise<void> {}

  /**
   * Convert a Telegram message context into IngestJobData.
   * Called from bot/index.ts queueMessage().
   */
  toIngestJob(
    chatId: number,
    text: string,
    metadata: Record<string, unknown>,
  ): IngestJobData {
    return {
      traceId: randomUUID(),
      platform: 'telegram',
      rawType: metadata.voice ? 'voice' : metadata.url ? 'link' : 'text',
      content: text,
      contentHash: computeContentHash(text),
      metadata: { chatId, ...metadata },
      createdAt: new Date().toISOString(),
    };
  }
}
```

### Database Tables

#### content_hashes

```sql
CREATE TABLE IF NOT EXISTS content_hashes (
  hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_content_hashes_platform ON content_hashes(platform);
CREATE INDEX idx_content_hashes_created ON content_hashes(created_at DESC);
```

#### ingest_sources

```sql
CREATE TABLE IF NOT EXISTS ingest_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

### Message Processor Refactor

Refactor `platform/src/workers/message-processor.ts` to accept `IngestJobData` alongside the existing `MessageJobData`. The processor already treats content generically — the main change is reading `platform` and `rawType` from the new fields when present.

```typescript
// Detect whether job is legacy MessageJobData or new IngestJobData
const isNewFormat = 'platform' in data && 'rawType' in data;
const platform = isNewFormat ? data.platform : 'telegram';
const rawType = isNewFormat ? data.rawType : detectLegacyType(data);
```

This keeps backward compatibility while the Telegram path is migrated.

---

## Verification

### Automated Tests

```typescript
// platform/src/test/services/ingest-router.test.ts
import { describe, it, expect } from 'vitest';
import { computeContentHash } from '../../services/ingest/router.js';

describe('IngestRouter', () => {
  it('should compute deterministic content hash', () => {
    const hash1 = computeContentHash('hello world');
    const hash2 = computeContentHash('hello world');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hash for different content', () => {
    const hash1 = computeContentHash('hello');
    const hash2 = computeContentHash('world');
    expect(hash1).not.toBe(hash2);
  });
});
```

### Manual Verification

```bash
# Verify content_hashes table exists
psql -d cognitive -c "\d content_hashes"

# Verify ingest_sources table exists
psql -d cognitive -c "\d ingest_sources"

# Send a Telegram message, confirm it appears in content_hashes
psql -d cognitive -c "SELECT hash, platform, trace_id FROM content_hashes ORDER BY created_at DESC LIMIT 5;"
```

---

## Acceptance Criteria

- [ ] `SourceAdapter` interface defined with `start()` / `stop()`
- [ ] `IngestJobData` generalizes `MessageJobData`
- [ ] `IngestRouter` deduplicates via `content_hashes` table
- [ ] `computeContentHash()` produces SHA-256
- [ ] `TelegramAdapter` wraps existing bot handler
- [ ] `silentNotifier` implemented for non-interactive sources
- [ ] `content_hashes` and `ingest_sources` tables created
- [ ] Message processor accepts both legacy and new job format
- [ ] Existing Telegram flow still works end-to-end

---

## Next Packet

- [W35: HTTP Ingest API](./W35-http-ingest-api.md) — First new input source
- [W36: File Watcher Service](./W36-file-watcher.md) — File-based input
- [W39: Obsidian Read Adapter](./W39-obsidian-read.md) — Obsidian vault input
