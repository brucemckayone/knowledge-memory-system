/**
 * Obsidian Read Adapter (W39)
 *
 * Syncs Obsidian vault markdown files into Mnemo.
 * Tracks per-file hashes to avoid re-ingesting unchanged files.
 * Loop prevention: ignores files in the Mnemo output folder.
 */

import { createHash } from 'crypto';
import { db } from '../../../db/index.js';
import { obsidianSyncState } from '../../../db/schema.js';
import { and, eq, sql } from 'drizzle-orm';
import { listVaultFiles } from '../../obsidian/cli.js';
import { ingestRouter } from '../router.js';
import { ml } from '../../ml-client.js';
import type { IngestItem } from '../types.js';
import { config } from '../../../config.js';

const MNEMO_OUTPUT_DIR = 'mnemo-output'; // Skip this folder to prevent loops

export interface SyncResult {
  total: number;
  synced: number;
  skipped: number;
  errors: number;
}

/**
 * Sync an Obsidian vault: discover files, diff against stored hashes,
 * and ingest new/changed files.
 */
export async function syncVault(vaultPath?: string): Promise<SyncResult> {
  const vault = vaultPath || config.OBSIDIAN_VAULT_PATH;
  if (!vault) {
    return { total: 0, synced: 0, skipped: 0, errors: 0 };
  }

  const files = await listVaultFiles(vault);
  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    // Loop prevention: skip files in our output directory
    if (file.relativePath.startsWith(MNEMO_OUTPUT_DIR)) {
      skipped++;
      continue;
    }

    try {
      // Check if file has changed since last sync
      const existing = await db
        .select()
        .from(obsidianSyncState)
        .where(and(
          eq(obsidianSyncState.vaultPath, vault),
          eq(obsidianSyncState.filePath, file.relativePath),
        ))
        .limit(1);

      if (existing.length > 0 && existing[0]!.contentHash === file.contentHash) {
        skipped++;
        continue;
      }

      // Parse markdown via ML service for richer extraction
      let title = file.relativePath.replace('.md', '');
      let tags: string[] = [];
      try {
        const parsed = await ml.parseMarkdown(file.content, file.relativePath);
        title = parsed.title || title;
        tags = parsed.tags || [];
      } catch {
        // ML not available — use filename as title
      }

      // Build IngestItem
      const contentHash = createHash('sha256')
        .update(`obsidian:${vault}:${file.relativePath}:${file.content}`)
        .digest('hex');

      const item: IngestItem = {
        id: `obsidian-${file.contentHash.slice(0, 16)}`,
        source: 'obsidian',
        contentType: 'markdown',
        content: file.content,
        sender: { id: 'obsidian-vault', name: 'Obsidian' },
        channel: { id: vault, name: file.relativePath, platform: 'obsidian' },
        contentHash,
        originTimestamp: file.modifiedAt.toISOString(),
        metadata: {
          vaultPath: vault,
          filePath: file.relativePath,
          title,
          tags,
          size: file.size,
        },
      };

      const result = await ingestRouter.ingest(item);

      // Update sync state
      if (result.accepted) {
        await db.execute(sql`
          INSERT INTO obsidian_sync_state (vault_path, file_path, content_hash, memory_id)
          VALUES (${vault}, ${file.relativePath}, ${file.contentHash}, ${item.id}::uuid)
          ON CONFLICT (vault_path, file_path)
          DO UPDATE SET content_hash = ${file.contentHash}, last_synced_at = NOW(), memory_id = ${item.id}::uuid
        `);
        synced++;
      } else {
        skipped++;
      }
    } catch (error) {
      console.error(`❌ Failed to sync ${file.relativePath}:`, error);
      errors++;
    }
  }

  console.log(`📚 Obsidian sync: ${synced} synced, ${skipped} skipped, ${errors} errors (${files.length} total)`);
  return { total: files.length, synced, skipped, errors };
}
