/**
 * Ingestion Context Service
 *
 * Manages ingestion sessions that group temporally-close items from the same user.
 * Sessions enable the context-linker KARMA agent to detect cross-item relationships,
 * enrich embeddings, and create knowledge graph connections.
 */

import { db } from '../db/index.js';
import { ingestionSessions, ingestionSessionMembers } from '../db/schema.js';
import { config } from '../config.js';
import { sql, eq, and, isNull, lte } from 'drizzle-orm';

/**
 * Compute a deterministic session key from sender ID and timestamp.
 * Messages in the same time bucket get the same key, enabling cross-source grouping.
 */
export function computeSessionKey(
  senderId: string,
  timestamp: Date,
  windowMinutes: number,
): string {
  const windowMs = windowMinutes * 60 * 1000;
  const bucket = Math.floor(timestamp.getTime() / windowMs);
  return `${senderId}:${bucket}`;
}

interface RegisterParams {
  memoryId: string;
  senderId: string;
  platform: string;
  rawType: string;
  contentPreview: string;
  timestamp: Date;
}

/**
 * Register a memory in an ingestion session.
 * Upserts the session and inserts the member in a single transaction.
 */
export async function registerInSession(params: RegisterParams): Promise<string> {
  const windowMinutes = config.INGESTION_SESSION_WINDOW_MINUTES;
  const sessionKey = computeSessionKey(params.senderId, params.timestamp, windowMinutes);

  const result = await db.execute(sql`
    INSERT INTO ingestion_sessions (sender_id, session_key, opened_at, member_count, raw_types, platforms)
    VALUES (
      ${params.senderId},
      ${sessionKey},
      ${params.timestamp.toISOString()}::timestamptz,
      1,
      ARRAY[${params.rawType}]::text[],
      ARRAY[${params.platform}]::text[]
    )
    ON CONFLICT (session_key) DO UPDATE SET
      member_count = ingestion_sessions.member_count + 1,
      raw_types = CASE
        WHEN ${params.rawType} = ANY(ingestion_sessions.raw_types) THEN ingestion_sessions.raw_types
        ELSE array_append(ingestion_sessions.raw_types, ${params.rawType})
      END,
      platforms = CASE
        WHEN ${params.platform} = ANY(ingestion_sessions.platforms) THEN ingestion_sessions.platforms
        ELSE array_append(ingestion_sessions.platforms, ${params.platform})
      END,
      updated_at = NOW()
    RETURNING id
  `);

  // Drizzle + postgres-js returns either { rows: [...] } or array-like result
  const rawResult = result as unknown as { rows?: Array<{ id: string }> } & Array<{ id: string }>;
  const rows = rawResult.rows ?? rawResult;
  const sessionId = rows[0]?.id;
  if (!sessionId) {
    throw new Error('Failed to upsert ingestion session');
  }

  await db.insert(ingestionSessionMembers).values({
    sessionId,
    memoryId: params.memoryId,
    platform: params.platform,
    rawType: params.rawType,
    contentPreview: params.contentPreview,
    ingestedAt: params.timestamp,
  });

  return sessionId;
}

export interface ExpiredSession {
  id: string;
  senderId: string;
  sessionKey: string;
  openedAt: Date;
  memberCount: number;
  rawTypes: string[];
  platforms: string[];
}

/**
 * Find open sessions that have expired (older than the window) with 2+ members.
 * These are ready for the context-linker agent to process.
 */
export async function getExpiredSessions(windowMinutes: number): Promise<ExpiredSession[]> {
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000);

  const rows = await db
    .select()
    .from(ingestionSessions)
    .where(
      and(
        isNull(ingestionSessions.closedAt),
        lte(ingestionSessions.openedAt, cutoff),
      ),
    );

  return rows
    .filter(r => r.memberCount >= 2)
    .map(r => ({
      id: r.id,
      senderId: r.senderId,
      sessionKey: r.sessionKey,
      openedAt: r.openedAt,
      memberCount: r.memberCount,
      rawTypes: r.rawTypes,
      platforms: r.platforms,
    }));
}

/**
 * Find open sessions that have expired with fewer than 2 members (for cleanup).
 */
export async function getExpiredSingleMemberSessions(windowMinutes: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000);

  const rows = await db
    .select({ id: ingestionSessions.id, memberCount: ingestionSessions.memberCount })
    .from(ingestionSessions)
    .where(
      and(
        isNull(ingestionSessions.closedAt),
        lte(ingestionSessions.openedAt, cutoff),
      ),
    );

  return rows
    .filter(r => r.memberCount < 2)
    .map(r => r.id);
}

export interface SessionMember {
  id: string;
  memoryId: string;
  platform: string;
  rawType: string;
  contentPreview: string | null;
  ingestedAt: Date;
}

/**
 * Fetch all members of a session.
 */
export async function getSessionMembers(sessionId: string): Promise<SessionMember[]> {
  const rows = await db
    .select()
    .from(ingestionSessionMembers)
    .where(eq(ingestionSessionMembers.sessionId, sessionId));

  return rows.map(r => ({
    id: r.id,
    memoryId: r.memoryId,
    platform: r.platform,
    rawType: r.rawType,
    contentPreview: r.contentPreview,
    ingestedAt: r.ingestedAt,
  }));
}

/**
 * Close a session after context-linker processing.
 */
export async function closeSession(
  sessionId: string,
  summary?: string,
  sharedEntities?: string[],
  sharedTags?: string[],
): Promise<void> {
  await db
    .update(ingestionSessions)
    .set({
      closedAt: new Date(),
      contextSummary: summary ?? null,
      sharedEntities: sharedEntities ?? [],
      sharedTags: sharedTags ?? [],
      updatedAt: new Date(),
    })
    .where(eq(ingestionSessions.id, sessionId));
}

/**
 * Look up which session a memory belongs to.
 */
export async function getSessionForMemory(memoryId: string): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: ingestionSessionMembers.sessionId })
    .from(ingestionSessionMembers)
    .where(eq(ingestionSessionMembers.memoryId, memoryId))
    .limit(1);

  return row?.sessionId ?? null;
}
