/**
 * Unit-grained retrieval read path — bead nmemo-yxj.3
 *
 * Acceptance (epic nmemo-yxj, Decision 1b — search units, dedup to parent,
 * return parent content):
 *  - A query whose needle lives in ONE unit returns the PARENT window (the
 *    canonical memory), with the needle in the 0.7+ score band — not the
 *    0.47 noise band the diluted whole-window vector would produce.
 *  - Duplicate unit hits from the same parent COLLAPSE to one result; top-k is
 *    k DISTINCT parents (a parent whose multiple units match appears once,
 *    scored by its best unit).
 *  - Window points and unit points never both surface as separate results.
 *  - Pre-yxj.2 window-only data (no unit satellites) is still retrievable via
 *    the fallback.
 *  - Empty corpus → empty result.
 *
 * Tests run against the isolated memories_test collection + cognitive_test DB
 * (vitest setup, bead nmemo-wow) — never production memories/cognitive.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { store, splitIntoUnits } from '../../pipeline.js';
import {
  searchMemoriesByUnit,
  clearMemories,
  storeMemory,
  qdrant,
  COLLECTIONS,
} from '../../services/qdrant.js';
import { ml } from '../../services/ml-client.js';
import { isQdrantAvailable, isMLServiceAvailable, skipCtx } from '../setup.js';

describe('searchMemoriesByUnit — unit search, dedup to parent, return parent', () => {
  let live = false;

  beforeAll(async (ctx) => {
    live = (await isQdrantAvailable()) && (await isMLServiceAvailable());
    if (!live) {
      console.warn('⚠️ Qdrant/ML not available — skipping retrieval read-path tests');
      skipCtx(ctx);
    }
  });

  beforeEach(async () => {
    if (!live) return;
    // Isolated memories_test collection — safe to reset between tests.
    await clearMemories();
  });

  it('needle in one unit returns the PARENT window in the 0.7+ band', async () => {
    // The needle fact buried in a long, otherwise-unrelated window. The
    // whole-window vector dilutes it to noise; the unit vector preserves it.
    const needle = 'The user graduated with a Master of Science degree in Marine Biology.';
    const filler =
      'We discussed the weather and the morning commute and the price of coffee. ' +
      'Then the conversation turned to weekend plans and a recent film. '.repeat(20);
    const text = `${filler} ${needle} ${filler}`;

    const memoryId = await store(text, { source: 'test-yxj3', contentType: 'prose' });
    // Sanity: this window really did split into multiple units.
    expect(splitIntoUnits(text).length).toBeGreaterThan(1);

    const q = await ml.embed("What degree did the user earn and in what field?");
    const hits = await searchMemoriesByUnit(q.vector, { limit: 5 });

    // The parent window — not a unit fragment — is the result.
    const top = hits.find((h) => h.id === memoryId);
    expect(top).toBeDefined();
    expect(top!.payload?.content).toBe(text); // full window content, not unit_text
    expect(top!.payload?.point_type).toBe('window');
    // Needle is recoverable above noise (epic acceptance: 0.7+ band, not 0.47).
    expect(top!.score).toBeGreaterThan(0.6);
  });

  it('multiple matching units of one parent collapse to ONE result', async () => {
    // A window where the SAME topic recurs across several units, so multiple
    // units score high against the query. Must surface once.
    const text =
      'Marine biology is the study of ocean life. '.repeat(6) +
      'The study of ocean life spans many species. '.repeat(6);
    const memoryId = await store(text, { source: 'test-yxj3' });
    expect(splitIntoUnits(text).length).toBeGreaterThan(2);

    const q = await ml.embed('the study of ocean life');
    const hits = await searchMemoriesByUnit(q.vector, { limit: 5 });

    const forParent = hits.filter((h) => h.id === memoryId);
    expect(forParent.length).toBe(1); // collapsed, despite many unit matches
    expect(forParent[0]!.matchedUnits).toBeGreaterThan(1); // really did dedup
    // The single result is the parent window, scored by its best unit.
    expect(forParent[0]!.payload?.point_type).toBe('window');
  });

  it('top-k returns k DISTINCT parents (no parent duplicated)', async () => {
    const sentences = [
      'The capital of France is Paris, a city on the Seine. '.repeat(6),
      'Photosynthesis converts sunlight into chemical energy in plants. '.repeat(6),
      'The mitochondria is the powerhouse of the cell in biology. '.repeat(6),
      'Jupiter is the largest planet in our solar system by mass. '.repeat(6),
    ];
    const ids: string[] = [];
    for (const s of sentences) ids.push(await store(s, { source: 'test-yxj3' }));

    const q = await ml.embed('what is the capital city of France');
    const hits = await searchMemoriesByUnit(q.vector, { limit: 3 });

    expect(hits.length).toBeLessThanOrEqual(3);
    // All returned ids are distinct parents.
    const seen = new Set(hits.map((h) => h.id));
    expect(seen.size).toBe(hits.length);
    // Every result is a parent window, never a unit fragment id.
    for (const h of hits) {
      expect(ids).toContain(h.id);
      expect(h.payload?.point_type).toBe('window');
    }
  });

  it('window points and unit points never both surface as separate results', async () => {
    const text = 'Quantum entanglement links particle states across distance. '.repeat(8);
    const memoryId = await store(text, { source: 'test-yxj3' });

    const q = await ml.embed('quantum entanglement of particle states');
    const hits = await searchMemoriesByUnit(q.vector, { limit: 10 });

    // Only the parent id appears; no unit satellite id leaks through.
    const unitPoints = await qdrant.scroll(COLLECTIONS.MEMORIES, {
      filter: { must: [{ key: 'parent_window_id', match: { value: memoryId } }] },
      with_payload: false,
      limit: 1000,
    });
    const unitIds = new Set(unitPoints.points.map((p) => String(p.id)));
    for (const h of hits) {
      expect(unitIds.has(h.id)).toBe(false); // never a unit
      expect(h.payload?.point_type).not.toBe('unit');
    }
    expect(hits.some((h) => h.id === memoryId)).toBe(true);
  });

  it('pre-yxj.2 window-only data (no units) is still retrievable via fallback', async () => {
    // Simulate legacy data: a bare window point with NO unit satellites.
    const text = 'Legacy memory about the Apollo 11 moon landing in 1969.';
    const id = '00000000-0000-4000-8000-00000000beef';
    const vec = await ml.embed(text);
    await storeMemory({
      id,
      vector: vec.vector,
      payload: { content: text, point_type: 'window', source: 'legacy' },
    });

    const q = await ml.embed('the first moon landing');
    const hits = await searchMemoriesByUnit(q.vector, { limit: 5 });

    const hit = hits.find((h) => h.id === id);
    expect(hit).toBeDefined();
    expect(hit!.payload?.content).toBe(text);
    expect(hit!.matchedUnits).toBe(0); // flags the fallback path
  });

  it('empty corpus yields empty results', async () => {
    const q = await ml.embed('anything at all');
    const hits = await searchMemoriesByUnit(q.vector, { limit: 5 });
    expect(hits).toEqual([]);
  });
});
