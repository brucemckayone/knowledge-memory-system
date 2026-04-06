/**
 * B03: Causal service — write functions
 *
 * Verifies createCausalEdge validation and creation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';
import { createCausalEdge } from '../../services/causal.js';

describe('B03: Causal service — write functions', () => {
  let entityId: string;
  let factId: string;
  let causeEventId: string;
  let effectEventId: string;

  beforeAll(async () => {

    const entity = await createTestEntity({
      canonicalName: 'B03 Test Person',
      entityType: 'person',
    });
    entityId = entity.id;

    const fact = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'works_at',
      objectValue: 'TestCorp',
    });
    factId = fact.id;

    // LOAD 'age' is required per-session for PL/pgSQL EXECUTE to resolve cypher()
    await testDb.unsafe(`LOAD 'age'`).catch(() => {});
    await testDb.unsafe(`SET search_path = ag_catalog, public, "$user"`);

    // Create two causal events for edge tests
    const [ev1] = await testDb`
      INSERT INTO public.causal_events (fact_id, transition_type, subject_entity_id, predicate)
      VALUES (${factId}::uuid, 'created', ${entityId}::uuid, 'works_at')
      RETURNING id
    `;
    const [ev2] = await testDb`
      INSERT INTO public.causal_events (fact_id, transition_type, subject_entity_id, predicate)
      VALUES (${factId}::uuid, 'expired', ${entityId}::uuid, 'works_at')
      RETURNING id
    `;
    causeEventId = ev1!.id;
    effectEventId = ev2!.id;
  });

  afterAll(async () => {
    // Only clean up our own data (scoped by entity)
    await testDb.unsafe(`DELETE FROM causal_edges WHERE cause_event_id = '${causeEventId}' OR effect_event_id = '${effectEventId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM causal_events WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM facts WHERE id = '${factId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityId}'`).catch(() => {});
  });

  it('creates a causal edge with valid params and returns edge ID', async () => {
    const edgeId = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.8,
      reasoning: 'Boss toxicity documented in multiple sources led to departure',
      sourceReferences: [
        { type: 'memory', id: crypto.randomUUID(), relevance: 'source text mentions toxic work environment' },
        { type: 'fact', id: factId, relevance: 'employment fact confirms timeline' },
      ],
    });

    expect(edgeId).toBeTruthy();

    // Verify in database
    const edges = await testDb`
      SELECT * FROM causal_edges WHERE id = ${edgeId}::uuid
    `;
    expect(edges.length).toBe(1);
    expect(edges[0]!.cause_event_id).toBe(causeEventId);
    expect(edges[0]!.effect_event_id).toBe(effectEventId);
    expect(edges[0]!.strength).toBeCloseTo(0.8);
    expect(edges[0]!.initial_strength).toBeCloseTo(0.8);
    expect(edges[0]!.reasoning).toContain('Boss toxicity');
    expect(edges[0]!.extraction_method).toBe('llm');
    expect(edges[0]!.expired_at).toBeNull();
  });

  it('rejects empty reasoning', async () => {
    await expect(createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: '',
      sourceReferences: [{ type: 'fact', id: factId, relevance: 'test' }],
    })).rejects.toThrow('reasoning must be a non-empty string');
  });

  it('rejects empty sourceReferences', async () => {
    await expect(createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'Some reasoning',
      sourceReferences: [],
    })).rejects.toThrow('sourceReferences must be a non-empty array');
  });

  it('rejects sourceReference with invalid type', async () => {
    await expect(createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'Some reasoning',
      sourceReferences: [{ type: 'invalid' as any, id: crypto.randomUUID(), relevance: 'test' }],
    })).rejects.toThrow("sourceReference type must be");
  });

  it('rejects sourceReference with invalid UUID', async () => {
    await expect(createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'Some reasoning',
      sourceReferences: [{ type: 'fact', id: 'not-a-uuid', relevance: 'test' }],
    })).rejects.toThrow('sourceReference id must be a valid UUID');
  });

  it('rejects sourceReference with empty relevance', async () => {
    await expect(createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'Some reasoning',
      sourceReferences: [{ type: 'fact', id: crypto.randomUUID(), relevance: '' }],
    })).rejects.toThrow('sourceReference relevance must be a non-empty string');
  });

  it('rejects self-loop (causeEventId === effectEventId)', async () => {
    await expect(createCausalEdge({
      causeEventId,
      effectEventId: causeEventId,
      strength: 0.5,
      reasoning: 'Some reasoning',
      sourceReferences: [{ type: 'fact', id: factId, relevance: 'test' }],
    })).rejects.toThrow('no self-loops');
  });

  it('rejects non-existent causeEventId', async () => {
    const fakeId = crypto.randomUUID();
    await expect(createCausalEdge({
      causeEventId: fakeId,
      effectEventId,
      strength: 0.5,
      reasoning: 'Some reasoning',
      sourceReferences: [{ type: 'fact', id: factId, relevance: 'test' }],
    })).rejects.toThrow('does not reference an existing causal event');
  });

  it('created edge appears in AGE causal_graph', async () => {
    // AGE sync triggers require ag_catalog in session search_path and LOAD 'age'.
    // The Drizzle db connection (used by createCausalEdge) doesn't have these,
    // so we insert via testDb with the correct setup to verify the trigger.
    await testDb.unsafe(`LOAD 'age'`).catch(() => {});
    await testDb.unsafe(`SET search_path = ag_catalog, public, "$user"`);

    // Clean up prior CAUSED edges in AGE
    try {
      await testDb.unsafe(
        `SELECT * FROM cypher('causal_graph', $$MATCH ()-[r:CAUSED]->() DELETE r$$) as (v agtype)`
      );
    } catch { /* may not exist */ }

    // Delete only our edges before re-inserting
    await testDb.unsafe(`DELETE FROM public.causal_edges WHERE cause_event_id = '${causeEventId}' OR effect_event_id = '${effectEventId}'`);
    await testDb`
      INSERT INTO public.causal_edges (
        cause_event_id, effect_event_id, strength, extraction_method,
        reasoning, source_references, initial_strength
      ) VALUES (
        ${causeEventId}::uuid, ${effectEventId}::uuid, 0.75, 'llm',
        'AGE sync test', ${JSON.stringify([{ type: 'entity', id: entityId, relevance: 'test' }])}::jsonb,
        0.75
      )
    `;

    // Query AGE for the CAUSED edge
    const edges = await testDb.unsafe(`
      SELECT * FROM cypher('causal_graph', $$
        MATCH (cause:Transition {event_id: '${causeEventId}'})-[r:CAUSED]->(effect:Transition {event_id: '${effectEventId}'})
        RETURN cause.event_id, effect.event_id
      $$) as (cause_id agtype, effect_id agtype)
    `);

    expect(edges.length).toBe(1);
  });
});
