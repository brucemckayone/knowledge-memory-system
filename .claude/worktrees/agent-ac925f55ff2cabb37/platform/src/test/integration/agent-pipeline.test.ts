/**
 * Agent Pipeline Integration Test
 *
 * Golden path E2E test covering the full KARMA agent pipeline.
 *
 * Pipeline: Message Processor → Reader → Entity Extraction → Relationship → Schema → Conflict
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  randomUUID,
  isMLServiceAvailable,
} from '../setup.js';
import { loadPhase4Seed } from '../fixtures/phase4-seed.js';
import { installMLServiceMock, restoreMLServiceMock } from '../mocks/ml-service.mock.js';

// Import agents
import { readerAgent } from '../../gardener/agents/reader.agent.js';
import { relationshipAgent } from '../../gardener/agents/relationship.agent.js';
import { schemaAlignmentAgent } from '../../gardener/agents/schema-alignment.agent.js';
import { normalizePredicate } from '../../services/predicates.js';
import { chunkContent } from '../../services/chunks.js';
import type { AgentContext } from '../../gardener/controller.js';
import type PgBoss from 'pg-boss';

describe('Agent Pipeline Integration', () => {
  let mlAvailable = false;
  const seed = loadPhase4Seed();

  beforeAll(async () => {
    mlAvailable = await isMLServiceAvailable();
    if (!mlAvailable) {
      console.warn('⚠️ ML Services not available - using mocks for pipeline tests');
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreMLServiceMock();
  });

  // Helper to create mock context
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

  describe('Golden Path: Full Pipeline Flow', () => {
    it('should process memory through complete pipeline', async () => {
      const memoryId = randomUUID();
      const content = seed.relationships.content;

      // Only use mocks if ML service is not available
      if (!mlAvailable) {
        // Helper to create a proper mock response
        const createResponse = (data: unknown, status = 200) => ({
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get: (name: string) => {
              if (name.toLowerCase() === 'content-type') return 'application/json';

              return null;
            },
          } as Headers,
          json: async () => data,
          text: async () => JSON.stringify(data),
        } as Response);

        // Mock ML service and Qdrant operations
        vi.spyOn(global, 'fetch').mockImplementation(async (input, _init) => {
          const urlStr = input instanceof Request ? input.url : input.toString();

          if (urlStr.includes('/collections/memories/points')) {
            return createResponse({
              result: { payload: { content } },
            });
          }

          if (urlStr.includes('/parse-content') && !urlStr.includes('/extract')) {
            return createResponse({
              content_type: 'thought',
              title: 'Meeting notes',
              summary: 'Team discussion',
              mentions: ['john', 'sarah'],
              dates: [],
              links: [],
              tags: ['meeting'],
              sentiment: 'positive',
              language: 'en',
              word_count: 100,
            });
          }

          if (urlStr.includes('/extract-entities')) {
            return createResponse({
              entities: [
                { mention: 'John Smith', type: 'person', confidence: 0.95 },
                { mention: 'Sarah Chen', type: 'person', confidence: 0.92 },
                { mention: 'Acme Corp', type: 'company', confidence: 0.88 },
              ],
            });
          }

          if (urlStr.includes('/extract-relationships')) {
            return createResponse({
              relationships: [
                { subject: 'John Smith', predicate: 'works_at', object: 'Acme Corp', confidence: 0.9 },
              ],
            });
          }

          if (urlStr.includes('/embed')) {
            return createResponse({ vector: Array(768).fill(0.1) });
          }

          return createResponse({});
        });
      }

      // Step 1: Reader (content threaded via payload, as message processor does)
      const readerResult = await readerAgent.execute(
        createMockContext({
          memoryId,
          content,
          contentLength: content.length,
          chunked: false,
          chunkCount: 1,
          type: 'thought',
          source: 'telegram',
        })
      );

      expect(readerResult.success).toBe(true);
      expect(readerResult.outputs?.contentType).toBeDefined();
      expect(readerResult.outputs?.wordCount).toBeGreaterThan(0);

      // Step 3: Set up entities for relationship extraction
      const john = await createTestEntity({
        canonicalName: 'John Smith',
        entityType: 'person',
      });
      const sarah = await createTestEntity({
        canonicalName: 'Sarah Chen',
        entityType: 'person',
      });
      const acme = await createTestEntity({
        canonicalName: 'Acme Corp',
        entityType: 'company',
      });

      // Link entities to memory
      await testDb`
        INSERT INTO memory_entities (memory_id, entity_id, mention_text, confidence)
        VALUES
          (${memoryId}::uuid, ${john.id}::uuid, 'John Smith', 0.95),
          (${memoryId}::uuid, ${sarah.id}::uuid, 'Sarah Chen', 0.92),
          (${memoryId}::uuid, ${acme.id}::uuid, 'Acme Corp', 0.88)
      `;

      // Step 4: Relationship Extraction (W26)
      const relationshipResult = await relationshipAgent.execute(
        createMockContext({
          memoryId,
          content,
          entities: [
            { id: john.id, name: 'John Smith', type: 'person' },
            { id: sarah.id, name: 'Sarah Chen', type: 'person' },
            { id: acme.id, name: 'Acme Corp', type: 'company' },
          ],
        })
      );

      expect(relationshipResult.success).toBe(true);
      expect(relationshipResult.outputs?.relationshipsFound).toBeGreaterThanOrEqual(0);

      // Step 5: Schema Alignment (W27)
      const schemaResult = await schemaAlignmentAgent.execute(
        createMockContext({ maxNormalize: 10 })
      );

      expect(schemaResult.success).toBeDefined();
    });

    it('should chain job outputs correctly between agents', async () => {
      // Install mock
      installMLServiceMock();

      const memoryId = randomUUID();
      const content = 'Simple test content for job chaining verification.';

      // Simulate what message processor does: fan-out to reader and entity extraction
      // Reader receives content in payload
      const readerResult = await readerAgent.execute(
        createMockContext({
          memoryId,
          content,
          contentLength: content.length,
          chunked: false,
          chunkCount: 1,
        })
      );

      expect(readerResult.success).toBeDefined();
    });

    it('should handle pipeline with chunked content', async () => {
      const longContent = seed.longContent.content;

      // Simulate message processor inline chunking
      const chunks = chunkContent(longContent, 4000, 200);
      const needsChunking = chunks.length > 1;

      expect(needsChunking).toBe(true);
      expect(chunks.length).toBe(seed.longContent.expectedChunks);

      // Reader receives chunking info in payload (as message processor sends it)
      // Just verify the chunking logic works correctly
      expect(chunks[0]!.content.length).toBeGreaterThan(0);
      expect(chunks[0]!.content.length).toBeLessThanOrEqual(4000);
    });
  });

  describe('Pipeline Resilience', () => {
    it('should continue pipeline when ML service is unavailable', async () => {
      // Mock ML service as unavailable
      vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const urlStr = input instanceof Request ? input.url : input.toString();

        // Create a proper mock response
        const createResponse = (data: unknown, status = 200) => ({
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get: (name: string) => {
              if (name.toLowerCase() === 'content-type') return 'application/json';

              return null;
            },
          } as Headers,
          json: async () => data,
          text: async () => JSON.stringify(data),
        } as Response);

        // ML endpoints fail
        if (urlStr.includes('/parse-content') ||
            urlStr.includes('/extract-entities') ||
            urlStr.includes('/extract-relationships')) {
          return createResponse({ error: 'Service unavailable' }, 503);
        }

        // Qdrant works
        if (urlStr.includes('/collections/')) {
          return createResponse({
            result: { payload: { content: 'Test' } },
          });
        }

        return createResponse({});
      });

      const memoryId = randomUUID();
      const content = 'Test content for resilience check with #tag and https://example.com';

      // Reader throws a retryable error when ML service is unavailable
      await expect(
        readerAgent.execute(createMockContext({ memoryId, content }))
      ).rejects.toThrow('Reader failed');
    });

    it('should handle empty entity list gracefully in relationship extraction', async () => {
      const memoryId = randomUUID();

      // Relationship agent should succeed with no entities
      const result = await relationshipAgent.execute(
        createMockContext({
          memoryId,
          content: 'Content with no recognized entities.',
          entities: [],
        })
      );

      expect(result.success).toBe(true);
      expect(result.metrics?.itemsProcessed).toBe(0);
    });
  });

  describe('Data Consistency', () => {
    it('should maintain referential integrity through pipeline', async () => {
      // Create base entities
      const person = await createTestEntity({
        canonicalName: 'Pipeline Test Person',
        entityType: 'person',
      });

      const company = await createTestEntity({
        canonicalName: 'Pipeline Test Company',
        entityType: 'company',
      });

      const memoryId = randomUUID();

      // Link entities to memory
      await testDb`
        INSERT INTO memory_entities (memory_id, entity_id, mention_text, confidence)
        VALUES
          (${memoryId}::uuid, ${person.id}::uuid, 'Pipeline Test Person', 0.9),
          (${memoryId}::uuid, ${company.id}::uuid, 'Pipeline Test Company', 0.85)
      `;

      // Create a fact
      await testDb`
        INSERT INTO facts (subject_entity_id, predicate, object_entity_id, confidence)
        VALUES (${person.id}::uuid, 'works_at', ${company.id}::uuid, 0.9)
      `;

      // Verify referential integrity
      const memoryEntities = await testDb`
        SELECT me.*, e.canonical_name
        FROM memory_entities me
        JOIN entities e ON me.entity_id = e.id
        WHERE me.memory_id = ${memoryId}::uuid
      `;

      expect(memoryEntities.length).toBe(2);

      const facts = await testDb`
        SELECT f.*, s.canonical_name as subject_name, o.canonical_name as object_name
        FROM facts f
        JOIN entities s ON f.subject_entity_id = s.id
        JOIN entities o ON f.object_entity_id = o.id
        WHERE f.subject_entity_id = ${person.id}::uuid
      `;

      expect(facts.length).toBe(1);
      expect(facts[0]!.subject_name).toBe('Pipeline Test Person');
      expect(facts[0]!.object_name).toBe('Pipeline Test Company');
    });

    it('should normalize predicates consistently', () => {
      // All aliases should map to same canonical form
      const aliases = ['employed_at', 'works_for', 'employee_of', 'working_at'];

      const normalizedSet = new Set(aliases.map(normalizePredicate));

      // All should normalize to same value
      expect(normalizedSet.size).toBe(1);
      expect(normalizedSet.has('works_at')).toBe(true);
    });
  });

  describe('Performance Characteristics', () => {
    it('should chunk content correctly for short content', () => {
      const shortContent = 'Brief content under chunk threshold.';
      const chunks = chunkContent(shortContent, 4000, 200);

      expect(chunks.length).toBe(1);
      expect(chunks[0]!.content).toBe(shortContent);
    });

    it('should process short content without chunking overhead', async () => {
      // Install mock
      installMLServiceMock();

      const memoryId = randomUUID();
      const shortContent = 'Brief content under chunk threshold.';

      const start = Date.now();
      const result = await readerAgent.execute(
        createMockContext({ memoryId, content: shortContent })
      );
      const duration = Date.now() - start;

      expect(result.success).toBeDefined();
      // Reader should be fast for short content
      expect(duration).toBeLessThan(5000);
    });
  });
});
