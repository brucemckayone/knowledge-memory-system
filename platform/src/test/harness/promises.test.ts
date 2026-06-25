/**
 * Promises service + routes (iOS API v1 — ASK-016 slice 2, READ routes).
 *
 * Pins the wire contract the iOS `Promise` / `OpenPromisesResponse` decoders
 * require + the backend-authoritative 6-state derivation:
 *   - the active set: only {open, held, ripening, nudged} (done/let-go excluded)
 *   - valid_at ASC NULLS LAST ordering (undated last)
 *   - promiseProse = "to " + object_value
 *   - sourceQuoteText = the source memory's Qdrant content (non-blank or dropped)
 *   - sourceQuoteAnnotations = [] (v1 leaf)
 *   - completionSuggestion = null (v1)
 *   - GET /:fact_id serves terminals (done/let-go) too; 404 for missing/non-
 *     commitment
 *
 * DB-backed (shared test DB) + a seeded Qdrant memory for sourceQuoteText.
 * Mirrors holding.test.ts: the self entity is seeded via stream_participants
 * (the row getSelfEntity() joins on).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { testDb, createTestEntity, deleteFromTables, QDRANT_URL, isQdrantAvailable } from '../setup.js';
import { streamParticipants } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { getOpenPromises, getPromiseByFactId, derivePromiseState } from '../../services/promises.js';
import { openPromisesHandler, promiseDetailHandler } from '../../routes/promises.js';
import { storeMemory, clearMemories, qdrant } from '../../services/qdrant.js';
import { randomEmbedding } from '../setup.js';

const qdrantOk = await isQdrantAvailable();

async function cleanSlate(): Promise<void> {
  await db.delete(streamParticipants).where(eq(streamParticipants.streamId, 'default'));
  await deleteFromTables({
    tables: [
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

/** Seed the default-stream USER speaker as a self entity; returns its id. */
async function seedSelfEntity(name = 'user'): Promise<string> {
  const { id } = await createTestEntity({ canonicalName: name, entityType: 'person' });
  await db
    .insert(streamParticipants)
    .values({ streamId: 'default', speakerKey: 'user', entityId: id, role: 'user' });
  return id;
}

/** Insert a promise fact with full substrate control (incl. completion state). */
async function seedPromiseFact(args: {
  subjectEntityId: string;
  predicate?: string;
  objectValue?: string;
  sourceText?: string | null;
  validAt?: Date | null;
  sourceMemoryId?: string | null;
  createdAt?: Date;
  nudgeCount?: number;
  completionResolution?: 'done' | 'let_go' | null;
}): Promise<string> {
  const result = await testDb`
    INSERT INTO facts (
      subject_entity_id, predicate, object_value, source_text, source_memory_id,
      valid_at, invalid_at, confidence, created_at, nudge_count, completion_resolution
    ) VALUES (
      ${args.subjectEntityId}::uuid,
      ${args.predicate ?? 'plans_to'},
      ${args.objectValue ?? 'send the studio reply by friday'},
      ${args.sourceText ?? null},
      ${args.sourceMemoryId || null}::uuid,
      ${args.validAt ?? null},
      NULL,
      1.0,
      ${args.createdAt ?? new Date()},
      ${args.nudgeCount ?? 0},
      ${args.completionResolution ?? null}
    )
    RETURNING id
  `;
  const row = result[0];
  if (!row) throw new Error('seedPromiseFact: insert returned no row');
  return row.id as string;
}

/** Seed a Qdrant memory carrying `.payload.content` so sourceQuoteText lifts. */
async function seedSourceMemory(content: string): Promise<string> {
  const id = crypto.randomUUID();
  await storeMemory({
    id,
    vector: randomEmbedding(),
    payload: { content, captured_at: new Date().toISOString() },
  });
  return id;
}

