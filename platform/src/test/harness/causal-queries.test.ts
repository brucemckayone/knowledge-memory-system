/**
 * B04: Causal service — read/query functions
 *
 * Tests traceCauses, projectTrajectory, getEntityCausalHistory, getCausalDelta
 * using a 3-edge chain: A → B → C
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';
import {
  traceCauses,
  projectTrajectory,
  getEntityCausalHistory,
  getCausalDelta,
} from '../../services/causal.js';

describe('B04: Causal service — read/query functions', () => {
  let entityId: string;
  let factA: string, factB: string, factC: string;
  let eventA: string, eventB: string, eventC: string;
  let beforeTest: Date;

  beforeAll(async () => {
    // Capture DB server time before creating events
    const rows = await testDb`SELECT NOW() - INTERVAL '1 second' as now`;
    beforeTest = new Date(rows[0]!.now);

    const entity = await createTestEntity({
      canonicalName: 'B04 Chain Entity',
      entityType: 'person',
    });
    entityId = entity.id;

    // Create 3 facts
    const fA = await createTestFact({ subjectEntityId: entityId, predicate: 'started_at', objectValue: 'new job' });
    const fB = await createTestFact({ subjectEntityId: entityId, predicate: 'experiences', objectValue: 'stress' });
    const fC = await createTestFact({ subjectEntityId: entityId, predicate: 'experiences', objectValue: 'poor sleep' });
    factA = fA.id; factB = fB.id; factC = fC.id;

    // Create 3 causal events (one per fact)
    const [evA] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${factA}::uuid, 'created', ${entityId}::uuid, 'started_at', 'Started new job')
      RETURNING id
    `;
    const [evB] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${factB}::uuid, 'created', ${entityId}::uuid, 'experiences', 'Feeling stressed')
      RETURNING id
    `;
    const [evC] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${factC}::uuid, 'created', ${entityId}::uuid, 'experiences', 'Sleeping badly')
      RETURNING id
    `;
    eventA = evA!.id; eventB = evB!.id; eventC = evC!.id;

    // Create chain: A → B → C
    await testDb`
      INSERT INTO causal_edges (cause_event_id, effect_event_id, strength, extraction_method, reasoning, source_references, initial_strength)
      VALUES (${eventA}::uuid, ${eventB}::uuid, 0.8, 'llm', 'New job caused stress', ${JSON.stringify([{type:'fact', id: factA, relevance:'job start'}])}::jsonb, 0.8)
    `;
    await testDb`
      INSERT INTO causal_edges (cause_event_id, effect_event_id, strength, extraction_method, reasoning, source_references, initial_strength)
      VALUES (${eventB}::uuid, ${eventC}::uuid, 0.7, 'llm', 'Stress caused poor sleep', ${JSON.stringify([{type:'fact', id: factB, relevance:'stress documented'}])}::jsonb, 0.7)
    `;
  });

  afterAll(async () => {
    await testDb.unsafe(`DELETE FROM causal_edges WHERE cause_event_id IN (SELECT id FROM causal_events WHERE subject_entity_id = '${entityId}')`).catch(() => {});
    await testDb.unsafe(`DELETE FROM causal_events WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityId}'`).catch(() => {});
  });

  // --- traceCauses ---

  it('traceCauses(C) returns full chain [A, B, C]', async () => {
    const chain = await traceCauses(factC);

    expect(chain.length).toBe(3);
    // Ordered root→leaf: A, B, C
    expect(chain[0]!.event.id).toBe(eventA);
    expect(chain[1]!.event.id).toBe(eventB);
    expect(chain[2]!.event.id).toBe(eventC);

    // Each node carries the edge that was followed to reach it.
    // A was reached via A→B edge, B via B→C edge, C is the starting point.
    expect(chain[0]!.edge?.causeEventId).toBe(eventA);
    expect(chain[0]!.edge?.effectEventId).toBe(eventB);
    expect(chain[1]!.edge?.causeEventId).toBe(eventB);
    expect(chain[1]!.edge?.effectEventId).toBe(eventC);
    expect(chain[2]!.edge).toBeUndefined(); // starting point
  });

  it('traceCauses(A) returns just [A] (no upstream causes)', async () => {
    const chain = await traceCauses(factA);
    expect(chain.length).toBe(1);
    expect(chain[0]!.event.id).toBe(eventA);
  });

  it('traceCauses respects minStrength', async () => {
    // The A→B edge has strength 0.8, B→C has 0.7
    // With minStrength 0.75, B→C is excluded — can't walk backwards from C at all
    const chain = await traceCauses(factC, { minStrength: 0.75 });
    expect(chain.length).toBe(1);
    expect(chain[0]!.event.id).toBe(eventC);
  });

  // --- projectTrajectory ---

  it('projectTrajectory(A) returns full chain [A, B, C]', async () => {
    const chain = await projectTrajectory(factA);

    expect(chain.length).toBe(3);
    // Ordered start→leaf: A, B, C
    expect(chain[0]!.event.id).toBe(eventA);
    expect(chain[1]!.event.id).toBe(eventB);
    expect(chain[2]!.event.id).toBe(eventC);

    // A is the starting event (no edge)
    expect(chain[0]!.edge).toBeUndefined();
    // B carries the A→B edge, C carries the B→C edge
    expect(chain[1]!.edge?.causeEventId).toBe(eventA);
    expect(chain[2]!.edge?.causeEventId).toBe(eventB);
  });

  it('projectTrajectory(C) returns just [C] (no downstream effects)', async () => {
    const chain = await projectTrajectory(factC);
    expect(chain.length).toBe(1);
    expect(chain[0]!.event.id).toBe(eventC);
  });

  // --- getEntityCausalHistory ---

  it('getEntityCausalHistory returns all events and edges for entity', async () => {
    const history = await getEntityCausalHistory(entityId);

    expect(history.events.length).toBe(3);
    expect(history.edges.length).toBe(2);

    const eventIds = history.events.map(e => e.id);
    expect(eventIds).toContain(eventA);
    expect(eventIds).toContain(eventB);
    expect(eventIds).toContain(eventC);
  });

  it('getEntityCausalHistory returns empty for unknown entity', async () => {
    const history = await getEntityCausalHistory(crypto.randomUUID());
    expect(history.events.length).toBe(0);
    expect(history.edges.length).toBe(0);
  });

  // --- getCausalDelta ---

  it('getCausalDelta returns events and edges in time window', async () => {
    const rows = await testDb`SELECT NOW() + INTERVAL '1 second' as now`;
    const delta = await getCausalDelta(beforeTest, new Date(rows[0]!.now));

    // Should include at least our 3 events and 2 edges
    expect(delta.events.length).toBeGreaterThanOrEqual(3);
    expect(delta.edges.length).toBeGreaterThanOrEqual(2);
  });

  it('getCausalDelta with entityId filter narrows results', async () => {
    const rows = await testDb`SELECT NOW() + INTERVAL '1 second' as now`;
    const delta = await getCausalDelta(beforeTest, new Date(rows[0]!.now), { entityId });

    // All events belong to our entity
    for (const event of delta.events) {
      expect(event.subjectEntityId).toBe(entityId);
    }
    expect(delta.events.length).toBe(3);
  });

  it('getCausalDelta with future window returns empty', async () => {
    const future1 = new Date('2099-01-01');
    const future2 = new Date('2099-12-31');
    const delta = await getCausalDelta(future1, future2);
    expect(delta.events.length).toBe(0);
    expect(delta.edges.length).toBe(0);
  });
});

/**
 * Cycle protection (nmemo-8vq.1) — both `traceCauses` and `projectTrajectory`
 * must terminate without inflating the chain when the underlying causal graph
 * contains a cycle. Phase 5's `detectCyclicCausal` proves cycles can exist in
 * live data; before this fix the recursive CTEs terminated only via the
 * depth cap, so each lap added duplicate event rows up to `maxDepth`.
 *
 * Pattern matches Phase 4's `findTransitiveChains`
 * (`src/services/impact.ts`): `path uuid[]` accumulator on the CTE,
 * recursive step guarded by `NOT (next_event.id = ANY(chain.path))`.
 */
