/**
 * E6 (nmemo-vpz.6) — the post-promotion causal pass (doc 41 §6, §8a.6).
 *
 * This file covers the propose-side surface against the real handleToolCall
 * dispatch + testDb:
 *   - the causal_agent allow-list = reads + propose_causal_edge, NO canonical writes;
 *   - propose_causal_edge stages an edge and previews disposal: refsResolve (do the
 *     cited cause/effect EVENT ids resolve) + citedFactStatus (live status of each
 *     cited FACT: active | superseded | invalidated);
 *   - the doc-01 invariant (non-empty reasoning + >=1 source reference) is rejected
 *     structurally at the propose boundary.
 *
 * The disposer (applyCausalPromotion) + the trigger/scope/invoke seam (runCausalPass)
 * DB tests live in the lower describe blocks — the propose side stages, deterministic
 * code disposes, and an INJECTED fake invoker drives runCausalPass without an LLM.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { handleToolCall, allowlistFor, type ToolCallContext } from '../../services/causal-agent.js';
import { applyCausalPromotion } from '../../services/causal-promotion.js';
import { runCausalPass } from '../../services/causal-pass.js';
import type { PromotionResult } from '../../services/promotion.js';
import { testDb, createTestEntity, createTestFact } from '../setup.js';

const TAG = 'caustest';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function clean(): Promise<void> {
  await testDb.unsafe('DELETE FROM staging_causal_edges');
  const tagEntities = `SELECT id FROM entities WHERE canonical_name LIKE '${TAG}%'`;
  const tagFacts = `SELECT id FROM facts WHERE subject_entity_id IN (${tagEntities})`;
  // causal_events.fact_id and .subject_entity_id are RESTRICT FKs — clear the causal
  // layer (edge_history → edges → events) before the facts/entities they point at.
  // causal_edge_history.edge_id has NO on-delete (RESTRICT); edge_source_refs cascades.
  const tagEdges = `SELECT id FROM causal_edges WHERE cause_event_id IN (SELECT id FROM causal_events WHERE subject_entity_id IN (${tagEntities})) OR effect_event_id IN (SELECT id FROM causal_events WHERE subject_entity_id IN (${tagEntities}))`;
  await testDb.unsafe(`DELETE FROM causal_edge_history WHERE edge_id IN (${tagEdges})`);
  await testDb.unsafe(`DELETE FROM causal_edges WHERE id IN (${tagEdges})`);
  await testDb.unsafe(`DELETE FROM causal_events WHERE subject_entity_id IN (${tagEntities}) OR fact_id IN (${tagFacts})`);
  await testDb.unsafe(`DELETE FROM fact_history WHERE fact_id IN (${tagFacts})`);
  await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id IN (${tagEntities})`);
  await testDb.unsafe(`DELETE FROM entities WHERE canonical_name LIKE '${TAG}%'`);
}

function causalCtx(epochId: string, extra?: Partial<ToolCallContext>): ToolCallContext {
  return { agent: 'causal_agent', epochId, ...extra };
}

async function call(tool: string, input: Record<string, unknown>, ctx: ToolCallContext): Promise<any> {
  return JSON.parse(await handleToolCall(tool, input, ctx));
}

/** Insert a SETTLED causal event directly (the shape promotion mints, §12 #5). */
async function insertEvent(entityId: string, factId: string | null): Promise<string> {
  const rows = await testDb`
    INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate)
    VALUES (${factId}::uuid, 'created', ${entityId}::uuid, 'test_pred')
    RETURNING id
  `;
  return (rows[0] as { id: string }).id;
}

/** Stage one edge into staging_causal_edges (the shape propose_causal_edge writes). */
async function stageEdge(
  epochId: string,
  cause: string,
  effect: string,
  refs: Array<{ type: string; id: string; relevance: string }>,
  reasoning = 'because the funding enabled the move',
): Promise<string> {
  // testDb.json() sends a real jsonb ARRAY — passing JSON.stringify(refs)::jsonb
  // double-encodes it into a jsonb STRING and trips the refs-nonempty CHECK.
  const rows = await testDb`
    INSERT INTO staging_causal_edges (epoch_id, cause_event_id, effect_event_id, reasoning, source_references)
    VALUES (${epochId}::uuid, ${cause}::uuid, ${effect}::uuid, ${reasoning}, ${testDb.json(refs)})
    RETURNING id`;
  return (rows[0] as { id: string }).id;
}

