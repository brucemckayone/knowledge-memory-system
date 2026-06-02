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

/** One deduped parent-window result from unit-grained retrieval. */
export interface UnitGroupedHit {
  /** Parent window id (the canonical memory id). */
  id: string;
  /** Best (max) unit score among this parent's matching units. */
  score: number;
  /** How many of this parent's units matched the query (before dedup). */
  matchedUnits: number;
  /** The parent window's full payload (content lives here, not on units). */
  payload: Record<string, unknown> | null | undefined;
  /** The unit_text of the single best-scoring unit for this parent. */
  bestUnitText?: string;
}

/**
 * Unit-grained retrieval read path (epic nmemo-yxj, Decision 1b / bead yxj.3).
 *
 * store() (nmemo-yxj.2) writes one parent `window` point plus N small
 * overlapping `unit` satellites. The window vector is the whole-window
 * embedding — diluted, so a single needle fact averages into noise (the
 * 0.809→0.472 collapse this epic exists to fix). The units are the undiluted
 * vectors. So we SEARCH units, then collapse back to the parent for context:
 *
 *  1. Vector-search with a point_type=unit filter (+ optional stream_id scope)
 *     so ranking happens on the undiluted unit vectors. Over-fetch candidates
 *     (limit × overFetch) because several candidate units can share a parent
 *     and collapse to one result — without over-fetching, k distinct parents
 *     could need more than k raw hits.
 *  2. Group hits by parent_window_id; keep the BEST (max) unit score per
 *     parent — a parent whose multiple units match surfaces ONCE, scored by its
 *     strongest unit (not summed: aggregation that rewards parents merely for
 *     having more units would re-introduce the length bias this epic removes).
 *  3. Return the top-k DISTINCT parents, each with the parent WINDOW payload
 *     (content) fetched via getMemory — never the unit fragment. Window points
 *     are excluded from the search itself, so a window and its units never both
 *     surface as separate results.
 *
 * Pre-yxj.2 fallback: memories stored before unit satellites existed have only
 * a window point and no units, so a unit-filtered search misses them entirely.
 * When the unit search yields zero hits we fall back to a window-filtered
 * search so old data stays retrievable. Mixed corpora are handled naturally:
 * any window WITH units is found via its units; only unit-less windows need the
 * fallback, and the fallback only fires when units found nothing at all.
 */
export async function searchMemoriesByUnit(
  vector: number[],
  options: {
    limit?: number;
    streamId?: string;
    /** Candidate over-fetch multiplier before dedup. Default 5. */
    overFetch?: number;
  } = {},
): Promise<UnitGroupedHit[]> {
  const { limit = 5, streamId, overFetch = 5 } = options;

  const must: Array<Record<string, unknown>> = [
    { key: 'point_type', match: { value: 'unit' } },
  ];
  if (streamId) must.push({ key: 'stream_id', match: { value: streamId } });

  const candidates = await qdrant.search(COLLECTIONS.MEMORIES, {
    vector,
    limit: Math.max(limit * overFetch, limit),
    with_payload: true,
    filter: { must } as any,
  });

  // Group by parent, keeping the best unit score (and its text) per parent.
  // Insertion order follows descending score (Qdrant returns sorted), so the
  // first time we see a parent is already its best hit.
  const byParent = new Map<string, { score: number; matchedUnits: number; bestUnitText?: string }>();
  for (const c of candidates) {
    const pl = (c.payload ?? {}) as Record<string, unknown>;
    const parentId = pl.parent_window_id as string | undefined;
    if (!parentId) continue;
    const existing = byParent.get(parentId);
    if (existing) {
      existing.matchedUnits += 1;
      if ((c.score ?? 0) > existing.score) {
        existing.score = c.score ?? 0;
        existing.bestUnitText = pl.unit_text as string | undefined;
      }
    } else {
      byParent.set(parentId, {
        score: c.score ?? 0,
        matchedUnits: 1,
        bestUnitText: pl.unit_text as string | undefined,
      });
    }
  }

  // Top-k DISTINCT parents by best unit score.
  const ranked = [...byParent.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit);

  if (ranked.length === 0) {
    // Pre-yxj.2 fallback: no units matched (old window-only data). Search
    // windows directly and return them as parents so old memories stay
    // retrievable. matchedUnits=0 flags the fallback path to callers.
    const windowMust: Array<Record<string, unknown>> = [
      { key: 'point_type', match: { value: 'window' } },
    ];
    if (streamId) windowMust.push({ key: 'stream_id', match: { value: streamId } });
    const windows = await qdrant.search(COLLECTIONS.MEMORIES, {
      vector,
      limit,
      with_payload: true,
      filter: { must: windowMust } as any,
    });
    return windows.map((w) => ({
      id: String(w.id),
      score: w.score ?? 0,
      matchedUnits: 0,
      payload: w.payload as Record<string, unknown> | null | undefined,
    }));
  }

  // Fetch parent window payloads (content lives on the parent, not the unit).
  const parents = await qdrant.retrieve(COLLECTIONS.MEMORIES, {
    ids: ranked.map(([id]) => id),
    with_payload: true,
    with_vector: false,
  });
  const parentPayloads = new Map<string, Record<string, unknown> | null | undefined>();
  for (const p of parents) {
    parentPayloads.set(String(p.id), p.payload as Record<string, unknown> | null | undefined);
  }

  return ranked.map(([id, agg]) => ({
    id,
    score: agg.score,
    matchedUnits: agg.matchedUnits,
    payload: parentPayloads.get(id) ?? null,
    bestUnitText: agg.bestUnitText,
  }));
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