describe('Cycle protection on traceCauses + projectTrajectory (nmemo-8vq.1)', () => {
  let entityId: string;
  let twoNodeFactA: string, twoNodeFactB: string;
  let twoNodeEventA: string, twoNodeEventB: string;
  let threeNodeFactA: string, threeNodeFactC: string;
  let threeNodeEventA: string, threeNodeEventB: string, threeNodeEventC: string;

  beforeAll(async () => {
    const entity = await createTestEntity({
      canonicalName: 'Cycle protection entity',
      entityType: 'person',
    });
    entityId = entity.id;

    // 2-node cycle: A ↔ B
    const fa2 = await createTestFact({ subjectEntityId: entityId, predicate: 'cycle2_a', objectValue: 'a' });
    const fb2 = await createTestFact({ subjectEntityId: entityId, predicate: 'cycle2_b', objectValue: 'b' });
    twoNodeFactA = fa2.id; twoNodeFactB = fb2.id;
    const [ea2] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${twoNodeFactA}::uuid, 'created', ${entityId}::uuid, 'cycle2_a', '2-node cycle A')
      RETURNING id`;
    const [eb2] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${twoNodeFactB}::uuid, 'created', ${entityId}::uuid, 'cycle2_b', '2-node cycle B')
      RETURNING id`;
    twoNodeEventA = ea2!.id; twoNodeEventB = eb2!.id;
    await testDb`
      INSERT INTO causal_edges (cause_event_id, effect_event_id, strength, extraction_method, reasoning, source_references, initial_strength)
      VALUES (${twoNodeEventA}::uuid, ${twoNodeEventB}::uuid, 0.8, 'llm', 'A causes B', ${JSON.stringify([{type:'fact', id: twoNodeFactA, relevance:'cycle leg 1'}])}::jsonb, 0.8)`;
    await testDb`
      INSERT INTO causal_edges (cause_event_id, effect_event_id, strength, extraction_method, reasoning, source_references, initial_strength)
      VALUES (${twoNodeEventB}::uuid, ${twoNodeEventA}::uuid, 0.8, 'llm', 'B causes A', ${JSON.stringify([{type:'fact', id: twoNodeFactB, relevance:'cycle leg 2'}])}::jsonb, 0.8)`;

    // 3-node cycle: A → B → C → A
    const fa3 = await createTestFact({ subjectEntityId: entityId, predicate: 'cycle3_a', objectValue: 'a' });
    const fb3 = await createTestFact({ subjectEntityId: entityId, predicate: 'cycle3_b', objectValue: 'b' });
    const fc3 = await createTestFact({ subjectEntityId: entityId, predicate: 'cycle3_c', objectValue: 'c' });
    threeNodeFactA = fa3.id; threeNodeFactC = fc3.id;
    const [ea3] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${threeNodeFactA}::uuid, 'created', ${entityId}::uuid, 'cycle3_a', '3-node cycle A')
      RETURNING id`;
    const [eb3] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${fb3.id}::uuid, 'created', ${entityId}::uuid, 'cycle3_b', '3-node cycle B')
      RETURNING id`;
    const [ec3] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${threeNodeFactC}::uuid, 'created', ${entityId}::uuid, 'cycle3_c', '3-node cycle C')
      RETURNING id`;
    threeNodeEventA = ea3!.id; threeNodeEventB = eb3!.id; threeNodeEventC = ec3!.id;
    await testDb`
      INSERT INTO causal_edges (cause_event_id, effect_event_id, strength, extraction_method, reasoning, source_references, initial_strength)
      VALUES (${threeNodeEventA}::uuid, ${threeNodeEventB}::uuid, 0.7, 'llm', 'A→B', ${JSON.stringify([{type:'fact', id: threeNodeFactA, relevance:'leg AB'}])}::jsonb, 0.7)`;
    await testDb`
      INSERT INTO causal_edges (cause_event_id, effect_event_id, strength, extraction_method, reasoning, source_references, initial_strength)
      VALUES (${threeNodeEventB}::uuid, ${threeNodeEventC}::uuid, 0.7, 'llm', 'B→C', ${JSON.stringify([{type:'fact', id: fb3.id, relevance:'leg BC'}])}::jsonb, 0.7)`;
    await testDb`
      INSERT INTO causal_edges (cause_event_id, effect_event_id, strength, extraction_method, reasoning, source_references, initial_strength)
      VALUES (${threeNodeEventC}::uuid, ${threeNodeEventA}::uuid, 0.7, 'llm', 'C→A', ${JSON.stringify([{type:'fact', id: threeNodeFactC, relevance:'leg CA'}])}::jsonb, 0.7)`;
  });

  afterAll(async () => {
    await testDb.unsafe(`DELETE FROM causal_edges WHERE cause_event_id IN (SELECT id FROM causal_events WHERE subject_entity_id = '${entityId}')`).catch(() => {});
    await testDb.unsafe(`DELETE FROM causal_events WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityId}'`).catch(() => {});
  });

  it('traceCauses on a 2-node cycle terminates without inflating the chain', async () => {
    // From B: walk backwards finds A (via B→A's reverse: edge A→B has effect=B, cause=A).
    // Without protection the next hop would re-add B (depth 2) then A (depth 3) and so on
    // up to maxDepth=10, producing 11 rows. With protection: chain has each event id once.
    const chain = await traceCauses(twoNodeFactB, { maxDepth: 10 });

    expect(chain.length).toBeLessThanOrEqual(2);
    const eventIds = chain.map((n) => n.event.id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(eventIds).toContain(twoNodeEventA);
    expect(eventIds).toContain(twoNodeEventB);
  });

  it('projectTrajectory on a 2-node cycle terminates without inflating the chain', async () => {
    const chain = await projectTrajectory(twoNodeFactA, { maxDepth: 10 });

    expect(chain.length).toBeLessThanOrEqual(2);
    const eventIds = chain.map((n) => n.event.id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(eventIds).toContain(twoNodeEventA);
    expect(eventIds).toContain(twoNodeEventB);
  });

  it('traceCauses on a 3-node cycle (A→B→C→A) terminates without inflating', async () => {
    // From C: backwards we reach B (via B→C), then A (via A→B). C→A edge
    // would close the cycle by re-visiting C; path accumulator blocks it.
    const chain = await traceCauses(threeNodeFactC, { maxDepth: 10 });

    expect(chain.length).toBeLessThanOrEqual(3);
    const eventIds = chain.map((n) => n.event.id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(eventIds).toContain(threeNodeEventA);
    expect(eventIds).toContain(threeNodeEventB);
    expect(eventIds).toContain(threeNodeEventC);
  });

  it('projectTrajectory on a 3-node cycle (A→B→C→A) terminates without inflating', async () => {
    const chain = await projectTrajectory(threeNodeFactA, { maxDepth: 10 });

    expect(chain.length).toBeLessThanOrEqual(3);
    const eventIds = chain.map((n) => n.event.id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(eventIds).toContain(threeNodeEventA);
    expect(eventIds).toContain(threeNodeEventB);
    expect(eventIds).toContain(threeNodeEventC);
  });

  it('traceCauses with a high maxDepth still bounds output to the cycle size', async () => {
    // Regression guard: even with maxDepth=50, output must not exceed the
    // number of distinct events reachable on a single branch.
    const chain = await traceCauses(threeNodeFactC, { maxDepth: 50 });
    expect(chain.length).toBeLessThanOrEqual(3);
  });

  it('projectTrajectory with a high maxDepth still bounds output to the cycle size', async () => {
    const chain = await projectTrajectory(threeNodeFactA, { maxDepth: 50 });
    expect(chain.length).toBeLessThanOrEqual(3);
  });
});