/** A minimal PromotionResult — runCausalPass reads only these three fields. */
function promotionResult(over: Partial<PromotionResult>): PromotionResult {
  return {
    epochId: over.epochId ?? randomUUID(),
    mintedCausalEventIds: over.mintedCausalEventIds ?? [],
    insertedFactIds: over.insertedFactIds ?? [],
    corroboratedFactIds: over.corroboratedFactIds ?? [],
    expiredFactIds: [],
    mergedAwayEntityIds: [],
    sameAsLinkIds: [],
    mintedEntityIds: {},
    plan: {} as PromotionResult['plan'],
  };
}

/** All active causal_edges between a specific (cause, effect) settled-event pair. */
async function edgesBetween(cause: string, effect: string): Promise<Array<{ id: string; stale: boolean; reason: string | null; corrob: number }>> {
  const rows = await testDb`
    SELECT id::text AS id, stale_citation AS stale, stale_citation_reason AS reason, corroboration_count AS corrob
    FROM causal_edges
    WHERE cause_event_id = ${cause}::uuid AND effect_event_id = ${effect}::uuid AND expired_at IS NULL`;
  return (rows as unknown as Array<{ id: string; stale: boolean; reason: string | null; corrob: number }>);
}

describe('E6 causal pass — propose_causal_edge + causal_agent surface (nmemo-vpz.6)', () => {
  beforeEach(clean);
  afterAll(clean);

  describe('causal_agent allow-list (doc 41 §8a.6)', () => {
    it('surface = reads + propose_causal_edge, NO canonical causal-write tools', () => {
      const surface = allowlistFor('causal_agent');
      expect(surface.has('propose_causal_edge')).toBe(true);
      expect(surface.has('get_causal_delta')).toBe(true); // a representative causal read
      expect(surface.has('trace_causes')).toBe(true);
      // canonical causal-writes are causal-promotion code, never the agent's:
      expect(surface.has('create_causal_edge')).toBe(false);
      expect(surface.has('create_fact')).toBe(false);
      expect(surface.has('execute_merge')).toBe(false);
    });
  });

  describe('propose_causal_edge (doc 41 §6, §8a.6)', () => {
    it('stages an edge and returns stagedEdgeId + refsResolve, persisting the proposal', async () => {
      const epochId = randomUUID();
      const ctx = causalCtx(epochId);
      const ent = await createTestEntity({ canonicalName: `${TAG} Co`, entityType: 'organization' });
      const f = await createTestFact({ subjectEntityId: ent.id, predicate: 'raised_round', objectValue: 'Series B' });
      const cause = await insertEvent(ent.id, f.id);
      const effect = await insertEvent(ent.id, f.id);

      const res = await call('propose_causal_edge', {
        causeEventId: cause,
        effectEventId: effect,
        reasoning: 'The Series B round funded the HQ relocation.',
        sourceReferences: [{ type: 'fact', id: f.id, relevance: 'the funding fact' }],
      }, ctx);

      expect(res.stagedEdgeId).toMatch(UUID_RE);
      expect(res.refsResolve).toEqual({ cause: true, effect: true });

      const rows = await testDb`
        SELECT cause_event_id::text AS cause, effect_event_id::text AS effect, reasoning,
               proposed_by, epoch_id::text AS epoch, jsonb_array_length(source_references) AS n_refs
        FROM staging_causal_edges WHERE id = ${res.stagedEdgeId}::uuid`;
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).cause).toBe(cause);
      expect((rows[0] as any).effect).toBe(effect);
      expect((rows[0] as any).proposed_by).toBe('causal_agent');
      expect((rows[0] as any).epoch).toBe(epochId);
      expect(Number((rows[0] as any).n_refs)).toBe(1);
    });

    it('refsResolve flags an event id that does not resolve (still staged — disposal drops it)', async () => {
      const epochId = randomUUID();
      const ctx = causalCtx(epochId);
      const ent = await createTestEntity({ canonicalName: `${TAG} Co`, entityType: 'organization' });
      const f = await createTestFact({ subjectEntityId: ent.id, predicate: 'p', objectValue: 'v' });
      const cause = await insertEvent(ent.id, f.id);

      const res = await call('propose_causal_edge', {
        causeEventId: cause,
        effectEventId: randomUUID(), // no such settled event
        reasoning: 'r',
        sourceReferences: [{ type: 'fact', id: f.id, relevance: 'r' }],
      }, ctx);

      expect(res.refsResolve.cause).toBe(true);
      expect(res.refsResolve.effect).toBe(false);
      expect(res.stagedEdgeId).toMatch(UUID_RE); // the tool stages; causal-promotion disposes
    });

    it('citedFactStatus reports active | superseded | invalidated for cited facts', async () => {
      const epochId = randomUUID();
      const ctx = causalCtx(epochId);
      const ent = await createTestEntity({ canonicalName: `${TAG} Co`, entityType: 'organization' });
      const f = await createTestFact({ subjectEntityId: ent.id, predicate: 'p', objectValue: 'v' });
      const cause = await insertEvent(ent.id, f.id);
      const effect = await insertEvent(ent.id, f.id);

      const active = await createTestFact({ subjectEntityId: ent.id, predicate: 'a', objectValue: 'v' });
      const superseded = await createTestFact({ subjectEntityId: ent.id, predicate: 's', objectValue: 'v' });
      const invalid = await createTestFact({ subjectEntityId: ent.id, predicate: 'i', objectValue: 'v' });
      await testDb`UPDATE facts SET expired_at = now() WHERE id = ${superseded.id}::uuid`;
      await testDb`UPDATE facts SET invalid_at = now() WHERE id = ${invalid.id}::uuid`;

      const res = await call('propose_causal_edge', {
        causeEventId: cause,
        effectEventId: effect,
        reasoning: 'grounded on three facts of differing status',
        sourceReferences: [
          { type: 'fact', id: active.id, relevance: 'active' },
          { type: 'fact', id: superseded.id, relevance: 'superseded' },
          { type: 'fact', id: invalid.id, relevance: 'invalidated' },
          { type: 'memory', id: randomUUID(), relevance: 'non-fact ref, ignored' },
        ],
      }, ctx);

      const byId = Object.fromEntries(
        (res.citedFactStatus as Array<{ factId: string; status: string }>).map((s) => [s.factId, s.status]),
      );
      expect(byId[active.id]).toBe('active');
      expect(byId[superseded.id]).toBe('superseded');
      expect(byId[invalid.id]).toBe('invalidated');
      expect(res.citedFactStatus).toHaveLength(3); // the memory ref is not a fact-status row
    });

    it('rejects the doc-01 invariant: empty reasoning or empty source references', async () => {
      const epochId = randomUUID();
      const ctx = causalCtx(epochId);
      const ent = await createTestEntity({ canonicalName: `${TAG} Co`, entityType: 'organization' });
      const f = await createTestFact({ subjectEntityId: ent.id, predicate: 'p', objectValue: 'v' });
      const cause = await insertEvent(ent.id, f.id);
      const effect = await insertEvent(ent.id, f.id);
      const refs = [{ type: 'fact', id: f.id, relevance: 'r' }];

      await expect(
        handleToolCall('propose_causal_edge',
          { causeEventId: cause, effectEventId: effect, reasoning: '   ', sourceReferences: refs }, ctx),
      ).rejects.toThrow(/reasoning/);

      await expect(
        handleToolCall('propose_causal_edge',
          { causeEventId: cause, effectEventId: effect, reasoning: 'ok', sourceReferences: [] }, ctx),
      ).rejects.toThrow(/source/i);
    });

    it('requires a harness-injected epoch context', async () => {
      await expect(
        handleToolCall('propose_causal_edge',
          { causeEventId: randomUUID(), effectEventId: randomUUID(), reasoning: 'r', sourceReferences: [{ type: 'fact', id: randomUUID(), relevance: 'r' }] },
          { agent: 'causal_agent' }),
      ).rejects.toThrow(/epoch context/);
    });
  });
});

