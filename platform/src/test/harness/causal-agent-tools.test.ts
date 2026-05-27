/**
 * B05: Causal agent — tool definitions
 *
 * Validates tool schemas are Anthropic-compliant and handlers dispatch correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';
import { GRAPH_TOOLS, handleToolCall } from '../../services/causal-agent.js';

describe('B05: Causal agent — tool definitions', () => {
  // --- Schema validation ---

  it('exposes the seven causal-reasoning tools', () => {
    // Original B05 seven tools remain; additional extraction/reconciliation/
    // gardener/reasoning tools were layered on by later phases and are tested
    // separately.
    const causalToolNames = [
      'query_entity_facts',
      'query_entity_neighbours',
      'search_similar_entities',
      'search_memories',
      'get_memory_text',
      'get_causal_history',
      'create_causal_edge',
    ];
    const actualNames = GRAPH_TOOLS.map(t => t.name);
    for (const name of causalToolNames) {
      expect(actualNames).toContain(name);
    }
  });

  it('all tools have valid MCP tool schema format', () => {
    for (const tool of GRAPH_TOOLS) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });

  // --- Handler dispatch ---

  let entityId: string;
  let factId: string;
  let eventId: string;
  let eventId2: string;

  beforeAll(async () => {
    const entity = await createTestEntity({
      canonicalName: 'B05 Handler Entity',
      entityType: 'person',
    });
    entityId = entity.id;

    const fact = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'works_at',
      objectValue: 'Test Corp',
    });
    factId = fact.id;

    // Create causal events for handler tests
    const [ev1] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${factId}::uuid, 'created', ${entityId}::uuid, 'works_at', 'Started at Test Corp')
      RETURNING id
    `;
    eventId = ev1!.id;

    // Create a second fact + event for edge creation test
    const fact2 = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'relocated_to',
      objectValue: 'New York',
    });
    const [ev2] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${fact2.id}::uuid, 'created', ${entityId}::uuid, 'relocated_to', 'Moved to New York')
      RETURNING id
    `;
    eventId2 = ev2!.id;
  });

  afterAll(async () => {
    await testDb.unsafe(`DELETE FROM causal_edges WHERE cause_event_id IN (SELECT id FROM causal_events WHERE subject_entity_id = '${entityId}')`).catch(() => {});
    await testDb.unsafe(`DELETE FROM causal_events WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityId}'`).catch(() => {});
  });

  it('query_entity_facts handler returns facts for entity', async () => {
    const result = await handleToolCall('query_entity_facts', { entity_id: entityId });
    const parsed = JSON.parse(result);
    const facts = Array.isArray(parsed) ? parsed : parsed.facts;
    expect(Array.isArray(facts)).toBe(true);
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0].predicate).toBeDefined();
  });

  it('get_causal_history handler returns events and edges', async () => {
    const result = await handleToolCall('get_causal_history', { entity_id: entityId });
    const parsed = JSON.parse(result);
    expect(parsed.events).toBeDefined();
    expect(parsed.edges).toBeDefined();
    expect(parsed.events.length).toBeGreaterThanOrEqual(1);
  });

  it('get_causal_history surfaces corroboration fields on edges (e2i.5)', async () => {
    // Insert an edge with non-default corroboration state so we can prove the
    // tool serialises real values, not defaults.
    const knownLastCorroborated = '2026-04-01T12:00:00.000Z';
    const [edgeRow] = await testDb`
      INSERT INTO causal_edges (
        cause_event_id, effect_event_id, strength, extraction_method,
        reasoning, source_references,
        corroboration_count, last_corroborated, initial_strength, decay_applied
      ) VALUES (
        ${eventId}::uuid, ${eventId2}::uuid, 0.65, 'inference',
        'e2i.5 corroboration field surfacing test', '[]'::jsonb,
        3, ${knownLastCorroborated}::timestamptz, 0.9, true
      )
      RETURNING id
    `;
    const insertedEdgeId = edgeRow!.id as string;

    try {
      const result = await handleToolCall('get_causal_history', { entity_id: entityId });
      const parsed = JSON.parse(result);
      const edge = parsed.edges.find((e: { id: string }) => e.id === insertedEdgeId);

      expect(edge).toBeDefined();
      expect(edge.corroborationCount).toBe(3);
      expect(edge.initialStrength).toBeCloseTo(0.9, 5);
      expect(edge.decayApplied).toBe(true);
      expect(new Date(edge.lastCorroborated).toISOString()).toBe(knownLastCorroborated);
    } finally {
      await testDb.unsafe(`DELETE FROM causal_edges WHERE id = '${insertedEdgeId}'`).catch(() => {});
    }
  });

  it('create_causal_edge handler creates edge and returns id', async () => {
    const result = await handleToolCall('create_causal_edge', {
      cause_event_id: eventId,
      effect_event_id: eventId2,
      strength: 0.75,
      reasoning: 'Job at Test Corp caused relocation to New York office',
      source_references: [
        { type: 'fact', id: factId, relevance: 'employment fact' },
      ],
    });
    const parsed = JSON.parse(result);
    expect(parsed.edgeId).toBeDefined();
    expect(typeof parsed.edgeId).toBe('string');
  });

  // nmemo-2yv.25: trace_causes / project_trajectory / get_causal_delta are exposed
  // as MCP tools so the reasoning agent can ask "why did this fact become true?" /
  // "what does this fact lead to?" / "what changed causally in this window?".
  //
  // These tests need an active (eventId → eventId2) edge. The earlier
  // `create_causal_edge handler creates edge and returns id` test creates one
  // and the unique partial index (cause_event_id, effect_event_id) WHERE
  // expired_at IS NULL prevents inserting a duplicate. Reuse whichever active
  // edge already exists, or insert one fresh if the test order ever drops the
  // dependency.
  async function ensureActiveEdge(): Promise<void> {
    const existing = await testDb`
      SELECT 1 FROM causal_edges
      WHERE cause_event_id = ${eventId}::uuid
        AND effect_event_id = ${eventId2}::uuid
        AND expired_at IS NULL
      LIMIT 1
    `;
    if (existing.length === 0) {
      await testDb`
        INSERT INTO causal_edges (cause_event_id, effect_event_id, strength, initial_strength, extraction_method, reasoning, source_references)
        VALUES (${eventId}::uuid, ${eventId2}::uuid, 0.8, 0.8, 'inference', 'nmemo-2yv.25 test edge', '[]'::jsonb)
      `;
    }
  }

  it('trace_causes handler walks the chain backwards from a fact', async () => {
    const fact2Rows = await testDb`
      SELECT id FROM facts WHERE subject_entity_id = ${entityId}::uuid AND predicate = 'relocated_to' LIMIT 1
    `;
    const fact2Id = (fact2Rows[0] as { id: string }).id;
    await ensureActiveEdge();

    const result = await handleToolCall('trace_causes', { fact_id: fact2Id });
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed.chain)).toBe(true);
    // Chain must contain at least the starting event (eventId2) and the upstream cause (eventId).
    const eventIds = parsed.chain.map((n: { event: { id: string } }) => n.event.id);
    expect(eventIds).toContain(eventId2);
    expect(eventIds).toContain(eventId);
  });

  it('project_trajectory handler walks the chain forwards from a fact', async () => {
    await ensureActiveEdge();

    const result = await handleToolCall('project_trajectory', { fact_id: factId });
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed.chain)).toBe(true);
    // Chain must contain the starting event (eventId) and the downstream effect (eventId2).
    const eventIds = parsed.chain.map((n: { event: { id: string } }) => n.event.id);
    expect(eventIds).toContain(eventId);
    expect(eventIds).toContain(eventId2);
  });

  it('get_causal_delta handler returns events and edges in window', async () => {
    // The events created in beforeAll already sit inside a wide window. Bounding
    // with entity_id keeps the result narrow under concurrent test traffic.
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await handleToolCall('get_causal_delta', {
      from,
      to,
      entity_id: entityId,
    });
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(Array.isArray(parsed.edges)).toBe(true);
    // Both events for this entity should land in the window.
    const ids = parsed.events.map((e: { id: string }) => e.id);
    expect(ids).toContain(eventId);
    expect(ids).toContain(eventId2);
  });

  it('unknown tool throws error', async () => {
    await expect(
      handleToolCall('nonexistent_tool', {}),
    ).rejects.toThrow('Unknown tool: nonexistent_tool');
  });

  it('get_memory_text handler returns error for missing memory', async () => {
    const result = await handleToolCall('get_memory_text', {
      memory_id: crypto.randomUUID(),
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('Memory not found');
  });

  // Regression: F3 — save_reasoning_report must update entity_meta.last_reasoned_at
  // for every entity_id passed in. Prior implementation used a raw `db.execute(sql\`...
  // = ANY(${entityIds}::uuid[])\`)` which silently matched 0 rows on the live db.
  it('save_reasoning_report sets last_reasoned_at on every referenced entity', async () => {
    await testDb`
      INSERT INTO entity_meta (entity_id, last_reasoned_at)
      VALUES (${entityId}::uuid, NULL)
      ON CONFLICT (entity_id) DO UPDATE SET last_reasoned_at = NULL
    `;

    const result = await handleToolCall('save_reasoning_report', {
      mode: 'patrol',
      report: 'F3 regression test report',
      entity_ids: [entityId],
      fact_ids: [],
      causal_edge_ids: [],
      actions_taken: { test: true },
    });

    const parsed = JSON.parse(result);
    expect(parsed.reportId).toBeDefined();

    const [row] = await testDb`
      SELECT last_reasoned_at FROM entity_meta WHERE entity_id = ${entityId}::uuid
    `;
    expect(row?.last_reasoned_at).toBeInstanceOf(Date);
    expect((row!.last_reasoned_at as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);

    // Cleanup
    await testDb`DELETE FROM reasoning_reports WHERE id = ${parsed.reportId}::uuid`;
    await testDb`DELETE FROM entity_meta WHERE entity_id = ${entityId}::uuid`;
  });

  it('save_reasoning_report with empty entity_ids does not throw', async () => {
    const result = await handleToolCall('save_reasoning_report', {
      mode: 'query',
      question: 'F3 empty-ids test',
      report: 'no entities referenced',
      entity_ids: [],
      fact_ids: [],
      causal_edge_ids: [],
      actions_taken: {},
    });
    const parsed = JSON.parse(result);
    expect(parsed.reportId).toBeDefined();
    await testDb`DELETE FROM reasoning_reports WHERE id = ${parsed.reportId}::uuid`;
  });

  // Regression: nmemo-2yv.77 — save_reasoning_report must UPSERT on
  // invocation_id so a second call within the same /api/reason pass updates
  // the existing row instead of inserting a duplicate. Prior behaviour was a
  // plain INSERT enforced only by prompt guidance.
  it('save_reasoning_report dedupes on invocation_id across duplicate calls', async () => {
    const invocationId = crypto.randomUUID();

    const first = await handleToolCall('save_reasoning_report', {
      mode: 'patrol',
      report: 'first save — initial findings',
      entity_ids: [entityId],
      fact_ids: [],
      causal_edge_ids: [],
      actions_taken: { phase: 'first' },
      invocation_id: invocationId,
    });
    const firstParsed = JSON.parse(first);
    expect(firstParsed.reportId).toBeDefined();

    const second = await handleToolCall('save_reasoning_report', {
      mode: 'patrol',
      report: 'second save — overwrites the first',
      entity_ids: [entityId],
      fact_ids: [],
      causal_edge_ids: [],
      actions_taken: { phase: 'second' },
      invocation_id: invocationId,
    });
    const secondParsed = JSON.parse(second);
    expect(secondParsed.reportId).toBe(firstParsed.reportId);

    // Confirm exactly one row exists for this invocation_id.
    const rows = await testDb`
      SELECT id, report, actions_taken
      FROM reasoning_reports
      WHERE invocation_id = ${invocationId}::uuid
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(firstParsed.reportId);
    expect(rows[0]?.report).toBe('second save — overwrites the first');
    expect((rows[0]?.actions_taken as { phase?: string })?.phase).toBe('second');

    await testDb`DELETE FROM reasoning_reports WHERE invocation_id = ${invocationId}::uuid`;
  });

  // Regression: nmemo-2yv.77 — legacy callers without an invocation_id must
  // continue to INSERT (one row per call). The UPSERT branch only fires when
  // the field is present, so back-compat with older python clients and
  // ad-hoc fixtures is preserved.
  it('save_reasoning_report without invocation_id still inserts a fresh row each call', async () => {
    const first = await handleToolCall('save_reasoning_report', {
      mode: 'patrol',
      report: 'legacy save A',
      entity_ids: [entityId],
      fact_ids: [],
      causal_edge_ids: [],
      actions_taken: {},
    });
    const firstId = JSON.parse(first).reportId as string;

    const second = await handleToolCall('save_reasoning_report', {
      mode: 'patrol',
      report: 'legacy save B',
      entity_ids: [entityId],
      fact_ids: [],
      causal_edge_ids: [],
      actions_taken: {},
    });
    const secondId = JSON.parse(second).reportId as string;

    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(firstId).not.toBe(secondId);

    await testDb`DELETE FROM reasoning_reports WHERE id IN (${firstId}::uuid, ${secondId}::uuid)`;
  });
});
