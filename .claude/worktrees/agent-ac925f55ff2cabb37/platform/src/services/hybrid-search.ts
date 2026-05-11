/**
 * Hybrid Search Service
 * 
 * Combines vector search (Qdrant), graph traversal (Apache AGE), 
 * and keyword search using Reciprocal Rank Fusion (RRF).
 * 
 * Based on LightRAG research achieving <100 token cost per query.
 */

import { findConnectedEntities } from './graph.js';
import { resolveEntity, type EntityType } from './entities.js';
import { sql, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { memoryEntities } from '../db/schema.js';
import { embed, extractEntities } from './ml.js';
import { searchMemories, scrollPoints, getMemory } from './qdrant.js';

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
  const embedding = await embed(query).then(res => res.vector).catch(() => []);
  
  // Execute searches in parallel
  const searches: Promise<HybridSearchResult[]>[] = [];
  
  // Vector search is always included
  if (embedding && embedding.length > 0) {
    searches.push(vectorSearch(embedding, fetchLimit));
  }
  
  // Graph search if enabled and entities found
  if (opts.includeGraph && queryEntities.length > 0) {
    searches.push(graphSearch(queryEntities, fetchLimit));
  }
  
  // Keyword search if enabled
  if (opts.includeKeyword) {
    searches.push(keywordSearch(query, fetchLimit));
  }
  
  const results = await Promise.all(searches);
  
  // Prepare result sets with weights
  const resultSets: Array<{ results: HybridSearchResult[]; weight: number }> = [];
  
  let resultIndex = 0;
  if (embedding && embedding.length > 0) {
    resultSets.push({ results: results[resultIndex++] || [], weight: opts.vectorWeight || 1.0 });
  }
  if (opts.includeGraph && queryEntities.length > 0) {
    resultSets.push({ results: results[resultIndex++] || [], weight: opts.graphWeight || 0.8 });
  }
  if (opts.includeKeyword) {
    resultSets.push({ results: results[resultIndex++] || [], weight: opts.keywordWeight || 0.6 });
  }
  
  // Apply RRF fusion
  const fused = reciprocalRankFusion(resultSets, 60);
  
  return fused.slice(0, opts.limit || 10);
}

/**
 * Vector search using Qdrant
 */
/**
 * Vector search using Qdrant
 */
async function vectorSearch(
  embedding: number[],
  limit: number
): Promise<HybridSearchResult[]> {
  try {
    const results = await searchMemories(embedding, {
      limit,
      with_payload: true,
    });
    
    return results.map(r => ({
      memoryId: String(r.id),
      score: r.score,
      source: 'vector' as const,
      fusedScore: 0,
      content: (r.payload?.content as string) || '',
      type: (r.payload?.type as string) || 'unknown',
    }));
  } catch (error) {
    console.warn('Vector search error:', error);
    return [];
  }
}

/**
 * Graph search using Apache AGE (or fallback to entity-memory links)
 */
async function graphSearch(
  entityIds: string[],
  limit: number
): Promise<HybridSearchResult[]> {
  if (entityIds.length === 0) return [];
  
  try {
    // Try graph traversal first (requires Apache AGE)
    const connectedMemories = new Set<string>();
    
    for (const entityId of entityIds) {
      // Find connected entities
      const connected = await findConnectedEntities(entityId, { maxDepth: 2 });
      
      // Get memories for each connected entity
      for (const entity of connected) {
        const memories = await getMemoriesForEntity(entity.entityId);
        memories.forEach(m => connectedMemories.add(m));
      }
      
      // Also get direct memories
      const directMemories = await getMemoriesForEntity(entityId);
      directMemories.forEach(m => connectedMemories.add(m));
    }
    
    // Fetch memory details
    const memoryDetails = await Promise.all(
      Array.from(connectedMemories).slice(0, limit).map(getMemoryById)
    );
    
    return memoryDetails.filter(Boolean).map((m, i) => ({
      memoryId: m!.id,
      score: 1 / (i + 1),  // Position-based score
      source: 'graph' as const,
      fusedScore: 0,
      content: m!.content || '',
      type: m!.type || 'unknown',
    }));
    
  } catch (error) {
    console.warn('Graph search fallback to memory_entities:', error);
    
    // Fallback: Use memory_entities table directly
    return fallbackGraphSearch(entityIds, limit);
  }
}

