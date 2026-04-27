/**
 * Performance Benchmarks
 *
 * Tracks performance metrics for the Knowledge Memory System.
 * Run with: pnpm vitest bench
 */

import { describe, bench, beforeAll, afterAll } from 'vitest';
import {
  testDb,
  truncateTables,
  randomUUID,
  randomEmbedding,
  normalizeVector,
  isQdrantAvailable,
  isMLServiceAvailable,
  QDRANT_URL,
  ML_SERVICES_URL,
  skipCtx,
} from '../setup.js';

// Performance targets from test strategy (used for reference)
// const TARGETS = {
//   entityCreationLatency: 100,      // <100ms
//   factCreationLatency: 100,        // <100ms
//   vectorSearchLatency: 200,        // <200ms for 10k memories
//   hybridSearchLatency: 500,        // <500ms all three sources
//   graphPathFinding: 100,           // <100ms with 10k nodes
//   entityResolutionLatency: 300,    // <300ms including embedding
// };

describe('Performance Benchmarks', () => {
  beforeAll(async (ctx) => {
    const qdrantAvailable = await isQdrantAvailable();
    const mlAvailable = await isMLServiceAvailable();
    if (!qdrantAvailable || !mlAvailable) {
      console.warn('⚠️ ML Services or Qdrant not available - skipping performance benchmarks');
      skipCtx(ctx);
    }

    // Ensure clean state
    await truncateTables({
      tables: ['memory_entities', 'entity_aliases', 'facts', 'entities'],
      acknowledgeGlobal: true,
    });
  });

  afterAll(async () => {
    // Cleanup
    await truncateTables({
      tables: ['memory_entities', 'entity_aliases', 'facts', 'entities'],
      acknowledgeGlobal: true,
    });
  });

  describe('Database Operations', () => {
    bench(
      'Entity creation with embedding',
      async () => {
        const embedding = normalizeVector(randomEmbedding());
        const embeddingStr = `[${embedding.join(',')}]`;

        await testDb`
          INSERT INTO entities (canonical_name, entity_type, embedding)
          VALUES (${'Bench Entity ' + Date.now()}, 'person', ${embeddingStr}::vector)
        `;
      },
      {
        iterations: 100,
        time: 10000,
      }
    );

    bench(
      'Fact creation',
      async () => {
        // First create entities for the fact
        const embedding = normalizeVector(randomEmbedding());
        const embeddingStr = `[${embedding.join(',')}]`;

        const subject = await testDb`
          INSERT INTO entities (canonical_name, entity_type, embedding)
          VALUES (${'Subject ' + Date.now()}, 'person', ${embeddingStr}::vector)
          RETURNING id
        `;

        const object = await testDb`
          INSERT INTO entities (canonical_name, entity_type, embedding)
          VALUES (${'Object ' + Date.now()}, 'company', ${embeddingStr}::vector)
          RETURNING id
        `;

        await testDb`
          INSERT INTO facts (subject_entity_id, predicate, object_entity_id, confidence)
          VALUES (${subject[0]!.id}::uuid, 'works_at', ${object[0]!.id}::uuid, 0.9)
        `;
      },
      {
        iterations: 50,
        time: 10000,
      }
    );

    bench(
      'Entity similarity search (embedding)',
      async () => {
        const queryEmbedding = normalizeVector(randomEmbedding());
        const embeddingStr = `[${queryEmbedding.join(',')}]`;

        await testDb`
          SELECT id, canonical_name, 1 - (embedding <=> ${embeddingStr}::vector) as similarity
          FROM entities
          WHERE embedding IS NOT NULL
          ORDER BY embedding <=> ${embeddingStr}::vector
          LIMIT 10
        `;
      },
      {
        iterations: 100,
        time: 10000,
      }
    );

    bench(
      'Point-in-time fact query',
      async () => {
        const queryDate = new Date();

        await testDb`
          SELECT * FROM facts_at_time(${queryDate})
          LIMIT 100
        `;
      },
      {
        iterations: 100,
        time: 5000,
      }
    );

    bench(
      'Entity alias lookup',
      async () => {
        await testDb`
          SELECT e.*
          FROM entities e
          LEFT JOIN entity_aliases a ON e.id = a.entity_id
          WHERE e.canonical_name ILIKE 'John%'
             OR a.alias ILIKE 'John%'
          LIMIT 10
        `;
      },
      {
        iterations: 100,
        time: 5000,
      }
    );
  });

  describe('Vector Search (Qdrant)', () => {
    bench(
      'Vector search query',
      async () => {
        const queryVector = normalizeVector(randomEmbedding());

        await fetch(`${QDRANT_URL}/collections/memories/points/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vector: queryVector,
            limit: 10,
            with_payload: true,
          }),
        });
      },
      {
        iterations: 50,
        time: 10000,
      }
    );

    bench(
      'Filtered vector search',
      async () => {
        const queryVector = normalizeVector(randomEmbedding());

        await fetch(`${QDRANT_URL}/collections/memories/points/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vector: queryVector,
            filter: {
              must: [{ key: 'type', match: { value: 'thought' } }],
            },
            limit: 10,
            with_payload: true,
          }),
        });
      },
      {
        iterations: 50,
        time: 10000,
      }
    );
  });

  describe('ML Services', () => {
    bench(
      'Embedding generation',
      async () => {
        await fetch(`${ML_SERVICES_URL}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'This is a sample text for embedding generation benchmark',
          }),
        });
      },
      {
        iterations: 20,
        time: 60000, // Longer timeout for LLM
      }
    );

    bench(
      'Classification',
      async () => {
        await fetch(`${ML_SERVICES_URL}/classify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'Remember to call John about the project tomorrow',
          }),
        });
      },
      {
        iterations: 10,
        time: 60000,
      }
    );

    bench(
      'Entity extraction',
      async () => {
        await fetch(`${ML_SERVICES_URL}/extract-entities`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'Meeting with John Smith at Google headquarters in San Francisco',
          }),
        });
      },
      {
        iterations: 10,
        time: 60000,
      }
    );
  });

  describe('Combined Operations', () => {
    bench(
      'Full memory ingestion (embed + store)',
      async () => {
        const text = 'Benchmark memory content ' + Date.now();

        // Embed
        const embedResponse = await fetch(`${ML_SERVICES_URL}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        const { embedding } = await embedResponse.json() as { embedding: number[] };

        // Store
        const memoryId = randomUUID();
        await fetch(`${QDRANT_URL}/collections/memories/points`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            points: [
              {
                id: memoryId,
                vector: embedding,
                payload: { content: text, type: 'thought' },
              },
            ],
          }),
        });
      },
      {
        iterations: 10,
        time: 120000,
      }
    );
  });
});
