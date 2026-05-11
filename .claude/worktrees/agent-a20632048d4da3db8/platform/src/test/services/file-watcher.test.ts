/**
 * File Watcher Service Tests (W36)
 */

import { describe, it, expect } from 'vitest';

describe('File Watcher Service', () => {
  it('exports expected functions', async () => {
    const mod = await import('../../services/ingest/adapters/file-watcher.js');
    expect(typeof mod.startFileWatcher).toBe('function');
    expect(typeof mod.stopFileWatcher).toBe('function');
    expect(typeof mod.isFileWatcherRunning).toBe('function');
  });

  it('reports not running when not started', async () => {
    const { isFileWatcherRunning } = await import('../../services/ingest/adapters/file-watcher.js');
    expect(isFileWatcherRunning()).toBe(false);
  });
});
