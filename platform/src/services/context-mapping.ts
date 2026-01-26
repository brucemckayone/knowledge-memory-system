import { db } from '../db/index.js';
import { contextSummaries, contextUuidAudit } from '../db/schema.js';
import { getContextUUID } from '../utils/context-uuid.js';
import { sql } from 'drizzle-orm';

/**
 * Ensure a context mapping exists for the given platform and conversation.
 *
 * This function:
 * 1. Generates a deterministic UUID from platform:conversationId
 * 2. Records/updates the UUID in the audit table (for drift detection)
 * 3. Ensures a context_summaries row exists (for foreign key relationships)
 *
 * @param platform - The platform identifier (e.g., 'telegram', 'discord')
 * @param conversationId - The platform-specific conversation identifier
 * @param conversationName - Optional human-readable name for the conversation
 * @returns The deterministic context UUID
 */
export async function ensureContextMapping(
  platform: string,
  conversationId: string,
  conversationName?: string
): Promise<string> {
  const contextUUID = getContextUUID(platform, conversationId);

  // Upsert audit record (always track usage for drift detection)
  await db
    .insert(contextUuidAudit)
    .values({
      contextUuid: contextUUID,
      platform,
      conversationId,
    })
    .onConflictDoUpdate({
      target: contextUuidAudit.contextUuid,
      set: { lastSeenAt: sql`NOW()` },
    });

  // Upsert context summary with deterministic UUID
  // Uses onConflictDoNothing since we just need the row to exist
  await db
    .insert(contextSummaries)
    .values({
      id: contextUUID,
      platform,
      conversationId,
      name: conversationName,
    })
    .onConflictDoNothing();

  return contextUUID;
}

/**
 * Lookup the source platform and conversation ID for a context UUID.
 *
 * Useful for debugging and reverse lookups.
 *
 * @param contextUuid - The context UUID to look up
 * @returns The platform and conversationId, or null if not found
 */
export async function lookupContextSource(
  contextUuid: string
): Promise<{ platform: string; conversationId: string } | null> {
  const [result] = await db
    .select({
      platform: contextUuidAudit.platform,
      conversationId: contextUuidAudit.conversationId,
    })
    .from(contextUuidAudit)
    .where(sql`${contextUuidAudit.contextUuid} = ${contextUuid}`)
    .limit(1);

  return result ?? null;
}
