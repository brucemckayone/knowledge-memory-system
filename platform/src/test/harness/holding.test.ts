/**
 * Holding service + route (iOS API v1 — ASK-HOLDING).
 *
 * Pins the wire contract the iOS `HoldingResponse` decoder requires, mirroring
 * the fail-loud posture of hero/notifications:
 *   - fresh DB / no self entity => { items: [] } (200), never null
 *   - every served item: non-empty holdingId + line, validAt present iff
 *     state==='ripening', createdAt always present
 *   - held/ripening derived from promise-predicate facts; `line` is source_text
 *     verbatim; ripening carries its deadline; a fact with no source_text is
 *     dropped (warn), never served blank
 *   - open derived from causal ghosts (mocked here — the real ghost gate needs
 *     canonical patterns at exactly N-1-of-N edges, covered in causal-patterns.test)
 *
 * DB-backed (uses the shared test DB + createTestEntity/createTestFact). The
 * self entity is seeded by inserting a (stream_id='default', speaker_key='user')
 * row into stream_participants, which is what getSelfEntity() joins on.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { testDb, createTestEntity, createTestFact, deleteFromTables } from '../setup.js';
import { getHolding } from '../../services/holding.js';
import { holdingHandler } from '../../routes/holding.js';
import { streamParticipants } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';

async function cleanSlate(): Promise<void> {
  // stream_participants is not in the default allowlist; clear it directly so
  // getSelfEntity() resolves a fresh self entity per test.
  await db.delete(streamParticipants).where(eq(streamParticipants.streamId, 'default'));
  await deleteFromTables({
    tables: [
      'causal_edge_history',
      'fact_history',
      'edge_source_refs',
      'causal_edges',
      'causal_events',
      'causal_patterns',
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

/** Insert a promise fact WITH source_text (createTestFact doesn't take it).
 *  Supplies object_value to satisfy the `has_object` CHECK
 *  (object_entity_id OR object_value must be non-null). */
