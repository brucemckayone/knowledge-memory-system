import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';

// Initialize client
export const qdrant = new QdrantClient({
  url: config.QDRANT_URL,
});

// Collection names
export const COLLECTIONS = {
  MEMORIES: 'memories',
  CONTEXTS: 'contexts',
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

  // Contexts collection
  if (!existing.has(COLLECTIONS.CONTEXTS)) {
    await qdrant.createCollection(COLLECTIONS.CONTEXTS, {
      vectors: {
        size: config.EMBED_DIMENSIONS,
        distance: 'Cosine',
      },
    });
    console.log('✅ Created contexts collection');
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
 * Scroll points (for keyword search / filtering)
 */
export async function scrollPoints(
  filter: Record<string, unknown>,
  options: {
    limit?: number;
    with_payload?: boolean;
    offset?: string; // Qdrant scroll API uses offset / point id
  } = {}
) {
  const { limit = 10, with_payload = true, offset } = options;

  const results = await qdrant.scroll(COLLECTIONS.MEMORIES, {
    filter: filter as any,
    limit,
    with_payload,
    offset,
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