describe('promises — derivePromiseState (pure unit)', () => {
  const now = new Date('2026-06-25T12:00:00Z');
  const within48h = new Date(now.getTime() + 6 * 60 * 60 * 1000); // +6h
  const beyond48h = new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000); // +20d
  const past = new Date(now.getTime() - 60 * 60 * 1000); // -1h

  it('terminal: done', () => {
    expect(derivePromiseState({ completionResolution: 'done', validAt: within48h, nudgeCount: 0, now }))
      .toBe('done');
  });
  it('terminal: let_go → let-go (hyphenated raw value)', () => {
    expect(derivePromiseState({ completionResolution: 'let_go', validAt: within48h, nudgeCount: 0, now }))
      .toBe('let-go');
  });
  it('active: valid_at NULL → open', () => {
    expect(derivePromiseState({ completionResolution: null, validAt: null, nudgeCount: 0, now }))
      .toBe('open');
  });
  it('active: >48h, nudge_count 0 → held', () => {
    expect(derivePromiseState({ completionResolution: null, validAt: beyond48h, nudgeCount: 0, now }))
      .toBe('held');
  });
  it('active: >48h, nudge_count > 0 → nudged', () => {
    expect(derivePromiseState({ completionResolution: null, validAt: beyond48h, nudgeCount: 2, now }))
      .toBe('nudged');
  });
  it('active: <=48h (within window) → ripening regardless of nudge_count (0)', () => {
    expect(derivePromiseState({ completionResolution: null, validAt: within48h, nudgeCount: 0, now }))
      .toBe('ripening');
  });
  it('active: <=48h with nudge_count>0 → ripening (nudged promise re-ripened)', () => {
    expect(derivePromiseState({ completionResolution: null, validAt: within48h, nudgeCount: 3, now }))
      .toBe('ripening');
  });
  it('active: past deadline → ripening (past-due stays ripening, not a new state)', () => {
    expect(derivePromiseState({ completionResolution: null, validAt: past, nudgeCount: 0, now }))
      .toBe('ripening');
  });
});

