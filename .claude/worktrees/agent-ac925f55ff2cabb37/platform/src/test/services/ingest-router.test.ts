/**
 * IngestRouter Tests (W34)
 *
 * Tests for the source adapter framework: adapter registration,
 * dedup, and ingest pipeline.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { testDb, deleteFromTables, randomUUID } from '../setup.js';
import { telegramAdapter } from '../../services/ingest/adapters/telegram.js';
import { ingestNotifier } from '../../services/ingest/notifier.js';

// Mock pg-boss queue — not running in tests
vi.mock('../../queue/index.js', () => ({
  getQueue: vi.fn(() => ({
    send: vi.fn().mockResolvedValue('mock-job-id'),
  })),
  QUEUES: { MESSAGE_PROCESSING: 'message-processing', CONTEXT_UPDATE: 'context-update', GARDENER: 'gardener' },
}));

import { ingestRouter } from '../../services/ingest/router.js';
import type { IngestItem } from '../../services/ingest/types.js';

function makeItem(overrides: Partial<IngestItem> = {}): IngestItem {
  const id = randomUUID();
  return {
    id,
    source: 'test',
    contentType: 'text',
    content: `Test content ${id}`,
    sender: { id: '1', name: 'Tester' },
    channel: { id: 'ch1', platform: 'test' },
    contentHash: createHash('sha256').update(`test:${id}`).digest('hex'),
    originTimestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('Source Adapter Framework', () => {
  describe('Telegram Adapter', () => {
    it('converts text message to IngestItem', () => {
      const raw = {
        chatId: 123,
        messageId: 456,
        senderId: 789,
        senderName: 'Alice',
        senderUsername: 'alice',
        text: 'Hello world',
        timestamp: '2026-03-19T10:00:00Z',
      };

      const item = telegramAdapter.toIngestItem(raw);
      expect(item).not.toBeNull();
      expect(item!.source).toBe('telegram');
      expect(item!.contentType).toBe('text');
      expect(item!.content).toBe('Hello world');
      expect(item!.sender.id).toBe('789');
      expect(item!.sender.name).toBe('Alice');
      expect(item!.channel.id).toBe('123');
      expect(item!.channel.platform).toBe('telegram');
      expect(item!.contentHash).toBeTruthy();
    });

    it('detects link content type', () => {
      const raw = {
        chatId: 123,
        messageId: 456,
        senderId: 789,
        senderName: 'Alice',
        text: 'https://example.com/article',
        timestamp: '2026-03-19T10:00:00Z',
      };

      const item = telegramAdapter.toIngestItem(raw);
      expect(item!.contentType).toBe('link');
    });

    it('handles voice messages', () => {
      const raw = {
        chatId: 123,
        messageId: 456,
        senderId: 789,
        senderName: 'Alice',
        voice: { fileId: 'file-abc', duration: 30 },
        timestamp: '2026-03-19T10:00:00Z',
      };

      const item = telegramAdapter.toIngestItem(raw);
      expect(item!.contentType).toBe('voice');
      expect(item!.mediaUrl).toBe('file-abc');
    });

    it('returns null for empty content', () => {
      const raw = {
        chatId: 123,
        messageId: 456,
        senderId: 789,
        senderName: 'Alice',
        timestamp: '2026-03-19T10:00:00Z',
      };

      const item = telegramAdapter.toIngestItem(raw);
      expect(item).toBeNull();
    });
  });

  describe('IngestNotifier', () => {
    it('emits and receives events', () => {
      const received: Record<string, unknown>[] = [];
      const handler = (data: Record<string, unknown>) => received.push(data);

      ingestNotifier.on('ingested', handler);
      ingestNotifier.emit('ingested', { itemId: 'test-1' });

      expect(received).toHaveLength(1);
      expect(received[0]!.itemId).toBe('test-1');

      ingestNotifier.off('ingested', handler);
      ingestNotifier.emit('ingested', { itemId: 'test-2' });
      expect(received).toHaveLength(1); // No new events
    });
  });

  describe('Content hash generation', () => {
    it('produces consistent hashes for same content', () => {
      const content = 'telegram:123:456:Hello world';
      const hash1 = createHash('sha256').update(content).digest('hex');
      const hash2 = createHash('sha256').update(content).digest('hex');
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different content', () => {
      const hash1 = createHash('sha256').update('content-a').digest('hex');
      const hash2 = createHash('sha256').update('content-b').digest('hex');
      expect(hash1).not.toBe(hash2);
    });
  });
});

describe('IngestRouter dedup', () => {
  beforeEach(async () => {
    await deleteFromTables('content_hashes', 'ingest_sources');
  });

  it('accepts a new item and records its hash', async () => {
    const item = makeItem();
    const result = await ingestRouter.ingest(item);

    expect(result.accepted).toBe(true);
    expect(result.duplicate).toBe(false);

    // Verify hash was recorded
    const rows = await testDb`SELECT * FROM content_hashes WHERE hash = ${item.contentHash}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.source).toBe('test');
  });

  it('rejects duplicate content hash', async () => {
    const item = makeItem();
    const first = await ingestRouter.ingest(item);
    expect(first.accepted).toBe(true);

    // Same hash should be rejected
    const second = await ingestRouter.ingest(item);
    expect(second.accepted).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it('tracks source in ingest_sources', async () => {
    const item = makeItem({ source: 'telegram', channel: { id: 'chat-99', platform: 'telegram' } });
    await ingestRouter.ingest(item);

    const rows = await testDb`SELECT * FROM ingest_sources WHERE source_name = 'telegram' AND channel_id = 'chat-99'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.item_count).toBe(1);
  });

  it('ingestBatch returns per-item results', async () => {
    const items = [makeItem(), makeItem()];
    // Make second item a duplicate of the first
    items[1]!.contentHash = items[0]!.contentHash;

    const results = await ingestRouter.ingestBatch(items);
    expect(results).toHaveLength(2);
    expect(results[0]!.accepted).toBe(true);
    expect(results[1]!.accepted).toBe(false);
    expect(results[1]!.duplicate).toBe(true);
  });
});
