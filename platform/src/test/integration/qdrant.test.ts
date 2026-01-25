/**
 * Qdrant Integration Tests
 *
 * Tests for Platform ↔ Qdrant module boundary.
 * Covers QD-001 through QD-007 from the test strategy.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QDRANT_URL, isQdrantAvailable, randomUUID, randomEmbedding, normalizeVector } from '../setup.js';

// Test collection name
const TEST_COLLECTION = 'test_memories';

// Helper to make Qdrant API calls
async function qdrantRequest(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown
): Promise<Response> {
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  return fetch(`${QDRANT_URL}${path}`, options);
}

describe('Platform ↔ Qdrant Integration', () => {
  let qdrantAvailable = false;

  beforeAll(async () => {
    qdrantAvailable = await isQdrantAvailable();
    if (!qdrantAvailable) {
      console.warn('⚠️ Qdrant not available - skipping Qdrant tests');
      return;
    }

    // Create test collection
    try {
      await qdrantRequest(`/collections/${TEST_COLLECTION}`, 'DELETE');
    } catch {
      // Collection might not exist
    }

    await qdrantRequest(`/collections/${TEST_COLLECTION}`, 'PUT', {
      vectors: {
        size: 768,
        distance: 'Cosine',
      },
    });
  });

  afterAll(async () => {
    if (qdrantAvailable) {
      // Clean up test collection
      await qdrantRequest(`/collections/${TEST_COLLECTION}`, 'DELETE');
    }
  });

  beforeEach(async () => {
    if (!qdrantAvailable) return;

    // Clear all points in test collection
    await qdrantRequest(`/collections/${TEST_COLLECTION}/points/delete`, 'POST', {
      filter: {},
    });
  });

  describe('QD-001: Memory storage', () => {
    it.skipIf(!qdrantAvailable)('should store memory with vector', async () => {
      // Given: Memory content and embedding
      const pointId = randomUUID();
      const embedding = normalizeVector(randomEmbedding());
      const payload = {
        content: 'Test memory content',
        type: 'thought',
        created_at: new Date().toISOString(),
      };

      // When: Upsert point
      const response = await qdrantRequest(
        `/collections/${TEST_COLLECTION}/points`,
        'PUT',
        {
          points: [
            {
              id: pointId,
              vector: embedding,
              payload,
            },
          ],
        }
      );

      // Then: Point ID returned successfully
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;
      expect(result.status).toBe('ok');

      // Verify point exists
      const getResponse = await qdrantRequest(
        `/collections/${TEST_COLLECTION}/points/${pointId}`
      );
      expect(getResponse.ok).toBe(true);
      const point = await response.json() as Record<string, unknown>;
      expect(point.result.payload.content).toBe('Test memory content');
    });
  });

  describe('QD-002: Vector search', () => {
    it.skipIf(!qdrantAvailable)('should retrieve by similarity', async () => {
      // Given: Multiple stored memories
      const baseEmbedding = normalizeVector(randomEmbedding());
      const points = [
        {
          id: randomUUID(),
          vector: baseEmbedding,
          payload: { content: 'Similar content 1', relevance: 'high' },
        },
        {
          id: randomUUID(),
          vector: normalizeVector(randomEmbedding()), // Different embedding
          payload: { content: 'Different content', relevance: 'low' },
        },
        {
          id: randomUUID(),
          // Very similar to base (slight perturbation)
          vector: normalizeVector(baseEmbedding.map((v, i) => i < 760 ? v : v * 0.999)),
          payload: { content: 'Similar content 2', relevance: 'high' },
        },
      ];

      await qdrantRequest(`/collections/${TEST_COLLECTION}/points`, 'PUT', { points });

      // When: Search with base embedding
      const searchResponse = await qdrantRequest(
        `/collections/${TEST_COLLECTION}/points/search`,
        'POST',
        {
          vector: baseEmbedding,
          limit: 3,
          with_payload: true,
        }
      );

      // Then: Results ranked by score
      expect(searchResponse.ok).toBe(true);
      const results = await response.json() as Record<string, unknown>;

      expect(results.result.length).toBe(3);
      // First result should be exact match (highest score)
      expect(results.result[0].payload.content).toBe('Similar content 1');
      expect(results.result[0].score).toBeGreaterThan(0.99);

      // Scores should be in descending order
      for (let i = 0; i < results.result.length - 1; i++) {
        expect(results.result[i].score).toBeGreaterThanOrEqual(results.result[i + 1].score);
      }
    });
  });

  describe('QD-003: Payload filtering', () => {
    it.skipIf(!qdrantAvailable)('should filter by metadata', async () => {
      // Given: Memories with different types
      const embedding = normalizeVector(randomEmbedding());
      const points = [
        {
          id: randomUUID(),
          vector: embedding,
          payload: { content: 'Thought 1', type: 'thought' },
        },
        {
          id: randomUUID(),
          vector: normalizeVector(randomEmbedding()),
          payload: { content: 'Task 1', type: 'task' },
        },
        {
          id: randomUUID(),
          vector: normalizeVector(randomEmbedding()),
          payload: { content: 'Thought 2', type: 'thought' },
        },
        {
          id: randomUUID(),
          vector: normalizeVector(randomEmbedding()),
          payload: { content: 'Link 1', type: 'link' },
        },
      ];

      await qdrantRequest(`/collections/${TEST_COLLECTION}/points`, 'PUT', { points });

      // When: Search with type filter
      const searchResponse = await qdrantRequest(
        `/collections/${TEST_COLLECTION}/points/search`,
        'POST',
        {
          vector: embedding,
          filter: {
            must: [{ key: 'type', match: { value: 'thought' } }],
          },
          limit: 10,
          with_payload: true,
        }
      );

      // Then: Only thoughts returned
      expect(searchResponse.ok).toBe(true);
      const results = await response.json() as Record<string, unknown>;

      expect(results.result.length).toBe(2);
      results.result.forEach((r: { payload: { type: string } }) => {
        expect(r.payload.type).toBe('thought');
      });
    });

    it.skipIf(!qdrantAvailable)('should filter by multiple conditions', async () => {
      // Given: Memories with various metadata
      const embedding = normalizeVector(randomEmbedding());
      const points = [
        {
          id: randomUUID(),
          vector: embedding,
          payload: { type: 'task', priority: 'high', status: 'pending' },
        },
        {
          id: randomUUID(),
          vector: normalizeVector(randomEmbedding()),
          payload: { type: 'task', priority: 'low', status: 'pending' },
        },
        {
          id: randomUUID(),
          vector: normalizeVector(randomEmbedding()),
          payload: { type: 'task', priority: 'high', status: 'completed' },
        },
      ];

      await qdrantRequest(`/collections/${TEST_COLLECTION}/points`, 'PUT', { points });

      // When: Filter for high priority pending tasks
      const searchResponse = await qdrantRequest(
        `/collections/${TEST_COLLECTION}/points/search`,
        'POST',
        {
          vector: embedding,
          filter: {
            must: [
              { key: 'type', match: { value: 'task' } },
              { key: 'priority', match: { value: 'high' } },
              { key: 'status', match: { value: 'pending' } },
            ],
          },
          limit: 10,
          with_payload: true,
        }
      );

      // Then: Only matching task returned
      expect(searchResponse.ok).toBe(true);
      const results = await response.json() as Record<string, unknown>;

      expect(results.result.length).toBe(1);
      expect(results.result[0].payload.priority).toBe('high');
      expect(results.result[0].payload.status).toBe('pending');
    });
  });

  describe('QD-004: Collection initialization', () => {
    it.skipIf(!qdrantAvailable)('should verify collection exists with correct config', async () => {
      // When: Get collection info
      const response = await qdrantRequest(`/collections/${TEST_COLLECTION}`);

      // Then: Collection has correct configuration
      expect(response.ok).toBe(true);
      const info = await response.json() as Record<string, unknown>;

      expect(info.result.config.params.vectors.size).toBe(768);
      expect(info.result.config.params.vectors.distance).toBe('Cosine');
    });
  });

  describe('QD-005: Keyword search', () => {
    it.skipIf(!qdrantAvailable)('should find text match in payload', async () => {
      // Given: Memories with searchable content
      const points = [
        {
          id: randomUUID(),
          vector: normalizeVector(randomEmbedding()),
          payload: { content: 'Meeting with John about the project deadline' },
        },
        {
          id: randomUUID(),
          vector: normalizeVector(randomEmbedding()),
          payload: { content: 'Lunch break at the cafeteria' },
        },
        {
          id: randomUUID(),
          vector: normalizeVector(randomEmbedding()),
          payload: { content: 'John sent the budget report' },
        },
      ];

      await qdrantRequest(`/collections/${TEST_COLLECTION}/points`, 'PUT', { points });

      // When: Scroll with text filter (using match text)
      const scrollResponse = await qdrantRequest(
        `/collections/${TEST_COLLECTION}/points/scroll`,
        'POST',
        {
          filter: {
            must: [{ key: 'content', match: { text: 'John' } }],
          },
          limit: 10,
          with_payload: true,
        }
      );

      // Then: Results contain keyword
      expect(scrollResponse.ok).toBe(true);
      const results = await response.json() as Record<string, unknown>;

      expect(results.result.points.length).toBe(2);
      results.result.points.forEach((p: { payload: { content: string } }) => {
        expect(p.payload.content.toLowerCase()).toContain('john');
      });
    });
  });

  describe('QD-006: Empty collection handling', () => {
    it.skipIf(!qdrantAvailable)('should return empty results, no error', async () => {
      // Given: Empty collection (cleared in beforeEach)

      // When: Search on empty collection
      const searchResponse = await qdrantRequest(
        `/collections/${TEST_COLLECTION}/points/search`,
        'POST',
        {
          vector: normalizeVector(randomEmbedding()),
          limit: 10,
          with_payload: true,
        }
      );

      // Then: Empty results, no error
      expect(searchResponse.ok).toBe(true);
      const results = await response.json() as Record<string, unknown>;

      expect(results.result).toEqual([]);
      expect(results.status).toBe('ok');
    });
  });

  describe('QD-007: Duplicate ID handling', () => {
    it.skipIf(!qdrantAvailable)('should update, not duplicate on upsert', async () => {
      // Given: Existing point
      const pointId = randomUUID();
      const originalEmbedding = normalizeVector(randomEmbedding());

      await qdrantRequest(`/collections/${TEST_COLLECTION}/points`, 'PUT', {
        points: [
          {
            id: pointId,
            vector: originalEmbedding,
            payload: { content: 'Original content', version: 1 },
          },
        ],
      });

      // When: Upsert same ID with new data
      const newEmbedding = normalizeVector(randomEmbedding());
      await qdrantRequest(`/collections/${TEST_COLLECTION}/points`, 'PUT', {
        points: [
          {
            id: pointId,
            vector: newEmbedding,
            payload: { content: 'Updated content', version: 2 },
          },
        ],
      });

      // Then: Only one point with updated data
      const getResponse = await qdrantRequest(
        `/collections/${TEST_COLLECTION}/points/${pointId}`
      );
      const point = await response.json() as Record<string, unknown>;

      expect(point.result.payload.content).toBe('Updated content');
      expect(point.result.payload.version).toBe(2);

      // Verify collection only has 1 point
      const countResponse = await qdrantRequest(`/collections/${TEST_COLLECTION}`);
      const info = await response.json() as Record<string, unknown>;
      expect(info.result.points_count).toBe(1);
    });
  });
});
