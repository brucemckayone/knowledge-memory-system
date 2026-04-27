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
import { applyConfidenceDecay, createCausalEdge, expireCausalEdge } from '../../services/causal.js';
import { expireFact, invalidateFact } from '../../services/facts.js';
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

/**
 * Seed a single causal edge with caller-controlled lifecycle fields, used
 * by the decay tests to bypass the corroboration logic on the way in.
 */
async function seedDecayEdge(opts: {
  causeEventId: string;
  effectEventId: string;
  strength: number;
  /** corroboration_count, default 1. */
  corroborationCount?: number;
  /** how many days ago last_corroborated should be set; omit to use NOW(). */
  ageDays?: number;
  /** extraction_method, default 'llm'. */
  extractionMethod?: string;
  /** mark already-expired before the test runs. */
  expired?: boolean;
}): Promise<string> {
  const refLiteral = JSON.stringify([{ type: 'memory', id: randomUUID(), relevance: 'r' }]);
  const [row] = await testDb`
    INSERT INTO public.causal_edges (
      cause_event_id, effect_event_id, strength, reasoning, source_references,
      extraction_method, initial_strength, corroboration_count
    ) VALUES (
      ${opts.causeEventId}::uuid, ${opts.effectEventId}::uuid,
      ${opts.strength}, 'seeded for decay test', ${refLiteral}::jsonb,
      ${opts.extractionMethod ?? 'llm'}, ${opts.strength},
      ${opts.corroborationCount ?? 1}
    ) RETURNING id
  `;
  const id = row!.id as string;
  if (opts.ageDays !== undefined) {
    await testDb`
      UPDATE public.causal_edges
      SET last_corroborated = NOW() - (${opts.ageDays} * INTERVAL '1 day')
      WHERE id = ${id}::uuid
    `;
  }
  if (opts.expired) {
    await testDb`
      UPDATE public.causal_edges
      SET expired_at = NOW(), expire_reason = 'pre-test'
      WHERE id = ${id}::uuid
    `;
  }
  return id;
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

describe('Phase 2 — Edge Lifecycle: confidence decay', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('decays a stale uncorroborated edge by the default rate', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.5, ageDays: 31,
    });

    const result = await applyConfidenceDecay();

    expect(result.decayed).toBe(1);
    expect(result.expired).toBe(0);
    expect(result.decayedEdgeIds).toContain(id);

    const rows = await testDb`SELECT strength, decay_applied, expired_at FROM causal_edges WHERE id = ${id}::uuid`;
    expect(Number(rows[0]!.strength)).toBeCloseTo(0.475, 5); // 0.5 * 0.95
    expect(rows[0]!.decay_applied).toBe(true);
    expect(rows[0]!.expired_at).toBeNull();
  });

  it('writes a decayed audit row with actor=system_trigger', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.5, ageDays: 31,
    });

    await applyConfidenceDecay();

    const hist = await getEdgeHistory(id);
    expect(hist).toHaveLength(1);
    expect(hist[0]!.eventType).toBe('decayed');
    expect(hist[0]!.actor).toBe('system_trigger');
    expect(hist[0]!.previousStrength).toBeCloseTo(0.5, 5);
    expect(hist[0]!.newStrength).toBeCloseTo(0.475, 5);
  });

  it('expires an edge whose decayed strength reaches the floor', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    // 0.105 * 0.95 = 0.09975, which is <= floor (0.1) → expire.
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.105, ageDays: 31,
    });

    const result = await applyConfidenceDecay();

    expect(result.expired).toBe(1);
    expect(result.decayed).toBe(0);
    expect(result.expiredEdgeIds).toContain(id);

    const rows = await testDb`SELECT expired_at, expire_reason FROM causal_edges WHERE id = ${id}::uuid`;
    expect(rows[0]!.expired_at).not.toBeNull();
    expect(rows[0]!.expire_reason).toBe('confidence decay');

    const hist = await getEdgeHistory(id);
    expect(hist[0]!.eventType).toBe('expired');
    expect(hist[0]!.actor).toBe('system_trigger');
  });

  it('skips edges with corroboration_count > 1', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.5, ageDays: 31, corroborationCount: 2,
    });

    const result = await applyConfidenceDecay();
    expect(result.decayed).toBe(0);
    expect(result.expired).toBe(0);

    const rows = await testDb`SELECT strength, decay_applied FROM causal_edges WHERE id = ${id}::uuid`;
    expect(Number(rows[0]!.strength)).toBeCloseTo(0.5, 5);
    expect(rows[0]!.decay_applied).toBe(false);
  });

  it('skips edges that are not yet stale (last_corroborated within ageDays)', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.5, ageDays: 5,
    });

    const result = await applyConfidenceDecay();
    expect(result.decayed).toBe(0);

    const rows = await testDb`SELECT strength FROM causal_edges WHERE id = ${id}::uuid`;
    expect(Number(rows[0]!.strength)).toBeCloseTo(0.5, 5);
  });

  it('skips edges with extraction_method != llm (e.g., user-asserted)', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.5, ageDays: 31, extractionMethod: 'user',
    });

    const result = await applyConfidenceDecay();
    expect(result.decayed).toBe(0);

    const rows = await testDb`SELECT strength FROM causal_edges WHERE id = ${id}::uuid`;
    expect(Number(rows[0]!.strength)).toBeCloseTo(0.5, 5);
  });

  it('skips already-expired edges', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.5, ageDays: 31, expired: true,
    });

    const result = await applyConfidenceDecay();
    expect(result.decayed).toBe(0);
    expect(result.expired).toBe(0);

    const hist = await getEdgeHistory(id);
    expect(hist).toHaveLength(0); // no new audit row produced by decay
  });

  it('skips edges already at or below the floor (filter qualifier)', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    // strength == floor → strength > floor is false → excluded by qualifier.
    // The edge is left alone for the next caller (e.g., manual expire) to handle.
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.1, ageDays: 31,
    });

    const result = await applyConfidenceDecay();
    expect(result.decayed).toBe(0);
    expect(result.expired).toBe(0);

    const rows = await testDb`SELECT strength, expired_at FROM causal_edges WHERE id = ${id}::uuid`;
    expect(Number(rows[0]!.strength)).toBeCloseTo(0.1, 5);
    expect(rows[0]!.expired_at).toBeNull();
  });

  it('honours options.rate over the default', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.6, ageDays: 31,
    });

    await applyConfidenceDecay({ rate: 0.5 });

    const rows = await testDb`SELECT strength FROM causal_edges WHERE id = ${id}::uuid`;
    expect(Number(rows[0]!.strength)).toBeCloseTo(0.3, 5); // 0.6 * 0.5
  });

  it('honours options.actor on the audit row', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.5, ageDays: 31,
    });

    await applyConfidenceDecay({ actor: 'reasoning_agent' });

    const hist = await getEdgeHistory(id);
    expect(hist[0]!.actor).toBe('reasoning_agent');
  });

  it('honours MNEMO_DECAY_RATE env var when no options.rate is given', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.6, ageDays: 31,
    });

    const original = process.env.MNEMO_DECAY_RATE;
    process.env.MNEMO_DECAY_RATE = '0.5';
    try {
      await applyConfidenceDecay();
    } finally {
      if (original === undefined) delete process.env.MNEMO_DECAY_RATE;
      else process.env.MNEMO_DECAY_RATE = original;
    }

    const rows = await testDb`SELECT strength FROM causal_edges WHERE id = ${id}::uuid`;
    expect(Number(rows[0]!.strength)).toBeCloseTo(0.3, 5);
  });

  it('falls back to default when MNEMO_DECAY_RATE is invalid', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const id = await seedDecayEdge({
      causeEventId, effectEventId,
      strength: 0.5, ageDays: 31,
    });

    const original = process.env.MNEMO_DECAY_RATE;
    process.env.MNEMO_DECAY_RATE = 'not-a-number';
    try {
      await applyConfidenceDecay();
    } finally {
      if (original === undefined) delete process.env.MNEMO_DECAY_RATE;
      else process.env.MNEMO_DECAY_RATE = original;
    }

    const rows = await testDb`SELECT strength FROM causal_edges WHERE id = ${id}::uuid`;
    expect(Number(rows[0]!.strength)).toBeCloseTo(0.475, 5); // default 0.95 still applied
  });

  it('processes a mixed batch — some decayed, some expired, some skipped', async () => {
    const a = await seedEventPair();
    const b = await seedEventPair();
    const c = await seedEventPair();
    const d = await seedEventPair();

    // Should decay
    const decayId = await seedDecayEdge({
      causeEventId: a.causeEventId, effectEventId: a.effectEventId,
      strength: 0.5, ageDays: 31,
    });
    // Should expire (just above floor → falls to floor)
    const expireId = await seedDecayEdge({
      causeEventId: b.causeEventId, effectEventId: b.effectEventId,
      strength: 0.105, ageDays: 31,
    });
    // Should skip — corroborated
    const skipCorroboratedId = await seedDecayEdge({
      causeEventId: c.causeEventId, effectEventId: c.effectEventId,
      strength: 0.5, ageDays: 31, corroborationCount: 3,
    });
    // Should skip — fresh
    const skipFreshId = await seedDecayEdge({
      causeEventId: d.causeEventId, effectEventId: d.effectEventId,
      strength: 0.5, ageDays: 1,
    });

    const result = await applyConfidenceDecay();

    expect(result.decayed).toBe(1);
    expect(result.expired).toBe(1);
    expect(result.decayedEdgeIds).toEqual([decayId]);
    expect(result.expiredEdgeIds).toEqual([expireId]);

    const cRows = await testDb`SELECT strength, decay_applied FROM causal_edges WHERE id = ${skipCorroboratedId}::uuid`;
    expect(cRows[0]!.decay_applied).toBe(false);

    const dRows = await testDb`SELECT strength, decay_applied FROM causal_edges WHERE id = ${skipFreshId}::uuid`;
    expect(dRows[0]!.decay_applied).toBe(false);
  });
});

