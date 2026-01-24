# Work Packet W19: Hybrid Retrieval

**Status:** Ready to Implement  
**Dependencies:** W18 (Apache AGE)  
**Estimated Time:** 3-4 hours

---

## Objective

Implement hybrid retrieval that combines vector search (Qdrant), graph traversal (Apache AGE), and keyword search (BM25) using Reciprocal Rank Fusion (RRF) to produce superior search results.

---

## Research Reference

From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 267-293:
- Parallel execution of vector and graph searches
- RRF fusion with k=60 constant
- LightRAG achieves <100 token cost per query

---

## Architecture

```
Query: "What did John say about the deadline?"
         │
         ├──────────────────┬──────────────────┐
         ▼                  ▼                  ▼
   [Vector Search]    [Graph Traversal]   [BM25 Keyword]
   (Qdrant)           (Apache AGE)        (PostgreSQL)
         │                  │                  │
         └──────────────────┼──────────────────┘
                            ▼
                    [RRF Fusion (k=60)]
                            │
                            ▼
                    [Ranked Results]
```

---

## Implementation

### Hybrid Search Service

Create `platform/src/services/hybrid-search.ts`:

```typescript
import { embed } from './ml.js';
import { searchMemories } from './qdrant.js';
import { findConnectedEntities } from './graph.js';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { config } from '../config.js';

export interface HybridSearchResult {
  memoryId: string;
  score: number;
  source: 'vector' | 'graph' | 'keyword';
  fusedScore: number;
  content: string;
  type: string;
}

export interface HybridSearchOptions {
  limit?: number;
  vectorWeight?: number;
  graphWeight?: number;
  keywordWeight?: number;
  includeGraph?: boolean;
  includeKeyword?: boolean;
}

const DEFAULT_OPTIONS: HybridSearchOptions = {
  limit: 10,
  vectorWeight: 1.0,
  graphWeight: 0.8,
  keywordWeight: 0.6,
  includeGraph: true,
  includeKeyword: true,
};

/**
 * Hybrid search combining vector, graph, and keyword approaches
 */
export async function hybridSearch(
  query: string,
  options: HybridSearchOptions = {}
): Promise<HybridSearchResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const fetchLimit = (opts.limit || 10) * 2;  // Over-fetch for fusion
  
  // Extract entities from query for graph search
  const queryEntities = await extractQueryEntities(query);
  
  // Generate embedding for vector search
  const embeddingResult = await embed(query);
  
  // Execute searches in parallel
  const searches = [
    vectorSearch(embeddingResult.vector, fetchLimit),
  ];
  
  if (opts.includeGraph && queryEntities.length > 0) {
    searches.push(graphSearch(queryEntities, fetchLimit));
  }
  
  if (opts.includeKeyword) {
    searches.push(keywordSearch(query, fetchLimit));
  }
  
  const results = await Promise.all(searches);
  
  const [vectorResults, graphResults = [], keywordResults = []] = results;
  
  // Apply RRF fusion
  const fused = reciprocalRankFusion(
    [
      { results: vectorResults, weight: opts.vectorWeight || 1.0 },
      { results: graphResults, weight: opts.graphWeight || 0.8 },
      { results: keywordResults, weight: opts.keywordWeight || 0.6 },
    ],
    60  // Standard RRF constant
  );
  
  return fused.slice(0, opts.limit || 10);
}

/**
 * Vector search using Qdrant
 */
async function vectorSearch(
  embedding: number[],
  limit: number
): Promise<HybridSearchResult[]> {
  const results = await searchMemories(embedding, { limit });
  
  return results.map(r => ({
    memoryId: r.id,
    score: r.score,
    source: 'vector' as const,
    fusedScore: 0,
    content: r.payload?.content || '',
    type: r.payload?.type || 'unknown',
  }));
}

/**
 * Graph search using Apache AGE
 */
async function graphSearch(
  entityIds: string[],
  limit: number
): Promise<HybridSearchResult[]> {
  if (entityIds.length === 0) return [];
  
  // Find memories connected to query entities
  const entityList = entityIds.map(id => `'${id}'`).join(', ');
  
  try {
    const result = await db.execute(sql`
      SELECT * FROM cypher('knowledge_graph', $$
        MATCH (e:Entity)-[:MENTIONS]-(m:Memory)
        WHERE e.entity_id IN [${sql.raw(entityList)}]
        RETURN DISTINCT m.memory_id as memory_id, count(e) as relevance
        ORDER BY relevance DESC
        LIMIT ${limit}
      $$) as (memory_id agtype, relevance agtype)
    `);
    
    // Fetch memory details from Qdrant
    const memoryIds = result.rows.map((r: any) => 
      String(r.memory_id).replace(/"/g, '')
    );
    
    const memories = await Promise.all(
      memoryIds.map(id => getMemoryById(id))
    );
    
    return memories.filter(Boolean).map((m, i) => ({
      memoryId: m!.id,
      score: parseFloat(String(result.rows[i].relevance)) / 10,  // Normalize
      source: 'graph' as const,
      fusedScore: 0,
      content: m!.content || '',
      type: m!.type || 'unknown',
    }));
    
  } catch (error) {
    console.warn('Graph search failed:', error);
    return [];
  }
}

/**
 * Keyword search using PostgreSQL full-text search
 */
async function keywordSearch(
  query: string,
  limit: number
): Promise<HybridSearchResult[]> {
  // Use Qdrant's payload filtering with keyword match
  // Or implement PostgreSQL FTS for memory content
  
  try {
    const response = await fetch(`${config.QDRANT_URL}/collections/memories/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          should: [
            {
              key: 'content',
              match: { text: query },
            },
            {
              key: 'summary',
              match: { text: query },
            },
          ],
        },
        limit,
        with_payload: true,
      }),
    });
    
    const data = await response.json();
    
    return (data.result?.points || []).map((p: any, i: number) => ({
      memoryId: p.id,
      score: 1 / (i + 1),  // Position-based score
      source: 'keyword' as const,
      fusedScore: 0,
      content: p.payload?.content || '',
      type: p.payload?.type || 'unknown',
    }));
    
  } catch (error) {
    console.warn('Keyword search failed:', error);
    return [];
  }
}

