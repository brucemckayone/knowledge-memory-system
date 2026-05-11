import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';

// Initialize client
export const qdrant = new QdrantClient({
  url: config.QDRANT_URL,
  checkCompatibility: false,
});

// Collection names
export const COLLECTIONS = {
  MEMORIES: 'memories',
} as const;

/**
 * Ensure collections exist with correct schema
 */
export async function ensureCollections(): Promise<void> {
  const collections = await qdrant.getCollections();
  const existing = new Set(collections.collections.map((c) => c.name));

  // Memories collection
  if (!existing.has(COLLECTIONS.MEMORIES)) {
    await qdrant.createCollection(COLLECTIONS.MEMORIES, {
      vectors: {
        size: config.EMBED_DIMENSIONS,
        distance: 'Cosine',
      },
    });
    console.log('✅ Created memories collection');
  }

}

/**
 * Store a memory in Qdrant
 */
export async function storeMemory(memory: {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}): Promise<void> {
  await qdrant.upsert(COLLECTIONS.MEMORIES, {
    points: [
      {
        id: memory.id,
        vector: memory.vector,
        payload: memory.payload,
      },
    ],
  });
}

/**
 * Update vector and payload for a point
 */
export async function updateVector(
  id: string,
  vector: number[],
  payload?: Record<string, unknown>
): Promise<void> {
  await qdrant.upsert(COLLECTIONS.MEMORIES, {
    points: [
      {
        id,
        vector,
        payload,
      },
    ],
  });
}

/**
 * Search memories by vector similarity
 */
export async function searchMemories(
  vector: number[],
  options: {
    limit?: number;
    filter?: Record<string, unknown>;
    with_payload?: boolean;
  } = {}
) {
  const { limit = 5, filter, with_payload = true } = options;

  const results = await qdrant.search(COLLECTIONS.MEMORIES, {
    vector,
    limit,
    with_payload,
    filter: filter as any,
  });

  return results;
}

/**
 * Update point payload
 */
export async function updatePayload(id: string, payload: Record<string, unknown>): Promise<void> {
  await qdrant.setPayload(COLLECTIONS.MEMORIES, {
    points: [id],
    payload,
  });
}

/**
 * Get memory by ID
 */
export async function getMemory(id: string) {
  const results = await qdrant.retrieve(COLLECTIONS.MEMORIES, {
    ids: [id],
    with_payload: true,
    with_vector: false,
  });
  return results[0] ?? null;
}

/**
 * Retrieve vectors for multiple memory IDs.
 * Used by graph-meta to compute entity centroids from source vectors.
 *
 * Returns the Map sorted by memory id so callers that accumulate values in
 * iteration order (e.g. centroid mean computation in graph-meta) produce
 * stable IEEE-754 results across calls. Qdrant's retrieve does not guarantee
 * response ordering — segment-internal — and floating-point addition is not
 * associative, so an unsorted iteration would yield slightly different
 * centroids on each call. Sorting fixes both reproducibility and snapshot
 * byte-stability.
 */
export async function getMemoryVectors(ids: string[]): Promise<Map<string, number[]>> {
  if (ids.length === 0) return new Map();
  const results = await qdrant.retrieve(COLLECTIONS.MEMORIES, {
    ids,
    with_payload: false,
    with_vector: true,
  });
  const sorted = [...results].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const map = new Map<string, number[]>();
  for (const r of sorted) {
    if (r.vector && Array.isArray(r.vector)) {
      map.set(String(r.id), r.vector as number[]);
    }
  }
  return map;
}

/**
 * Delete and recreate the memories collection (full reset).
 */
export async function clearMemories(): Promise<void> {
  try {
    await qdrant.deleteCollection(COLLECTIONS.MEMORIES);
  } catch {
    // Collection may not exist — that's fine
  }
  await qdrant.createCollection(COLLECTIONS.MEMORIES, {
    vectors: {
      size: config.EMBED_DIMENSIONS,
      distance: 'Cosine',
    },
  });
}

/**
 * Health check
 */
export async function checkQdrantHealth(): Promise<boolean> {
  try {
    await qdrant.getCollections();
    return true;
  } catch {
    return false;
  }
}