describe('promises — getOpenPromises + routes', () => {
  // Guard each test on Qdrant availability (the repo convention — see
  // qdrant.test.ts — rather than the describe-options skip overload, which
  // TS struggles to resolve when the skip value may be undefined).
  function qdrantTest(name: string, fn: () => Promise<void>): void {
    it(name, async () => {
      if (!qdrantOk) return; // Qdrant unavailable — skip silently
      await fn();
    });
  }

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

  it('returns { promises: [] } on a fresh DB with no self entity', async () => {
    const res = await getOpenPromises();
    expect(res).toEqual({ promises: [] });
  });

  qdrantTest('seeds all six states and returns only the active set with correct states', async () => {
    const selfId = await seedSelfEntity();
    const memId = await seedSourceMemory('i said i would write to dad.');
    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000); // ripening
    const far = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000); // held/nudged

    // undated → open
    await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: 'write to dad',
      sourceMemoryId: memId,
    });
    // far + nudge 0 → held
    const heldId = await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: 'ship the long thing',
      validAt: far,
      sourceMemoryId: memId,
    });
    // far + nudge 1 → nudged
    await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: 'finish the draft',
      validAt: far,
      nudgeCount: 1,
      sourceMemoryId: memId,
    });
    // soon → ripening
    await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: 'send the studio reply',
      validAt: soon,
      sourceMemoryId: memId,
    });
    // done — terminal, excluded
    await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: 'already done thing',
      validAt: soon,
      completionResolution: 'done',
      sourceMemoryId: memId,
    });
    // let_go — terminal, excluded
    await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: 'released thing',
      validAt: soon,
      completionResolution: 'let_go',
      sourceMemoryId: memId,
    });

    const res = await getOpenPromises();
    const states = res.promises.map((p) => p.state).sort();
    // exactly the 4 active states, none terminal.
    expect(states).toEqual(['held', 'nudged', 'open', 'ripening']);
    expect(res.promises).toHaveLength(4);
    // held carries its far validAt; nudge_count surfaced.
    const held = res.promises.find((p) => p.factId === heldId);
    expect(held?.state).toBe('held');
    expect(held?.nudgeCount).toBe(0);
    expect(held?.validAt).not.toBeNull();
  });

  qdrantTest('orders valid_at ASC with NULL (undated) last', async () => {
    const selfId = await seedSelfEntity();
    const memId = await seedSourceMemory('q');
    const t = Date.now();
    const soon = new Date(t + 6 * 60 * 60 * 1000);
    const mid = new Date(t + 12 * 60 * 60 * 1000);

    const ripeningId = await seedPromiseFact({
      subjectEntityId: selfId, objectValue: 'a', validAt: mid, sourceMemoryId: memId,
    });
    const soonerId = await seedPromiseFact({
      subjectEntityId: selfId, objectValue: 'b', validAt: soon, sourceMemoryId: memId,
    });
    const undatedId = await seedPromiseFact({
      subjectEntityId: selfId, objectValue: 'c', sourceMemoryId: memId, // validAt NULL
    });

    const res = await getOpenPromises();
    const ids = res.promises.map((p) => p.factId);
    // soon (ripening) → mid (ripening) → undated (open, last).
    expect(ids).toEqual([soonerId, ripeningId, undatedId]);
  });

  qdrantTest('respects ?limit (widget cap)', async () => {
    const selfId = await seedSelfEntity();
    const memId = await seedSourceMemory('q');
    for (let i = 0; i < 5; i++) {
      await seedPromiseFact({
        subjectEntityId: selfId,
        objectValue: `thing-${i}`,
        validAt: new Date(Date.now() + (i + 1) * 60 * 60 * 1000),
        sourceMemoryId: memId,
        createdAt: new Date(Date.now() + i * 1000),
      });
    }
    const res = await getOpenPromises(2);
    expect(res.promises).toHaveLength(2);
  });

  qdrantTest('shapes the wire contract exactly (camelCase, prose prefix, leaf arrays, null suggestion)', async () => {
    const selfId = await seedSelfEntity();
    const memId = await seedSourceMemory('the user said this verbatim.');
    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const id = await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: 'send the studio reply by friday',
      validAt: soon,
      sourceMemoryId: memId,
    });

    const res = await getOpenPromises();
    const p = res.promises.find((x) => x.factId === id)!;
    // camelCase keys present, iOS verbatim.
    expect(p.promiseProse).toBe('to send the studio reply by friday'); // "to " + object_value
    expect(p.state).toBe('ripening');
    expect(new Date(p.validAt!).getTime()).toBeCloseTo(soon.getTime(), -2);
    expect(new Date(p.createdAt).toString()).not.toBe('Invalid Date');
    expect(p.sourceMemoryId).toBe(memId);
    expect(p.sourceQuoteText).toBe('the user said this verbatim.');
    expect(p.sourceQuoteAnnotations).toEqual([]); // v1 leaf
    expect(p.completionSuggestion).toBeNull(); // v1
    expect(p.nudgeCount).toBe(0);
  });

  qdrantTest('drops a fact whose source memory is unreadable (no Qdrant content)', async () => {
    const selfId = await seedSelfEntity();
    // sourceMemoryId points at a memory id that was never stored in Qdrant.
    await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: 'something',
      sourceMemoryId: '00000000-0000-0000-0000-0000000000cd',
    });
    const res = await getOpenPromises();
    expect(res.promises).toEqual([]); // dropped — blank sourceQuoteText would fail iOS decoder
  });

  qdrantTest('drops a fact whose object_value is blank (promiseProse would be blank)', async () => {
    const selfId = await seedSelfEntity();
    const memId = await seedSourceMemory('q');
    await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: '   ',
      sourceMemoryId: memId,
    });
    const res = await getOpenPromises();
    expect(res.promises).toEqual([]);
  });

  qdrantTest('does not pick up non-commitment predicates', async () => {
    const selfId = await seedSelfEntity();
    const memId = await seedSourceMemory('q');
    await seedPromiseFact({
      subjectEntityId: selfId,
      predicate: 'lives_in',
      objectValue: 'paris',
      sourceMemoryId: memId,
    });
    const res = await getOpenPromises();
    expect(res.promises).toEqual([]);
  });

  it('GET /api/promises/open route returns 200 { promises: [] } on fresh DB', async () => {
    const json = vi.fn();
    const c = { req: { query: (_k: string) => undefined }, json } as unknown as Parameters<typeof openPromisesHandler>[0];
    await openPromisesHandler(c);
    expect(json).toHaveBeenCalledTimes(1);
    const [body, status] = json.mock.calls[0]!;
    expect(status ?? 200).toBe(200);
    expect(body).toEqual({ promises: [] });
  });

  qdrantTest('GET /api/promises/open?limit=N caps the result', async () => {
    const selfId = await seedSelfEntity();
    const memId = await seedSourceMemory('q');
    for (let i = 0; i < 3; i++) {
      await seedPromiseFact({
        subjectEntityId: selfId,
        objectValue: `t-${i}`,
        validAt: new Date(Date.now() + (i + 1) * 60 * 60 * 1000),
        sourceMemoryId: memId,
      });
    }
    const json = vi.fn();
    const c = {
      req: { query: (k: string) => (k === 'limit' ? '2' : undefined) },
      json,
    } as unknown as Parameters<typeof openPromisesHandler>[0];
    await openPromisesHandler(c);
    const [body] = json.mock.calls[0]!;
    expect(body.promises).toHaveLength(2);
  });
});

