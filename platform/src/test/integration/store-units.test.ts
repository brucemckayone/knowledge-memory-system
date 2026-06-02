/**
 * store() unit-splitter + multi-point Qdrant write — bead nmemo-yxj.2
 *
 * Acceptance (epic nmemo-yxj, Decision 1 — parent-as-point + unit satellites):
 *  - Storing a window writes 1 PARENT point (point_type=window, full content,
 *    whole-window vector) + N UNIT points (point_type=unit, parent_window_id
 *    set, unit_text + char offsets, unit vector).
 *  - getMemory(memoryId) still returns the full window content.
 *  - getMemoryVectors([memoryId]) still returns the window vector (the
 *    entity-centroid path is unaffected — units are never linked in
 *    memory_entities so they never reach getMemoryVectors).
 *  - Unit size + overlap are configurable.
 *  - Each unit embeds within nomic limits (small units never 500 the embedder).
 *
 * The splitter is a PURE function (splitIntoUnits) tested without infra; the
 * Qdrant-write assertions gate on isQdrantAvailable()/isMLServiceAvailable().
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { store, splitIntoUnits } from '../../pipeline.js';
import { getMemory, getMemoryVectors, qdrant, COLLECTIONS } from '../../services/qdrant.js';
import { config } from '../../config.js';
import { isQdrantAvailable, isMLServiceAvailable, skipCtx } from '../setup.js';

describe('splitIntoUnits (pure)', () => {
  it('splits into overlapping units with contiguous-by-stride offsets', () => {
    // 10 chars, unit=4, overlap=2 → stride 2 → starts 0,2,4,6 (8 reaches end)
    const text = 'ABCDEFGHIJ';
    const units = splitIntoUnits(text, 4, 2);
    expect(units.map((u) => [u.charStart, u.charEnd])).toEqual([
      [0, 4],
      [2, 6],
      [4, 8],
      [6, 10],
    ]);
    expect(units.map((u) => u.text)).toEqual(['ABCD', 'CDEF', 'EFGH', 'GHIJ']);
  });

  it('offsets reconstruct the exact source slice (shared coordinate system)', () => {
    const text = 'The quick brown fox jumps over the lazy dog twice over.';
    for (const u of splitIntoUnits(text, 16, 8)) {
      expect(text.slice(u.charStart, u.charEnd)).toBe(u.text);
    }
  });

  it('adjacent units overlap so a boundary-straddling span survives whole', () => {
    const units = splitIntoUnits('ABCDEFGHIJ', 4, 2);
    for (let i = 1; i < units.length; i++) {
      expect(units[i]!.charStart).toBeLessThan(units[i - 1]!.charEnd);
    }
  });

  it('text at/below one unit width yields exactly one whole-window unit', () => {
    expect(splitIntoUnits('short', 128, 64)).toEqual([
      { text: 'short', charStart: 0, charEnd: 5 },
    ]);
    expect(splitIntoUnits('exactlyfour!', 12, 4)).toEqual([
      { text: 'exactlyfour!', charStart: 0, charEnd: 12 },
    ]);
  });

  it('empty text yields zero units', () => {
    expect(splitIntoUnits('', 128, 64)).toEqual([]);
  });

  it('no degenerate trailing duplicate unit at the tail', () => {
    // 11 chars, unit=4, overlap=2, stride=2 → 0,2,4,6,8(→[8,11]) then stop.
    const units = splitIntoUnits('ABCDEFGHIJK', 4, 2);
    const last = units[units.length - 1]!;
    expect(last.charEnd).toBe(11);
    // No two units share identical offsets.
    const seen = new Set(units.map((u) => `${u.charStart}:${u.charEnd}`));
    expect(seen.size).toBe(units.length);
  });

  it('honours configured defaults (size + overlap are config knobs)', () => {
    const text = 'x'.repeat(400);
    const units = splitIntoUnits(text); // defaults from config
    const stride = config.EMBED_UNIT_CHARS - config.EMBED_UNIT_OVERLAP;
    expect(units[0]!.charEnd).toBe(config.EMBED_UNIT_CHARS);
    expect(units[1]!.charStart).toBe(stride);
    // Every non-final unit is exactly unitChars wide.
    for (let i = 0; i < units.length - 1; i++) {
      expect(units[i]!.charEnd - units[i]!.charStart).toBe(config.EMBED_UNIT_CHARS);
    }
  });

  it('throws on non-positive stride rather than looping forever', () => {
    expect(() => splitIntoUnits('abc', 4, 4)).toThrow(/stride/);
    expect(() => splitIntoUnits('abc', 4, 5)).toThrow(/stride/);
  });
});

describe('store() multi-point write (parent + unit satellites)', () => {
  let live = false;

  beforeAll(async (ctx) => {
    live = (await isQdrantAvailable()) && (await isMLServiceAvailable());
    if (!live) {
      console.warn('⚠️ Qdrant/ML not available — skipping store() multi-point tests');
      skipCtx(ctx);
    }
  });

  async function unitPointsFor(memoryId: string) {
    // Scroll the shared collection for unit satellites of this parent.
    const res = await qdrant.scroll(COLLECTIONS.MEMORIES, {
      filter: { must: [{ key: 'parent_window_id', match: { value: memoryId } }] },
      with_payload: true,
      with_vector: true,
      limit: 1000,
    });
    return res.points;
  }

  it('writes 1 window parent + N unit satellites; offsets + vectors present', async () => {
    // A window comfortably wider than one unit so we get several satellites.
    const text = 'The user graduated with a degree in Business Administration. '.repeat(8);
    const memoryId = await store(text, { source: 'test-yxj2', contentType: 'prose' });

    // Parent point: full content + point_type=window + whole-window vector.
    const parent = await getMemory(memoryId);
    expect(parent?.payload?.content).toBe(text);
    expect(parent?.payload?.point_type).toBe('window');

    const winVecs = await getMemoryVectors([memoryId]);
    const windowVec = winVecs.get(memoryId);
    expect(windowVec).toBeDefined();
    expect(windowVec!.length).toBe(config.EMBED_DIMENSIONS);

    // Unit satellites: point_type=unit, parent_window_id, unit_text + offsets.
    const expected = splitIntoUnits(text);
    const units = await unitPointsFor(memoryId);
    expect(units.length).toBe(expected.length);
    expect(units.length).toBeGreaterThan(1);

    for (const p of units) {
      const pl = p.payload as Record<string, unknown>;
      expect(pl.point_type).toBe('unit');
      expect(pl.parent_window_id).toBe(memoryId);
      expect(typeof pl.unit_text).toBe('string');
      expect(typeof pl.char_start).toBe('number');
      expect(typeof pl.char_end).toBe('number');
      // Offset bridge: stored unit_text equals the parent slice at its offsets.
      expect(text.slice(pl.char_start as number, pl.char_end as number)).toBe(pl.unit_text);
      // Units carry ONLY their own text — never a copy of the full window.
      expect(pl.content).toBeUndefined();
      // Each unit got its own vector of the right dimension.
      expect(Array.isArray(p.vector)).toBe(true);
      expect((p.vector as number[]).length).toBe(config.EMBED_DIMENSIONS);
    }

    // Unit ids are distinct from the parent id (satellites, not the parent).
    expect(units.every((p) => String(p.id) !== memoryId)).toBe(true);
  });

  it('getMemoryVectors([memoryId]) returns the WINDOW vector, not a unit vector', async () => {
    // Invariant guard: centroids are computed over window ids via
    // memory_entities → getMemoryVectors. Unit points have fresh ids and are
    // never linked in memory_entities, so they never reach this path. We assert
    // the parent id resolves to a vector that is NOT equal to any unit vector.
    const text = 'Centroid invariant check sentence. '.repeat(6);
    const memoryId = await store(text, { source: 'test-yxj2' });

    const winVecs = await getMemoryVectors([memoryId]);
    const windowVec = winVecs.get(memoryId);
    expect(windowVec).toBeDefined();

    const units = await unitPointsFor(memoryId);
    for (const p of units) {
      expect(p.vector).not.toEqual(windowVec);
    }
  });

  it('a short window (≤ one unit) writes parent + exactly one unit', async () => {
    const text = 'tiny window';
    const memoryId = await store(text, { source: 'test-yxj2' });

    const parent = await getMemory(memoryId);
    expect(parent?.payload?.content).toBe(text);
    expect(parent?.payload?.point_type).toBe('window');

    const units = await unitPointsFor(memoryId);
    expect(units.length).toBe(1);
    expect((units[0]!.payload as Record<string, unknown>).unit_text).toBe(text);
  });
});
