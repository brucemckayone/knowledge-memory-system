/**
 * IngestRouter (W34)
 *
 * Central ingest pipeline: accepts IngestItems from any adapter,
 * deduplicates via content_hashes, and forwards to the message processor queue.
 */

import { db } from '../../db/index.js';
import { contentHashes } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { getQueue, QUEUES } from '../../queue/index.js';
import type { IngestItem, IngestResult, SourceAdapter } from './types.js';

class IngestRouter {
  private adapters = new Map<string, SourceAdapter>();

  registerAdapter(adapter: SourceAdapter): void {
    this.adapters.set(adapter.name, adapter);
    console.log(`📥 Registered ingest adapter: ${adapter.name}`);
  }

  getAdapter(name: string): SourceAdapter | undefined {
    return this.adapters.get(name);
  }

  /**
   * Ingest a pre-formed IngestItem through the pipeline.
   * Returns whether it was accepted or rejected as duplicate.
   */
  async ingest(item: IngestItem): Promise<IngestResult> {
    // 1. Dedup check
    const isDuplicate = await this.checkDuplicate(item.contentHash, item.source);
    if (isDuplicate) {
      return { accepted: false, itemId: item.id, duplicate: true, reason: 'Content already ingested' };
    }

    // 2. Record the hash
    await this.recordHash(item);

    // 3. Update source tracking
    await this.updateSourceTracking(item.source, item.channel.id);

    // 4. Forward to message processing queue
    const boss = getQueue();
    await boss.send(QUEUES.MESSAGE_PROCESSING, {
      // Standard fields the message processor expects
      chatId: 0, // Placeholder for non-Telegram sources
      messageId: 0,
      senderId: parseInt(item.sender.id, 10) || 0,
      senderName: item.sender.name,
      senderUsername: item.sender.handle,
      text: item.content,
      timestamp: item.originTimestamp,
      // Extended fields for multi-source support
      _ingest: {
        id: item.id,
        source: item.source,
        contentType: item.contentType,
        channelId: item.channel.id,
        channelPlatform: item.channel.platform,
        mediaUrl: item.mediaUrl,
        metadata: item.metadata,
      },
    });

    return { accepted: true, itemId: item.id, duplicate: false };
  }

  /**
   * Ingest a batch of items. Returns per-item results.
   */
  async ingestBatch(items: IngestItem[]): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    for (const item of items) {
      results.push(await this.ingest(item));
    }
    return results;
  }

  private async checkDuplicate(hash: string, _source: string): Promise<boolean> {
    try {
      const existing = await db
        .select({ id: contentHashes.id })
        .from(contentHashes)
        .where(eq(contentHashes.hash, hash))
        .limit(1);
      return existing.length > 0;
    } catch {
      // Table might not exist yet during migration — allow through
      return false;
    }
  }

  private async recordHash(item: IngestItem): Promise<void> {
    try {
      await db.insert(contentHashes).values({
        hash: item.contentHash,
        source: item.source,
        itemId: item.id,
      }).onConflictDoNothing();
    } catch {
      // Non-fatal: dedup is best-effort
    }
  }

  private async updateSourceTracking(source: string, channelId: string): Promise<void> {
    try {
      await db.execute(sql`
        INSERT INTO ingest_sources (source_name, channel_id, last_seen_at, item_count)
        VALUES (${source}, ${channelId}, NOW(), 1)
        ON CONFLICT (source_name, channel_id)
        DO UPDATE SET last_seen_at = NOW(), item_count = ingest_sources.item_count + 1
      `);
    } catch {
      // Non-fatal
    }
  }
}

// Singleton
export const ingestRouter = new IngestRouter();
