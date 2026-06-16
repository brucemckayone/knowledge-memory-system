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
 * The causal-promotion disposer + the trigger/delta/invoke seam land in later E6
 * steps; their DB tests will extend this file.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { handleToolCall, allowlistFor, type ToolCallContext } from '../../services/causal-agent.js';
import { testDb, createTestEntity, createTestFact } from '../setup.js';

const TAG = 'caustest';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function clean(): Promise<void> {
  await testDb.unsafe('DELETE FROM staging_causal_edges');
  const tagEntities = `SELECT id FROM entities WHERE canonical_name LIKE '${TAG}%'`;
  const tagFacts = `SELECT id FROM facts WHERE subject_entity_id IN (${tagEntities})`;
  // causal_events.fact_id and .subject_entity_id are RESTRICT FKs — clear the causal
  // layer (edges → events) before the facts/entities they point at.
  await testDb.unsafe(
    `DELETE FROM causal_edges WHERE cause_event_id IN (SELECT id FROM causal_events WHERE subject_entity_id IN (${tagEntities})) OR effect_event_id IN (SELECT id FROM causal_events WHERE subject_entity_id IN (${tagEntities}))`,
  );
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
