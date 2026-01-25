/**
 * Hybrid Search Service
 * 
 * Combines vector search (Qdrant), graph traversal (Apache AGE), 
 * and keyword search using Reciprocal Rank Fusion (RRF).
 * 
 * Based on LightRAG research achieving <100 token cost per query.
 */

import { config } from '../config.js';
import { findConnectedEntities } from './graph.js';
import { resolveEntity, type EntityType } from './entities.js';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

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
  const embedding = await generateEmbedding(query);
  
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
async function vectorSearch(
  embedding: number[],
  limit: number
): Promise<HybridSearchResult[]> {
  try {
    const response = await fetch(`${config.QDRANT_URL}/collections/memories/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector: embedding,
        limit,
        with_payload: true,
      }),
    });
    
    if (!response.ok) {
      console.warn('Vector search failed:', response.status);
      return [];
    }
    
    const data = await response.json() as {
      result?: Array<{
        id: string;
        score: number;
        payload?: { content?: string; type?: string };
      }>;
    };
    
    return (data.result || []).map(r => ({
      memoryId: String(r.id),
      score: r.score,
      source: 'vector' as const,
      fusedScore: 0,
      content: r.payload?.content || '',
      type: r.payload?.type || 'unknown',
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
    const result = await db.execute(sql`
      SELECT DISTINCT me.memory_id, COUNT(*) as relevance
      FROM memory_entities me
      WHERE me.entity_id = ANY(${entityIds}::uuid[])
      GROUP BY me.memory_id
      ORDER BY relevance DESC
      LIMIT ${limit}
    `);
    
    const memoryIds = (result as unknown as { rows: Array<{ memory_id: string }> }).rows
      .map(r => r.memory_id);
    
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
async function keywordSearch(
  query: string,
  limit: number
): Promise<HybridSearchResult[]> {
  try {
    // Split query into keywords
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
    
    if (keywords.length === 0) return [];
    
    const response = await fetch(`${config.QDRANT_URL}/collections/memories/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          should: keywords.map(keyword => ({
            key: 'content',
            match: { text: keyword },
          })),
        },
        limit,
        with_payload: true,
      }),
    });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json() as {
      result?: {
        points?: Array<{
          id: string;
          payload?: { content?: string; type?: string };
        }>;
      };
    };
    
    return (data.result?.points || []).map((p, i) => ({
      memoryId: String(p.id),
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
    
    const data = await response.json() as {
      entities?: Array<{ mention: string; type: string }>;
    };
    
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
async function getMemoryById(id: string): Promise<{ id: string; content: string; type: string } | null> {
  try {
    const response = await fetch(
      `${config.QDRANT_URL}/collections/memories/points/${id}`
    );
    if (!response.ok) return null;
    
    const data = await response.json() as {
      result?: { id: string; payload?: { content?: string; type?: string } };
    };
    
    return {
      id: data.result?.id || id,
      content: data.result?.payload?.content || '',
      type: data.result?.payload?.type || 'unknown',
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
    const result = await db.execute(sql`
      SELECT memory_id FROM memory_entities WHERE entity_id = ${entityId}
    `);
    return (result as unknown as { rows: Array<{ memory_id: string }> }).rows
      .map(r => r.memory_id);
  } catch {
    return [];
  }
}

/**
 * Generate embedding via ML service
 */
async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    
    if (!response.ok) return [];
    
    const data = await response.json() as { embedding?: number[]; vector?: number[] };
    return data.embedding || data.vector || [];
  } catch {
    return [];
  }
}
