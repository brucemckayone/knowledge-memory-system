/**
 * Fact->unit evidentiary links — bead nmemo-yxj.6
 *
 * ADDITIVE offset-mapped links from a fact to the small embedding unit(s)
 * (epic nmemo-yxj / yxj.2) whose char offsets cover the fact's verbatim
 * source_text span within its parent window. Resolved persistence target per
 * design doc 38 §7 (graph-anchored fallback retrieval).
 *
 * ISOLATION: this suite touches ONLY the cognitive_test DB (via global-setup)
 * and SYNTHETIC data. It never reads/writes the Qdrant 'memories' collection,
 * never embeds, never loads Ollama. Unit ids are computed by the PURE
 * unitPointId() (deterministic uuidv5(memoryId, index)), and fact_units rows
 * are inserted/queried directly against cognitive_test. fact_units is not in
 * deleteFromTables()'s allowlist, so we clean it explicitly via testDb DELETE.
 *
 * Acceptance bullets (bd show nmemo-yxj.6):
 *  (a) unit id determinism: same (memoryId,index) -> same id; different -> diff.
 *  (b) fact source-span -> overlapping unit(s), incl. boundary/overlap cases
 *      and a fact spanning two units; window-fallback when not verbatim/repeats.
 *  (c) fact_units rows persisted/queryable.
 *  (d) additive / satellite invariant: facts.source_memory_id stays the window;
 *      fact_units never moves it onto units.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import {
  unitPointId,
  mapFactToUnits,
  splitIntoUnits,
} from '../../pipeline.js';
import { testDb, createTestEntity } from '../setup.js';

// ----------------------------------------------------------------------------
// (a) Deterministic unit ids — pure, no infra
// ----------------------------------------------------------------------------
describe('unitPointId (deterministic, pure)', () => {
  const mem = '11111111-1111-1111-1111-111111111111';

  it('is stable: same (memoryId,index) -> same id across calls', () => {
    expect(unitPointId(mem, 0)).toBe(unitPointId(mem, 0));
    expect(unitPointId(mem, 7)).toBe(unitPointId(mem, 7));
  });

  it('distinguishes index and memoryId', () => {
    expect(unitPointId(mem, 0)).not.toBe(unitPointId(mem, 1));
    const other = '22222222-2222-2222-2222-222222222222';
    expect(unitPointId(mem, 0)).not.toBe(unitPointId(other, 0));
  });

  it('emits a canonical RFC-4122 v5 UUID string (Qdrant-acceptable TEXT)', () => {
    const id = unitPointId(mem, 3);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ----------------------------------------------------------------------------
// (b) source-span -> overlapping unit(s) — pure offset mapping
// ----------------------------------------------------------------------------
describe('mapFactToUnits (pure offset mapping)', () => {
  const mem = '33333333-3333-3333-3333-333333333333';

  // 10-char window, unit=4, overlap=2 → units [0,4)[2,6)[4,8)[6,10).
  const content = 'ABCDEFGHIJ';
  const units = splitIntoUnits(content, 4, 2);

  it('maps a span fully inside one unit to that unit (offset_overlap)', () => {
    // span "AB" = [0,2) overlaps only [0,4) (unit 0).
    const links = mapFactToUnits(mem, content, 'AB', units);
    expect(links.map((l) => l.matchKind)).toEqual(['offset_overlap']);
    expect(links.map((l) => l.unitPointId)).toEqual([unitPointId(mem, 0)]);
    expect(links[0]!.charStart).toBe(0);
    expect(links[0]!.charEnd).toBe(4);
  });

  it('maps a boundary-straddling span to BOTH overlapping units', () => {
    // span "CDEF" = [2,6) overlaps [0,4)[2,6)[4,8) → units 0,1,2.
    const links = mapFactToUnits(mem, content, 'CDEF', units);
    expect(links.every((l) => l.matchKind === 'offset_overlap')).toBe(true);
    expect(links.map((l) => l.unitPointId)).toEqual([
      unitPointId(mem, 0),
      unitPointId(mem, 1),
      unitPointId(mem, 2),
    ]);
  });

  it('maps a span spanning two distinct units', () => {
    // span "EFGH" = [4,8) overlaps [2,6)[4,8)[6,10) → units 1,2,3.
    const links = mapFactToUnits(mem, content, 'EFGH', units);
    expect(links.map((l) => l.unitPointId)).toEqual([
      unitPointId(mem, 1),
      unitPointId(mem, 2),
      unitPointId(mem, 3),
    ]);
  });

  it('touching-at-a-boundary does NOT overlap (half-open intervals)', () => {
    // Window split so a span ends exactly where the next unit starts.
    // content "ABCDEF", unit=3, overlap=0 → units [0,3)[3,6).
    const c = 'ABCDEF';
    const u = splitIntoUnits(c, 3, 0);
    // span "ABC" = [0,3): touches unit1.charStart=3 but does not cross it.
    const links = mapFactToUnits(mem, c, 'ABC', u);
    expect(links.map((l) => l.charStart)).toEqual([0]);
    expect(links.length).toBe(1);
  });

  it('falls back to window when source_text is null/empty', () => {
    for (const st of [null, undefined, '']) {
      const links = mapFactToUnits(mem, content, st, units);
      expect(links).toEqual([
        { unitPointId: mem, charStart: null, charEnd: null, matchKind: 'window_fallback' },
      ]);
    }
  });

  it('falls back to window when source_text is not verbatim', () => {
    const links = mapFactToUnits(mem, content, 'NOT_PRESENT', units);
    expect(links).toEqual([
      { unitPointId: mem, charStart: null, charEnd: null, matchKind: 'window_fallback' },
    ]);
  });

  it('falls back to window when source_text repeats (ambiguous offset)', () => {
    const repeated = 'AB cd AB';
    const u = splitIntoUnits(repeated, 4, 2);
    const links = mapFactToUnits(mem, repeated, 'AB', u);
    expect(links).toEqual([
      { unitPointId: mem, charStart: null, charEnd: null, matchKind: 'window_fallback' },
    ]);
  });

  it('window-fallback uses the parent window id as the unit_point_id', () => {
    const links = mapFactToUnits(mem, content, '', units);
    expect(links[0]!.unitPointId).toBe(mem);
  });
});

// ----------------------------------------------------------------------------
// (c)+(d) persistence + satellite invariant — cognitive_test DB, synthetic data
// ----------------------------------------------------------------------------
describe('fact_units persistence (cognitive_test, synthetic)', () => {
  let subjectId: string;
  const createdFactIds: string[] = [];

  async function cleanFactUnits() {
    // fact_units is not in deleteFromTables()'s allowlist — clean explicitly.
    await testDb`DELETE FROM fact_units`;
  }

  beforeEach(async () => {
    await cleanFactUnits();
    const e = await createTestEntity({
      canonicalName: `subj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      entityType: 'person',
    });
    subjectId = e.id;
  });

  afterAll(async () => {
    await cleanFactUnits();
    if (createdFactIds.length > 0) {
      await testDb`DELETE FROM facts WHERE id = ANY(${createdFactIds})`;
    }
  });

  /** Insert a synthetic fact with a window provenance + verbatim source_text. */
  async function insertFact(memoryId: string, sourceText: string | null) {
    const rows = await testDb`
      INSERT INTO facts (subject_entity_id, predicate, object_value, source_memory_id, source_text)
      VALUES (${subjectId}::uuid, 'mentions', 'obj', ${memoryId}::uuid, ${sourceText})
      RETURNING id, source_memory_id, source_text
    `;
    createdFactIds.push(rows[0]!.id);
    return rows[0]!;
  }

  /** Mirror of extract()'s fact_units write: compute links + persist. */
  async function persistLinks(factId: string, memoryId: string, content: string, sourceText: string | null) {
    const units = splitIntoUnits(content);
    const links = mapFactToUnits(memoryId, content, sourceText, units);
    for (const l of links) {
      await testDb`
        INSERT INTO fact_units (fact_id, unit_point_id, char_start, char_end, match_kind)
        VALUES (${factId}::uuid, ${l.unitPointId}, ${l.charStart}, ${l.charEnd}, ${l.matchKind})
        ON CONFLICT (fact_id, unit_point_id) DO NOTHING
      `;
    }
  }

  it('persists offset_overlap rows that are queryable by fact_id', async () => {
    const memoryId = randomUUID();
    const content = 'The user graduated in Business Administration.';
    const sourceText = 'graduated in Business Administration';
    const fact = await insertFact(memoryId, sourceText);
    await persistLinks(fact.id, memoryId, content, sourceText);

    const rows = await testDb`
      SELECT unit_point_id, char_start, char_end, match_kind
      FROM fact_units WHERE fact_id = ${fact.id}::uuid
      ORDER BY char_start
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.match_kind === 'offset_overlap')).toBe(true);
    // Persisted unit ids match the deterministic recomputation (the join key
    // the fallback uses against Qdrant).
    const units = splitIntoUnits(content);
    const expected = mapFactToUnits(memoryId, content, sourceText, units);
    expect(rows.map((r) => r.unit_point_id).sort()).toEqual(
      expected.map((l) => l.unitPointId).sort(),
    );
  });

  it('persists a single window_fallback row for a non-verbatim span', async () => {
    const memoryId = randomUUID();
    const content = 'A short window of prose about nothing in particular.';
    const fact = await insertFact(memoryId, 'this phrase is not in the window');
    await persistLinks(fact.id, memoryId, content, 'this phrase is not in the window');

    const rows = await testDb`
      SELECT unit_point_id, match_kind FROM fact_units WHERE fact_id = ${fact.id}::uuid
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.match_kind).toBe('window_fallback');
    // The fallback row is keyed on the parent WINDOW id, not a unit id.
    expect(rows[0]!.unit_point_id).toBe(memoryId);
  });

  it('re-running the write is idempotent (stable ids + ON CONFLICT)', async () => {
    const memoryId = randomUUID();
    const content = 'The user graduated in Business Administration.';
    const sourceText = 'Business Administration';
    const fact = await insertFact(memoryId, sourceText);

    await persistLinks(fact.id, memoryId, content, sourceText);
    const after1 = await testDb`SELECT count(*)::int AS n FROM fact_units WHERE fact_id = ${fact.id}::uuid`;
    await persistLinks(fact.id, memoryId, content, sourceText);
    const after2 = await testDb`SELECT count(*)::int AS n FROM fact_units WHERE fact_id = ${fact.id}::uuid`;
    expect(after2[0]!.n).toBe(after1[0]!.n);
  });

  it('SATELLITE INVARIANT: source_memory_id stays the window; fact_units is additive', async () => {
    const memoryId = randomUUID();
    const content = 'The user graduated in Business Administration.';
    const sourceText = 'Business Administration';
    const fact = await insertFact(memoryId, sourceText);
    await persistLinks(fact.id, memoryId, content, sourceText);

    // facts.source_memory_id is UNCHANGED by the link write — still the window.
    const factRow = await testDb`SELECT source_memory_id FROM facts WHERE id = ${fact.id}::uuid`;
    expect(factRow[0]!.source_memory_id).toBe(memoryId);

    // No fact_units row carries the window's offsets as a relocated provenance:
    // offset_overlap rows reference UNIT ids (≠ the window id).
    const overlapRows = await testDb`
      SELECT unit_point_id FROM fact_units
      WHERE fact_id = ${fact.id}::uuid AND match_kind = 'offset_overlap'
    `;
    expect(overlapRows.every((r) => r.unit_point_id !== memoryId)).toBe(true);
  });

  it('CASCADE: deleting the fact removes its fact_units rows', async () => {
    const memoryId = randomUUID();
    const content = 'The user graduated in Business Administration.';
    const sourceText = 'Business Administration';
    const fact = await insertFact(memoryId, sourceText);
    await persistLinks(fact.id, memoryId, content, sourceText);

    await testDb`DELETE FROM facts WHERE id = ${fact.id}::uuid`;
    const rows = await testDb`SELECT 1 FROM fact_units WHERE fact_id = ${fact.id}::uuid`;
    expect(rows.length).toBe(0);
  });
});
