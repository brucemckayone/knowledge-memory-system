/**
 * Unit Tests: Ingestion Context Service
 *
 * Tests for session key computation, session registration,
 * expiry queries, and cross-source grouping.
 */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import {
  computeSessionKey,
  registerInSession,
  getExpiredSessions,
  getExpiredSingleMemberSessions,
  getSessionMembers,
  closeSession,
  getSessionForMemory,
} from '../../services/ingestion-context.js';
import { db } from '../../db/index.js';
import { ingestionSessions } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { testDb, randomUUID } from '../setup.js';

describe('Ingestion Context Service', () => {
  const testSenderId = 'test-sender-ingestion';

  beforeEach(async () => {
    // Clean up test data
    try {
      await testDb.unsafe(`DELETE FROM ingestion_session_members`);
      await testDb.unsafe(`DELETE FROM ingestion_sessions`);
    } catch {
      // Tables may not exist yet
    }
  });

  afterAll(async () => {
    try {
      await testDb.unsafe(`DELETE FROM ingestion_session_members`);
      await testDb.unsafe(`DELETE FROM ingestion_sessions`);
    } catch {
      // Tables may not exist
    }
  });

  describe('computeSessionKey', () => {
    it('should produce deterministic keys for same sender and time bucket', () => {
      const ts1 = new Date('2026-03-13T10:00:00Z');
      const ts2 = new Date('2026-03-13T10:05:00Z');

      const key1 = computeSessionKey('user1', ts1, 15);
      const key2 = computeSessionKey('user1', ts2, 15);

      expect(key1).toBe(key2);
    });

    it('should produce different keys for different time windows', () => {
      const ts1 = new Date('2026-03-13T10:00:00Z');
      const ts2 = new Date('2026-03-13T10:20:00Z');

      const key1 = computeSessionKey('user1', ts1, 15);
      const key2 = computeSessionKey('user1', ts2, 15);

      expect(key1).not.toBe(key2);
    });

    it('should produce different keys for different senders', () => {
      const ts = new Date('2026-03-13T10:00:00Z');

      const key1 = computeSessionKey('user1', ts, 15);
      const key2 = computeSessionKey('user2', ts, 15);

      expect(key1).not.toBe(key2);
    });

    it('should group cross-source items in the same window', () => {
      // Same user, same time window, different "platforms" — key should match
      const ts = new Date('2026-03-13T10:03:00Z');

      const keyTelegram = computeSessionKey('user1', ts, 15);
      const keyFile = computeSessionKey('user1', ts, 15);

      expect(keyTelegram).toBe(keyFile);
    });

    it('should respect window size parameter', () => {
      const ts1 = new Date('2026-03-13T10:00:00Z');
      const ts2 = new Date('2026-03-13T10:06:00Z');

      // 5-minute window: these should be in different buckets
      const key1 = computeSessionKey('user1', ts1, 5);
      const key2 = computeSessionKey('user1', ts2, 5);

      expect(key1).not.toBe(key2);

      // 15-minute window: these should be in the same bucket
      const key3 = computeSessionKey('user1', ts1, 15);
      const key4 = computeSessionKey('user1', ts2, 15);

      expect(key3).toBe(key4);
    });
  });

  describe('registerInSession', () => {
    it('should create a new session for the first item', async () => {
      const memoryId = randomUUID();

      const sessionId = await registerInSession({
        memoryId,
        senderId: testSenderId,
        platform: 'telegram',
        rawType: 'text',
        contentPreview: 'Test message',
        timestamp: new Date(),
      });

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');

      // Verify session was created
      const [session] = await db
        .select()
        .from(ingestionSessions)
        .where(eq(ingestionSessions.id, sessionId))
        .limit(1);

      expect(session).toBeDefined();
      expect(session?.memberCount).toBe(1);
      expect(session?.rawTypes).toContain('text');
      expect(session?.platforms).toContain('telegram');
    });

    it('should increment member_count on upsert', async () => {
      const memoryId1 = randomUUID();
      const memoryId2 = randomUUID();
      const now = new Date();

      const sessionId1 = await registerInSession({
        memoryId: memoryId1,
        senderId: testSenderId,
        platform: 'telegram',
        rawType: 'text',
        contentPreview: 'First message',
        timestamp: now,
      });

      const sessionId2 = await registerInSession({
        memoryId: memoryId2,
        senderId: testSenderId,
        platform: 'telegram',
        rawType: 'voice',
        contentPreview: 'Second message',
        timestamp: new Date(now.getTime() + 60000), // 1 min later, same window
      });

      expect(sessionId1).toBe(sessionId2);

      const [session] = await db
        .select()
        .from(ingestionSessions)
        .where(eq(ingestionSessions.id, sessionId1))
        .limit(1);

      expect(session?.memberCount).toBe(2);
      expect(session?.rawTypes).toContain('text');
      expect(session?.rawTypes).toContain('voice');
    });

    it('should append unique platforms only', async () => {
      const now = new Date();

      await registerInSession({
        memoryId: randomUUID(),
        senderId: testSenderId,
        platform: 'telegram',
        rawType: 'text',
        contentPreview: 'First',
        timestamp: now,
      });

      const sessionId = await registerInSession({
        memoryId: randomUUID(),
        senderId: testSenderId,
        platform: 'telegram',
        rawType: 'text',
        contentPreview: 'Second',
        timestamp: new Date(now.getTime() + 60000),
      });

      const [session] = await db
        .select()
        .from(ingestionSessions)
        .where(eq(ingestionSessions.id, sessionId))
        .limit(1);

      // Should not duplicate 'telegram'
      const telegramCount = session?.platforms.filter(p => p === 'telegram').length ?? 0;
      expect(telegramCount).toBe(1);
    });

    it('should insert session member record', async () => {
      const memoryId = randomUUID();

      const sessionId = await registerInSession({
        memoryId,
        senderId: testSenderId,
        platform: 'telegram',
        rawType: 'text',
        contentPreview: 'Test content',
        timestamp: new Date(),
      });

      const members = await getSessionMembers(sessionId);
      expect(members).toHaveLength(1);
      expect(members[0]!.memoryId).toBe(memoryId);
      expect(members[0]!.platform).toBe('telegram');
      expect(members[0]!.rawType).toBe('text');
    });
  });

  describe('getExpiredSessions', () => {
    it('should return sessions older than window with 2+ members', async () => {
      const pastTime = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes ago

      // Create a session with 2 members in the past
      await registerInSession({
        memoryId: randomUUID(),
        senderId: testSenderId,
        platform: 'telegram',
        rawType: 'text',
        contentPreview: 'Old message 1',
        timestamp: pastTime,
      });

      await registerInSession({
        memoryId: randomUUID(),
        senderId: testSenderId,
        platform: 'telegram',
        rawType: 'voice',
        contentPreview: 'Old message 2',
        timestamp: new Date(pastTime.getTime() + 60000),
      });

      const expired = await getExpiredSessions(15);

      expect(expired.length).toBeGreaterThanOrEqual(1);
      expect(expired[0]!.memberCount).toBeGreaterThanOrEqual(2);
    });

    it('should not return recent sessions', async () => {
      const recentTime = new Date(); // Now

      await registerInSession({
        memoryId: randomUUID(),
        senderId: testSenderId + '-recent',
        platform: 'telegram',
        rawType: 'text',
        contentPreview: 'Recent message 1',
        timestamp: recentTime,
      });

      await registerInSession({
        memoryId: randomUUID(),
        senderId: testSenderId + '-recent',
        platform: 'telegram',
        rawType: 'text',
        contentPreview: 'Recent message 2',
        timestamp: new Date(recentTime.getTime() + 60000),
      });

      const expired = await getExpiredSessions(15);
      const recentSessions = expired.filter(s => s.senderId === testSenderId + '-recent');

      expect(recentSessions).toHaveLength(0);
    });
  });

  describe('getExpiredSingleMemberSessions', () => {
    it('should return single-member sessions past the window', async () => {
      const pastTime = new Date(Date.now() - 20 * 60 * 1000);

      await registerInSession({
        memoryId: randomUUID(),
        senderId: testSenderId + '-single',
        platform: 'telegram',
        rawType: 'text',
        contentPreview: 'Lone message',
        timestamp: pastTime,
      });

      const singleIds = await getExpiredSingleMemberSessions(15);

      expect(singleIds.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('closeSession', () => {
    it('should set closed_at and store aggregates', async () => {
      const sessionId = await registerInSession({
        memoryId: randomUUID(),
        senderId: testSenderId,
        platform: 'telegram',
        rawType: 'text',
        contentPreview: 'Test',
        timestamp: new Date(),
      });

      const entityUuid = randomUUID();
      await closeSession(sessionId, 'Test summary', [entityUuid], ['tag1', 'tag2']);

      const [session] = await db
        .select()
        .from(ingestionSessions)
        .where(eq(ingestionSessions.id, sessionId))
        .limit(1);

      expect(session?.closedAt).toBeDefined();
      expect(session?.contextSummary).toBe('Test summary');
      expect(session?.sharedTags).toContain('tag1');
      expect(session?.sharedTags).toContain('tag2');
    });
  });

  describe('getSessionForMemory', () => {
    it('should return the session ID for a registered memory', async () => {
      const memoryId = randomUUID();

      const sessionId = await registerInSession({
        memoryId,
        senderId: testSenderId,
        platform: 'telegram',
        rawType: 'text',
        contentPreview: 'Lookup test',
        timestamp: new Date(),
      });

      const foundSessionId = await getSessionForMemory(memoryId);
      expect(foundSessionId).toBe(sessionId);
    });

    it('should return null for unknown memory', async () => {
      const result = await getSessionForMemory(randomUUID());
      expect(result).toBeNull();
    });
  });
});