async function seedPromiseFact(args: {
  subjectEntityId: string;
  predicate: string;
  sourceText: string;
  validAt?: Date | null;
  sourceMemoryId?: string | null;
  createdAt?: Date;
  objectValue?: string;
}): Promise<string> {
  const result = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_value, source_text, source_memory_id, valid_at, invalid_at, confidence, created_at)
    VALUES (
      ${args.subjectEntityId}::uuid,
      ${args.predicate},
      ${args.objectValue ?? 'something'},
      ${args.sourceText},
      ${args.sourceMemoryId || null}::uuid,
      ${args.validAt ?? null},
      NULL,
      1.0,
      ${args.createdAt ?? new Date()}
    )
    RETURNING id
  `;
  const row = result[0];
  if (!row) throw new Error('seedPromiseFact: insert returned no row');
  return row.id as string;
}

describe('holding — getHolding', () => {
  beforeAll(async () => {
    await cleanSlate();
  });
  beforeEach(async () => {
    await cleanSlate();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanSlate();
  });

  it('returns { items: [] } on a fresh DB with no self entity (sparse, 200-shape)', async () => {
    const res = await getHolding();
    expect(res).toEqual({ items: [] });
  });

  it('classifies a promise fact with no valid_at as held; line is source_text verbatim', async () => {
    const selfId = await seedSelfEntity();
    await seedPromiseFact({
      subjectEntityId: selfId,
      predicate: 'plans_to',
      sourceText: 'to call your sister back this week.',
    });

    const res = await getHolding();
    expect(res.items).toHaveLength(1);
    const item = res.items[0]!;
    expect(item.state).toBe('held');
    // line is the user's OWN words, verbatim — NOT composed.
    expect(item.line).toBe('to call your sister back this week.');
    // held never carries a deadline.
    expect(item.validAt).toBeNull();
    expect(item.holdingId).toMatch(/^holding:fact:/);
    expect(item.factId).not.toBeNull();
    expect(item.createdAt).not.toBeNull();
    // ISO-8601 parseable.
    expect(new Date(item.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('classifies a promise fact with a valid_at within 48h as ripening and carries the deadline', async () => {
    const selfId = await seedSelfEntity();
    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000); // +6h, within 48h
    await seedPromiseFact({
      subjectEntityId: selfId,
      predicate: 'committed_to',
      sourceText: 'to send the studio reply by friday.',
      validAt: soon,
      sourceMemoryId: '00000000-0000-0000-0000-0000000000ab',
    });

    const res = await getHolding();
    expect(res.items).toHaveLength(1);
    const item = res.items[0]!;
    expect(item.state).toBe('ripening');
    // ripening MUST carry its deadline (iOS throws on ripening-without-validAt).
    expect(item.validAt).not.toBeNull();
    expect(new Date(item.validAt!).getTime()).toBeCloseTo(soon.getTime(), -2);
    expect(item.sourceMemoryId).toBe('00000000-0000-0000-0000-0000000000ab');
  });

  it('classifies a promise fact with a valid_at > 48h out as held (no near deadline)', async () => {
    const selfId = await seedSelfEntity();
    const far = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000); // +20d
    await seedPromiseFact({
      subjectEntityId: selfId,
      predicate: 'intends_to',
      sourceText: 'to ship the long thing.',
      validAt: far,
    });

    const res = await getHolding();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.state).toBe('held');
    expect(res.items[0]!.validAt).toBeNull();
  });

  it('ignores invalidated / expired promise facts', async () => {
    const selfId = await seedSelfEntity();
    await seedPromiseFact({
      subjectEntityId: selfId,
      predicate: 'plans_to',
      sourceText: 'to do the thing.',
    });
    // invalidated
    await createTestFact({ subjectEntityId: selfId, predicate: 'plans_to', objectValue: 'x', invalidAt: new Date() });
    // expired via direct SQL (createTestFact supports expiredAt)
    await createTestFact({
      subjectEntityId: selfId,
      predicate: 'plans_to',
      objectValue: 'x',
      expiredAt: new Date(),
    });

    const res = await getHolding();
    // only the seeded-with-source_text one survives; the two no-source_text
    // facts would be dropped anyway, but they're also invalid/expired.
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.line).toBe('to do the thing.');
  });

  it('drops a promise fact whose source_text is blank (fail-loud; never serves an empty line)', async () => {
    const selfId = await seedSelfEntity();
    await testDb`
      INSERT INTO facts (subject_entity_id, predicate, object_value, source_text, valid_at, invalid_at, confidence)
      VALUES (${selfId}::uuid, 'plans_to', 'something', '   ', NULL, NULL, 1.0)
    `;

    const res = await getHolding();
    expect(res.items).toEqual([]);
  });

  it('does not pick up non-promise predicates', async () => {
    const selfId = await seedSelfEntity();
    await seedPromiseFact({
      subjectEntityId: selfId,
      predicate: 'lives_in',
      sourceText: 'some place',
    });

    const res = await getHolding();
    expect(res.items).toEqual([]);
  });

  it('turns causal ghosts into open items (mocked ghost source)', async () => {
    const selfId = await seedSelfEntity();
    // No promise facts — only the mocked ghosts should yield items, all `open`.
    const ghostMock = {
      patternId: 'pat-1',
      patternName: 'approach → commit → ship',
      expectedCauseEntityType: null,
      expectedEffectEntityType: null,
      expectedPredicateCategory: 'commit',
      positionInPattern: 1,
      confidence: 0.7,
      reasoning: 'Entity covers 1 of 2 edge positions.',
    };
    const spy = vi.spyOn(await import('../../services/causal-patterns.js'), 'findCausalGhosts');
    spy.mockResolvedValue([ghostMock]);

    const res = await getHolding();
    expect(res.items).toHaveLength(1);
    const item = res.items[0]!;
    expect(item.state).toBe('open');
    expect(item.validAt).toBeNull(); // open has no deadline
    expect(item.holdingId).toMatch(/^holding:ghost:/);
    // placeholder line is non-empty, lowercase, Voice-C-safe
    expect(item.line.length).toBeGreaterThan(0);
    expect(item.line).toBe(item.line.toLowerCase());
    expect(item.factId).toBeNull();
  });

  it('limits the result count', async () => {
    const selfId = await seedSelfEntity();
    for (let i = 0; i < 5; i++) {
      await seedPromiseFact({
        subjectEntityId: selfId,
        predicate: 'plans_to',
        sourceText: `item ${i}`,
        objectValue: `thing-${i}`,
        createdAt: new Date(Date.now() + i * 1000),
      });
    }

    const res = await getHolding(2);
    expect(res.items).toHaveLength(2);
  });
});

describe('holding — holdingHandler', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanSlate();
  });

  it('returns 200 { items: [] } JSON for a fresh DB', async () => {
    const json = vi.fn();
    const c = {
      req: { query: (_k: string) => undefined },
      json,
    } as unknown as Parameters<typeof holdingHandler>[0];

    await holdingHandler(c);
    expect(json).toHaveBeenCalledTimes(1);
    const [body, status] = json.mock.calls[0]!;
    expect(status ?? 200).toBe(200);
    expect(body).toEqual({ items: [] });
  });
});