/**
 * Fallback graph search using memory_entities table
 */
async function fallbackGraphSearch(
  entityIds: string[],
  limit: number
): Promise<HybridSearchResult[]> {
  try {
    const rows = await rawQuery<{ memoryId: string; relevance: number }>(sql`
      SELECT DISTINCT me.memory_id, COUNT(*) as relevance
      FROM memory_entities me
      WHERE me.entity_id = ANY(${entityIds}::uuid[])
      GROUP BY me.memory_id
      ORDER BY relevance DESC
      LIMIT ${limit}
    `);

    const memoryIds = rows.map(r => r.memoryId);
    
    const memoryDetails = await Promise.all(
      memoryIds.map(getMemoryById)
    );
    
    return memoryDetails.filter(Boolean).map((m, i) => ({
      memoryId: m!.id,
      score: 1 / (i + 1),
      source: 'graph' as const,
      fusedScore: 0,
      content: m!.content || '',
      type: m!.type || 'unknown',
    }));
  } catch {
    return [];
  }
}

/**
 * Keyword search using Qdrant payload filtering
 */
/**
 * Keyword search using Qdrant payload filtering
 */
async function keywordSearch(
  query: string,
  limit: number
): Promise<HybridSearchResult[]> {
  try {
    // Split query into keywords
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
    
    if (keywords.length === 0) return [];
    
    const { points } = await scrollPoints({
      should: keywords.map(keyword => ({
        key: 'content',
        match: { text: keyword },
      })),
    }, { limit, with_payload: true });
    
    return (points || []).map((p, i) => ({
      memoryId: String(p.id),
      score: 1 / (i + 1),  // Position-based score
      source: 'keyword' as const,
      fusedScore: 0,
      content: (p.payload?.content as string) || '',
      type: (p.payload?.type as string) || 'unknown',
    }));
    
  } catch (error) {
    console.warn('Keyword search failed:', error);
    return [];
  }
}

/**
 * Extract entities from query using LLM
 */
/**
 * Extract entities from query using LLM
 */
async function extractQueryEntities(query: string): Promise<string[]> {
  try {
    const data = await extractEntities(query);
    
    // Resolve entity mentions to IDs
    const entityIds: string[] = [];
    for (const entity of data.entities || []) {
      try {
        const resolved = await resolveEntity(
          entity.mention,
          query,
          entity.type as EntityType
        );
        entityIds.push(resolved.id);
      } catch {
        // Skip unresolved entities
      }
    }
    
    return entityIds;
  } catch {
    return [];
  }
}

/**
 * Reciprocal Rank Fusion
 * Combines multiple ranked lists using 1/(k + rank)
 */
function reciprocalRankFusion(
  resultSets: Array<{ results: HybridSearchResult[]; weight: number }>,
  k: number = 60
): HybridSearchResult[] {
  const scores = new Map<string, { score: number; item: HybridSearchResult }>();
  
  for (const { results, weight } of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const item = results[rank]!;
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
    ...s.item!,
    fusedScore: s.score,
  }));
}

/**
 * Helper to get memory by ID from Qdrant
 */
/**
 * Helper to get memory by ID from Qdrant
 */
async function getMemoryById(id: string): Promise<{ id: string; content: string; type: string } | null> {
  try {
    const result = await getMemory(id);
    if (!result) return null;
    
    return {
      id: String(result.id),
      content: (result.payload?.content as string) || '',
      type: (result.payload?.type as string) || 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * Helper to get memories for an entity
 */
async function getMemoriesForEntity(entityId: string): Promise<string[]> {
  try {
    const rows = await db
      .select({ memoryId: memoryEntities.memoryId })
      .from(memoryEntities)
      .where(eq(memoryEntities.entityId, entityId));
    return rows.map(r => r.memoryId);
  } catch {
    return [];
  }
}


