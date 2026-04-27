/**
 * Phase 2 — Edge Lifecycle (doc 13, nmemo-e2i)
 *
 * Part A coverage: exact-match corroboration in createCausalEdge (nmemo-e2i.1).
 * Semantic-match (e2i.2), decay (e2i.3) and cascade (e2i.4) live in their own
 * test blocks added when those beads land.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  deleteFromTables,
  randomUUID,
} from '../setup.js';
import { createCausalEdge, expireCausalEdge } from '../../services/causal.js';
import { getEdgeHistory } from '../../services/audit.js';

async function cleanSlate(): Promise<void> {
  await deleteFromTables({
    tables: [
      'causal_edge_history',
      'fact_history',
      'causal_edges',
      'causal_events',
      'memory_entities',
      'entity_aliases',
      'facts',
      'entity_merges',
      'entities',
    ],
    acknowledgeGlobal: true,
  });
}

async function seedEventPair(): Promise<{
  causeEventId: string;
  effectEventId: string;
  entityId: string;
  factId: string;
}> {
  const subject = await createTestEntity({
    canonicalName: `e2i-subj-${randomUUID().slice(0, 8)}`,
    entityType: 'person',
  });
  const fact = await createTestFact({
    subjectEntityId: subject.id,
    predicate: 'works_at',
    objectValue: `e2i-obj-${randomUUID().slice(0, 8)}`,
  });

  const [cause] = await testDb`
    INSERT INTO public.causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
    VALUES (${fact.id}::uuid, 'created', ${subject.id}::uuid, 'works_at', 'cause event')
    RETURNING id
  `;
  const [effect] = await testDb`
    INSERT INTO public.causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
    VALUES (${fact.id}::uuid, 'expired', ${subject.id}::uuid, 'works_at', 'effect event')
    RETURNING id
  `;

  return {
    causeEventId: cause!.id as string,
    effectEventId: effect!.id as string,
    entityId: subject.id,
    factId: fact.id,
  };
}

/**
 * Insert a freestanding cause/effect event pair with caller-controlled
 * `subject_entity_id` / `predicate` on each event. Used by the semantic-match
 * tests to produce multiple pairs that share the same `(entity, predicate)`
 * metadata but have different event IDs.
 */
async function createEventPair(opts: {
  causeEntityId: string | null;
  causePredicate: string | null;
  effectEntityId: string | null;
  effectPredicate: string | null;
}): Promise<{ causeEventId: string; effectEventId: string }> {
  const [cause] = await testDb`
    INSERT INTO public.causal_events (transition_type, subject_entity_id, predicate)
    VALUES ('created', ${opts.causeEntityId}::uuid, ${opts.causePredicate})
    RETURNING id
  `;
  const [effect] = await testDb`
    INSERT INTO public.causal_events (transition_type, subject_entity_id, predicate)
    VALUES ('created', ${opts.effectEntityId}::uuid, ${opts.effectPredicate})
    RETURNING id
  `;
  return {
    causeEventId: cause!.id as string,
    effectEventId: effect!.id as string,
  };
}

async function seedTwoEntities(): Promise<{ causeEntityId: string; effectEntityId: string }> {
  const cause = await createTestEntity({
    canonicalName: `e2i-cause-${randomUUID().slice(0, 8)}`,
    entityType: 'concept',
  });
  const effect = await createTestEntity({
    canonicalName: `e2i-effect-${randomUUID().slice(0, 8)}`,
    entityType: 'concept',
  });
  return { causeEntityId: cause.id, effectEntityId: effect.id };
}