describe('applyCausalPromotion — disposal (doc 41 §6, §12 #5)', () => {
  beforeEach(clean);
  afterAll(clean);

  async function fixtureEvents() {
    const ent = await createTestEntity({ canonicalName: `${TAG} Co`, entityType: 'organization' });
    const f = await createTestFact({ subjectEntityId: ent.id, predicate: 'raised_round', objectValue: 'Series B' });
    const cause = await insertEvent(ent.id, f.id);
    const effect = await insertEvent(ent.id, f.id);
    return { ent, f, cause, effect };
  }

  it('promotes a staged edge between settled events, preserving reasoning + source_references', async () => {
    const epochId = randomUUID();
    const { f, cause, effect } = await fixtureEvents();
    await stageEdge(epochId, cause, effect, [{ type: 'fact', id: f.id, relevance: 'the funding fact' }], 'Series B funded the relocation');

    const r = await applyCausalPromotion(epochId);
    expect(r.created).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);

    const edges = await edgesBetween(cause, effect);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.stale).toBe(false);
    // Invariant: reasoning + >=1 source reference persisted (doc 01).
    const rows = await testDb`SELECT reasoning, jsonb_array_length(source_references) AS n FROM causal_edges WHERE id = ${edges[0]!.id}::uuid`;
    expect((rows[0] as any).reasoning).toContain('Series B');
    expect(Number((rows[0] as any).n)).toBeGreaterThan(0);
  });

  it('drops a staged edge whose effect event is not settled (ref-resolve)', async () => {
    const epochId = randomUUID();
    const { f, cause } = await fixtureEvents();
    await stageEdge(epochId, cause, randomUUID(), [{ type: 'fact', id: f.id, relevance: 'r' }]);
    const r = await applyCausalPromotion(epochId);
    expect(r.created).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.reason).toContain('unresolved');
  });

  it('drops a self-loop (cause == effect)', async () => {
    const epochId = randomUUID();
    const { f, cause } = await fixtureEvents();
    await stageEdge(epochId, cause, cause, [{ type: 'fact', id: f.id, relevance: 'r' }]);
    const r = await applyCausalPromotion(epochId);
    expect(r.created).toHaveLength(0);
    expect(r.dropped[0]!.reason).toContain('self-loop');
  });

  it('an invalidated cited fact → edge kept + stale_citation flagged, naming the fact (never auto-repointed)', async () => {
    const epochId = randomUUID();
    const { ent, cause, effect } = await fixtureEvents();
    const bad = await createTestFact({ subjectEntityId: ent.id, predicate: 'i', objectValue: 'v' });
    await testDb`UPDATE facts SET invalid_at = now() WHERE id = ${bad.id}::uuid`;
    await stageEdge(epochId, cause, effect, [{ type: 'fact', id: bad.id, relevance: 'shaky' }]);

    const r = await applyCausalPromotion(epochId);
    expect(r.created).toHaveLength(1);
    expect(r.created[0]!.staleCitation).toBe(true);

    const edges = await edgesBetween(cause, effect);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.stale).toBe(true);
    expect(edges[0]!.reason).toContain(bad.id);
  });

  it('a superseded cited fact → edge kept, NOT flagged (the past event is still real)', async () => {
    const epochId = randomUUID();
    const { ent, cause, effect } = await fixtureEvents();
    const sup = await createTestFact({ subjectEntityId: ent.id, predicate: 's', objectValue: 'v' });
    await testDb`UPDATE facts SET expired_at = now() WHERE id = ${sup.id}::uuid`;
    await stageEdge(epochId, cause, effect, [{ type: 'fact', id: sup.id, relevance: 'superseded' }]);

    const r = await applyCausalPromotion(epochId);
    expect(r.created).toHaveLength(1);
    expect(r.created[0]!.staleCitation).toBe(false);
    expect((await edgesBetween(cause, effect))[0]!.stale).toBe(false);
  });

  it('dedup + fresh-insert-only stale: a corroboration citing an invalidated fact does NOT condemn the healthy edge', async () => {
    const { ent, f, cause, effect } = await fixtureEvents();
    const bad = await createTestFact({ subjectEntityId: ent.id, predicate: 'i', objectValue: 'v' });
    await testDb`UPDATE facts SET invalid_at = now() WHERE id = ${bad.id}::uuid`;

    // epoch 1: fresh insert grounded on a healthy fact → not stale.
    const e1 = randomUUID();
    await stageEdge(e1, cause, effect, [{ type: 'fact', id: f.id, relevance: 'healthy' }]);
    const r1 = await applyCausalPromotion(e1);
    expect(r1.created[0]!.staleCitation).toBe(false);

    // epoch 2: identical pair, cites an INVALIDATED fact → corroborates the existing
    // edge (count → 2). A corroboration is NOT a fresh insert, so the edge keeps its
    // prior healthy grounding and is NOT flagged (the WHERE corroboration_count=1 guard).
    const e2 = randomUUID();
    await stageEdge(e2, cause, effect, [{ type: 'fact', id: bad.id, relevance: 'shaky' }]);
    const r2 = await applyCausalPromotion(e2);
    expect(r2.created[0]!.staleCitation).toBe(false);

    const edges = await edgesBetween(cause, effect);
    expect(edges).toHaveLength(1); // dedup: one canonical edge, not two
    expect(edges[0]!.corrob).toBeGreaterThan(1); // corroborated
    expect(edges[0]!.stale).toBe(false); // healthy edge not condemned
  });
});

