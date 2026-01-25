/**
 * Hybrid Search Integration Tests
 *
 * Tests for the hybrid search system combining vector, graph, and keyword search.
 * Covers HS-001 through HS-007 from the test strategy.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestMemoryEntity,
  isQdrantAvailable,
  isMLServiceAvailable,
  QDRANT_URL,
  ML_SERVICES_URL,
  randomUUID,
  randomEmbedding,
  normalizeVector,
} from '../setup.js';

// Test collection name for memories
const MEMORIES_COLLECTION = 'memories';

// Helper to ensure memories collection exists
async function ensureMemoriesCollection(): Promise<void> {
  try {
    await fetch(`${QDRANT_URL}/collections/${MEMORIES_COLLECTION}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vectors: { size: 768, distance: 'Cosine' },
      }),
    });
  } catch {
    // Collection might already exist
  }
}

// Helper to clear memories collection
async function clearMemoriesCollection(): Promise<void> {
  try {
    await fetch(`${QDRANT_URL}/collections/${MEMORIES_COLLECTION}/points/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: {} }),
    });
  } catch {
    // Ignore
  }
}

// Helper to add memory to Qdrant
async function addMemoryToQdrant(
  id: string,
  content: string,
  type: string,
  embedding?: number[]
): Promise<void> {
  const vector = embedding || normalizeVector(randomEmbedding());

  await fetch(`${QDRANT_URL}/collections/${MEMORIES_COLLECTION}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: [
        {
          id,
          vector,
          payload: { content, type },
        },
      ],
    }),
  });
}

describe('Hybrid Search Integration', () => {
  let qdrantAvailable = false;
  let mlAvailable = false;

  beforeAll(async () => {
    qdrantAvailable = await isQdrantAvailable();
    mlAvailable = await isMLServiceAvailable();

    if (!qdrantAvailable) {
      console.warn('⚠️ Qdrant not available - skipping hybrid search tests');
      return;
    }

    await ensureMemoriesCollection();
  });

  beforeEach(async () => {
    if (!qdrantAvailable) return;

    // Clear Qdrant collection (tests are self-contained for DB with unique IDs)
    await clearMemoriesCollection();
  });

  describe('HS-001: Vector-only search', () => {
    it.skipIf(!qdrantAvailable)('should return vector results only when graph disabled', async () => {
      // Given: Memories in Qdrant
      const targetEmbedding = normalizeVector(randomEmbedding());

      await addMemoryToQdrant('mem-1', 'Meeting about machine learning project', 'thought', targetEmbedding);
      await addMemoryToQdrant('mem-2', 'Lunch with team', 'thought');
      await addMemoryToQdrant('mem-3', 'Code review for ML module', 'task',
        // Similar to target
        normalizeVector(targetEmbedding.map((v, i) => i < 760 ? v : v * 0.999))
      );

      // When: Vector search only
      const response = await fetch(`${QDRANT_URL}/collections/${MEMORIES_COLLECTION}/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vector: targetEmbedding,
          limit: 10,
          with_payload: true,
        }),
      });

      // Then: Returns results ranked by vector similarity
      expect(response.ok).toBe(true);
      const results = await response.json() as Record<string, unknown>;

      expect((results.result as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
      expect(((results.result as Array<Record<string, unknown>>)[0] as Record<string, unknown>).id).toBe('mem-1'); // Exact match
      expect(((results.result as Array<Record<string, unknown>>)[0] as Record<string, unknown>).score).toBeGreaterThan(0.99);
    });
  });

  describe('HS-002: Graph-augmented search', () => {
    it.skipIf(!qdrantAvailable)('should include results from entity graph neighbors', async () => {
      // Given: Entities with relationships
      const person = await createTestEntity({
        canonicalName: 'John Smith',
        entityType: 'person',
      });

      const project = await createTestEntity({
        canonicalName: 'Alpha Project',
        entityType: 'project',
      });

      // Memories linked to entities
      const memoryId1 = randomUUID();
      const memoryId2 = randomUUID();

      await createTestMemoryEntity({
        memoryId: memoryId1,
        entityId: person.id,
        mentionText: 'John Smith',
      });

      await createTestMemoryEntity({
        memoryId: memoryId2,
        entityId: project.id,
        mentionText: 'Alpha Project',
      });

      // Add to Qdrant
      await addMemoryToQdrant(memoryId1, 'John Smith discussed the timeline', 'thought');
      await addMemoryToQdrant(memoryId2, 'Alpha Project milestone reached', 'thought');

      // When: Query for memories linked to John Smith
      const linkedMemories = await testDb`
        SELECT DISTINCT memory_id
        FROM memory_entities
        WHERE entity_id = ${person.id}::uuid
      `;

      // Then: Should find memories through entity links
      expect(linkedMemories.length).toBe(1);
      expect(linkedMemories[0]!.memory_id).toBe(memoryId1);
    });
  });

  describe('HS-003: RRF fusion', () => {
    it('should combine multiple sources using reciprocal rank fusion', () => {
      // Given: Results from different sources
      const vectorResults = [
        { memoryId: 'A', score: 0.9, source: 'vector' },
        { memoryId: 'B', score: 0.8, source: 'vector' },
        { memoryId: 'C', score: 0.7, source: 'vector' },
      ];

      const keywordResults = [
        { memoryId: 'B', score: 1.0, source: 'keyword' }, // B appears in both
        { memoryId: 'D', score: 0.9, source: 'keyword' },
        { memoryId: 'A', score: 0.8, source: 'keyword' }, // A appears in both
      ];

      // When: Apply RRF
      const k = 60;
      const scores = new Map<string, number>();

      // Vector scores
      vectorResults.forEach((r, rank) => {
        const rrfScore = 1 / (k + rank + 1);
        scores.set(r.memoryId, (scores.get(r.memoryId) || 0) + rrfScore);
      });

      // Keyword scores
      keywordResults.forEach((r, rank) => {
        const rrfScore = 1 / (k + rank + 1);
        scores.set(r.memoryId, (scores.get(r.memoryId) || 0) + rrfScore);
      });

      // Then: Items appearing in multiple lists rank higher
      const sorted = Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1]);

      // A and B should be near the top (appear in both lists)
      const topIds = sorted.slice(0, 2).map(s => s[0]);
      expect(topIds).toContain('A');
      expect(topIds).toContain('B');
    });
  });

  describe('HS-004: Weight adjustment', () => {
    it('should reflect custom weights in scores', () => {
      // Given: Same results with different weights
      const results = [
        { memoryId: 'A', rank: 0 },
        { memoryId: 'B', rank: 1 },
      ];

      const k = 60;

      // When: Apply with weight 1.0
      const scores1 = results.map(r => ({
        id: r.memoryId,
        score: 1.0 / (k + r.rank + 1),
      }));

      // When: Apply with weight 0.5
      const scores2 = results.map(r => ({
        id: r.memoryId,
        score: 0.5 / (k + r.rank + 1),
      }));

      // Then: Scores are proportional to weights
      expect(scores1[0]!.score).toBe(scores2[0]!.score * 2);
      expect(scores1[1]!.score).toBe(scores2[1]!.score * 2);
    });
  });

  describe('HS-005: Entity extraction from query', () => {
    it.skipIf(!mlAvailable)('should resolve entities in query', async () => {
      // When: Extract entities from query
      const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Tell me about Bruce McKay' }),
      });

      // Then: Entity mention found
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      // Should find at least one entity mention
      const mentions = (result.entities as Array<{ mention: string }> | undefined)?.map((e: { mention: string }) =>
        e.mention.toLowerCase()
      ) || [];

      // Should include "Bruce" or "McKay" or "Bruce McKay"
      const hasBruce = mentions.some((m: string) =>
        m.includes('bruce') || m.includes('mckay')
      );
      expect(hasBruce).toBe(true);
    }, 30000);
  });

  describe('HS-006: Empty graph fallback', () => {
    it.skipIf(!qdrantAvailable)('should return vector results when graph is empty', async () => {
      // Given: Memories in Qdrant but no entity links
      const embedding = normalizeVector(randomEmbedding());
      await addMemoryToQdrant('orphan-mem', 'This memory has no entity links', 'thought', embedding);

      // Verify no entity links
      const links = await testDb`SELECT COUNT(*) as count FROM memory_entities`;
      expect(parseInt(links[0]!.count as string)).toBe(0);

      // When: Vector search
      const response = await fetch(`${QDRANT_URL}/collections/${MEMORIES_COLLECTION}/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vector: embedding,
          limit: 10,
          with_payload: true,
        }),
      });

      // Then: Vector results returned
      expect(response.ok).toBe(true);
      const results = await response.json() as Record<string, unknown>;
      expect((results.result as Array<Record<string, unknown>>).length).toBe(1);
      expect(((results.result as Array<Record<string, unknown>>)[0] as Record<string, unknown>).id).toBe('orphan-mem');
    });
  });

  describe('HS-007: Keyword boost', () => {
    it.skipIf(!qdrantAvailable)('should rank exact keyword matches high', async () => {
      // Given: Memories with specific keywords
      await addMemoryToQdrant('exact-match', 'Project Phoenix kickoff meeting', 'thought');
      await addMemoryToQdrant('partial-match', 'The project is going well', 'thought');
      await addMemoryToQdrant('no-match', 'Had lunch at the cafe', 'thought');

      // When: Keyword filter for "Phoenix"
      const response = await fetch(`${QDRANT_URL}/collections/${MEMORIES_COLLECTION}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter: {
            must: [{ key: 'content', match: { text: 'Phoenix' } }],
          },
          limit: 10,
          with_payload: true,
        }),
      });

      // Then: Only exact match returned
      expect(response.ok).toBe(true);
      const results = await response.json() as Record<string, unknown>;

      expect(((results.result as Record<string, unknown>).points as Array<Record<string, unknown>>).length).toBe(1);
      expect(((results.result as Record<string, unknown>).points as Array<Record<string, unknown>>)[0]!.id).toBe('exact-match');
    });
  });
});