describe('Phase 2 — Edge Lifecycle: exact-match corroboration', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('second assertion of same (cause, effect) returns the original edge id', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();

    const id1 = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'first assertion',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'first source' }],
      actor: 'graph_agent',
    });

    const id2 = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.6,
      reasoning: 'second assertion — same pair',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'second source' }],
      actor: 'reasoning_agent',
    });

    expect(id2).toBe(id1);

    const rows = await testDb`SELECT * FROM causal_edges WHERE id = ${id1}::uuid`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.corroboration_count).toBe(2);
    expect(Number(rows[0]!.strength)).toBeCloseTo(0.55, 5);
    expect(Number(rows[0]!.initial_strength)).toBeCloseTo(0.5, 5);
    expect(Array.isArray(rows[0]!.source_references)).toBe(true);
    expect((rows[0]!.source_references as unknown[]).length).toBe(2);
  });

  it('updates last_corroborated to a fresh timestamp', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();

    const id = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'first',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'graph_agent',
    });

    const before = await testDb`SELECT last_corroborated FROM causal_edges WHERE id = ${id}::uuid`;
    const beforeTs = new Date(before[0]!.last_corroborated as string).getTime();

    // 50ms gap so NOW() advances measurably.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.6,
      reasoning: 'second',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r2' }],
      actor: 'reasoning_agent',
    });

    const after = await testDb`SELECT last_corroborated FROM causal_edges WHERE id = ${id}::uuid`;
    const afterTs = new Date(after[0]!.last_corroborated as string).getTime();
    expect(afterTs).toBeGreaterThan(beforeTs);
  });

  it('caps strength at 1.0 across many corroborations', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();

    const id = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.95,
      reasoning: 'high-strength initial assertion',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'graph_agent',
    });

    for (let i = 0; i < 10; i++) {
      await createCausalEdge({
        causeEventId,
        effectEventId,
        strength: 0.99,
        reasoning: `corroboration ${i}`,
        sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: `r${i}` }],
        actor: 'reasoning_agent',
      });
    }

    const rows = await testDb`SELECT strength, corroboration_count FROM causal_edges WHERE id = ${id}::uuid`;
    expect(Number(rows[0]!.strength)).toBeLessThanOrEqual(1.0);
    expect(Number(rows[0]!.strength)).toBeCloseTo(1.0, 5);
    expect(rows[0]!.corroboration_count).toBe(11);
  });

  it('deduplicates source_references by type+id', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const sharedMemoryId = randomUUID();
    const uniqueMemoryId = randomUUID();

    const id = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'first',
      sourceReferences: [{ type: 'memory', id: sharedMemoryId, relevance: 'first' }],
      actor: 'graph_agent',
    });

    await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'second — re-cites first source plus a new one',
      sourceReferences: [
        { type: 'memory', id: sharedMemoryId, relevance: 'cited again — different relevance text' },
        { type: 'memory', id: uniqueMemoryId, relevance: 'new source' },
      ],
      actor: 'reasoning_agent',
    });

    const rows = await testDb`SELECT source_references FROM causal_edges WHERE id = ${id}::uuid`;
    const refs = rows[0]!.source_references as Array<{ type: string; id: string; relevance: string }>;
    expect(refs).toHaveLength(2);
    const ids = refs.map((r) => r.id).sort();
    expect(ids).toEqual([sharedMemoryId, uniqueMemoryId].sort());
    // First-write-wins for relevance — re-citing the same memory does not overwrite.
    const shared = refs.find((r) => r.id === sharedMemoryId)!;
    expect(shared.relevance).toBe('first');
  });

  it('writes a corroborated audit row with prev/new strength and the diff of refs', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const firstRefId = randomUUID();
    const newRefId = randomUUID();

    const id = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'first',
      sourceReferences: [{ type: 'memory', id: firstRefId, relevance: 'a' }],
      actor: 'graph_agent',
    });

    await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.7,
      reasoning: 'corroborating evidence found in another memory',
      sourceReferences: [
        { type: 'memory', id: firstRefId, relevance: 'duplicate' }, // dropped by dedup
        { type: 'memory', id: newRefId, relevance: 'new' },
      ],
      actor: 'reasoning_agent',
      reasoningReportId: null,
    });

    const hist = await getEdgeHistory(id);
    expect(hist).toHaveLength(2);

    const [latest, original] = hist;
    expect(latest!.eventType).toBe('corroborated');
    expect(latest!.actor).toBe('reasoning_agent');
    expect(latest!.previousStrength).toBeCloseTo(0.5, 5);
    expect(latest!.newStrength).toBeCloseTo(0.55, 5);
    expect(latest!.reasoning).toContain('corroborating evidence');
    expect(latest!.addedSourceRefs).toHaveLength(1);
    expect(latest!.addedSourceRefs![0]!.id).toBe(newRefId);

    expect(original!.eventType).toBe('created');
    expect(original!.actor).toBe('graph_agent');
  });

  it('records an empty addedSourceRefs diff when re-asserting the same ref', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const refId = randomUUID();

    const id = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'first',
      sourceReferences: [{ type: 'memory', id: refId, relevance: 'a' }],
      actor: 'graph_agent',
    });

    await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'second — exact same ref re-asserted',
      sourceReferences: [{ type: 'memory', id: refId, relevance: 'a' }],
      actor: 'reasoning_agent',
    });

    const hist = await getEdgeHistory(id);
    expect(hist[0]!.eventType).toBe('corroborated');
    expect(hist[0]!.addedSourceRefs).toEqual([]);
  });

  it('does not corroborate an expired edge — creates a new one instead', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();

    const id1 = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'first',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'graph_agent',
    });

    await expireCausalEdge({
      edgeId: id1,
      reasoning: 'archiving for test',
      actor: 'user',
    });

    const id2 = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.6,
      reasoning: 'asserted again post-expiry',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r2' }],
      actor: 'reasoning_agent',
    });

    expect(id2).not.toBe(id1);

    const rows = await testDb`
      SELECT id, expired_at, corroboration_count
      FROM causal_edges
      WHERE cause_event_id = ${causeEventId}::uuid
        AND effect_event_id = ${effectEventId}::uuid
      ORDER BY created_at ASC
    `;
    expect(rows.length).toBe(2);
    expect(rows[0]!.expired_at).not.toBeNull();
    expect(rows[1]!.expired_at).toBeNull();
    expect(rows[1]!.corroboration_count).toBe(1);
  });
});