/**
 * Seed a cascade fixture: one subject entity, two facts (target + sibling),
 * three causal events, and three causal edges in a known topology.
 *
 *   sole-source edge   — cites only `factId`,        corroboration_count=1
 *   multi-source edge  — cites `factId` + `otherFactId`, corroboration_count=2
 *   non-citing edge    — cites only `otherFactId`,   corroboration_count=1
 *
 * Each edge is mirrored into `edge_source_refs` to match what the wired
 * createCausalEdge would have produced — the fixture is hand-rolled (raw
 * INSERT) so we control corroboration_count, strength, and the exact ref
 * topology. Cascade behaviour is exercised by expireFact / invalidateFact
 * on `factId` and observed via the three edges' state and audit rows.
 */
async function seedCascadeFixture(opts: {
  /** Initial strength for the multi-source edge. Default 0.5. */
  multiStrength?: number;
} = {}): Promise<{
  factId: string;
  otherFactId: string;
  soleEdgeId: string;
  multiEdgeId: string;
  nonCitingEdgeId: string;
}> {
  const subject = await createTestEntity({
    canonicalName: `cascade-subj-${randomUUID().slice(0, 8)}`,
    entityType: 'concept',
  });
  const factTarget = await createTestFact({
    subjectEntityId: subject.id,
    predicate: 'caused',
    objectValue: `cascade-target-${randomUUID().slice(0, 8)}`,
    confidence: 0.9,
  });
  const factOther = await createTestFact({
    subjectEntityId: subject.id,
    predicate: 'related_to',
    objectValue: `cascade-other-${randomUUID().slice(0, 8)}`,
    confidence: 0.9,
  });

  const [ev1] = await testDb`
    INSERT INTO public.causal_events (fact_id, transition_type, subject_entity_id, predicate)
    VALUES (${factTarget.id}::uuid, 'created', ${subject.id}::uuid, 'caused') RETURNING id
  `;
  const [ev2] = await testDb`
    INSERT INTO public.causal_events (fact_id, transition_type, subject_entity_id, predicate)
    VALUES (${factOther.id}::uuid, 'created', ${subject.id}::uuid, 'related_to') RETURNING id
  `;
  const [ev3] = await testDb`
    INSERT INTO public.causal_events (fact_id, transition_type, subject_entity_id, predicate)
    VALUES (${factTarget.id}::uuid, 'created', ${subject.id}::uuid, 'effect') RETURNING id
  `;

  const refsSole = JSON.stringify([{ type: 'fact', id: factTarget.id, relevance: 'sole' }]);
  const [soleEdge] = await testDb`
    INSERT INTO public.causal_edges (
      cause_event_id, effect_event_id, strength, reasoning, source_references,
      extraction_method, initial_strength, corroboration_count
    ) VALUES (
      ${ev1!.id}::uuid, ${ev3!.id}::uuid, 0.7, 'cascade fixture sole-source',
      ${refsSole}::jsonb, 'llm', 0.7, 1
    ) RETURNING id
  `;
  await testDb`
    INSERT INTO public.edge_source_refs (edge_id, ref_type, ref_id, relevance)
    VALUES (${soleEdge!.id}::uuid, 'fact', ${factTarget.id}::uuid, 'sole')
  `;

  const multiStrength = opts.multiStrength ?? 0.5;
  const refsMulti = JSON.stringify([
    { type: 'fact', id: factTarget.id, relevance: 'one' },
    { type: 'fact', id: factOther.id, relevance: 'two' },
  ]);
  const [multiEdge] = await testDb`
    INSERT INTO public.causal_edges (
      cause_event_id, effect_event_id, strength, reasoning, source_references,
      extraction_method, initial_strength, corroboration_count
    ) VALUES (
      ${ev2!.id}::uuid, ${ev3!.id}::uuid, ${multiStrength}, 'cascade fixture multi-source',
      ${refsMulti}::jsonb, 'llm', ${multiStrength}, 2
    ) RETURNING id
  `;
  await testDb`
    INSERT INTO public.edge_source_refs (edge_id, ref_type, ref_id, relevance) VALUES
      (${multiEdge!.id}::uuid, 'fact', ${factTarget.id}::uuid, 'one'),
      (${multiEdge!.id}::uuid, 'fact', ${factOther.id}::uuid, 'two')
  `;

  const refsNon = JSON.stringify([{ type: 'fact', id: factOther.id, relevance: 'unrelated' }]);
  const [nonCiting] = await testDb`
    INSERT INTO public.causal_edges (
      cause_event_id, effect_event_id, strength, reasoning, source_references,
      extraction_method, initial_strength, corroboration_count
    ) VALUES (
      ${ev2!.id}::uuid, ${ev1!.id}::uuid, 0.6, 'cascade fixture non-citing',
      ${refsNon}::jsonb, 'llm', 0.6, 1
    ) RETURNING id
  `;
  await testDb`
    INSERT INTO public.edge_source_refs (edge_id, ref_type, ref_id, relevance)
    VALUES (${nonCiting!.id}::uuid, 'fact', ${factOther.id}::uuid, 'unrelated')
  `;

  return {
    factId: factTarget.id,
    otherFactId: factOther.id,
    soleEdgeId: soleEdge!.id as string,
    multiEdgeId: multiEdge!.id as string,
    nonCitingEdgeId: nonCiting!.id as string,
  };
}

