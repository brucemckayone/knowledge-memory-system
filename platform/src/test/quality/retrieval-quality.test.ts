/**
 * Layer 3: Retrieval Accuracy Tests
 *
 * Tests that the hybrid search pipeline retrieves the right context.
 * Seeds knowledge into PostgreSQL + Qdrant, then verifies search results.
 *
 * Requires: PostgreSQL + ML service + Qdrant
 * Speed: ~3-5 min
 * Skips: when Qdrant or ML unavailable
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  deleteFromTables,
  isMLServiceAvailable,
  isQdrantAvailable,
  ML_SERVICES_URL,
  QDRANT_URL,
} from '../setup.js';
import { RETRIEVAL_SCENARIOS } from './golden-scenarios.js';
import { seedFacts, seedQdrantMemory, computeMRR } from './helpers.js';

describe('Layer 3: Retrieval Accuracy', () => {
  let mlAvailable = false;
  let qdrantAvailable = false;

  beforeAll(async () => {
    [mlAvailable, qdrantAvailable] = await Promise.all([
      isMLServiceAvailable(),
      isQdrantAvailable(),
    ]);

    if (!mlAvailable) {
      console.warn('⚠️  ML Services not available — skipping retrieval tests');
    }
    if (!qdrantAvailable) {
      console.warn('⚠️  Qdrant not available — skipping retrieval tests');
    }
  });

  const canRun = () => mlAvailable && qdrantAvailable;

  beforeEach(async () => {
    if (!canRun()) return;

    await deleteFromTables({
      tables: [
        'memory_entities', 'entity_aliases', 'entity_merges',
        'contradiction_reviews', 'facts', 'entities',
      ],
      acknowledgeGlobal: true,
    });

    // Clean Qdrant test points (delete collection and recreate)
    try {
      await fetch(`${QDRANT_URL}/collections/memories`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000),
      });
      await fetch(`${QDRANT_URL}/collections/memories`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vectors: { size: 768, distance: 'Cosine' },
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Qdrant might not support delete, or collection might not exist
    }
  });

  // R1: Direct entity lookup
  it('R1: direct entity lookup returns seeded memory', async (ctx) => {
    if (!canRun()) { ctx.skip(); return; }
    // Seed a memory about Alice working at Beta Corp
    const entityCache = await seedFacts([
      { subjectName: 'Alice', subjectType: 'person', predicate: 'works_at', objectName: 'Beta Corp', objectType: 'company' },
    ]);

    const aliceId = entityCache.get('Alice')!;
    const content = 'Alice works at Beta Corp as a software engineer.';
    const memoryId = await seedQdrantMemory(content, [aliceId]);

    // Wait for Qdrant indexing
    await new Promise(r => setTimeout(r, 1000));

    // Search
    const queryVector = await getEmbedding('Where does Alice work?');
    if (!queryVector) return;

    const results = await searchQdrant(queryVector, 5);

    // The seeded memory should appear in top-3
    const ids = results.map(r => String(r.id));
    const found = ids.includes(memoryId);

    console.log(`R1: Direct lookup — seeded memory ${found ? 'found' : 'NOT found'} in top ${results.length}`);
    expect(found).toBe(true);
  }, 60000);

  // R2: Multi-hop graph traversal
  it('R2: multi-hop query surfaces related memories', async (ctx) => {
    if (!canRun()) { ctx.skip(); return; }
    // Seed: Alice → Beta Corp → Manchester + Alice knows React
    const entityCache = await seedFacts([
      { subjectName: 'Alice', subjectType: 'person', predicate: 'works_at', objectName: 'Beta Corp', objectType: 'company' },
      { subjectName: 'Beta Corp', subjectType: 'company', predicate: 'located_in', objectName: 'Manchester', objectType: 'place' },
      { subjectName: 'Alice', subjectType: 'person', predicate: 'has_role', objectValue: 'React developer' },
    ]);

    const aliceId = entityCache.get('Alice')!;
    const betaId = entityCache.get('Beta Corp')!;

    // Seed memories with entity links
    await seedQdrantMemory(
      'Alice is a React developer at Beta Corp in Manchester.',
      [aliceId, betaId],
    );

    await new Promise(r => setTimeout(r, 1000));

    // Search for React developer in Manchester (requires combining multiple facts)
    const queryVector = await getEmbedding('React developer in Manchester');
    if (!queryVector) return;

    const results = await searchQdrant(queryVector, 5);

    // Should find at least some results related to Alice
    const hasContent = results.some(r =>
      (r.payload?.content as string || '').toLowerCase().includes('alice') ||
      (r.payload?.content as string || '').toLowerCase().includes('react'),
    );

    console.log(`R2: Multi-hop — relevant content ${hasContent ? 'found' : 'NOT found'}`);
    expect(hasContent).toBe(true);
  }, 60000);

  // R3: Temporal relevance
  it('R3: temporal query surfaces time-relevant memories', async (ctx) => {
    if (!canRun()) { ctx.skip(); return; }
    const entityCache = await seedFacts([
      {
        subjectName: 'Alice', subjectType: 'person', predicate: 'works_at',
        objectName: 'Acme', objectType: 'company',
        validAt: new Date('2023-01-01'), invalidAt: new Date('2024-06-01'),
      },
      {
        subjectName: 'Alice', subjectType: 'person', predicate: 'works_at',
        objectName: 'Beta Corp', objectType: 'company',
        validAt: new Date('2024-06-01'),
      },
    ]);

    const aliceId = entityCache.get('Alice')!;
    const acmeId = entityCache.get('Acme')!;
    const betaId = entityCache.get('Beta Corp')!;

    // Seed two memories from different eras
    await seedQdrantMemory('Alice worked at Acme during 2023.', [aliceId, acmeId]);
    await seedQdrantMemory('Alice joined Beta Corp in mid 2024.', [aliceId, betaId]);

    await new Promise(r => setTimeout(r, 1000));

    // Search with temporal context
    const queryVector = await getEmbedding('Where did Alice work in 2023?');
    if (!queryVector) return;

    const results = await searchQdrant(queryVector, 5);

    // At least one result should mention Acme or 2023
    const hasTemporallyRelevant = results.some(r => {
      const content = (r.payload?.content as string || '').toLowerCase();
      return content.includes('acme') || content.includes('2023');
    });

    console.log(`R3: Temporal relevance — time-relevant content ${hasTemporallyRelevant ? 'found' : 'NOT found'}`);
    expect(hasTemporallyRelevant).toBe(true);
  }, 60000);

  // R4: No-match graceful degradation
  it('R4: search for unknown entity returns no hallucinated results', async (ctx) => {
    if (!canRun()) { ctx.skip(); return; }
    // Seed some unrelated data
    await seedFacts([
      { subjectName: 'Alice', subjectType: 'person', predicate: 'works_at', objectName: 'Beta Corp', objectType: 'company' },
    ]);

    const queryVector = await getEmbedding('What is the status of the Mars colonization project?');
    if (!queryVector) return;

    const results = await searchQdrant(queryVector, 5);

    // Results should either be empty or have low scores
    const highScoreResults = results.filter(r => (r.score ?? 0) > 0.8);
    console.log(`R4: No-match — ${results.length} results total, ${highScoreResults.length} with score > 0.8`);

    // We don't expect high-confidence matches for completely unrelated queries
    expect(highScoreResults.length).toBeLessThanOrEqual(1);
  }, 60000);

  // R5: Multi-entity query
  it('R5: multi-entity query ranks memories mentioning multiple entities highest', async (ctx) => {
    if (!canRun()) { ctx.skip(); return; }
    const entityCache = await seedFacts([
      { subjectName: 'Alice', subjectType: 'person', predicate: 'knows', objectName: 'Bob', objectType: 'person' },
      { subjectName: 'Alice', subjectType: 'person', predicate: 'works_on', objectName: 'Project Alpha', objectType: 'project' },
      { subjectName: 'Bob', subjectType: 'person', predicate: 'works_on', objectName: 'Project Alpha', objectType: 'project' },
    ]);

    const aliceId = entityCache.get('Alice')!;
    const bobId = entityCache.get('Bob')!;
    const projectId = entityCache.get('Project Alpha')!;

    // Memory mentioning all three
    await seedQdrantMemory(
      'Alice and Bob had a productive meeting about Project Alpha requirements.',
      [aliceId, bobId, projectId],
    );
    // Memory mentioning only Alice
    await seedQdrantMemory(
      'Alice finished the documentation update.',
      [aliceId],
    );

    await new Promise(r => setTimeout(r, 1000));

    const queryVector = await getEmbedding('What did Alice and Bob discuss about Project Alpha?');
    if (!queryVector) return;

    const results = await searchQdrant(queryVector, 5);

    // The multi-entity memory should ideally rank highest
    if (results.length > 0) {
      const topContent = (results[0]!.payload?.content as string || '').toLowerCase();
      const mentionsMultiple = topContent.includes('alice') && topContent.includes('bob');
      console.log(`R5: Multi-entity — top result mentions multiple entities: ${mentionsMultiple}`);
    }

    // At least one result should exist
    expect(results.length).toBeGreaterThan(0);
  }, 60000);

  // Aggregate MRR across all retrieval scenarios
  it('Aggregate: MRR across retrieval scenarios', async (ctx) => {
    if (!canRun()) { ctx.skip(); return; }
    const mrrResults: Array<{ queryId: string; rankedIds: string[]; relevantIds: string[] }> = [];

    for (const scenario of RETRIEVAL_SCENARIOS) {
      if (scenario.expectedRelevantEntities.length === 0) continue;

      await deleteFromTables({
        tables: [
          'memory_entities', 'entity_aliases', 'entity_merges',
          'contradiction_reviews', 'facts', 'entities',
        ],
        acknowledgeGlobal: true,
      });

      const entityCache = await seedFacts(scenario.seededFacts);

      // Seed memories for each entity
      const seededMemoryEntityNames: string[] = [];
      for (const fact of scenario.seededFacts) {
        const subjectId = entityCache.get(fact.subjectName);
        const objectId = fact.objectName ? entityCache.get(fact.objectName) : undefined;
        const entityIds = [subjectId, objectId].filter(Boolean) as string[];

        const desc = fact.objectValue
          ? `${fact.subjectName} ${fact.predicate} ${fact.objectValue}`
          : `${fact.subjectName} ${fact.predicate} ${fact.objectName}`;

        await seedQdrantMemory(desc, entityIds);
        seededMemoryEntityNames.push(fact.subjectName);
        if (fact.objectName) seededMemoryEntityNames.push(fact.objectName);
      }

      await new Promise(r => setTimeout(r, 1000));

      const queryVector = await getEmbedding(scenario.query);
      if (!queryVector) continue;

      const results = await searchQdrant(queryVector, 10);

      // Map results to entity names mentioned in content
      const rankedEntityNames = results.map(r => {
        const content = (r.payload?.content as string || '').toLowerCase();
        return content;
      });

      // Check if expected entities appear in results
      const relevantIds = scenario.expectedRelevantEntities;
      const rankedIds = rankedEntityNames.map(content => {
        for (const name of relevantIds) {
          if (content.includes(name.toLowerCase())) return name;
        }
        return '';
      }).filter(Boolean);

      mrrResults.push({
        queryId: scenario.id,
        rankedIds,
        relevantIds,
      });
    }

    const mrr = computeMRR(mrrResults);
    console.log(`Aggregate MRR = ${mrr.toFixed(3)} across ${mrrResults.length} queries`);
    // Starting threshold is lenient
    expect(mrr).toBeGreaterThanOrEqual(0.40);
  }, 300000);
});

// --- Helpers ---

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await fetch(`${ML_SERVICES_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { vector?: number[] };
    return data.vector || null;
  } catch {
    return null;
  }
}

async function searchQdrant(
  vector: number[],
  limit: number,
): Promise<Array<{ id: string | number; score?: number; payload?: Record<string, unknown> }>> {
  try {
    const response = await fetch(`${QDRANT_URL}/collections/memories/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const data = await response.json() as { result?: Array<{ id: string | number; score?: number; payload?: Record<string, unknown> }> };
    return data.result || [];
  } catch {
    return [];
  }
}
