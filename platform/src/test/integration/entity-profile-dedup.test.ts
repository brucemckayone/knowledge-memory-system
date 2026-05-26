/**
 * Integration test for getEntityMemories DISTINCT-by-memory_id behaviour.
 *
 * Bead nmemo-2yv.58 H8 acceptance:
 *
 *   With a fixture where entity E is mentioned 5 times in memory M1 and once
 *   each in M2-M11, getEntityMemories(E, { limit: 10 }) returns 10 distinct
 *   memories (M1, M2, ..., M10), not just 6 due to M1 dedup.
 *
 * The unique index on memory_entities is
 *   (memory_id, entity_id, COALESCE(mention_start, -1))
 * so the same (memory_id, entity_id) pair can repeat once per mention offset.
 * Without DISTINCT ON (memory_id) in the dedup subquery, the SELECT with
 * LIMIT N can consume slots with duplicate memory_ids, then Qdrant returns
 * fewer than N distinct points.
 *
 * Real DB + mocked qdrant.retrieve: the dedup is purely DB-side, so we mock
 * Qdrant to assert what memory_ids the service hands it, then assert the
 * shape of the returned EntityMemory[].
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  randomUUID,
} from '../setup.js';
import * as qdrantModule from '../../services/qdrant.js';
import { getEntityMemories } from '../../services/entity-profile.js';

describe('getEntityMemories — DISTINCT-by-memory_id (bead nmemo-2yv.58 H8)', () => {
  let qdrantSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Mock qdrant.retrieve to echo the requested IDs as points with payloads,
    // so we can both (a) assert what memory_ids were passed and (b) get a
    // realistic EntityMemory[] back from the service.
    qdrantSpy = vi.spyOn(qdrantModule.qdrant, 'retrieve').mockImplementation(
      async (_collection: string, params: { ids: (string | number)[] }) => {
        return params.ids.map((id) => ({
          id,
          payload: {
            content: `content-of-${id}`,
            type: 'thought',
            created_at: new Date().toISOString(),
          },
          vector: null,
        })) as unknown as Awaited<ReturnType<typeof qdrantModule.qdrant.retrieve>>;
      },
    );
  });

  afterEach(() => {
    qdrantSpy.mockRestore();
  });

  it('returns 10 distinct memories when M1 has 5 mentions and M2..M11 have 1 each', async () => {
    // Setup: one entity, 11 memories. M1 carries 5 mention rows at different
    // mention_start offsets (the schema allows this because the unique index
    // includes mention_start). M2..M11 each carry exactly one mention.
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const entity = await createTestEntity({
      canonicalName: `H8-Hub-Entity-${suffix}`,
      entityType: 'person',
    });

    const memoryIds: string[] = [];
    for (let i = 1; i <= 11; i++) memoryIds.push(randomUUID());
    const [m1, ...mRest] = memoryIds;

    // Insert M2..M11 first (1 mention each) so they have the OLDEST
    // created_at timestamps, then insert the 5 M1 rows so M1 is the NEWEST.
    // After dedup by memory_id keeping the most-recent created_at per memory,
    // ORDER BY created_at DESC LIMIT 10 should yield: [M1, M11, M10, ..., M3]
    // (10 distinct memories — M2 falls off the end).
    for (const memId of mRest) {
      await testDb`
        INSERT INTO memory_entities (memory_id, entity_id, mention_text, mention_start)
        VALUES (${memId}::uuid, ${entity.id}::uuid, 'mention', 0)
      `;
      // Tiny gap so created_at ordering is deterministic
      await new Promise((r) => setTimeout(r, 5));
    }

    // 5 mentions of the entity in M1, at distinct mention_start offsets
    for (const offset of [10, 100, 200, 300, 500]) {
      await testDb`
        INSERT INTO memory_entities (memory_id, entity_id, mention_text, mention_start)
        VALUES (${m1}::uuid, ${entity.id}::uuid, 'mention', ${offset})
      `;
      await new Promise((r) => setTimeout(r, 2));
    }

    // Sanity check: there are 15 memory_entities rows for this entity
    const rowCount = await testDb`
      SELECT COUNT(*)::int AS n FROM memory_entities WHERE entity_id = ${entity.id}::uuid
    `;
    expect(rowCount[0]!.n).toBe(15);

    // Action
    const memories = await getEntityMemories(entity.id, { limit: 10 });

    // Assert: 10 distinct memory IDs returned (the bug would yield 6 —
    // 5 M1 rows collapsed by Qdrant + 5 M2..M6 = 6 distinct).
    expect(memories).toHaveLength(10);
    const distinctIds = new Set(memories.map((m) => m.memoryId));
    expect(distinctIds.size).toBe(10);

    // M1 must be in the result set (it has the newest created_at after the
    // 5-row burst) and must appear exactly once despite 5 mention rows.
    expect(distinctIds.has(m1!)).toBe(true);

    // qdrant.retrieve was called with exactly 10 distinct ids (proving the
    // dedup happened on the DB side, not via Qdrant server-side dedup).
    expect(qdrantSpy).toHaveBeenCalledTimes(1);
    const idsPassed = qdrantSpy.mock.calls[0]![1].ids as string[];
    expect(idsPassed).toHaveLength(10);
    expect(new Set(idsPassed).size).toBe(10);

    // Cleanup
    await testDb`DELETE FROM memory_entities WHERE entity_id = ${entity.id}::uuid`;
    await testDb`DELETE FROM entities WHERE id = ${entity.id}::uuid`;
  });
});
