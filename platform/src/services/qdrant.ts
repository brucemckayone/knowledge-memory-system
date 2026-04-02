import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';

// Initialize client
export const qdrant = new QdrantClient({
  url: config.QDRANT_URL,
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
