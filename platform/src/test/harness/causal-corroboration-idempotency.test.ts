/**
 * PC-3 (bead nmemo-uhp.4) — corroboration count-stability under epoch-replay.
 *
 * The bug: createCausalEdge's corroborate-or-insert bumped corroboration_count
 * (+ strength, + a 'corroborated' audit row) on every exact/semantic match, and
 * applyCausalPromotion re-dispatches the SAME staging_causal_edges rows whenever
 * an epoch's causal pass re-runs. A literal replay therefore inflated the count.
 * The pre-existing idempotency test only asserted the row-SET, so it stayed green
 * while the count drifted — a silent breach of the epoch-v2 order-independence
 * guarantee, and the exact pattern Phase A clones into bridge_edges.
 *
 * The fix (mig 051 + causal_edge_corroborations, the mig-034 UPSERT model):
 * corroboration is scoped to a stable identity (the staged-row id). Re-applying
 * the same identity is a no-op on count/strength; a genuinely new proposal still
 * corroborates. This suite pins BOTH the primitive (createCausalEdge with a
 * corroborationKey) and the real replay path (applyCausalPromotion twice).
 *
 * Isolation note: createCausalEdge's SEMANTIC-match branch corroborates across
 * DIFFERENT event pairs that share (subject_entity_id, predicate) on both ends,
 * so every case here mints its own entity to avoid cross-case corroboration.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';
import { createCausalEdge } from '../../services/causal.js';
import { applyCausalPromotion } from '../../services/causal-promotion.js';

interface Fixture {
  entityId: string;
  factId: string;
  causeEventId: string;
  effectEventId: string;
}

const createdEntityIds: string[] = [];
const usedEpochIds: string[] = [];

/** Fresh entity + fact + a distinct (cause, effect) event pair. Unique per case. */
async function mintFixture(tag: string): Promise<Fixture> {
  const entity = await createTestEntity({ canonicalName: `PC3 ${tag} ${crypto.randomUUID().slice(0, 8)}`, entityType: 'person' });
  const fact = await createTestFact({ subjectEntityId: entity.id, predicate: 'works_at', objectValue: 'TestCorp' });
  const [ev1] = await testDb`
    INSERT INTO public.causal_events (fact_id, transition_type, subject_entity_id, predicate)
    VALUES (${fact.id}::uuid, 'created', ${entity.id}::uuid, 'works_at')
    RETURNING id
  `;
  const [ev2] = await testDb`
    INSERT INTO public.causal_events (fact_id, transition_type, subject_entity_id, predicate)
    VALUES (${fact.id}::uuid, 'expired', ${entity.id}::uuid, 'works_at')
    RETURNING id
  `;
  createdEntityIds.push(entity.id);
  return { entityId: entity.id, factId: fact.id, causeEventId: ev1!.id, effectEventId: ev2!.id };
}

const memRef = () => ({ type: 'memory' as const, id: crypto.randomUUID(), relevance: 'narrates the transition' });

async function edgeRow(edgeId: string): Promise<{ corroboration_count: number; strength: number } | undefined> {
  const rows = await testDb`
    SELECT corroboration_count, strength FROM public.causal_edges WHERE id = ${edgeId}::uuid
  `;
  return rows[0] as { corroboration_count: number; strength: number } | undefined;
}

async function ledgerCount(edgeId: string): Promise<number> {
  const rows = await testDb`
    SELECT count(*)::int AS n FROM public.causal_edge_corroborations WHERE edge_id = ${edgeId}::uuid
  `;
  return (rows[0] as { n: number }).n;
}

async function corroboratedHistoryCount(edgeId: string): Promise<number> {
  const rows = await testDb`
    SELECT count(*)::int AS n FROM public.causal_edge_history
    WHERE edge_id = ${edgeId}::uuid AND event_type = 'corroborated'
  `;
  return (rows[0] as { n: number }).n;
}

/** Insert a staged causal edge for an epoch; returns its staged-row id. */
async function stage(epochId: string, f: Fixture): Promise<string> {
  // postgres.js encodes a bare JS array as a Postgres ARRAY and double-encodes a
  // JSON string; testDb.json() sends it as a real json value so jsonb_typeof='array'
  // (the staging_causal_edge_refs_nonempty CHECK) holds.
  const [row] = await testDb`
    INSERT INTO public.staging_causal_edges (epoch_id, cause_event_id, effect_event_id, reasoning, source_references)
    VALUES (
      ${epochId}::uuid, ${f.causeEventId}::uuid, ${f.effectEventId}::uuid,
      'PC-3 replay fixture: the created state was later expired',
      ${testDb.json([memRef()])}
    )
    RETURNING id
  `;
  return (row as { id: string }).id;
}