describe('promises — getPromiseByFactId + route', () => {
  function qdrantTest(name: string, fn: () => Promise<void>): void {
    it(name, async () => {
      if (!qdrantOk) return; // Qdrant unavailable — skip silently
      await fn();
    });
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanSlate();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanSlate();
    if (qdrantOk) await clearMemories();
  });

  qdrantTest('returns a BARE Promise object (no wrapper) for a commitment fact', async () => {
    const selfId = await seedSelfEntity();
    const memId = await seedSourceMemory('the source quote text here.');
    const id = await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: 'write to dad',
      sourceMemoryId: memId,
    });
    const p = await getPromiseByFactId(id);
    expect(p).not.toBeNull();
    // BARE object — has factId at top level, NOT wrapped in { promise: ... }.
    expect(p!.factId).toBe(id);
    expect(p!.promiseProse).toBe('to write to dad');
    expect(p!.state).toBe('open'); // undated
  });

  qdrantTest('serves terminal states (done) on the detail route', async () => {
    const selfId = await seedSelfEntity();
    const memId = await seedSourceMemory('q');
    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const id = await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: 'done thing',
      validAt: soon,
      completionResolution: 'done',
      sourceMemoryId: memId,
    });
    const p = await getPromiseByFactId(id);
    expect(p?.state).toBe('done');
  });

  it('returns null (→ 404) for a non-existent fact id', async () => {
    const p = await getPromiseByFactId('00000000-0000-0000-0000-000000000001');
    expect(p).toBeNull();
  });

  qdrantTest('returns null (→ 404) for a fact that is not a commitment predicate', async () => {
    const selfId = await seedSelfEntity();
    const memId = await seedSourceMemory('q');
    const id = await seedPromiseFact({
      subjectEntityId: selfId,
      predicate: 'lives_in',
      objectValue: 'paris',
      sourceMemoryId: memId,
    });
    const p = await getPromiseByFactId(id);
    expect(p).toBeNull();
  });

  qdrantTest('GET /api/promises/:fact_id route returns bare object 200, then 404 for missing', async () => {
    const selfId = await seedSelfEntity();
    const memId = await seedSourceMemory('source quote.');
    const id = await seedPromiseFact({
      subjectEntityId: selfId,
      objectValue: 'x',
      sourceMemoryId: memId,
    });

    // 200 bare object
    const jsonOk = vi.fn();
    const cOk = { req: { param: () => id }, json: jsonOk } as unknown as Parameters<typeof promiseDetailHandler>[0];
    await promiseDetailHandler(cOk);
    const [body, status] = jsonOk.mock.calls[0]!;
    expect(status ?? 200).toBe(200);
    expect(body.factId).toBe(id);
    expect(body.promiseProse).toBe('to x');

    // 404 for missing
    const json404 = vi.fn();
    const c404 = { req: { param: () => '00000000-0000-0000-0000-000000000099' }, json: json404 } as unknown as Parameters<typeof promiseDetailHandler>[0];
    await promiseDetailHandler(c404);
    const [, status404] = json404.mock.calls[0]!;
    expect(status404).toBe(404);
  });
});

// Keep the Qdrant client import referenced so tree-shaking doesn't drop the
// collection-init side effect under test bundlers; QDRANT_URL documents the env.
void qdrant;
void QDRANT_URL;
