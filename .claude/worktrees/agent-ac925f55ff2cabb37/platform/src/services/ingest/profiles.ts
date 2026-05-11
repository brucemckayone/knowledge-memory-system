/**
 * Processing Profiles Service (W43)
 *
 * Manages per-channel processing configuration.
 * Determines how content from each source/channel should be processed
 * (chunking, extraction, priority, etc.).
 */

import { db } from '../../db/index.js';
import { channelProfiles, type ChannelProfile } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';

export interface ProcessingConfig {
  extractionStrategy: string;
  chunkingEnabled: boolean;
  chunkSize: number;
  chunkOverlap: number;
  entityExtraction: boolean;
  relationshipExtraction: boolean;
  taskExtraction: boolean;
  priority: string;
  custom: Record<string, unknown>;
}

const DEFAULT_CONFIG: ProcessingConfig = {
  extractionStrategy: 'standard',
  chunkingEnabled: true,
  chunkSize: 4000,
  chunkOverlap: 200,
  entityExtraction: true,
  relationshipExtraction: true,
  taskExtraction: true,
  priority: 'normal',
  custom: {},
};

// In-memory cache with TTL
const cache = new Map<string, { config: ProcessingConfig; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(source: string, channelId: string): string {
  return `${source}:${channelId}`;
}

/**
 * Get the processing configuration for a source/channel pair.
 * Falls back to defaults if no profile is configured.
 */
export async function getProcessingConfig(
  source: string,
  channelId: string,
): Promise<ProcessingConfig> {
  const key = cacheKey(source, channelId);

  // Check cache
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  // Query DB
  try {
    const profile = await db
      .select()
      .from(channelProfiles)
      .where(and(
        eq(channelProfiles.source, source),
        eq(channelProfiles.channelId, channelId),
      ))
      .limit(1);

    if (profile.length > 0) {
      const p = profile[0]!;
      const config: ProcessingConfig = {
        extractionStrategy: p.extractionStrategy,
        chunkingEnabled: p.chunkingEnabled,
        chunkSize: p.chunkSize,
        chunkOverlap: p.chunkOverlap,
        entityExtraction: p.entityExtraction,
        relationshipExtraction: p.relationshipExtraction,
        taskExtraction: p.taskExtraction,
        priority: p.priority,
        custom: (p.config as Record<string, unknown>) || {},
      };

      cache.set(key, { config, expiresAt: Date.now() + CACHE_TTL_MS });
      return config;
    }
  } catch {
    // Table may not exist yet — return defaults
  }

  cache.set(key, { config: DEFAULT_CONFIG, expiresAt: Date.now() + CACHE_TTL_MS });
  return DEFAULT_CONFIG;
}

/**
 * Create or update a channel processing profile.
 */
export async function setProcessingProfile(
  source: string,
  channelId: string,
  config: Partial<ProcessingConfig>,
): Promise<void> {
  const existing = await db
    .select()
    .from(channelProfiles)
    .where(and(
      eq(channelProfiles.source, source),
      eq(channelProfiles.channelId, channelId),
    ))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(channelProfiles)
      .set({
        extractionStrategy: config.extractionStrategy,
        chunkingEnabled: config.chunkingEnabled,
        chunkSize: config.chunkSize,
        chunkOverlap: config.chunkOverlap,
        entityExtraction: config.entityExtraction,
        relationshipExtraction: config.relationshipExtraction,
        taskExtraction: config.taskExtraction,
        priority: config.priority,
        config: config.custom,
        updatedAt: new Date(),
      })
      .where(and(
        eq(channelProfiles.source, source),
        eq(channelProfiles.channelId, channelId),
      ));
  } else {
    await db.insert(channelProfiles).values({
      source,
      channelId,
      extractionStrategy: config.extractionStrategy || 'standard',
      chunkingEnabled: config.chunkingEnabled ?? true,
      chunkSize: config.chunkSize ?? 4000,
      chunkOverlap: config.chunkOverlap ?? 200,
      entityExtraction: config.entityExtraction ?? true,
      relationshipExtraction: config.relationshipExtraction ?? true,
      taskExtraction: config.taskExtraction ?? true,
      priority: config.priority || 'normal',
      config: config.custom || {},
    });
  }

  // Invalidate cache
  cache.delete(cacheKey(source, channelId));
}

/**
 * List all configured profiles.
 */
export async function listProfiles(): Promise<ChannelProfile[]> {
  return db.select().from(channelProfiles);
}

/**
 * Clear the profile cache (useful for testing).
 */
export function clearProfileCache(): void {
  cache.clear();
}