describe('PC-3: corroboration count-stability (createCausalEdge primitive)', () => {
  it('same corroborationKey twice → count and strength stay put (idempotent replay)', async () => {
    const f = await mintFixture('prim-same');
    const key = crypto.randomUUID();
    const edgeId = await createCausalEdge({
      causeEventId: f.causeEventId, effectEventId: f.effectEventId, strength: 0.5,
      reasoning: 'initial assertion', sourceReferences: [memRef()],
      actor: 'graph_agent', corroborationKey: key,
    });
    const after1 = await edgeRow(edgeId);
    expect(after1!.corroboration_count).toBe(1);

    // Re-dispatch the SAME staged identity → exact match, but the ledger key is
    // already claimed, so no bump.
    const edgeId2 = await createCausalEdge({
      causeEventId: f.causeEventId, effectEventId: f.effectEventId, strength: 0.5,
      reasoning: 'initial assertion', sourceReferences: [memRef()],
      actor: 'graph_agent', corroborationKey: key,
    });
    expect(edgeId2).toBe(edgeId);
    const after2 = await edgeRow(edgeId);
    expect(after2!.corroboration_count).toBe(1);
    expect(after2!.strength).toBeCloseTo(after1!.strength);
    expect(await ledgerCount(edgeId)).toBe(1);
    // No spurious audit row for the no-op replay.
    expect(await corroboratedHistoryCount(edgeId)).toBe(0);
  });

  it('different corroborationKey → genuine corroboration still bumps to 2', async () => {
    const f = await mintFixture('prim-diff');
    const edgeId = await createCausalEdge({
      causeEventId: f.causeEventId, effectEventId: f.effectEventId, strength: 0.5,
      reasoning: 'initial assertion', sourceReferences: [memRef()],
      actor: 'graph_agent', corroborationKey: crypto.randomUUID(),
    });
    const edgeId2 = await createCausalEdge({
      causeEventId: f.causeEventId, effectEventId: f.effectEventId, strength: 0.5,
      reasoning: 'independent re-assertion', sourceReferences: [memRef()],
      actor: 'graph_agent', corroborationKey: crypto.randomUUID(),
    });
    expect(edgeId2).toBe(edgeId);
    expect((await edgeRow(edgeId))!.corroboration_count).toBe(2);
    expect(await ledgerCount(edgeId)).toBe(2);
    expect(await corroboratedHistoryCount(edgeId)).toBe(1);
  });

  it('no corroborationKey (legacy caller) → unconditional bump preserved', async () => {
    const f = await mintFixture('prim-legacy');
    const edgeId = await createCausalEdge({
      causeEventId: f.causeEventId, effectEventId: f.effectEventId, strength: 0.5,
      reasoning: 'initial assertion', sourceReferences: [memRef()], actor: 'graph_agent',
    });
    await createCausalEdge({
      causeEventId: f.causeEventId, effectEventId: f.effectEventId, strength: 0.5,
      reasoning: 'legacy re-assertion', sourceReferences: [memRef()], actor: 'graph_agent',
    });
    expect((await edgeRow(edgeId))!.corroboration_count).toBe(2);
    expect(await ledgerCount(edgeId)).toBe(0); // legacy path writes no ledger rows
  });
});

describe('PC-3: corroboration count-stability (applyCausalPromotion replay)', () => {
  it('double-dispatch of the same staging leaves corroboration_count unchanged', async () => {
    const f = await mintFixture('promo-replay');
    const epochId = crypto.randomUUID();
    usedEpochIds.push(epochId);
    await stage(epochId, f);

    // First dispatch: fresh insert, count = 1.
    const r1 = await applyCausalPromotion(epochId);
    expect(r1.created).toHaveLength(1);
    expect(r1.dropped).toHaveLength(0);
    const edgeId = r1.created[0]!.edgeId;
    const after1 = await edgeRow(edgeId);
    expect(after1!.corroboration_count).toBe(1);

    // Second dispatch of the SAME staging rows (the replay). The edge already
    // exists; without the fix this bumped the count to 2.
    const r2 = await applyCausalPromotion(epochId);
    expect(r2.created).toHaveLength(1);
    expect(r2.created[0]!.edgeId).toBe(edgeId); // same canonical edge, no duplicate
    const after2 = await edgeRow(edgeId);
    expect(after2!.corroboration_count).toBe(1); // ← the count holds
    expect(after2!.strength).toBeCloseTo(after1!.strength); // strength holds too

    // Exactly one canonical edge for this pair (row-set stable).
    const dupe = await testDb`
      SELECT count(*)::int AS n FROM public.causal_edges
      WHERE cause_event_id = ${f.causeEventId}::uuid AND effect_event_id = ${f.effectEventId}::uuid
    `;
    expect((dupe[0] as { n: number }).n).toBe(1);
  });

  it('a NEW staged proposal for the same claim (new epoch) still corroborates to 2', async () => {
    const f = await mintFixture('promo-genuine');
    const epochA = crypto.randomUUID();
    const epochB = crypto.randomUUID();
    usedEpochIds.push(epochA, epochB);

    await stage(epochA, f);
    const r1 = await applyCausalPromotion(epochA);
    const edgeId = r1.created[0]!.edgeId;
    expect((await edgeRow(edgeId))!.corroboration_count).toBe(1);

    // A distinct staged row (new id) in a new epoch = a genuine re-assertion.
    await stage(epochB, f);
    const r2 = await applyCausalPromotion(epochB);
    expect(r2.created[0]!.edgeId).toBe(edgeId);
    expect((await edgeRow(edgeId))!.corroboration_count).toBe(2);
  });
});

afterAll(async () => {
  for (const epochId of usedEpochIds) {
    await testDb.unsafe(`DELETE FROM public.staging_causal_edges WHERE epoch_id = '${epochId}'`).catch(() => {});
  }
  for (const entityId of createdEntityIds) {
    // causal_edge_corroborations cascades with causal_edges; history holds an FK too.
    await testDb.unsafe(`
      DELETE FROM public.causal_edge_history WHERE edge_id IN (
        SELECT ce.id FROM public.causal_edges ce
        JOIN public.causal_events ev ON ev.id = ce.cause_event_id
        WHERE ev.subject_entity_id = '${entityId}'
      )
    `).catch(() => {});
    await testDb.unsafe(`
      DELETE FROM public.causal_edges WHERE cause_event_id IN (
        SELECT id FROM public.causal_events WHERE subject_entity_id = '${entityId}'
      )
    `).catch(() => {});
    await testDb.unsafe(`DELETE FROM public.causal_events WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM public.facts WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM public.entities WHERE id = '${entityId}'`).catch(() => {});
  }
});
