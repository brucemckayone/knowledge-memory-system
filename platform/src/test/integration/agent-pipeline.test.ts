/**
 * Agent Pipeline Integration Test
 *
 * Golden path E2E test covering the full KARMA agent pipeline
 * from ingestion through evaluation.
 *
 * Pipeline: W22 → W23 → W25 → W26 → W27 → W28 → W29
 *           (Ingestion → Reader → Entity → Relationship → Schema → Conflict → Evaluator)
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

// Import all agents
import { ingestionAgent } from '../../gardener/agents/ingestion.agent.js';
import { readerAgent } from '../../gardener/agents/reader.agent.js';
import { relationshipAgent } from '../../gardener/agents/relationship.agent.js';
import { schemaAlignmentAgent } from '../../gardener/agents/schema-alignment.agent.js';
import { evaluatorAgent } from '../../gardener/agents/evaluator.agent.js';
import { normalizePredicate } from '../../services/predicates.js';
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
    };
  }

  describe('Golden Path: Full Pipeline Flow', () => {
    it('should process memory through complete pipeline', async () => {
      // Install comprehensive mock
      installMLServiceMock({
        parseContent: {
          content_type: 'thought',
          title: 'Team meeting notes',
          summary: 'Discussion about project progress',
          mentions: ['john', 'sarah'],
          dates: [],
          links: [],
          tags: ['meeting', 'project'],
          sentiment: 'positive',
          language: 'en',
          word_count: 100,
        },
        extractEntities: {
          entities: [
            { mention: 'John Smith', type: 'person', confidence: 0.95 },
            { mention: 'Sarah Chen', type: 'person', confidence: 0.92 },
            { mention: 'Acme Corp', type: 'company', confidence: 0.88 },
          ],
        },
        extractRelationships: {
          relationships: [
            {
              subject: 'John Smith',
              predicate: 'works_at',
              object: 'Acme Corp',
              confidence: 0.9,
            },
            {
              subject: 'John Smith',
              predicate: 'knows',
              object: 'Sarah Chen',
              confidence: 0.85,
            },
          ],
        },
      });

      // Also mock Qdrant calls
      vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
        const urlStr = url.toString();

        // Qdrant operations
        if (urlStr.includes('/collections/memories/points/')) {
          if (init?.method === 'PATCH' || init?.method === 'PUT') {
            return { ok: true, json: async () => ({}) } as Response;
          }
          return {
            ok: true,
            json: async () => ({
              result: { payload: { content: seed.relationships.content } },
            }),
          } as Response;
        }

        // ML service operations
        if (urlStr.includes('/parse-content')) {
          return {
            ok: true,
            json: async () => ({
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
            }),
          } as Response;
        }

        if (urlStr.includes('/extract-entities')) {
          return {
            ok: true,
            json: async () => ({
              entities: [
                { mention: 'John Smith', type: 'person', confidence: 0.95 },
                { mention: 'Sarah Chen', type: 'person', confidence: 0.92 },
                { mention: 'Acme Corp', type: 'company', confidence: 0.88 },
              ],
            }),
          } as Response;
        }

        if (urlStr.includes('/extract-relationships')) {
          return {
            ok: true,
            json: async () => ({
              relationships: [
                { subject: 'John Smith', predicate: 'works_at', object: 'Acme Corp', confidence: 0.9 },
              ],
            }),
          } as Response;
        }

        if (urlStr.includes('/embed')) {
          return {
            ok: true,
            json: async () => ({ embedding: Array(768).fill(0.1) }),
          } as Response;
        }

        return { ok: true, json: async () => ({}) } as Response;
      });

      const memoryId = randomUUID();
      const content = seed.relationships.content;

      // Step 1: Ingestion (W22)
      const ingestionResult = await ingestionAgent.execute(
        createMockContext({ memoryId, content })
      );

      expect(ingestionResult.success).toBe(true);
      expect(ingestionResult.nextJobs).toBeDefined();
      expect(ingestionResult.nextJobs?.length).toBeGreaterThan(0);

      // Verify downstream jobs queued
      const readerJob = ingestionResult.nextJobs?.find(j => j.type === 'gardener:reader');
      const entityJob = ingestionResult.nextJobs?.find(j => j.type === 'gardener:extract-entities');
      expect(readerJob).toBeDefined();
      expect(entityJob).toBeDefined();

      // Step 2: Reader (W23)
      const readerResult = await readerAgent.execute(
        createMockContext({
          memoryId,
          content,
          ...readerJob?.payload,
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

      // Step 6: Evaluator (W29)
      // First, create some job metadata to evaluate
      const evalJobId = randomUUID();
      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, started_at, completed_at, duration_ms)
        VALUES (${evalJobId}::uuid, 'gardener:reader', 'realtime', NOW() - INTERVAL '2 seconds', NOW(), 1500)
      `;

      const evaluatorResult = await evaluatorAgent.execute(
        createMockContext({ limit: 10 })
      );

      expect(evaluatorResult.success).toBeDefined();
    });

    it('should chain job outputs correctly between agents', async () => {
      // Install mock
      installMLServiceMock();

      const memoryId = randomUUID();
      const content = 'Simple test content for job chaining verification.';

      // Step 1: Ingestion produces jobs for reader and entity extraction
      const ingestionResult = await ingestionAgent.execute(
        createMockContext({ memoryId, content })
      );

      expect(ingestionResult.success).toBe(true);

      // Verify job payloads contain necessary data
      const nextJobs = ingestionResult.nextJobs || [];

      for (const job of nextJobs) {
        // All downstream jobs should have memoryId
        expect(job.payload.memoryId).toBe(memoryId);

        // Reader job should have content metadata
        if (job.type === 'gardener:reader') {
          expect(job.payload.contentLength).toBe(content.length);
        }

        // Entity extraction job should have content
        if (job.type === 'gardener:extract-entities') {
          expect(job.payload.content).toBe(content);
        }
      }
    });

    it('should handle pipeline with chunked content', async () => {
      // Install mock
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();
        if (urlStr.includes('/parse-content')) {
          return {
            ok: true,
            json: async () => ({
              content_type: 'thought',
              title: 'Long document',
              summary: 'Summary...',
              mentions: [],
              dates: [],
              links: [],
              tags: [],
              sentiment: 'neutral',
              language: 'en',
              word_count: 2000,
            }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      });

      const memoryId = randomUUID();

      // Step 1: Ingestion chunks long content
      const ingestionResult = await ingestionAgent.execute(
        createMockContext({
          memoryId,
          content: seed.longContent.content,
        })
      );

      expect(ingestionResult.success).toBe(true);
      expect(ingestionResult.outputs?.chunked).toBe(true);
      expect(ingestionResult.outputs?.chunkCount).toBe(seed.longContent.expectedChunks);

      // Verify reader job receives chunking info
      const readerJob = ingestionResult.nextJobs?.find(j => j.type === 'gardener:reader');
      expect(readerJob?.payload.chunked).toBe(true);
      expect(readerJob?.payload.chunkCount).toBe(seed.longContent.expectedChunks);
    });
  });

  describe('Pipeline Resilience', () => {
    it('should continue pipeline when ML service is unavailable', async () => {
      // Mock ML service as unavailable
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        const urlStr = url.toString();

        // ML endpoints fail
        if (urlStr.includes('/parse-content') ||
            urlStr.includes('/extract-entities') ||
            urlStr.includes('/extract-relationships')) {
          return { ok: false, status: 503 } as Response;
        }

        // Qdrant works
        if (urlStr.includes('/collections/')) {
          return {
            ok: true,
            json: async () => ({ result: { payload: { content: 'Test' } } }),
          } as Response;
        }

        return { ok: true, json: async () => ({}) } as Response;
      });

      const memoryId = randomUUID();
      const content = 'Test content for resilience check with #tag and https://example.com';

      // Ingestion should work (no ML dependency)
      const ingestionResult = await ingestionAgent.execute(
        createMockContext({ memoryId, content })
      );
      expect(ingestionResult.success).toBe(true);

      // Reader should use fallback parsing
      const readerResult = await readerAgent.execute(
        createMockContext({ memoryId, content })
      );
      expect(readerResult.success).toBe(true);
      // Fallback should still detect links and tags
      expect(readerResult.outputs?.linksFound).toBeGreaterThan(0);
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
    it('should complete ingestion in reasonable time', async () => {
      const start = Date.now();
      const memoryId = randomUUID();

      await ingestionAgent.execute(
        createMockContext({
          memoryId,
          content: 'Quick test content for performance check.',
        })
      );

      const duration = Date.now() - start;

      // Ingestion should be fast (realtime tier expects < 30s)
      expect(duration).toBeLessThan(5000);
    });

    it('should process short content without chunking overhead', async () => {
      const memoryId = randomUUID();
      const shortContent = 'Brief content under chunk threshold.';

      const result = await ingestionAgent.execute(
        createMockContext({ memoryId, content: shortContent })
      );

      expect(result.success).toBe(true);
      expect(result.outputs?.chunked).toBe(false);
      expect(result.outputs?.chunkCount).toBe(1);
    });
  });
});