describe('Phase 2 — Edge Lifecycle: cascade (fact expiry/invalidation)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('expireFact expires sole-source edges (corroboration_count = 1)', async () => {
    const f = await seedCascadeFixture();

    await expireFact({ factId: f.factId, reasoning: 'test cascade — sole source', actor: 'user' });

    const [sole] = await testDb`
      SELECT expired_at::text AS expired_at, expire_reason FROM causal_edges WHERE id = ${f.soleEdgeId}::uuid
    `;
    expect(sole!.expired_at).not.toBeNull();
    expect(sole!.expire_reason).toContain('upstream fact');
    expect(sole!.expire_reason).toContain(f.factId);
  });

  it('expireFact weakens multi-source edges by 20% (corroboration_count > 1)', async () => {
    const f = await seedCascadeFixture({ multiStrength: 0.5 });

    await expireFact({ factId: f.factId, reasoning: 'test cascade — multi source', actor: 'user' });

    const [multi] = await testDb`
      SELECT strength, expired_at::text AS expired_at FROM causal_edges WHERE id = ${f.multiEdgeId}::uuid
    `;
    expect(multi!.expired_at).toBeNull();
    expect(Number(multi!.strength)).toBeCloseTo(0.4, 5);
  });

  it('expireFact does not affect edges that do not cite the fact', async () => {
    const f = await seedCascadeFixture();

    const [before] = await testDb`SELECT strength, expired_at::text AS expired_at FROM causal_edges WHERE id = ${f.nonCitingEdgeId}::uuid`;
    await expireFact({ factId: f.factId, reasoning: 'test cascade — non-citing', actor: 'user' });
    const [after] = await testDb`SELECT strength, expired_at::text AS expired_at FROM causal_edges WHERE id = ${f.nonCitingEdgeId}::uuid`;

    expect(after!.expired_at).toBe(before!.expired_at);
    expect(Number(after!.strength)).toBeCloseTo(Number(before!.strength), 5);
  });

  it('writes a cascade audit row with actor=cascade and event_type=expired on the sole-source edge', async () => {
    const f = await seedCascadeFixture();

    await expireFact({ factId: f.factId, reasoning: 'audit cascade', actor: 'reasoning_agent' });

    const history = await getEdgeHistory(f.soleEdgeId);
    const cascadeRow = history.find((r) => r.actor === 'cascade');
    expect(cascadeRow).toBeDefined();
    expect(cascadeRow!.eventType).toBe('expired');
    expect(cascadeRow!.previousStrength).toBeCloseTo(0.7, 5);
    expect(cascadeRow!.newStrength).toBeCloseTo(0.7, 5);
    expect(cascadeRow!.reasoning).toContain(f.factId);
  });

  it('writes a cascade audit row with actor=cascade and event_type=weakened on the multi-source edge', async () => {
    const f = await seedCascadeFixture({ multiStrength: 0.5 });

    await expireFact({ factId: f.factId, reasoning: 'audit cascade', actor: 'reasoning_agent' });

    const history = await getEdgeHistory(f.multiEdgeId);
    const cascadeRow = history.find((r) => r.actor === 'cascade');
    expect(cascadeRow).toBeDefined();
    expect(cascadeRow!.eventType).toBe('weakened');
    expect(cascadeRow!.previousStrength).toBeCloseTo(0.5, 5);
    expect(cascadeRow!.newStrength).toBeCloseTo(0.4, 5);
  });

  it('invalidateFact triggers the same cascade as expireFact', async () => {
    const f = await seedCascadeFixture({ multiStrength: 0.5 });

    await invalidateFact({ factId: f.factId, reasoning: 'test invalidate cascade', actor: 'user' });

    const [sole] = await testDb`SELECT expired_at::text AS expired_at FROM causal_edges WHERE id = ${f.soleEdgeId}::uuid`;
    expect(sole!.expired_at).not.toBeNull();
    const [multi] = await testDb`SELECT strength FROM causal_edges WHERE id = ${f.multiEdgeId}::uuid`;
    expect(Number(multi!.strength)).toBeCloseTo(0.4, 5);
  });

  it('weaken honours the 0.1 floor when strength * 0.8 would dip below', async () => {
    // multiStrength=0.11 → 0.11 * 0.8 = 0.088, floor clamps to 0.1
    const f = await seedCascadeFixture({ multiStrength: 0.11 });

    await expireFact({ factId: f.factId, reasoning: 'floor test', actor: 'user' });

    const [multi] = await testDb`SELECT strength FROM causal_edges WHERE id = ${f.multiEdgeId}::uuid`;
    expect(Number(multi!.strength)).toBeCloseTo(0.1, 5);
  });
});
