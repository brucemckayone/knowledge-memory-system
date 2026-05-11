/**
 * Processing Profiles Tests (W43)
 *
 * Tests per-channel processing configuration: defaults, persistence,
 * cache behavior, and profile updates.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, deleteFromTables } from '../setup.js';
import {
  getProcessingConfig,
  setProcessingProfile,
  listProfiles,
  clearProfileCache,
} from '../../services/ingest/profiles.js';

describe('Processing Profiles', () => {
  beforeEach(async () => {
    await deleteFromTables('channel_profiles');
    clearProfileCache();
  });

  it('returns default config when no profile is set', async () => {
    const config = await getProcessingConfig('telegram', 'unknown-channel');

    expect(config.extractionStrategy).toBe('standard');
    expect(config.chunkingEnabled).toBe(true);
    expect(config.chunkSize).toBe(4000);
    expect(config.chunkOverlap).toBe(200);
    expect(config.entityExtraction).toBe(true);
    expect(config.relationshipExtraction).toBe(true);
    expect(config.taskExtraction).toBe(true);
    expect(config.priority).toBe('normal');
  });

  it('setProcessingProfile creates and getProcessingConfig reads back', async () => {
    await setProcessingProfile('telegram', 'chat-42', {
      extractionStrategy: 'minimal',
      chunkSize: 2000,
      priority: 'high',
      entityExtraction: false,
    });

    const config = await getProcessingConfig('telegram', 'chat-42');
    expect(config.extractionStrategy).toBe('minimal');
    expect(config.chunkSize).toBe(2000);
    expect(config.priority).toBe('high');
    expect(config.entityExtraction).toBe(false);
    // Defaults still apply for unset fields
    expect(config.chunkingEnabled).toBe(true);
    expect(config.relationshipExtraction).toBe(true);
  });

  it('setProcessingProfile updates existing profile', async () => {
    await setProcessingProfile('telegram', 'chat-42', { priority: 'low' });
    await setProcessingProfile('telegram', 'chat-42', { priority: 'high' });

    const config = await getProcessingConfig('telegram', 'chat-42');
    expect(config.priority).toBe('high');

    // Should be one row, not two
    const rows = await testDb`SELECT * FROM channel_profiles WHERE source = 'telegram' AND channel_id = 'chat-42'`;
    expect(rows.length).toBe(1);
  });

  it('cache invalidation works on update', async () => {
    await setProcessingProfile('telegram', 'cache-test', { priority: 'low' });

    // First read populates cache
    const first = await getProcessingConfig('telegram', 'cache-test');
    expect(first.priority).toBe('low');

    // Update invalidates cache
    await setProcessingProfile('telegram', 'cache-test', { priority: 'high' });

    const second = await getProcessingConfig('telegram', 'cache-test');
    expect(second.priority).toBe('high');
  });

  it('listProfiles returns all configured profiles', async () => {
    await setProcessingProfile('telegram', 'ch-1', { priority: 'low' });
    await setProcessingProfile('obsidian', 'vault-1', { priority: 'high' });

    const profiles = await listProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(2);
  });
});
