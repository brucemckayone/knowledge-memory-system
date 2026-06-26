/**
 * Rise service + route (iOS API v1 — ASK-009 degraded v1, "risen plate").
 *
 * Pins the iOS `RiseData` wire contract (Sources/MnemoBackend/ASK/Rise/RiseData.swift):
 *   - sources: BARE array, single leaf source for a known memory id
 *   - sourceText VERBATIM from Qdrant `.payload.content`
 *   - strength 1.0, annotations [], factId null (v1 leaf/additive)
 *   - edgeIds: the memory's causal edge ids (or [])
 *   - patternMatch: a REAL canonical-pattern partner (real edge id + label) or null
 *   - isHardTopic: false (v1)
 *   - unknown id → { sources: [], patternMatch: null, isHardTopic: false } (200,
 *     the "source let go" success-shape — NOT a 404)
 *
 * DB-backed (shared test DB) + a seeded Qdrant memory for sourceText. Mirrors
 * promises.test.ts conventions (qdrantTest guard, clean slate around each).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { testDb, deleteFromTables, QDRANT_URL, isQdrantAvailable, randomEmbedding } from '../setup.js';
import { db } from '../../db/index.js';
import { composeRise } from '../../services/rise.js';
import { riseHandler } from '../../routes/rise.js';
import { storeMemory, clearMemories, qdrant } from '../../services/qdrant.js';

const qdrantOk = await isQdrantAvailable();

async function cleanSlate(): Promise<void> {
  await deleteFromTables({
    tables: [
      'causal_edges',
      'causal_events',
      'causal_patterns',
      'fact_history',
      'memory_entities',
      'entity_aliases',
      'facts',
      'entity_merges',
      'entities',
    ],
    acknowledgeGlobal: true,
  });
}

/** Seed a Qdrant memory carrying `.payload.content` so sourceText lifts. */
async function seedMemory(content: string, capturedAt?: string): Promise<string> {
  const id = crypto.randomUUID();
  await storeMemory({
    id,
    vector: randomEmbedding(),
    payload: { content, captured_at: capturedAt ?? new Date().toISOString() },
  });
  return id;
}

/** Insert a causal_events row sourced from a memory; returns the event id. */
async function seedEvent(sourceMemoryId: string): Promise<string> {
  const rows = await testDb`
    INSERT INTO causal_events (transition_type, source_memory_id)
    VALUES ('created', ${sourceMemoryId}::uuid)
    RETURNING id
  `;
  return rows[0]!.id as string;
}

/** Insert a canonical causal_patterns row; returns its id. */
async function seedCanonicalPattern(name: string | null): Promise<string> {
  const rows = await testDb`
    INSERT INTO causal_patterns (name, template_structure, template_length, status)
    VALUES (${name}, ${'{}'}::jsonb, 1, 'canonical')
    RETURNING id
  `;
  return rows[0]!.id as string;
}

/**
 * Insert a causal_edges row joining cause→effect events, optionally under a
 * pattern. Returns the edge id.
 */
async function seedEdge(args: {
  causeEventId: string;
  effectEventId: string;
  patternId?: string;
  strength?: number;
}): Promise<string> {
  const rows = await testDb`
    INSERT INTO causal_edges (
      cause_event_id, effect_event_id, strength, extraction_method,
      reasoning, source_references, initial_strength, pattern_id
    ) VALUES (
      ${args.causeEventId}::uuid,
      ${args.effectEventId}::uuid,
      ${args.strength ?? 0.8},
      'llm',
      'test edge',
      ${'[]'}::jsonb,
      ${args.strength ?? 0.8},
      ${args.patternId ?? null}::uuid
    )
    RETURNING id
  `;
  return rows[0]!.id as string;
}

function qdrantTest(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!qdrantOk) return; // Qdrant unavailable — skip silently
    await fn();
  });
}

