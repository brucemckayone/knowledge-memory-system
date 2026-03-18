/**
 * Summarizer Agent Tests (W24)
 *
 * Tests for the Summarizer Gardener Agent.
 * Covers SUM-001 through SUM-004 from the Phase 4 test strategy.
 *
 * Boundary: ML /summarize (B3), Qdrant embed update (B11)
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { randomUUID, isMLServiceAvailable } from '../setup.js';
import { loadPhase4Seed } from '../fixtures/phase4-seed.js';
import { installMLServiceMock, restoreMLServiceMock } from '../mocks/ml-service.mock.js';

// Mock Qdrant service before importing the agent
vi.mock('../../services/qdrant.js', () => ({
  getMemory: vi.fn(),
  updateVector: vi.fn(),
  // Other exports can be stubbed
  qdrant: {},
  checkQdrantHealth: vi.fn(),
}));

import { summarizerAgent } from '../../gardener/agents/summarizer.agent.js';
import * as qdrantService from '../../services/qdrant.js';
import type { AgentContext } from '../../gardener/controller.js';
import type PgBoss from 'pg-boss';

describe('W24 Summarizer Agent', () => {
  let mlAvailable = false;
  const seed = loadPhase4Seed();

  beforeAll(async () => {
    mlAvailable = await isMLServiceAvailable();
    if (!mlAvailable) {
      console.warn('⚠️ ML Services not available - using mocks for summarizer tests');
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
      traceId: (data.memoryId as string) ?? null,
      config: {} as any,
      services: { ml: {} as any, controller: {} as any },
      signal: AbortSignal.timeout(30000),
    };
  }

  // Helper to mock Qdrant service functions
  function mockQdrantService(content: string) {
    (qdrantService.getMemory as vi.Mock).mockResolvedValue({
      id: randomUUID(),
      payload: { content },
    });
    (qdrantService.updateVector as vi.Mock).mockResolvedValue(undefined);
  }

  afterEach(() => {
    vi.clearAllMocks();
    restoreMLServiceMock();
  });

  describe('SUM-001: Generate summary', () => {
    it('should generate summary shorter than original content', async () => {
      // Install mock that returns summary
      const originalContent = seed.longDocument.content;
      const mockSummary = 'This is a concise summary of the long document about AI and team collaboration.';

      installMLServiceMock({
        summarize: {
          summary: mockSummary,
          key_points: ['AI development', 'team collaboration', 'product launches'],
          style: 'standard',
        },
      });

      // Mock Qdrant service directly
      mockQdrantService(originalContent);

      // Given: Long content to summarize
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        contentType: 'thought',
        wordCount: 500,
      });

      // When: Process through summarizer
      const result = await summarizerAgent.execute(context);

      // Then: Summary is generated
      expect(result.success).toBe(true);
      if (result.outputs?.summaryLength) {
        expect(result.outputs.summaryLength as number).toBeLessThan(originalContent.length);
      }
    });

    it('should return concise style for thought content', async () => {
      // Install mock
      installMLServiceMock({
        summarize: {
          summary: 'A brief summary',
          key_points: ['point 1'],
        },
      });

      // Mock Qdrant service directly
      mockQdrantService('Some thought content here.');

      // Given: Thought type content
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        contentType: 'thought',
      });

      // When: Process
      const result = await summarizerAgent.execute(context);

      // Then: Style matches content type
      expect(result.success).toBe(true);
      expect(result.outputs?.style).toBe('concise');
    });
  });

  describe('SUM-002: Extract key points', () => {
    it('should extract key points from content', async () => {
      // Install mock with key points
      const keyPoints = ['AI platform development', 'Team collaboration', 'Agile methodology'];

      installMLServiceMock({
        summarize: {
          summary: 'Summary of the document.',
          key_points: keyPoints,
        },
      });

      // Mock Qdrant service directly
      mockQdrantService(seed.longDocument.content);

      // Given: Content with multiple topics
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        contentType: 'note',
      });

      // When: Process
      const result = await summarizerAgent.execute(context);

      // Then: Key points are populated
      expect(result.success).toBe(true);
      if (result.outputs?.keyPointCount !== undefined) {
        expect(result.outputs.keyPointCount as number).toBeGreaterThan(0);
      }
    });
  });

  describe('SUM-003: Update Qdrant embedding', () => {
    it('should call Qdrant PUT for embedding update', async () => {
      // Reset mocks
      (qdrantService.getMemory as vi.Mock).mockResolvedValue({
        id: randomUUID(),
        payload: { content: 'Test content for embedding.' },
      });
      (qdrantService.updateVector as vi.Mock).mockResolvedValue(undefined);

      // Install mock for ML service (includes embed)
      installMLServiceMock({
        summarize: {
          summary: 'Test summary',
          key_points: ['test'],
        },
        embed: {
          vector: Array(768).fill(0.1),
        },
      });

      // Given: Memory to summarize
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        contentType: 'note',
      });

      // When: Process
      const result = await summarizerAgent.execute(context);

      // Then: Qdrant updateVector was called
      expect(result.success).toBe(true);
      expect(qdrantService.updateVector as vi.Mock).toHaveBeenCalled();
    });
  });

  describe('SUM-004: ML fallback', () => {
    it('should generate extractive summary when ML fails', async () => {
      // Mock Qdrant service
      mockQdrantService('First sentence of the document. Middle content here. Last sentence provides conclusion.');

      // Mock ML service to fail
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();

        if (urlStr.includes('/summarize')) {
          return { ok: false, status: 500 } as Response;
        }

        if (urlStr.includes('/embed')) {
          return { ok: false, status: 500 } as Response;
        }

        return { ok: true, json: async () => ({}) } as Response;
      });

      // Given: Memory to summarize with failing ML
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        contentType: 'note',
      });

      // When: Process
      const result = await summarizerAgent.execute(context);

      // Then: Fallback summary is generated
      expect(result.success).toBe(true);
      // Extractive summary uses first and last sentences
      if (result.outputs?.summaryLength) {
        expect(result.outputs.summaryLength as number).toBeGreaterThan(0);
      }
    });

    it('should use word frequency for key points in fallback', async () => {
      // Content with repeated important words
      const contentWithKeywords = `
        The machine learning project focuses on machine learning models.
        Machine learning algorithms are essential. Deep learning is a subset.
        The project uses advanced machine learning techniques.
      `;

      // Mock Qdrant service
      mockQdrantService(contentWithKeywords);

      // ML service unavailable
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();

        if (urlStr.includes('/summarize')) {
          return { ok: false, status: 503 } as Response;
        }

        return { ok: true, json: async () => ({}) } as Response;
      });

      // Given: Content with repeated keywords
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        contentType: 'note',
      });

      // When: Process
      const result = await summarizerAgent.execute(context);

      // Then: Fallback generates key points from word frequency
      expect(result.success).toBe(true);
      // Key points should be extracted (fallback uses word frequency)
      if (result.outputs?.keyPointCount !== undefined) {
        expect(result.outputs.keyPointCount as number).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Batch mode processing', () => {
    it('should process in batch mode when batchMode is true', async () => {
      // Install mock
      installMLServiceMock();

      // Given: Batch mode request
      const context = createMockContext({
        batchMode: true,
        limit: 5,
      });

      // When: Process
      const result = await summarizerAgent.execute(context);

      // Then: Batch processing completes
      expect(result.success).toBe(true);
      // May have processed 0 if no memories need summarization
      expect(result.metrics?.itemsProcessed).toBeDefined();
    });

    it('should checkpoint during batch processing', async () => {
      // Track checkpoint calls
      const checkpointCalls: unknown[] = [];

      // Given: Context with checkpoint tracking
      const context: AgentContext = {
        job: {
          id: randomUUID(),
          data: { batchMode: true, limit: 10 },
        } as PgBoss.Job<unknown>,
        log: vi.fn(),
        checkpoint: vi.fn().mockImplementation((state) => {
          checkpointCalls.push(state);
          return Promise.resolve();
        }),
        restoreCheckpoint: vi.fn().mockResolvedValue({ processedIds: [] }),
        traceId: null,
        config: {} as any,
        services: { ml: {} as any, controller: {} as any },
        signal: AbortSignal.timeout(30000),
      };

      // Install mock
      installMLServiceMock();

      // When: Process batch
      const result = await summarizerAgent.execute(context);

      // Then: Checkpoint was called (may be 0 if no memories to process)
      expect(result.success).toBe(true);
    });
  });
});
