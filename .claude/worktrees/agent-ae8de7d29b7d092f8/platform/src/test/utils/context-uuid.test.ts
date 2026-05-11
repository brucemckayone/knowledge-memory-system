/**
 * Context UUID Utility Tests
 *
 * Tests deterministic UUID v5 generation from platform:conversation_id.
 * These are pure unit tests - no database or external services required.
 */

import { describe, it, expect } from 'vitest';
import { getContextUUID, createContextIdentifier } from '../../utils/context-uuid.js';

describe('Context UUID Generation', () => {
  describe('Determinism', () => {
    it('produces consistent UUIDs for the same input', () => {
      const uuid1 = getContextUUID('telegram', '12345');
      const uuid2 = getContextUUID('telegram', '12345');

      expect(uuid1).toBe(uuid2);
    });

    it('produces different UUIDs for different platforms', () => {
      const telegramUuid = getContextUUID('telegram', '12345');
      const discordUuid = getContextUUID('discord', '12345');

      expect(telegramUuid).not.toBe(discordUuid);
    });

    it('produces different UUIDs for different conversation IDs', () => {
      const uuid1 = getContextUUID('telegram', '12345');
      const uuid2 = getContextUUID('telegram', '67890');

      expect(uuid1).not.toBe(uuid2);
    });

    it('is case-sensitive for platform names', () => {
      const lower = getContextUUID('telegram', '12345');
      const upper = getContextUUID('TELEGRAM', '12345');

      expect(lower).not.toBe(upper);
    });
  });

  describe('UUID v5 Format Compliance', () => {
    it('produces valid UUID format', () => {
      const uuid = getContextUUID('telegram', '12345');

      // Standard UUID format: 8-4-4-4-12 hex chars
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(uuid).toMatch(uuidRegex);
    });

    it('has correct version nibble (5)', () => {
      const uuid = getContextUUID('telegram', '12345');

      // Version is the first nibble of the 3rd group
      // Format: xxxxxxxx-xxxx-Vxxx-xxxx-xxxxxxxxxxxx where V is version
      const versionChar = uuid.charAt(14);
      expect(versionChar).toBe('5');
    });

    it('has correct variant bits (RFC 4122)', () => {
      const uuid = getContextUUID('telegram', '12345');

      // Variant is the first nibble of the 4th group
      // RFC 4122 variant has pattern 10xx, so first char should be 8, 9, a, or b
      const variantChar = uuid.charAt(19);
      expect(['8', '9', 'a', 'b']).toContain(variantChar);
    });

    it('produces valid format for various input types', () => {
      const testCases = [
        { platform: 'telegram', conversationId: '123' },
        { platform: 'discord', conversationId: 'guild_123_channel_456' },
        { platform: 'slack', conversationId: 'C0123456789' },
        { platform: 'email', conversationId: 'thread:abc@example.com:12345' },
        { platform: 'web', conversationId: 'session-uuid-here' },
      ];

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

      for (const { platform, conversationId } of testCases) {
        const uuid = getContextUUID(platform, conversationId);
        expect(uuid).toMatch(uuidRegex);
      }
    });
  });

  describe('createContextIdentifier', () => {
    it('returns complete identifier with all fields', () => {
      const result = createContextIdentifier('telegram', '12345');

      expect(result.platform).toBe('telegram');
      expect(result.conversationId).toBe('12345');
      expect(result.uuid).toBe(getContextUUID('telegram', '12345'));
    });

    it('uuid matches direct getContextUUID call', () => {
      const identifier = createContextIdentifier('discord', 'abc123');
      const directUuid = getContextUUID('discord', 'abc123');

      expect(identifier.uuid).toBe(directUuid);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty conversation ID', () => {
      const uuid = getContextUUID('telegram', '');

      // Should still produce valid UUID
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('handles very long conversation ID', () => {
      const longId = 'x'.repeat(1000);
      const uuid = getContextUUID('telegram', longId);

      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('handles special characters in conversation ID', () => {
      const uuid = getContextUUID('telegram', '!@#$%^&*()_+-=[]{}|;:,.<>?');

      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('handles unicode in platform and conversation ID', () => {
      const uuid = getContextUUID('telegram', '');

      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });
});
