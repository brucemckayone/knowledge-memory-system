/**
 * Unit Tests: Context-Linker KARMA Agent
 *
 * Tests the context-linker agent with mocked dependencies.
 * Verifies session processing, context summary generation,
 * re-embedding, cross-linking, and fact creation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentContext, JobResult } from '../../gardener/controller.js';

// Mock all external dependencies before importing the agent
vi.mock('../../services/ingestion-context.js', () => ({
  getExpiredSessions: vi.fn(),
  getExpiredSingleMemberSessions: vi.fn(),
  getSessionMembers: vi.fn(),
  closeSession: vi.fn(),
}));

vi.mock('../../services/qdrant.js', () => ({
  getMemory: vi.fn(),
  updateVector: vi.fn(),
  updatePayload: vi.fn(),
}));

vi.mock('../../services/entities.js', () => ({
  getMemoryEntities: vi.fn(),
}));

vi.mock('../../services/facts.js', () => ({
  createFact: vi.fn(),
}));

vi.mock('../../services/ml-client.js', () => ({
  ml: {
    chat: vi.fn(),
    embed: vi.fn(),
  },
}));

vi.mock('../../config.js', () => ({
  config: {
    INGESTION_SESSION_WINDOW_MINUTES: 15,
  },
}));

import { contextLinkerAgent } from '../../gardener/agents/context-linker.agent.js';
import {
  getExpiredSessions,
  getExpiredSingleMemberSessions,
  getSessionMembers,
  closeSession,
} from '../../services/ingestion-context.js';
import { getMemory, updateVector, updatePayload } from '../../services/qdrant.js';
import { getMemoryEntities } from '../../services/entities.js';
import { createFact } from '../../services/facts.js';
import { ml } from '../../services/ml-client.js';

function createMockContext(): AgentContext {
  return {
    job: { id: 'test-job-id', data: {} } as any,
    log: vi.fn(),
    checkpoint: vi.fn(),
    restoreCheckpoint: vi.fn(),
    traceId: null,
    config: {} as any,
    services: { ml: {} as any, controller: {} as any },
    signal: AbortSignal.timeout(30000),
  };
}

describe('Context-Linker Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have correct name and tier', () => {
    expect(contextLinkerAgent.name).toBe('context-linker');
    expect(contextLinkerAgent.tier).toBe('frequent');
  });

  it('should return success with no sessions to process', async () => {
    vi.mocked(getExpiredSessions).mockResolvedValue([]);
    vi.mocked(getExpiredSingleMemberSessions).mockResolvedValue([]);

    const ctx = createMockContext();
    const result = await contextLinkerAgent.execute(ctx);

    expect(result.success).toBe(true);
    expect(result.metrics?.itemsProcessed).toBe(0);
  });

  it('should close single-member sessions without enrichment', async () => {
    vi.mocked(getExpiredSingleMemberSessions).mockResolvedValue(['session-1', 'session-2']);
    vi.mocked(getExpiredSessions).mockResolvedValue([]);

    const ctx = createMockContext();
    const result = await contextLinkerAgent.execute(ctx);

    expect(result.success).toBe(true);
    expect(closeSession).toHaveBeenCalledWith('session-1');
    expect(closeSession).toHaveBeenCalledWith('session-2');
    // No ML calls for single-member sessions
    expect(ml.chat).not.toHaveBeenCalled();
    expect(ml.embed).not.toHaveBeenCalled();
  });

  it('should process multi-member sessions with context enrichment', async () => {
    const memoryId1 = 'mem-1111-1111-1111-111111111111';
    const memoryId2 = 'mem-2222-2222-2222-222222222222';
    const sessionId = 'sess-1111-1111-1111-111111111111';
    const entityId = 'ent-1111-1111-1111-111111111111';

    vi.mocked(getExpiredSingleMemberSessions).mockResolvedValue([]);
    vi.mocked(getExpiredSessions).mockResolvedValue([{
      id: sessionId,
      senderId: 'user1',
      sessionKey: 'user1:12345',
      openedAt: new Date(),
      memberCount: 2,
      rawTypes: ['text', 'link'],
      platforms: ['telegram'],
    }]);

    vi.mocked(getSessionMembers).mockResolvedValue([
      { id: 'sm-1', memoryId: memoryId1, platform: 'telegram', rawType: 'text', contentPreview: 'Meeting notes', ingestedAt: new Date() },
      { id: 'sm-2', memoryId: memoryId2, platform: 'telegram', rawType: 'link', contentPreview: 'Related article', ingestedAt: new Date() },
    ]);

    vi.mocked(getMemory).mockImplementation(async (id: string) => ({
      id,
      payload: {
        content: id === memoryId1 ? 'Meeting notes about project X' : 'Article about project X trends',
        tags: id === memoryId1 ? ['meeting'] : ['article'],
      },
    } as any));

    vi.mocked(getMemoryEntities).mockImplementation(async (memId: string) => {
      // Both memories share entity "Project X"
      return [{ id: entityId, canonicalName: 'Project X', entityType: 'project' }] as any;
    });

    vi.mocked(ml.chat).mockResolvedValue({
      response: 'Both items relate to Project X — meeting notes and a related article captured together.',
    } as any);

    vi.mocked(ml.embed).mockResolvedValue({
      vector: Array(768).fill(0.1),
      model: 'test-model',
      dimensions: 768,
    } as any);

    vi.mocked(createFact).mockResolvedValue('fact-1');

    const ctx = createMockContext();
    const result = await contextLinkerAgent.execute(ctx);

    expect(result.success).toBe(true);

    // Should have generated context summary
    expect(ml.chat).toHaveBeenCalledOnce();

    // Should have re-embedded both members
    expect(ml.embed).toHaveBeenCalledTimes(2);

    // Should have updated vectors for both members
    expect(updateVector).toHaveBeenCalledTimes(2);

    // Should have updated payloads with cross-links
    expect(updatePayload).toHaveBeenCalledTimes(2);

    // Verify related_to contains the other memory
    const payload1Call = vi.mocked(updatePayload).mock.calls.find(c => c[0] === memoryId1);
    expect(payload1Call?.[1].related_to).toContain(memoryId2);

    const payload2Call = vi.mocked(updatePayload).mock.calls.find(c => c[0] === memoryId2);
    expect(payload2Call?.[1].related_to).toContain(memoryId1);

    // Should have set ingestion_session_id
    expect(payload1Call?.[1].ingestion_session_id).toBe(sessionId);

    // Should have propagated shared tags
    expect(payload1Call?.[1].tags).toContain('meeting');
    expect(payload1Call?.[1].tags).toContain('article');

    // Should have created CO_TEMPORAL fact (1 pair = 1 fact)
    expect(createFact).toHaveBeenCalledOnce();
    expect(createFact).toHaveBeenCalledWith(expect.objectContaining({
      subjectEntityId: entityId,
      predicate: 'CO_TEMPORAL',
      extractionMethod: 'context_linker_agent',
    }));

    // Should have closed the session with summary
    expect(closeSession).toHaveBeenCalledWith(
      sessionId,
      expect.stringContaining('Project X'),
      [entityId],
      expect.arrayContaining(['meeting', 'article']),
    );
  });

  it('should handle LLM failure with fallback summary', async () => {
    const memoryId1 = 'mem-3333-3333-3333-333333333333';
    const memoryId2 = 'mem-4444-4444-4444-444444444444';
    const sessionId = 'sess-2222-2222-2222-222222222222';

    vi.mocked(getExpiredSingleMemberSessions).mockResolvedValue([]);
    vi.mocked(getExpiredSessions).mockResolvedValue([{
      id: sessionId,
      senderId: 'user1',
      sessionKey: 'user1:99999',
      openedAt: new Date(),
      memberCount: 2,
      rawTypes: ['text'],
      platforms: ['telegram'],
    }]);

    vi.mocked(getSessionMembers).mockResolvedValue([
      { id: 'sm-3', memoryId: memoryId1, platform: 'telegram', rawType: 'text', contentPreview: 'Msg A', ingestedAt: new Date() },
      { id: 'sm-4', memoryId: memoryId2, platform: 'telegram', rawType: 'text', contentPreview: 'Msg B', ingestedAt: new Date() },
    ]);

    vi.mocked(getMemory).mockResolvedValue({
      id: 'test',
      payload: { content: 'Some content', tags: [] },
    } as any);

    vi.mocked(getMemoryEntities).mockResolvedValue([]);

    // LLM fails
    vi.mocked(ml.chat).mockRejectedValue(new Error('LLM unavailable'));

    vi.mocked(ml.embed).mockResolvedValue({
      vector: Array(768).fill(0.1),
      model: 'test-model',
      dimensions: 768,
    } as any);

    const ctx = createMockContext();
    const result = await contextLinkerAgent.execute(ctx);

    expect(result.success).toBe(true);

    // Should still close the session with fallback summary
    expect(closeSession).toHaveBeenCalledWith(
      sessionId,
      'Items captured in the same time window',
      [],
      expect.any(Array),
    );
  });

  it('should not create facts when no shared entities exist', async () => {
    const sessionId = 'sess-3333-3333-3333-333333333333';

    vi.mocked(getExpiredSingleMemberSessions).mockResolvedValue([]);
    vi.mocked(getExpiredSessions).mockResolvedValue([{
      id: sessionId,
      senderId: 'user1',
      sessionKey: 'user1:88888',
      openedAt: new Date(),
      memberCount: 2,
      rawTypes: ['text'],
      platforms: ['telegram'],
    }]);

    vi.mocked(getSessionMembers).mockResolvedValue([
      { id: 'sm-5', memoryId: 'mem-a', platform: 'telegram', rawType: 'text', contentPreview: 'Msg', ingestedAt: new Date() },
      { id: 'sm-6', memoryId: 'mem-b', platform: 'telegram', rawType: 'text', contentPreview: 'Msg', ingestedAt: new Date() },
    ]);

    vi.mocked(getMemory).mockResolvedValue({
      id: 'test',
      payload: { content: 'Content', tags: [] },
    } as any);

    // No shared entities
    vi.mocked(getMemoryEntities).mockResolvedValue([]);

    vi.mocked(ml.chat).mockResolvedValue({ response: 'Summary' } as any);
    vi.mocked(ml.embed).mockResolvedValue({
      vector: Array(768).fill(0.1),
      model: 'test',
      dimensions: 768,
    } as any);

    const ctx = createMockContext();
    await contextLinkerAgent.execute(ctx);

    // No facts should be created without shared entities
    expect(createFact).not.toHaveBeenCalled();
  });

  it('should create facts for all pairs with 3+ members', async () => {
    const sessionId = 'sess-4444-4444-4444-444444444444';
    const entityId = 'ent-shared';

    vi.mocked(getExpiredSingleMemberSessions).mockResolvedValue([]);
    vi.mocked(getExpiredSessions).mockResolvedValue([{
      id: sessionId,
      senderId: 'user1',
      sessionKey: 'user1:77777',
      openedAt: new Date(),
      memberCount: 3,
      rawTypes: ['text'],
      platforms: ['telegram'],
    }]);

    vi.mocked(getSessionMembers).mockResolvedValue([
      { id: 'sm-7', memoryId: 'mem-x', platform: 'telegram', rawType: 'text', contentPreview: 'X', ingestedAt: new Date() },
      { id: 'sm-8', memoryId: 'mem-y', platform: 'telegram', rawType: 'text', contentPreview: 'Y', ingestedAt: new Date() },
      { id: 'sm-9', memoryId: 'mem-z', platform: 'telegram', rawType: 'text', contentPreview: 'Z', ingestedAt: new Date() },
    ]);

    vi.mocked(getMemory).mockResolvedValue({
      id: 'test',
      payload: { content: 'Content', tags: [] },
    } as any);

    // All share one entity
    vi.mocked(getMemoryEntities).mockResolvedValue([
      { id: entityId, canonicalName: 'Shared', entityType: 'concept' },
    ] as any);

    vi.mocked(ml.chat).mockResolvedValue({ response: 'Summary' } as any);
    vi.mocked(ml.embed).mockResolvedValue({
      vector: Array(768).fill(0.1),
      model: 'test',
      dimensions: 768,
    } as any);
    vi.mocked(createFact).mockResolvedValue('fact-id');

    const ctx = createMockContext();
    await contextLinkerAgent.execute(ctx);

    // 3 members = 3 pairs (x-y, x-z, y-z)
    expect(createFact).toHaveBeenCalledTimes(3);
  });
});