describe('rise — composeRise (service)', () => {
  beforeAll(async () => {
    await cleanSlate();
    if (qdrantOk) await clearMemories();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanSlate();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanSlate();
    if (qdrantOk) await clearMemories();
  });

  qdrantTest('known memory id → single leaf source with exact wire shape + VERBATIM sourceText', async () => {
    const verbatim = 'i want to make something honest. that has not changed.';
    const captured = '2027-05-17T12:00:00.000Z';
    const memId = await seedMemory(verbatim, captured);

    const data = await composeRise(memId);

    // sources: bare array, exactly one leaf source.
    expect(Array.isArray(data.sources)).toBe(true);
    expect(data.sources).toHaveLength(1);
    const s = data.sources[0]!;
    expect(s.memoryId).toBe(memId);
    expect(s.sourceText).toBe(verbatim); // VERBATIM, not trimmed.
    expect(new Date(s.createdAt).toISOString()).toBe(captured);
    expect(s.strength).toBe(1.0);
    expect(Number.isFinite(s.strength)).toBe(true);
    expect(s.annotations).toEqual([]); // v1 leaf.
    expect(Array.isArray(s.edgeIds)).toBe(true);
    expect(s.edgeIds).toEqual([]); // no causal edges seeded.
    expect(s.factId).toBeNull(); // v1 additive.

    // no pattern partner; not a hard topic.
    expect(data.patternMatch).toBeNull();
    expect(data.isHardTopic).toBe(false);
  });

  qdrantTest('unknown id → { sources: [], patternMatch: null, isHardTopic: false } (let-go success-shape, NOT 404)', async () => {
    const data = await composeRise('00000000-0000-0000-0000-0000000000ab');
    expect(data).toEqual({ sources: [], patternMatch: null, isHardTopic: false });
  });

  it('blank / empty id → let-go success-shape (no throw)', async () => {
    const data = await composeRise('   ');
    expect(data).toEqual({ sources: [], patternMatch: null, isHardTopic: false });
  });

  qdrantTest('memory with no captured_at → createdAt falls back to a valid date (decoder-safe)', async () => {
    const id = crypto.randomUUID();
    await storeMemory({ id, vector: randomEmbedding(), payload: { content: 'no timestamp here.' } });
    const data = await composeRise(id);
    expect(data.sources).toHaveLength(1);
    expect(new Date(data.sources[0]!.createdAt).toString()).not.toBe('Invalid Date');
  });

  qdrantTest('source carries the memory\'s causal edge ids', async () => {
    const memId = await seedMemory('this caused that.');
    const otherMem = await seedMemory('the downstream thing.');
    const evA = await seedEvent(memId);
    const evB = await seedEvent(otherMem);
    const edgeId = await seedEdge({ causeEventId: evA, effectEventId: evB });

    const data = await composeRise(memId);
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0]!.edgeIds).toContain(edgeId);
  });

  qdrantTest('canonical-pattern partner present → patternMatch populated with a REAL edge id + label', async () => {
    const memId = await seedMemory('tired of the shape of my days.');
    const partnerText = 'the same weariness, said again on wednesday.';
    const partnerMem = await seedMemory(partnerText);
    const evThis = await seedEvent(memId);
    const evPartner = await seedEvent(partnerMem);
    const patternId = await seedCanonicalPattern('recurring weariness');
    const edgeId = await seedEdge({
      causeEventId: evThis,
      effectEventId: evPartner,
      patternId,
      strength: 0.9,
    });

    const data = await composeRise(memId);
    expect(data.patternMatch).not.toBeNull();
    const pm = data.patternMatch!;
    expect(pm.patternText).toBe('recurring weariness'); // real pattern label.
    expect(pm.partnerMemoryId).toBe(partnerMem);
    expect(pm.partnerExcerpt).toBe(partnerText); // partner content (short → not truncated).
    expect(pm.edgeId).toBe(edgeId); // REAL edge id — not fabricated.
    // The source also surfaces the same edge (it touches this memory's events).
    expect(data.sources[0]!.edgeIds).toContain(edgeId);
  });

  qdrantTest('pattern with no name/description → patternMatch null (no honest label, not fabricated)', async () => {
    const memId = await seedMemory('an echo with no label.');
    const partnerMem = await seedMemory('the partner echo.');
    const evThis = await seedEvent(memId);
    const evPartner = await seedEvent(partnerMem);
    const patternId = await seedCanonicalPattern(null); // no name, no description
    await seedEdge({ causeEventId: evThis, effectEventId: evPartner, patternId });

    const data = await composeRise(memId);
    expect(data.patternMatch).toBeNull(); // dropped — no honest patternText.
    expect(data.sources).toHaveLength(1); // source itself still rises.
  });
});

describe('rise — route (GET /api/rise/:annotationId)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanSlate();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanSlate();
    if (qdrantOk) await clearMemories();
  });

  qdrantTest('route returns 200 bare RiseData for a known id', async () => {
    const memId = await seedMemory('the bare object check.');
    const json = vi.fn();
    const c = { req: { param: () => memId }, json } as unknown as Parameters<typeof riseHandler>[0];
    await riseHandler(c);
    const [body, status] = json.mock.calls[0]!;
    expect(status ?? 200).toBe(200);
    // BARE object — sources at top level (no envelope).
    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.sources[0].memoryId).toBe(memId);
    expect(body.isHardTopic).toBe(false);
  });

  it('route returns 200 let-go shape (NOT 404) for an unknown id', async () => {
    const json = vi.fn();
    const c = {
      req: { param: () => '00000000-0000-0000-0000-0000000000cd' },
      json,
    } as unknown as Parameters<typeof riseHandler>[0];
    await riseHandler(c);
    const [body, status] = json.mock.calls[0]!;
    expect(status ?? 200).toBe(200); // success-shape, not 404.
    expect(body).toEqual({ sources: [], patternMatch: null, isHardTopic: false });
  });
});

// Keep the Qdrant client + URL referenced (collection-init side effect / env doc).
void qdrant;
void QDRANT_URL;
void db;
