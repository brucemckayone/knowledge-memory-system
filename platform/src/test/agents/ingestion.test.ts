/**
 * Ingestion Agent Tests (W22)
 *
 * Tests for the Ingestion Gardener Agent.
 * Covers ING-001 through ING-004 from the Phase 4 test strategy.
 *
 * Boundary: Message → Chunks → DB (B2)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from '../setup.js';
import { loadPhase4Seed } from '../fixtures/phase4-seed.js';
import { ingestionAgent } from '../../gardener/agents/ingestion.agent.js';
import { chunkContent, estimateTokens } from '../../services/chunks.js';
import type { AgentContext } from '../../gardener/controller.js';
import type PgBoss from 'pg-boss';

describe('W22 Ingestion Agent', () => {
  const seed = loadPhase4Seed();

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

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('ING-001: Content chunking', () => {
    it('should chunk 10k content into 3 parts', async () => {
      // Given: Long content that exceeds max chunk size
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: seed.longContent.content,
      });

      // When: Process through ingestion agent
      const result = await ingestionAgent.execute(context);

      // Then: Content is chunked
      expect(result.success).toBe(true);
      expect(result.outputs?.chunked).toBe(true);
      expect(result.outputs?.chunkCount).toBe(seed.longContent.expectedChunks);
      expect(result.metrics?.itemsProcessed).toBe(seed.longContent.expectedChunks);
    });

    it('should preserve content with overlap for chunk reassembly', () => {
      // Given: Long content
      const content = seed.longContent.content;

      // When: Chunk the content directly
      const chunks = chunkContent(content, 4000, 200);

      // Then: Chunks have proper overlap
      expect(chunks.length).toBe(seed.longContent.expectedChunks);

      // Verify overlap in subsequent chunks
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.overlapChars).toBeGreaterThan(0);
        expect(chunks[i]!.overlapChars).toBeLessThanOrEqual(200);
      }
    });
  });

  describe('ING-002: Skip chunking for short content', () => {
    it('should not chunk content under 4k chars', async () => {
      // Given: Short content under threshold
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: seed.shortContent.content,
      });

      // When: Process through ingestion agent
      const result = await ingestionAgent.execute(context);

      // Then: No chunking performed
      expect(result.success).toBe(true);
      expect(result.outputs?.chunked).toBe(false);
      expect(result.outputs?.chunkCount).toBe(1);
    });

    it('should still estimate tokens for short content', async () => {
      // Given: Short content
      const memoryId = randomUUID();
      const content = seed.shortContent.content;
      const context = createMockContext({
        memoryId,
        content,
      });

      // When: Process through ingestion agent
      const result = await ingestionAgent.execute(context);

      // Then: Token estimate is provided
      expect(result.success).toBe(true);
      expect(result.outputs?.tokenEstimate).toBeDefined();
      expect(result.outputs?.tokenEstimate).toBeGreaterThan(0);

      // Verify estimation is reasonable (~4 chars per token)
      const expectedTokens = estimateTokens(content);
      expect(result.outputs?.tokenEstimate).toBe(expectedTokens);
    });
  });

  describe('ING-003: Queue downstream jobs', () => {
    it('should queue reader and entity extraction jobs', async () => {
      // Given: Valid content to process
      const memoryId = randomUUID();
      const content = 'John Smith works at Acme Corp. This is a test memory.';
      const context = createMockContext({
        memoryId,
        content,
        type: 'thought',
        source: 'test',
      });

      // When: Process through ingestion agent
      const result = await ingestionAgent.execute(context);

      // Then: Downstream jobs are queued
      expect(result.success).toBe(true);
      expect(result.nextJobs).toBeDefined();
      expect(result.nextJobs?.length).toBe(2);

      // Verify job types
      const jobTypes = result.nextJobs?.map(j => j.type) || [];
      expect(jobTypes).toContain('gardener:reader');
      expect(jobTypes).toContain('gardener:extract-entities');

      // Verify reader job payload
      const readerJob = result.nextJobs?.find(j => j.type === 'gardener:reader');
      expect(readerJob?.payload.memoryId).toBe(memoryId);
      expect(readerJob?.tier).toBe('realtime');

      // Verify entity extraction job payload
      const entityJob = result.nextJobs?.find(j => j.type === 'gardener:extract-entities');
      expect(entityJob?.payload.memoryId).toBe(memoryId);
      expect(entityJob?.payload.content).toBe(content);
    });

    it('should pass chunking info to reader job', async () => {
      // Given: Long content that will be chunked
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: seed.longContent.content,
      });

      // When: Process through ingestion agent
      const result = await ingestionAgent.execute(context);

      // Then: Reader job includes chunking info
      const readerJob = result.nextJobs?.find(j => j.type === 'gardener:reader');
      expect(readerJob?.payload.chunked).toBe(true);
      expect(readerJob?.payload.chunkCount).toBe(seed.longContent.expectedChunks);
      expect(readerJob?.payload.contentLength).toBe(seed.longContent.content.length);
    });
  });

  describe('ING-004: Empty content handling', () => {
    it('should return success with skip for empty content', async () => {
      // Given: Empty content
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: '',
      });

      // When: Process through ingestion agent
      const result = await ingestionAgent.execute(context);

      // Then: Success but no processing
      expect(result.success).toBe(true);
      expect(result.metrics?.itemsProcessed).toBe(0);
      expect(result.nextJobs).toBeUndefined();
    });

    it('should return success with skip for whitespace-only content', async () => {
      // Given: Whitespace-only content
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: '   \n\t   ',
      });

      // When: Process through ingestion agent
      const result = await ingestionAgent.execute(context);

      // Then: Success but no processing
      expect(result.success).toBe(true);
      expect(result.metrics?.itemsProcessed).toBe(0);
    });

    it('should return success with skip for very short content', async () => {
      // Given: Content below minimum length (10 chars)
      const memoryId = randomUUID();
      const context = createMockContext({
        memoryId,
        content: 'Hi',
      });

      // When: Process through ingestion agent
      const result = await ingestionAgent.execute(context);

      // Then: Success but no processing
      expect(result.success).toBe(true);
      expect(result.metrics?.itemsProcessed).toBe(0);
    });

    it('should fail without memoryId', async () => {
      // Given: Missing memoryId
      const context = createMockContext({
        content: 'Some content without memory ID',
      });

      // When: Process through ingestion agent
      const result = await ingestionAgent.execute(context);

      // Then: Failure
      expect(result.success).toBe(false);
    });
  });
});