/**
 * Extract entities from query using LLM
 */
async function extractQueryEntities(query: string): Promise<string[]> {
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/extract-entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: query }),
    });
    
    if (!response.ok) return [];
    
    const data = await response.json();
    
    // Resolve entity mentions to IDs
    const entityIds: string[] = [];
    for (const entity of data.entities || []) {
      const resolved = await resolveEntityMention(entity.mention);
      if (resolved) {
        entityIds.push(resolved.id);
      }
    }
    
    return entityIds;
  } catch {
    return [];
  }
}

/**
 * Reciprocal Rank Fusion
 */
function reciprocalRankFusion(
  resultSets: Array<{ results: HybridSearchResult[]; weight: number }>,
  k: number = 60
): HybridSearchResult[] {
  const scores: Map<string, { score: number; item: HybridSearchResult }> = new Map();
  
  for (const { results, weight } of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const item = results[rank];
      const rrfScore = weight / (k + rank + 1);
      
      const existing = scores.get(item.memoryId);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(item.memoryId, { score: rrfScore, item });
      }
    }
  }
  
  // Sort by fused score
  const sorted = Array.from(scores.values())
    .sort((a, b) => b.score - a.score);
  
  return sorted.map(s => ({
    ...s.item,
    fusedScore: s.score,
  }));
}

/**
 * Helper to get memory by ID
 */
async function getMemoryById(id: string): Promise<{ id: string; content: string; type: string } | null> {
  try {
    const response = await fetch(
      `${config.QDRANT_URL}/collections/memories/points/${id}`
    );
    if (!response.ok) return null;
    
    const data = await response.json();
    return {
      id: data.result?.id,
      content: data.result?.payload?.content,
      type: data.result?.payload?.type,
    };
  } catch {
    return null;
  }
}

/**
 * Helper to resolve entity mention
 */
async function resolveEntityMention(mention: string): Promise<{ id: string } | null> {
  // Import from entities service
  const { resolveEntity } = await import('./entities.js');
  try {
    const resolved = await resolveEntity(mention, '', undefined);
    return { id: resolved.id };
  } catch {
    return null;
  }
}
```

---

## Update Search Endpoint

Update `platform/src/app.ts` to use hybrid search:

```typescript
import { hybridSearch } from './services/hybrid-search.js';

// New hybrid search endpoint
app.get('/api/hybrid-search', async (c) => {
  const query = c.req.query('q');
  const limit = parseInt(c.req.query('limit') || '10');
  const includeGraph = c.req.query('graph') !== 'false';
  
  if (!query) {
    return c.json({ error: 'Query required' }, 400);
  }
  
  const results = await hybridSearch(query, {
    limit,
    includeGraph,
  });
  
  return c.json({
    query,
    count: results.length,
    results: results.map(r => ({
      id: r.memoryId,
      score: r.fusedScore,
      source: r.source,
      content: r.content,
      type: r.type,
    })),
  });
});
```

---

## Verification

### Automated Tests

```bash
# Create platform/src/services/__tests__/hybrid-search.test.ts
import { hybridSearch } from '../hybrid-search.js';
import { describe, it, expect, vi } from 'vitest';

describe('Hybrid Search', () => {
  it('should combine results using RRF', async () => {
      // Mock vector and graph searches
      // Verify fused scores
  });
});
```

### Manual Verification

```bash
# Test hybrid search
curl "http://localhost:3001/api/hybrid-search?q=project%20deadline"

# Compare with vector-only
curl "http://localhost:3001/api/search?q=project%20deadline"
```

---

## Acceptance Criteria

- [ ] `hybridSearch()` executes all three search types
- [ ] Vector search uses Qdrant
- [ ] Graph search uses Apache AGE
- [ ] Keyword search uses Qdrant filtering
- [ ] RRF fusion combines results correctly
- [ ] API endpoint returns fused results
- [ ] Results include source attribution
- [ ] Performance under 500ms for typical queries

---

## Next Packet

- [W20: Entity Extraction Skill](./W20-entity-extraction.md) - Add to Phase 2 pipeline
