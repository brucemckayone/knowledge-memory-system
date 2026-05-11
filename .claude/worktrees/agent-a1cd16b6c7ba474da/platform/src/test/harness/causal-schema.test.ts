/**
 * B01: Causal schema + AGE causal_graph
 *
 * Verifies:
 * - All 3 tables exist with all columns
 * - causal_edges.reasoning is NOT NULL
 * - causal_edges.source_references is NOT NULL
 * - causal_graph AGE graph exists
 * - INSERT into causal_events creates a :Transition node in causal_graph
 * - INSERT into causal_edges creates a :CAUSED edge in causal_graph
 * - Drizzle schema exports causalEvents, causalEdges, causalPatterns
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';

// Verify Drizzle exports exist at import time
import { causalEvents, causalEdges, causalPatterns } from '../../db/schema.js';

describe('B01: Causal schema + AGE causal_graph', () => {
  let entityId: string;
  let factId: string;

  beforeAll(async () => {

    // Create test entity and fact for FK references
    const entity = await createTestEntity({
      canonicalName: 'B01 Test Entity',
      entityType: 'person',
    });
    entityId = entity.id;

    const fact = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'works_at',
      objectValue: 'Acme Corp',
    });
    factId = fact.id;
  });

  afterAll(async () => {
    // Only clean up our own data (scoped by entity)
    await testDb.unsafe(`DELETE FROM causal_edges WHERE cause_event_id IN (SELECT id FROM causal_events WHERE subject_entity_id = '${entityId}')`).catch(() => {});
    await testDb.unsafe(`DELETE FROM causal_events WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityId}'`).catch(() => {});
  });

  // --- Table existence and columns ---

  it('causal_patterns table exists with all columns', async () => {
    const cols = await testDb`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'causal_patterns'
      ORDER BY ordinal_position
    `;
    const colNames = cols.map((c: any) => c.column_name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('description');
    expect(colNames).toContain('template_structure');
    expect(colNames).toContain('template_length');
    expect(colNames).toContain('topology_type');
    expect(colNames).toContain('pattern_embedding');
    expect(colNames).toContain('status');
    expect(colNames).toContain('instance_count');
    expect(colNames).toContain('first_seen_at');
    expect(colNames).toContain('last_seen_at');
    expect(colNames).toContain('promoted_at');
    expect(colNames).toContain('rejected_at');
    expect(colNames).toContain('rejection_reason');
    expect(colNames).toContain('avg_temporal_span');
    expect(colNames).toContain('avg_strength');
    expect(colNames).toContain('activation_count_30d');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');
  });

  it('causal_events table exists with all columns', async () => {
    const cols = await testDb`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'causal_events' ORDER BY ordinal_position
    `;
    const colNames = cols.map((c: any) => c.column_name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('fact_id');
    expect(colNames).toContain('transition_type');
    expect(colNames).toContain('subject_entity_id');
    expect(colNames).toContain('predicate');
    expect(colNames).toContain('delta_confidence');
    expect(colNames).toContain('occurred_at');
    expect(colNames).toContain('event_embedding');
    expect(colNames).toContain('source_memory_id');
    expect(colNames).toContain('source_text');
    expect(colNames).toContain('created_at');
  });

  it('causal_edges table exists with all columns', async () => {
    const cols = await testDb`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'causal_edges' ORDER BY ordinal_position
    `;
    const colNames = cols.map((c: any) => c.column_name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('cause_event_id');
    expect(colNames).toContain('effect_event_id');
    expect(colNames).toContain('strength');
    expect(colNames).toContain('temporal_span');
    expect(colNames).toContain('extraction_method');
    expect(colNames).toContain('reasoning');
    expect(colNames).toContain('source_references');
    expect(colNames).toContain('pathway_event_ids');
    expect(colNames).toContain('source_memory_id');
    expect(colNames).toContain('source_text');
    expect(colNames).toContain('corroboration_count');
    expect(colNames).toContain('last_corroborated');
    expect(colNames).toContain('initial_strength');
    expect(colNames).toContain('decay_applied');
    expect(colNames).toContain('pattern_id');
    expect(colNames).toContain('pattern_position');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('expired_at');
    expect(colNames).toContain('expire_reason');
  });

  // --- NOT NULL constraints ---

  it('causal_edges.reasoning is NOT NULL', async () => {
    const col = await testDb`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'causal_edges' AND column_name = 'reasoning'
    `;
    expect(col[0]?.is_nullable).toBe('NO');
  });

  it('causal_edges.source_references is NOT NULL', async () => {
    const col = await testDb`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'causal_edges' AND column_name = 'source_references'
    `;
    expect(col[0]?.is_nullable).toBe('NO');
  });

  // --- AGE graph existence ---

  it('causal_graph AGE graph exists', async () => {
    const result = await testDb`
      SELECT name FROM ag_catalog.ag_graph WHERE name = 'causal_graph'
    `;
    expect(result.length).toBe(1);
    expect(result[0]?.name).toBe('causal_graph');
  });

  // --- Trigger: INSERT causal_event → :Transition node ---

  it('INSERT into causal_events creates a :Transition node in causal_graph', async () => {
    // LOAD 'age' required per-session for PL/pgSQL triggers to resolve cypher()
    await testDb.unsafe(`LOAD 'age'`).catch(() => {});
    await testDb.unsafe(`SET search_path = ag_catalog, public, "$user"`);

    const inserted = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${factId}::uuid, 'created', ${entityId}::uuid, 'works_at', 'B01 test source text')
      RETURNING id
    `;
    const eventId = inserted[0]!.id;

    // Query AGE for the node
    await testDb.unsafe(`SET search_path = ag_catalog, public, "$user"`);
    const nodes = await testDb.unsafe(`
      SELECT * FROM cypher('causal_graph', $$
        MATCH (e:Transition {event_id: '${eventId}'})
        RETURN e.transition_type, e.predicate
      $$) as (transition_type agtype, predicate agtype)
    `);

    expect(nodes.length).toBe(1);
    expect(JSON.parse(nodes[0]!.transition_type)).toBe('created');
    expect(JSON.parse(nodes[0]!.predicate)).toBe('works_at');
  });

  // --- Trigger: INSERT causal_edge → :CAUSED edge ---

  it('INSERT into causal_edges creates a :CAUSED edge in causal_graph', async () => {
    // Create two events for the edge
    const ev1 = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${factId}::uuid, 'created', ${entityId}::uuid, 'works_at', 'cause event')
      RETURNING id
    `;
    const ev2 = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${factId}::uuid, 'expired', ${entityId}::uuid, 'works_at', 'effect event')
      RETURNING id
    `;

    const causeId = ev1[0]!.id;
    const effectId = ev2[0]!.id;

    // Insert the causal edge
    await testDb`
      INSERT INTO causal_edges (
        cause_event_id, effect_event_id, strength, extraction_method,
        reasoning, source_references, initial_strength
      ) VALUES (
        ${causeId}::uuid, ${effectId}::uuid, 0.8, 'llm',
        'Test reasoning: cause led to effect because of temporal proximity',
        ${JSON.stringify([{ type: 'fact', id: factId, relevance: 'direct evidence' }])}::jsonb,
        0.8
      )
    `;

    // Query AGE for the :CAUSED edge between the two Transition nodes.
    // Note: AGE in this version doesn't persist edge properties via SET,
    // so we only verify the edge structure exists. The canonical edge data
    // (strength, reasoning, source_references) lives in the PostgreSQL
    // causal_edges table, not the AGE graph.
    await testDb.unsafe(`SET search_path = ag_catalog, public, "$user"`);
    const edges = await testDb.unsafe(`
      SELECT * FROM cypher('causal_graph', $$
        MATCH (cause:Transition {event_id: '${causeId}'})-[r:CAUSED]->(effect:Transition {event_id: '${effectId}'})
        RETURN cause.event_id, effect.event_id
      $$) as (cause_id agtype, effect_id agtype)
    `);

    expect(edges.length).toBe(1);
    expect(JSON.parse(edges[0]!.cause_id)).toBe(causeId);
    expect(JSON.parse(edges[0]!.effect_id)).toBe(effectId);
  });

  // --- Drizzle schema exports ---

  it('Drizzle schema exports causalEvents, causalEdges, causalPatterns', () => {
    expect(causalEvents).toBeDefined();
    expect(causalEdges).toBeDefined();
    expect(causalPatterns).toBeDefined();

    // Verify table names match
    expect((causalEvents as any)[Symbol.for('drizzle:Name')]).toBe('causal_events');
    expect((causalEdges as any)[Symbol.for('drizzle:Name')]).toBe('causal_edges');
    expect((causalPatterns as any)[Symbol.for('drizzle:Name')]).toBe('causal_patterns');
  });
});