describe('runCausalPass — trigger + dispose via injected invoker (doc 41 §12 #6)', () => {
  beforeEach(clean);
  afterAll(clean);

  it('skips when no trigger fires (low fact count, no causal language, no history)', async () => {
    const ent = await createTestEntity({ canonicalName: `${TAG} Co`, entityType: 'organization' });
    const f = await createTestFact({ subjectEntityId: ent.id, predicate: 'p', objectValue: 'v' });
    const cause = await insertEvent(ent.id, f.id);
    const effect = await insertEvent(ent.id, f.id);
    const epochId = randomUUID();

    let invoked = false;
    const res = await runCausalPass(
      epochId,
      promotionResult({ mintedCausalEventIds: [cause, effect], insertedFactIds: [f.id] }), // count 1 < 5
      { invokeCausalAgent: async () => { invoked = true; } },
    );
    expect(res.ran).toBe(false);
    expect(invoked).toBe(false);
  });

  it('fires on promoted-fact count >= N, pushes the scope, and disposes the staged edge', async () => {
    const ent = await createTestEntity({ canonicalName: `${TAG} Co`, entityType: 'organization' });
    const f = await createTestFact({ subjectEntityId: ent.id, predicate: 'p', objectValue: 'v' });
    const cause = await insertEvent(ent.id, f.id);
    const effect = await insertEvent(ent.id, f.id);
    const epochId = randomUUID();

    let seenScope: any = null;
    const res = await runCausalPass(
      epochId,
      promotionResult({
        mintedCausalEventIds: [cause, effect],
        insertedFactIds: [f.id, randomUUID(), randomUUID(), randomUUID(), randomUUID()], // 5 >= N
      }),
      {
        invokeCausalAgent: async (eid, scope) => {
          seenScope = scope;
          // The agent would propose_causal_edge; here the fake stages directly.
          await stageEdge(eid, cause, effect, [{ type: 'fact', id: f.id, relevance: 'r' }]);
        },
      },
    );

    expect(res.ran).toBe(true);
    expect(res.decision.reasons.join(' ')).toContain('promoted-fact count');
    expect(seenScope.epochId).toBe(epochId);
    expect(seenScope.newEvents).toHaveLength(2);
    expect(res.promotion?.created).toHaveLength(1);
    expect(await edgesBetween(cause, effect)).toHaveLength(1);
  });

  it('fires when a touched entity already has prior causal history (trigger c)', async () => {
    const ent = await createTestEntity({ canonicalName: `${TAG} Co`, entityType: 'organization' });
    const f = await createTestFact({ subjectEntityId: ent.id, predicate: 'p', objectValue: 'v' });
    // Prior causal structure: two earlier events + an edge between them.
    const pc = await insertEvent(ent.id, f.id);
    const pe = await insertEvent(ent.id, f.id);
    await testDb`INSERT INTO causal_edges (cause_event_id, effect_event_id, strength, initial_strength, reasoning, source_references, extraction_method)
                 VALUES (${pc}::uuid, ${pe}::uuid, 0.6, 0.6, 'prior', ${testDb.json([{ type: 'fact', id: f.id, relevance: 'r' }])}, 'llm')`;
    // The new promotion delta: one fresh event (low count, no causal language).
    const fresh = await insertEvent(ent.id, f.id);
    const epochId = randomUUID();

    const res = await runCausalPass(
      epochId,
      promotionResult({ mintedCausalEventIds: [fresh], insertedFactIds: [f.id] }),
      { invokeCausalAgent: async () => {} },
    );
    expect(res.ran).toBe(true);
    expect(res.decision.reasons.join(' ')).toContain('prior causal history');
  });
});