describe('Phase 2 — Edge Lifecycle: semantic-match corroboration', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('two distinct event pairs sharing (entity, predicate) corroborate the same edge', async () => {
    const { causeEntityId, effectEntityId } = await seedTwoEntities();
    const pairA = await createEventPair({
      causeEntityId, causePredicate: 'mandates',
      effectEntityId, effectPredicate: 'enabled',
    });
    const pairB = await createEventPair({
      causeEntityId, causePredicate: 'mandates',
      effectEntityId, effectPredicate: 'enabled',
    });

    const id1 = await createCausalEdge({
      causeEventId: pairA.causeEventId,
      effectEventId: pairA.effectEventId,
      strength: 0.5,
      reasoning: 'first source mentions the link',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'a' }],
      actor: 'graph_agent',
    });

    const id2 = await createCausalEdge({
      causeEventId: pairB.causeEventId,
      effectEventId: pairB.effectEventId,
      strength: 0.6,
      reasoning: 'second source — different events but same claim',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'b' }],
      actor: 'reasoning_agent',
    });

    expect(id2).toBe(id1);

    const rows = await testDb`SELECT corroboration_count, strength FROM causal_edges WHERE id = ${id1}::uuid`;
    expect(rows[0]!.corroboration_count).toBe(2);
    expect(Number(rows[0]!.strength)).toBeCloseTo(0.55, 5);
  });

  it('writes a corroborated audit row for the semantic match', async () => {
    const { causeEntityId, effectEntityId } = await seedTwoEntities();
    const pairA = await createEventPair({
      causeEntityId, causePredicate: 'p1',
      effectEntityId, effectPredicate: 'p2',
    });
    const pairB = await createEventPair({
      causeEntityId, causePredicate: 'p1',
      effectEntityId, effectPredicate: 'p2',
    });

    const id = await createCausalEdge({
      causeEventId: pairA.causeEventId,
      effectEventId: pairA.effectEventId,
      strength: 0.5,
      reasoning: 'first',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'a' }],
      actor: 'graph_agent',
    });
    await createCausalEdge({
      causeEventId: pairB.causeEventId,
      effectEventId: pairB.effectEventId,
      strength: 0.6,
      reasoning: 'second source confirms',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'b' }],
      actor: 'reasoning_agent',
    });

    const hist = await getEdgeHistory(id);
    expect(hist[0]!.eventType).toBe('corroborated');
    expect(hist[0]!.actor).toBe('reasoning_agent');
    expect(hist[0]!.previousStrength).toBeCloseTo(0.5, 5);
    expect(hist[0]!.newStrength).toBeCloseTo(0.55, 5);
  });

  it('picks the strongest active candidate when multiple semantic matches exist', async () => {
    const { causeEntityId, effectEntityId } = await seedTwoEntities();
    const meta = {
      causeEntityId, causePredicate: 'p1',
      effectEntityId, effectPredicate: 'p2',
    };
    const pairWeak = await createEventPair(meta);
    const pairStrong = await createEventPair(meta);
    const pairNew = await createEventPair(meta);

    // Two parallel active edges seeded directly so corroboration logic
    // doesn't collapse them on the way in. Real callers shouldn't end up
    // with parallel edges — this is the post-load / migration scenario.
    const refLiteral = JSON.stringify([{ type: 'memory', id: randomUUID(), relevance: 'r' }]);
    const [weak] = await testDb`
      INSERT INTO public.causal_edges (
        cause_event_id, effect_event_id, strength, reasoning, source_references,
        extraction_method, initial_strength
      ) VALUES (
        ${pairWeak.causeEventId}::uuid, ${pairWeak.effectEventId}::uuid,
        0.3, 'weak edge', ${refLiteral}::jsonb, 'llm', 0.3
      ) RETURNING id
    `;
    const [strong] = await testDb`
      INSERT INTO public.causal_edges (
        cause_event_id, effect_event_id, strength, reasoning, source_references,
        extraction_method, initial_strength
      ) VALUES (
        ${pairStrong.causeEventId}::uuid, ${pairStrong.effectEventId}::uuid,
        0.8, 'strong edge', ${refLiteral}::jsonb, 'llm', 0.8
      ) RETURNING id
    `;

    const newId = await createCausalEdge({
      causeEventId: pairNew.causeEventId,
      effectEventId: pairNew.effectEventId,
      strength: 0.5,
      reasoning: 'third assertion of the same claim',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'reasoning_agent',
    });

    expect(newId).toBe(strong!.id as string);

    const weakRow = await testDb`SELECT corroboration_count, strength FROM causal_edges WHERE id = ${weak!.id}::uuid`;
    expect(weakRow[0]!.corroboration_count).toBe(1);
    expect(Number(weakRow[0]!.strength)).toBeCloseTo(0.3, 5);

    const strongRow = await testDb`SELECT corroboration_count, strength FROM causal_edges WHERE id = ${strong!.id}::uuid`;
    expect(strongRow[0]!.corroboration_count).toBe(2);
    expect(Number(strongRow[0]!.strength)).toBeCloseTo(0.85, 5);
  });

  it('does not match when the cause predicate differs', async () => {
    const { causeEntityId, effectEntityId } = await seedTwoEntities();
    const pairA = await createEventPair({
      causeEntityId, causePredicate: 'p1',
      effectEntityId, effectPredicate: 'p2',
    });
    const pairB = await createEventPair({
      causeEntityId, causePredicate: 'different-predicate',
      effectEntityId, effectPredicate: 'p2',
    });

    const id1 = await createCausalEdge({
      causeEventId: pairA.causeEventId,
      effectEventId: pairA.effectEventId,
      strength: 0.5,
      reasoning: 'first',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'graph_agent',
    });
    const id2 = await createCausalEdge({
      causeEventId: pairB.causeEventId,
      effectEventId: pairB.effectEventId,
      strength: 0.5,
      reasoning: 'second — different cause predicate',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'reasoning_agent',
    });

    expect(id2).not.toBe(id1);
  });

  it('does not match when the effect entity differs', async () => {
    const { causeEntityId } = await seedTwoEntities();
    const effectA = await createTestEntity({ canonicalName: `e2i-effA-${randomUUID().slice(0, 8)}`, entityType: 'concept' });
    const effectB = await createTestEntity({ canonicalName: `e2i-effB-${randomUUID().slice(0, 8)}`, entityType: 'concept' });

    const pairA = await createEventPair({
      causeEntityId, causePredicate: 'p1',
      effectEntityId: effectA.id, effectPredicate: 'p2',
    });
    const pairB = await createEventPair({
      causeEntityId, causePredicate: 'p1',
      effectEntityId: effectB.id, effectPredicate: 'p2',
    });

    const id1 = await createCausalEdge({
      causeEventId: pairA.causeEventId,
      effectEventId: pairA.effectEventId,
      strength: 0.5,
      reasoning: 'first',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'graph_agent',
    });
    const id2 = await createCausalEdge({
      causeEventId: pairB.causeEventId,
      effectEventId: pairB.effectEventId,
      strength: 0.5,
      reasoning: 'second — different effect entity',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'reasoning_agent',
    });

    expect(id2).not.toBe(id1);
  });

  it('does not false-match when both events have NULL predicate', async () => {
    const { causeEntityId, effectEntityId } = await seedTwoEntities();
    const pairA = await createEventPair({
      causeEntityId, causePredicate: null,
      effectEntityId, effectPredicate: null,
    });
    const pairB = await createEventPair({
      causeEntityId, causePredicate: null,
      effectEntityId, effectPredicate: null,
    });

    const id1 = await createCausalEdge({
      causeEventId: pairA.causeEventId,
      effectEventId: pairA.effectEventId,
      strength: 0.5,
      reasoning: 'first',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'graph_agent',
    });
    const id2 = await createCausalEdge({
      causeEventId: pairB.causeEventId,
      effectEventId: pairB.effectEventId,
      strength: 0.5,
      reasoning: 'second — NULL metadata on both',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'reasoning_agent',
    });

    // NULL semantics on JOIN equality must NOT collapse anonymous events.
    expect(id2).not.toBe(id1);
  });

  it('falls through to insert when neither exact nor semantic match exists', async () => {
    const { causeEntityId, effectEntityId } = await seedTwoEntities();
    const pair = await createEventPair({
      causeEntityId, causePredicate: 'unique-1',
      effectEntityId, effectPredicate: 'unique-2',
    });

    const id = await createCausalEdge({
      causeEventId: pair.causeEventId,
      effectEventId: pair.effectEventId,
      strength: 0.5,
      reasoning: 'fresh edge',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'graph_agent',
    });

    const rows = await testDb`SELECT corroboration_count FROM causal_edges WHERE id = ${id}::uuid`;
    expect(rows[0]!.corroboration_count).toBe(1);
  });

  it('does not corroborate against an expired semantic-equivalent edge — creates a new one', async () => {
    const { causeEntityId, effectEntityId } = await seedTwoEntities();
    const meta = {
      causeEntityId, causePredicate: 'p1',
      effectEntityId, effectPredicate: 'p2',
    };
    const pairA = await createEventPair(meta);
    const pairB = await createEventPair(meta);

    const id1 = await createCausalEdge({
      causeEventId: pairA.causeEventId,
      effectEventId: pairA.effectEventId,
      strength: 0.5,
      reasoning: 'first',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'graph_agent',
    });

    await expireCausalEdge({ edgeId: id1, reasoning: 'archived', actor: 'user' });

    const id2 = await createCausalEdge({
      causeEventId: pairB.causeEventId,
      effectEventId: pairB.effectEventId,
      strength: 0.6,
      reasoning: 'asserted again, semantically equivalent',
      sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'r' }],
      actor: 'reasoning_agent',
    });

    expect(id2).not.toBe(id1);
  });
});
