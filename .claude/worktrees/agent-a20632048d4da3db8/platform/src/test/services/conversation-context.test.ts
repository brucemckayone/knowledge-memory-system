/**
 * Conversation Context Service Tests (W44)
 *
 * Tests adaptive conversation windows: opening, extending,
 * closing on idle timeout, and summary generation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, deleteFromTables } from '../setup.js';
import {
  recordMessage,
  getActiveConversation,
  closeStaleConversations,
} from '../../services/conversation-context.js';

describe('Conversation Context Service', () => {
  beforeEach(async () => {
    await deleteFromTables('conversation_summaries', 'conversation_state');
  });

  describe('recordMessage', () => {
    it('opens a new window on first message', async () => {
      const result = await recordMessage('telegram', 'chat-1', 'Hello');

      expect(result.conversationId).toBeDefined();
      expect(result.isNewWindow).toBe(true);

      const conv = await getActiveConversation('telegram', 'chat-1');
      expect(conv).not.toBeNull();
      expect(conv!.messageCount).toBe(1);
      expect(conv!.active).toBe(true);
    });

    it('extends existing window on subsequent messages', async () => {
      const first = await recordMessage('telegram', 'chat-2', 'First');
      const second = await recordMessage('telegram', 'chat-2', 'Second');

      expect(second.conversationId).toBe(first.conversationId);
      expect(second.isNewWindow).toBe(false);

      const conv = await getActiveConversation('telegram', 'chat-2');
      expect(conv!.messageCount).toBe(2);
    });

    it('opens new window after idle timeout', async () => {
      // Create a conversation and backdate its last_activity_at past the 30min threshold
      const first = await recordMessage('telegram', 'chat-3', 'Old message');

      // Manually set last_activity_at to 31 minutes ago
      const oldTime = new Date(Date.now() - 31 * 60 * 1000);
      await testDb`
        UPDATE conversation_state
        SET last_activity_at = ${oldTime}
        WHERE id = ${first.conversationId}::uuid
      `;

      const second = await recordMessage('telegram', 'chat-3', 'New message');
      expect(second.isNewWindow).toBe(true);
      expect(second.conversationId).not.toBe(first.conversationId);

      // Old conversation should be closed with a summary
      const summaries = await testDb`
        SELECT * FROM conversation_summaries
        WHERE conversation_state_id = ${first.conversationId}::uuid
      `;
      expect(summaries.length).toBe(1);
      expect(summaries[0]!.summary).toBeTruthy();
    });

    it('isolates channels — different channels get different windows', async () => {
      const a = await recordMessage('telegram', 'chat-A', 'Hello A');
      const b = await recordMessage('telegram', 'chat-B', 'Hello B');

      expect(a.conversationId).not.toBe(b.conversationId);
    });
  });

  describe('getActiveConversation', () => {
    it('returns null for unknown channel', async () => {
      const result = await getActiveConversation('telegram', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('closeStaleConversations', () => {
    it('closes conversations past idle timeout', async () => {
      const { conversationId } = await recordMessage('telegram', 'stale-ch', 'Stale msg');

      // Backdate past the 30min threshold
      const oldTime = new Date(Date.now() - 31 * 60 * 1000);
      await testDb`
        UPDATE conversation_state
        SET last_activity_at = ${oldTime}
        WHERE id = ${conversationId}::uuid
      `;

      const closed = await closeStaleConversations();
      expect(closed).toBeGreaterThanOrEqual(1);

      const conv = await getActiveConversation('telegram', 'stale-ch');
      expect(conv).toBeNull();
    });

    it('does not close recent conversations', async () => {
      await recordMessage('telegram', 'recent-ch', 'Recent msg');

      await closeStaleConversations();
      // Our recent conversation should NOT be closed
      const conv = await getActiveConversation('telegram', 'recent-ch');
      expect(conv).not.toBeNull();
    });
  });
});
