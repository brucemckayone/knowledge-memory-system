/**
 * Bead nmemo-2yv.114 — qdrant.ts wrapper integration tests.
 *
 * The existing `qdrant.test.ts` is a raw-HTTP smoke probe against the docker
 * container (QD-001..QD-007); this suite exercises the TypeScript wrapper
 * surface (`ensureCollections`, `storeMemory`, `updateVector`, `searchMemories`,
 * `updatePayload`, `getMemory`, `getMemoryVectors`, `clearMemories`).
 *
 * Pattern: integration tests against live Qdrant. Each test scopes its writes
 * to unique UUIDs and the suite calls `clearMemories()` in beforeAll/afterAll
 * to fence test data from any prior state. Suite skips cleanly when Qdrant is
 * unavailable.
 *
 * Note on the "scratch collection" guidance in the bead: the wrapper hard-codes
 * `COLLECTIONS.MEMORIES`, so the tests operate against that collection. In
 * test/CI envs the qdrant instance is the docker container — there's no
 * production `memories` to protect; the `clearMemories()` fence is the
 * isolation mechanism.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isQdrantAvailable, skipCtx } from '../setup.js';
import {
  qdrant,
  COLLECTIONS,
  ensureCollections,
  storeMemory,
  updateVector,
  searchMemories,
  updatePayload,
  getMemory,
  getMemoryVectors,
  clearMemories,
} from '../../services/qdrant.js';
import { config } from '../../config.js';

const DIM = config.EMBED_DIMENSIONS;
const ZEROS = () => Array.from({ length: DIM }, () => 0);
const UNIT_AT = (i: number) => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));

describe('qdrant.ts wrapper (nmemo-2yv.114)', () => {
  beforeAll(async (ctx) => {
    if (!(await isQdrantAvailable())) {
      skipCtx(ctx);
      return;
    }
    // Fence: drop + recreate so prior runs don't leak.
    await clearMemories();
  });

  afterAll(async () => {
    if (await isQdrantAvailable()) {
      // Leave the collection in a clean state for the next suite.
      await clearMemories().catch(() => undefined);
    }
  });

  it('ensureCollections creates the memories collection when absent', async () => {
    await qdrant.deleteCollection(COLLECTIONS.MEMORIES).catch(() => undefined);
    await ensureCollections();
    const info = await qdrant.getCollection(COLLECTIONS.MEMORIES);
    expect(info).toBeDefined();
    const vectorsConfig = info.config?.params?.vectors;
    const size = vectorsConfig && 'size' in vectorsConfig ? vectorsConfig.size : undefined;
    expect(size).toBe(DIM);
  });

  it('ensureCollections is idempotent — second call after creation does not error', async () => {
    await ensureCollections();
    // Second call must not throw and must not re-create.
    await ensureCollections();
    const info = await qdrant.getCollection(COLLECTIONS.MEMORIES);
    expect(info).toBeDefined();
  });

  it('ensureCollections throws a descriptive error on dimension mismatch (forward-ref from nmemo-2yv.121)', async () => {
    // Drop + create at a deliberately wrong size, then call ensureCollections
    // against the current config.EMBED_DIMENSIONS. The error message must name
    // both sizes so an operator can diagnose without reading source.
    await qdrant.deleteCollection(COLLECTIONS.MEMORIES).catch(() => undefined);
    const wrongSize = DIM === 1024 ? 512 : 1024;
    await qdrant.createCollection(COLLECTIONS.MEMORIES, {
      vectors: { size: wrongSize, distance: 'Cosine' },
    });
    try {
      await expect(ensureCollections()).rejects.toThrow(/dimension mismatch/);
      const err = await ensureCollections().catch((e) => e);
      expect(String(err.message)).toContain(`size=${wrongSize}`);
      expect(String(err.message)).toContain(`EMBED_DIMENSIONS=${DIM}`);
    } finally {
      // Reset to the correct size for subsequent tests.
      await qdrant.deleteCollection(COLLECTIONS.MEMORIES).catch(() => undefined);
      await ensureCollections();
    }
  });

  it('storeMemory + getMemory round-trip preserves payload', async () => {
    const id = randomUUID();
    await storeMemory({
      id,
      vector: UNIT_AT(0),
      payload: { text: 'hello world', source: 'unit-test', n: 42 },
    });
    const retrieved = await getMemory(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.payload?.text).toBe('hello world');
    expect(retrieved!.payload?.source).toBe('unit-test');
    expect(retrieved!.payload?.n).toBe(42);
  });

  it('getMemory returns null for an absent id', async () => {
    const result = await getMemory(randomUUID());
    expect(result).toBeNull();
  });

  it('updateVector overwrites the vector + payload for an existing point', async () => {
    const id = randomUUID();
    await storeMemory({ id, vector: UNIT_AT(0), payload: { generation: 1 } });
    await updateVector(id, UNIT_AT(1), { generation: 2 });
    const after = await qdrant.retrieve(COLLECTIONS.MEMORIES, {
      ids: [id], with_payload: true, with_vector: true,
    });
    expect(after.length).toBe(1);
    expect(after[0]!.payload?.generation).toBe(2);
    expect((after[0]!.vector as number[])[1]).toBe(1);
    expect((after[0]!.vector as number[])[0]).toBe(0);
  });

  it('updatePayload mutates payload without touching the vector', async () => {
    const id = randomUUID();
    const originalVec = UNIT_AT(2);
    await storeMemory({ id, vector: originalVec, payload: { tag: 'before' } });
    await updatePayload(id, { tag: 'after', extra: 'added' });
    const after = await qdrant.retrieve(COLLECTIONS.MEMORIES, {
      ids: [id], with_payload: true, with_vector: true,
    });
    expect(after[0]!.payload?.tag).toBe('after');
    expect(after[0]!.payload?.extra).toBe('added');
    expect((after[0]!.vector as number[])[2]).toBe(1);
  });

  it('searchMemories returns hits ordered by similarity, honouring limit', async () => {
    // Earlier tests may have left UNIT_AT(0)-matching rows in the collection,
    // tying the top-2 scores. Clear + re-seed so this test sees only its own
    // data — the ordering assertion below requires strict inequality.
    await clearMemories();
    const id0 = randomUUID();
    const id1 = randomUUID();
    const id2 = randomUUID();
    await storeMemory({ id: id0, vector: UNIT_AT(0), payload: { tag: 'a' } });
    await storeMemory({ id: id1, vector: UNIT_AT(1), payload: { tag: 'b' } });
    await storeMemory({ id: id2, vector: UNIT_AT(2), payload: { tag: 'c' } });

    // Query closest to UNIT_AT(0) — id0 wins with cosine similarity 1.0;
    // id1 and id2 are orthogonal (similarity ~0).
    const results = await searchMemories(UNIT_AT(0), { limit: 2 });
    expect(results.length).toBe(2);
    expect(results[0]!.id).toBe(id0);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('searchMemories filter pass-through narrows results by payload predicate', async () => {
    const idMatch = randomUUID();
    const idOther = randomUUID();
    await storeMemory({ id: idMatch, vector: UNIT_AT(3), payload: { tag: 'filter-match', score: 100 } });
    await storeMemory({ id: idOther, vector: UNIT_AT(3), payload: { tag: 'filter-other', score: 50 } });

    const results = await searchMemories(UNIT_AT(3), {
      limit: 10,
      filter: { must: [{ key: 'tag', match: { value: 'filter-match' } }] },
    });
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe(idMatch);
  });

  it('getMemoryVectors returns a Map sorted by id (stability invariant from qdrant.ts:130-145)', async () => {
    // Pick IDs whose sort order is deterministic by lexicographic compare.
    const idA = '00000000-0000-0000-0000-00000000000a';
    const idB = '00000000-0000-0000-0000-00000000000b';
    const idC = '00000000-0000-0000-0000-00000000000c';
    await storeMemory({ id: idA, vector: UNIT_AT(0), payload: { o: 1 } });
    await storeMemory({ id: idB, vector: UNIT_AT(1), payload: { o: 2 } });
    await storeMemory({ id: idC, vector: UNIT_AT(2), payload: { o: 3 } });

    // Pass IDs in deliberately shuffled order — sort happens inside the wrapper.
    const map = await getMemoryVectors([idC, idA, idB]);
    const iterOrder = [...map.keys()];
    expect(iterOrder).toEqual([idA, idB, idC]);
  });

  it('getMemoryVectors returns empty map when given empty array (no fetch)', async () => {
    const map = await getMemoryVectors([]);
    expect(map.size).toBe(0);
  });

  it('clearMemories drops + recreates the collection at the current EMBED_DIMENSIONS', async () => {
    // Seed a row, then clearMemories should wipe it.
    const id = randomUUID();
    await storeMemory({ id, vector: UNIT_AT(0), payload: { sentinel: true } });
    expect(await getMemory(id)).not.toBeNull();

    await clearMemories();
    expect(await getMemory(id)).toBeNull();

    const info = await qdrant.getCollection(COLLECTIONS.MEMORIES);
    const vectorsConfig = info.config?.params?.vectors;
    const size = vectorsConfig && 'size' in vectorsConfig ? vectorsConfig.size : undefined;
    expect(size).toBe(DIM);
  });
});
