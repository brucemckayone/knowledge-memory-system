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
});
