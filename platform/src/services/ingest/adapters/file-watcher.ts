/**
 * File Watcher Service (W36)
 *
 * Watches a directory for new/changed files and ingests them
 * through the IngestRouter. Supports markdown, text, and media files.
 */

import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { basename, extname } from 'path';
import { watch } from 'chokidar';
import { ingestRouter } from '../router.js';
import type { IngestItem } from '../types.js';
import { config } from '../../../config.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.md', '.txt', '.markdown',
  '.pdf', '.docx',
  '.json', '.yaml', '.yml',
]);

const CONTENT_TYPE_MAP: Record<string, IngestItem['contentType']> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.pdf': 'document',
  '.docx': 'document',
  '.json': 'text',
  '.yaml': 'text',
  '.yml': 'text',
};

let watcher: { close: () => Promise<void> } | null = null;

/**
 * Start watching the configured directory for file changes.
 */
export async function startFileWatcher(): Promise<void> {
  const watchDir = config.WATCH_DIR;
  if (!watchDir) {
    console.log('⏭️ File watcher: WATCH_DIR not configured, skipping');
    return;
  }

  const chokidarWatcher = watch(watchDir, {
    ignored: /(^|[/\\])\../,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
  });

  chokidarWatcher.on('add', (filePath) => handleFile(filePath, 'added'));
  chokidarWatcher.on('change', (filePath) => handleFile(filePath, 'changed'));
  chokidarWatcher.on('ready', () => console.log(`📂 File watcher watching: ${watchDir}`));
  chokidarWatcher.on('error', (error) => console.error('📂 File watcher error:', error));

  watcher = { close: () => chokidarWatcher.close() };
}

/**
 * Stop the file watcher.
 */
export async function stopFileWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
    console.log('📂 File watcher stopped');
  }
}

/**
 * Handle a detected file event.
 */
async function handleFile(filePath: string, event: string): Promise<void> {
  const ext = extname(filePath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return; // Skip unsupported file types
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    const fileStat = await stat(filePath);
    const filename = basename(filePath);

    const contentHash = createHash('sha256')
      .update(`file-watcher:${filePath}:${content}`)
      .digest('hex');

    const contentType = CONTENT_TYPE_MAP[ext] || 'text';

    const item: IngestItem = {
      id: `file-${contentHash.slice(0, 16)}`,
      source: 'file-watcher',
      contentType,
      content,
      sender: {
        id: 'local-filesystem',
        name: 'File System',
      },
      channel: {
        id: config.WATCH_DIR || 'unknown',
        name: filename,
        platform: 'filesystem',
      },
      contentHash,
      originTimestamp: fileStat.mtime.toISOString(),
      metadata: {
        filePath,
        filename,
        extension: ext,
        event,
        size: fileStat.size,
      },
    };

    const result = await ingestRouter.ingest(item);

    if (result.accepted) {
      console.log(`📂 Ingested ${event} file: ${filename}`);
    } else if (result.duplicate) {
      console.log(`📂 Skipped duplicate: ${filename}`);
    }
  } catch (error) {
    console.error(`📂 Failed to process file ${filePath}:`, error);
  }
}

/**
 * Check if the file watcher is running.
 */
export function isFileWatcherRunning(): boolean {
  return watcher !== null;
}
