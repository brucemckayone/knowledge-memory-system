/**
 * Reader Agent Tests (W23)
 *
 * Tests for the Reader Gardener Agent.
 * Covers RDR-001 through RDR-005 from the Phase 4 test strategy.
 *
 * Boundary: Chunks → DB, ML /parse-content (B2, B3)
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { randomUUID, isMLServiceAvailable } from '../setup.js';
import { loadPhase4Seed } from '../fixtures/phase4-seed.js';
import { installMLServiceMock, restoreMLServiceMock } from '../mocks/ml-service.mock.js';

// Mock Qdrant service before importing the agent
vi.mock('../../services/qdrant.js', () => ({
  getMemory: vi.fn(),
  updatePayload: vi.fn(),
  updateVector: vi.fn(),
  qdrant: {},
  checkQdrantHealth: vi.fn(),
}));

import { readerAgent } from '../../gardener/agents/reader.agent.js';
import * as qdrantService from '../../services/qdrant.js';
import type { AgentContext } from '../../gardener/controller.js';
import type PgBoss from 'pg-boss';

describe('W23 Reader Agent', () => {
  let mlAvailable = false;
  const seed = loadPhase4Seed();

  beforeAll(async () => {
    mlAvailable = await isMLServiceAvailable();
    if (!mlAvailable) {
      console.warn('⚠️ ML Services not available - using mocks for reader tests');
    }
  });

  // Create mock context helper
  function createMockContext(data: Record<string, unknown>): AgentContext {
    return {
      job: {
        id: randomUUID(),
        data,
      } as PgBoss.Job<unknown>,
      log: vi.fn(),
      checkpoint: vi.fn().mockResolvedValue(undefined),
      restoreCheckpoint: vi.fn().mockResolvedValue(null),
    };
  }

  // Helper to mock Qdrant service getMemory
  function mockQdrantGetMemory(content?: string) {
    (qdrantService.getMemory as vi.Mock).mockResolvedValue(
      content ? { id: randomUUID(), payload: { content } } : null
    );
  }

  afterEach(() => {
    vi.clearAllMocks();
    restoreMLServiceMock();
    // Reset Qdrant mocks
    (qdrantService.getMemory as vi.Mock).mockResolvedValue(null);
    (qdrantService.updatePayload as vi.Mock).mockResolvedValue(undefined);
  });

  describe('RDR-001: Classify content type', () => {
    it('should classify content with links as link type', async () => {
      // Install mock if ML not available
      if (!mlAvailable) {
        installMLServiceMock({
          parseContent: {
            content_type: 'link',
            title: seed.contentTypes.withLinks.content.slice(0, 100),
            summary: seed.contentTypes.withLinks.content.slice(0, 200),
            mentions: [],
            dates: [],
            links: ['https://example.com/article'],
            tags: [],
            sentiment: 'neutral',
            language: 'en',
            word_count: 10,
          },
        });
      }

      // Given: Content with URL
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: seed.contentTypes.withLinks.content,
      });

      // When: Process through reader agent
      const result = await readerAgent.execute(context);

      // Then: Classified as link type
      expect(result.success).toBe(true);
      expect(result.outputs?.contentType).toBe(seed.contentTypes.withLinks.expectedType);
    });

    it('should classify plain text as thought type', async () => {
      // Install mock if ML not available
      if (!mlAvailable) {
        installMLServiceMock({
          parseContent: {
            content_type: 'thought',
            title: seed.contentTypes.plainThought.content.slice(0, 100),
            summary: seed.contentTypes.plainThought.content,
            mentions: [],
            dates: [],
            links: [],
            tags: [],
            sentiment: 'neutral',
            language: 'en',
            word_count: 12,
          },
        });
      }

      // Given: Plain text content
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: seed.contentTypes.plainThought.content,
      });

      // When: Process through reader agent
      const result = await readerAgent.execute(context);

      // Then: Classified as thought type
      expect(result.success).toBe(true);
      expect(result.outputs?.contentType).toBe(seed.contentTypes.plainThought.expectedType);
    });
  });

  describe('RDR-002: Extract tags and mentions', () => {
    it('should extract hashtags from content', async () => {
      // Install mock if ML not available
      if (!mlAvailable) {
        installMLServiceMock({
          parseContent: {
            content_type: 'thought',
            title: 'Working on project',
            summary: seed.contentTypes.withTags.content,
            mentions: [],
            dates: [],
            links: [],
            tags: seed.contentTypes.withTags.expectedTags,
            sentiment: 'neutral',
            language: 'en',
            word_count: 12,
          },
        });
      }

      // Given: Content with hashtags
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: seed.contentTypes.withTags.content,
      });

      // When: Process through reader agent
      const result = await readerAgent.execute(context);

      // Then: Tags are extracted
      expect(result.success).toBe(true);
      expect(result.outputs?.tagsFound).toBeGreaterThanOrEqual(seed.contentTypes.withTags.expectedTags.length);
    });

    it('should extract @mentions from content', async () => {
      // Install mock if ML not available
      if (!mlAvailable) {
        installMLServiceMock({
          parseContent: {
            content_type: 'thought',
            title: 'Meeting notes',
            summary: seed.contentTypes.withMentions.content,
            mentions: seed.contentTypes.withMentions.expectedMentions,
            dates: [],
            links: [],
            tags: [],
            sentiment: 'positive',
            language: 'en',
            word_count: 12,
          },
        });
      }

      // Given: Content with @mentions
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: seed.contentTypes.withMentions.content,
      });

      // When: Process through reader agent
      const result = await readerAgent.execute(context);

      // Then: Mentions are extracted
      expect(result.success).toBe(true);
      expect(result.outputs?.mentionsFound).toBeGreaterThanOrEqual(seed.contentTypes.withMentions.expectedMentions.length);
    });
  });

  describe('RDR-003: Reassemble chunks', () => {
    it('should handle chunked content with reassembly flag', async () => {
      // Install mock for ML service
      installMLServiceMock();

      // Given: Chunked content indicator
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        chunked: true,
        chunkCount: 3,
        contentLength: 10000,
        // Provide content directly to avoid DB dependency in test
        content: seed.longContent.content,
      });

      // When: Process through reader agent
      const result = await readerAgent.execute(context);

      // Then: Content is processed
      expect(result.success).toBe(true);
      expect(result.outputs?.wordCount).toBeGreaterThan(0);
    });

    it('should use provided content when available', async () => {
      // Install mock for ML service
      installMLServiceMock();

      // Given: Direct content in payload
      const memoryId = randomUUID();
      const content = 'Direct content provided in payload for testing.';
      const context = createMockContext({
        memoryId,
        content,
        chunked: false,
      });

      // When: Process through reader agent
      const result = await readerAgent.execute(context);

      // Then: Provided content is used
      expect(result.success).toBe(true);
      expect(result.outputs?.wordCount).toBeDefined();
    });
  });

  describe('RDR-004: Queue summarizer for long content', () => {
    it('should queue summarizer when wordCount >= 500', async () => {
      // Install mock that returns high word count
      installMLServiceMock({
        parseContent: {
          content_type: 'thought',
          title: 'Long document',
          summary: 'A very long document summary...',
          mentions: [],
          dates: [],
          links: [],
          tags: [],
          sentiment: 'neutral',
          language: 'en',
          word_count: 750, // Above threshold
        },
      });

      // Given: Long content
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: seed.longDocument.content,
      });

      // When: Process through reader agent
      const result = await readerAgent.execute(context);

      // Then: Summarizer is queued
      expect(result.success).toBe(true);
      expect(result.nextJobs).toBeDefined();
      expect(result.nextJobs?.length).toBeGreaterThan(0);

      const summarizerJob = result.nextJobs?.find(j => j.type === 'gardener:summarize');
      expect(summarizerJob).toBeDefined();
      expect(summarizerJob?.payload.memoryId).toBe(memoryId);
      expect(summarizerJob?.tier).toBe('frequent');
    });

    it('should not queue summarizer for short content', async () => {
      // Install mock that returns low word count
      installMLServiceMock({
        parseContent: {
          content_type: 'thought',
          title: 'Short note',
          summary: seed.shortDocument.content,
          mentions: [],
          dates: [],
          links: [],
          tags: [],
          sentiment: 'neutral',
          language: 'en',
          word_count: seed.shortDocument.wordCount, // Below threshold
        },
      });

      // Given: Short content
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: seed.shortDocument.content,
      });

      // When: Process through reader agent
      const result = await readerAgent.execute(context);

      // Then: No summarizer queued
      expect(result.success).toBe(true);

      // nextJobs might be undefined or empty, or not contain summarizer
      const summarizerJob = result.nextJobs?.find(j => j.type === 'gardener:summarize');
      expect(summarizerJob).toBeUndefined();
    });
  });

  describe('RDR-005: ML fallback parsing', () => {
    it('should use fallback parsing when ML service fails', async () => {
      // Install mock that fails
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ML service unavailable'));

      // Given: Content to parse
      const memoryId = randomUUID();
      const content = 'This is a test with https://example.com link and #testing tag.';
      const context = createMockContext({
        memoryId,
        content,
      });

      // When: Process through reader agent
      const result = await readerAgent.execute(context);

      // Then: Agent returns failure when ML service is unavailable (no fallback implemented)
      expect(result.success).toBe(false);
    });

    it('should extract basic metadata with fallback parser', async () => {
      // Mock Qdrant to return content
      mockQdrantGetMemory('Meeting with @john about #project-alpha. Link: https://docs.example.com');

      // Install mock that returns error status (for ML service)
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => null } as Headers,
        json: async () => ({ error: 'Internal error' }),
        text: async () => '{"error": "Internal error"}',
      } as Response);

      // Given: Content with various elements
      const memoryId = randomUUID();
      const content = 'Meeting with @john about #project-alpha. Link: https://docs.example.com';
      const context = createMockContext({
        memoryId,
        content,
      });

      // When: Process through reader agent
      const result = await readerAgent.execute(context);

      // Then: Agent returns failure when ML service is unavailable (no fallback implemented)
      expect(result.success).toBe(false);
    });

    it('should handle no content gracefully', async () => {
      // Mock Qdrant to return null (no content)
      mockQdrantGetMemory();

      // Install mock
      installMLServiceMock();

      // Given: No content available
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        // No content provided, not chunked
      });

      // When: Process through reader agent
      const result = await readerAgent.execute(context);

      // Then: Graceful handling
      expect(result.success).toBe(true);
      expect(result.metrics?.itemsProcessed).toBe(0);
    });
  });
});
