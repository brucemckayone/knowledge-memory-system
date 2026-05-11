/**
 * Conversation Context Service (W44)
 *
 * Manages adaptive conversation windows for stream-type sources.
 * Tracks ongoing conversations, detects topic drift, and generates
 * rollup summaries when windows close.
 */

import { db } from '../db/index.js';
import { conversationState, conversationSummaries } from '../db/schema.js';
import { and, eq, sql } from 'drizzle-orm';
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_WINDOW_MESSAGES = 100;

/**
 * Record a new message in the conversation context.
 * Opens a new window if needed, or extends the existing one.
 */
export async function recordMessage(
  source: string,
  channelId: string,
  _content: string,
): Promise<{ conversationId: string; isNewWindow: boolean }> {
  // Find active conversation for this channel
  const active = await db
    .select()
    .from(conversationState)
    .where(and(
      eq(conversationState.source, source),
      eq(conversationState.channelId, channelId),
      eq(conversationState.active, true),
    ))
    .limit(1);

  const now = new Date();

  if (active.length > 0) {
    const conv = active[0]!;

    // Check if window should close (idle timeout or max messages)
    const idleTime = now.getTime() - conv.lastActivityAt.getTime();
    if (idleTime > IDLE_TIMEOUT_MS || conv.messageCount >= MAX_WINDOW_MESSAGES) {
      // Close current window
      await closeWindow(conv.id);
      // Open new one below
    } else {
      // Extend current window
      await db
        .update(conversationState)
        .set({
          messageCount: conv.messageCount + 1,
          lastActivityAt: now,
          updatedAt: now,
        })
        .where(eq(conversationState.id, conv.id));

      return { conversationId: conv.id, isNewWindow: false };
    }
  }

  // Open new window
  const result = await db
    .insert(conversationState)
    .values({
      source,
      channelId,
      messageCount: 1,
      windowStart: now,
      lastActivityAt: now,
      active: true,
    })
    .returning({ id: conversationState.id });

  return { conversationId: result[0]!.id, isNewWindow: true };
}

/**
 * Close a conversation window and generate a summary.
 */
async function closeWindow(conversationId: string): Promise<void> {
  const now = new Date();

  // Mark as closed
  await db
    .update(conversationState)
    .set({
      active: false,
      windowEnd: now,
      updatedAt: now,
    })
    .where(eq(conversationState.id, conversationId));

  // Generate summary (best-effort)
  try {
    const conv = await db
      .select()
      .from(conversationState)
      .where(eq(conversationState.id, conversationId))
      .limit(1);

    if (conv.length > 0) {
      const c = conv[0]!;
      const durationMin = Math.round(
        (now.getTime() - c.windowStart.getTime()) / 60_000
      );

      const summaryText = `Conversation in ${c.source}/${c.channelId}: ${c.messageCount} messages over ${durationMin} minutes.`;

      await db.insert(conversationSummaries).values({
        conversationStateId: conversationId,
        summary: summaryText,
        keyTopics: [],
        participantCount: 1,
        messageCount: c.messageCount,
      });
    }
  } catch (error) {
    console.warn('Failed to generate conversation summary:', error);
  }
}

/**
 * Get active conversations for a source/channel.
 */
export async function getActiveConversation(source: string, channelId: string) {
  const result = await db
    .select()
    .from(conversationState)
    .where(and(
      eq(conversationState.source, source),
      eq(conversationState.channelId, channelId),
      eq(conversationState.active, true),
    ))
    .limit(1);

  return result[0] || null;
}

/**
 * Close all stale conversations (idle > timeout).
 */
export async function closeStaleConversations(): Promise<number> {
  const cutoff = new Date(Date.now() - IDLE_TIMEOUT_MS);

  const stale = await db
    .select({ id: conversationState.id })
    .from(conversationState)
    .where(and(
      eq(conversationState.active, true),
      sql`${conversationState.lastActivityAt} < ${cutoff}`,
    ));

  for (const conv of stale) {
    await closeWindow(conv.id);
  }

  return stale.length;
}
