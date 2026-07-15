/**
 * audit_agent propose_bridge_edge → staging → promotion (bead nmemo-uhp.12.2).
 *
 * End-to-end over the whole Phase-B surface built so far: the audit agent stages a
 * cross-corpus ENTITY→ENTITY bridge via handleToolCall (allow-list enforced), the
 * tool previews endpoint resolution + cited-fact status, and bridge-promotion
 * disposes it to canonical bridge_edges with an 'entity' endpoint (migration 056).
 * Also pins the deny-by-default and doc-01 invariants. No ML — entities are seeded
 * directly (the propose tool does not embed; endpoints resolve by existence).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, randomUUID } from './setup.js';
import { handleToolCall, allowlistFor, VALID_ACTORS, GRAPH_TOOLS } from '../services/causal-agent.js';
import { applyBridgePromotion } from '../services/bridge-promotion.js';

// Pure structural checks on the audit_agent surface (no DB). They live in the DB
// lane because importing causal-agent.js loads config (which requires DATABASE_URL,
// set only in this lane), not because they touch the database.
describe('audit_agent MCP surface — structural (nmemo-uhp.12.2)', () => {
  it('audit_agent is a valid actor with a mutating propose_bridge_edge tool', () => {
    expect(VALID_ACTORS.has('audit_agent')).toBe(true);
    const t = GRAPH_TOOLS.find((x) => x.name === 'propose_bridge_edge');
    expect(t?.mutates).toBe(true);
    expect(Object.keys(t!.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
  });

  it("surface = reads + propose_bridge_edge; NO canonical-write or foreign-pass staging tool", () => {
    const surface = allowlistFor('audit_agent');
    expect(surface.has('propose_bridge_edge')).toBe(true);
    expect(surface.has('search_similar_entities')).toBe(true);
    expect(surface.has('query_entity_facts')).toBe(true);
    for (const forbidden of [
      'create_fact', 'expire_fact', 'invalidate_fact', 'execute_merge', 'create_same_as_link',
      'propose_entity', 'propose_fact', 'propose_causal_edge', 'propose_identity_verdict',
    ]) {
      expect(surface.has(forbidden)).toBe(false);
    }
    const names = new Set(GRAPH_TOOLS.map((t) => t.name));
    for (const tool of surface) expect(names.has(tool)).toBe(true);
  });
});

async function seedEntity(name: string, corpusId: string): Promise<string> {
  const rows = await testDb`
    INSERT INTO public.entities (canonical_name, entity_type, corpus_id)
    VALUES (${name}, 'concept', ${corpusId})
    RETURNING id::text AS id
  `;
  return (rows[0] as { id: string }).id;
}

async function clean(): Promise<void> {
  await testDb`DELETE FROM public.bridge_source_refs`;
  await testDb`DELETE FROM public.bridge_edges`;
  await testDb`DELETE FROM public.staging_bridge_edges`;
  await testDb`DELETE FROM public.entities WHERE corpus_id IN ('code', 'std')`;
}

const validInput = (src: string, tgt: string) => ({
  aKind: 'entity',
  aRef: src,
  bKind: 'entity',
  bRef: tgt,
  sourceCorpusId: 'code',
  targetCorpusId: 'std',
  relation: 'violates',
  reasoning: 'memcpy copies without a bound check; Rule 21.18 requires a bounded size',
  sourceReferences: [{ type: 'entity', id: src, relevance: 'the offending call site' }],
});

describe('audit_agent bridge surface (nmemo-uhp.12.2)', () => {
  beforeEach(clean);

  it('stages an entity→entity bridge, previews endpoint resolution, promotes to canonical', async () => {
    const src = await seedEntity('memcpy', 'code');
    const tgt = await seedEntity('MISRA Rule 21.18', 'std');
    const invocationId = randomUUID();

    const raw = await handleToolCall('propose_bridge_edge', validInput(src, tgt), {
      agent: 'audit_agent',
      invocationId,
    });
    const res = JSON.parse(raw);
    expect(res.stagedEdgeId).toBeTruthy();
    expect(res.endpointsResolve).toEqual({ a: true, b: true });
    expect(res.citedFactStatus).toEqual([]); // no fact refs cited

    const staged = await testDb`
      SELECT invocation_id::text AS iid, a_ref::text AS a_ref, relation
      FROM public.staging_bridge_edges
    `;
    expect(staged.length).toBe(1);
    expect((staged[0] as { iid: string }).iid).toBe(invocationId);
    expect((staged[0] as { a_ref: string }).a_ref).toBe(src);

    const result = await applyBridgePromotion(invocationId);
    expect(result.created.length).toBe(1);

    const edges = await testDb`
      SELECT a_kind, a_ref::text AS a_ref, b_ref::text AS b_ref, relation, reasoning
      FROM public.bridge_edges WHERE expired_at IS NULL
    `;
    expect(edges.length).toBe(1);
    const e = edges[0] as { a_kind: string; a_ref: string; b_ref: string; relation: string; reasoning: string };
    expect(e.a_kind).toBe('entity');
    expect(e.a_ref).toBe(src);
    expect(e.b_ref).toBe(tgt);
    expect(e.relation).toBe('violates');
    expect(e.reasoning.length).toBeGreaterThan(0);
  });

  it('previews an unresolved endpoint (endpointsResolve.a=false) and promotion DROPS it', async () => {
    const tgt = await seedEntity('some rule', 'std');
    const bogus = randomUUID(); // no such entity
    const invocationId = randomUUID();

    const raw = await handleToolCall('propose_bridge_edge', {
      ...validInput(bogus, tgt),
      sourceReferences: [{ type: 'entity', id: tgt, relevance: 'y' }],
    }, { agent: 'audit_agent', invocationId });
    expect(JSON.parse(raw).endpointsResolve.a).toBe(false);

    const result = await applyBridgePromotion(invocationId);
    expect(result.created.length).toBe(0);
    expect(result.dropped.length).toBe(1);
    expect(result.dropped[0]!.reason).toMatch(/unresolved endpoint/i);
  });

  it('rejects an off-surface tool for audit_agent (deny-by-default)', async () => {
    await expect(handleToolCall('create_fact', {}, { agent: 'audit_agent' })).rejects.toThrow(/not permitted/i);
  });

  it('requires an invocation context (MNEMO_INVOCATION_ID)', async () => {
    const src = await seedEntity('a', 'code');
    const tgt = await seedEntity('b', 'std');
    await expect(
      handleToolCall('propose_bridge_edge', validInput(src, tgt), { agent: 'audit_agent' }),
    ).rejects.toThrow(/invocation context/i);
  });

  it('rejects empty reasoning (doc-01 invariant)', async () => {
    const src = await seedEntity('a', 'code');
    const tgt = await seedEntity('b', 'std');
    await expect(
      handleToolCall('propose_bridge_edge', { ...validInput(src, tgt), reasoning: '   ' }, {
        agent: 'audit_agent',
        invocationId: randomUUID(),
      }),
    ).rejects.toThrow(/non-empty reasoning/i);
  });
});
