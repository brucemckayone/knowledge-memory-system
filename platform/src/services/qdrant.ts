import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';

// Initialize client
export const qdrant = new QdrantClient({
  url: config.QDRANT_URL,
  checkCompatibility: false,
});

// Collection names.
//
// MEMORIES is env-driven via a LAZY getter (bead nmemo-wow): it reads
// process.env.QDRANT_COLLECTION at *access* time, not at module-import time.
// This matters because the vitest setupFile (src/test/setup.ts) sets
// QDRANT_COLLECTION='memories_test' before any test imports this module, but a
// plain `as const` literal — or even `process.env.QDRANT_COLLECTION ?? 'memories'`
// evaluated once at import — would bind the name too early and tests would still
// hit the production 'memories' collection (the exact contamination bug this
// fixes). With the getter, every consumer that reads COLLECTIONS.MEMORIES
// resolves the current env value:
//   - production / benchmark (no env var) → 'memories' (unchanged behaviour)
//   - under vitest                        → 'memories_test' (isolated)
export const COLLECTIONS = {
  get MEMORIES(): string {
    return process.env.QDRANT_COLLECTION ?? 'memories';
  },
} as const;

/**
 * Ensure collections exist; throw on dimension mismatch against EMBED_DIMENSIONS.
 */
export async function ensureCollections(): Promise<void> {
  const collections = await qdrant.getCollections();
  const existing = new Set(collections.collections.map((c) => c.name));

  if (!existing.has(COLLECTIONS.MEMORIES)) {
    await qdrant.createCollection(COLLECTIONS.MEMORIES, {
      vectors: {
        size: config.EMBED_DIMENSIONS,
        distance: 'Cosine',
      },
    });
    console.log(`✅ Created memories collection (size=${config.EMBED_DIMENSIONS})`);
    return;
  }

  // Collection exists — validate dimension against current config.
  const info = await qdrant.getCollection(COLLECTIONS.MEMORIES);
  const vectorsConfig = info.config?.params?.vectors;
  const actualSize =
    vectorsConfig && 'size' in vectorsConfig && typeof vectorsConfig.size === 'number'
      ? vectorsConfig.size
      : undefined;
  if (actualSize !== config.EMBED_DIMENSIONS) {
    throw new Error(
      `Qdrant collection "${COLLECTIONS.MEMORIES}" dimension mismatch: ` +
        `collection has size=${actualSize}, but EMBED_DIMENSIONS=${config.EMBED_DIMENSIONS} ` +
        `(EMBED_MODEL=${config.EMBED_MODEL}). ` +
        `Run clearMemories() to drop and recreate the collection, or revert EMBED_MODEL ` +
        `to the model that originally produced size=${actualSize} vectors.`,
    );
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

/** A Qdrant point: id + vector + payload. */
export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

/**
 * Store a parent window point plus its small overlapping unit satellites in a
 * SINGLE upsert (epic nmemo-yxj, Decision 1). The collection stays single-vector
 * 768-dim Cosine — this writes MORE points (1 parent + N units), not named or
 * multi-vectors. The parent keeps id=memoryId and the whole-window vector so it
 * remains the canonical memory point (extract/getMemory, facts.source_memory_id,
 * entity_meta centroids all key on the parent id); units are separate-id
 * retrieval-only satellites carrying parent_window_id back to the parent.
 *
 * One upsert (parent first, units after) so a window and its units land
 * atomically from Qdrant's perspective — no partial-window state where a unit
 * is searchable before its parent exists.
 */
export async function storeMemoryWithUnits(args: {
  parent: QdrantPoint;
  units: QdrantPoint[];
}): Promise<void> {
  await qdrant.upsert(COLLECTIONS.MEMORIES, {
    points: [args.parent, ...args.units],
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
