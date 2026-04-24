/**
 * B06: Causal MCP server + agent invocation
 *
 * Tests that the MCP server correctly exposes all 7 tools and that
 * the invocation wrapper generates valid config and delta formatting.
 */

import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';
import { GRAPH_TOOLS, handleToolCall, getMcpConfigPath } from '../../services/causal-agent.js';
import fs from 'fs';

describe('B06: Causal MCP server', () => {

  // --- MCP tool listing ---

  it('exposes the seven causal-reasoning tools', () => {
    const names = GRAPH_TOOLS.map(t => t.name);
    for (const t of [
      'create_causal_edge',
      'get_causal_history',
      'get_memory_text',
      'query_entity_facts',
      'query_entity_neighbours',
      'search_memories',
      'search_similar_entities',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('all tool schemas have MCP-compatible shape', () => {
    for (const tool of GRAPH_TOOLS) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });

  // --- MCP config generation ---

  it('getMcpConfigPath generates valid JSON config', () => {
    const configPath = getMcpConfigPath();
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.mcpServers).toBeDefined();
    // MCP config now registers a single unified graph server ('mnemo-graph')
    // hosting all extraction/causal/reconciliation/gardener/reasoning tools.
    expect(config.mcpServers['mnemo-graph']).toBeDefined();
    expect(config.mcpServers['mnemo-graph'].command).toBe('npx');
    // Args use absolute path (Claude Code ignores cwd for MCP server spawning)
    const mcpArg = config.mcpServers['mnemo-graph'].args.find((a: string) => a.includes('graph-mcp.ts'));
    expect(mcpArg).toBeDefined();
    expect(path.isAbsolute(mcpArg)).toBe(true);
    // cwd should be an absolute path
    expect(config.mcpServers['mnemo-graph'].cwd).toMatch(/^[A-Z]:|^\//);

    // Cleanup
    fs.unlinkSync(configPath);
  });

  // --- Tool handlers via MCP dispatch ---

  let entityId: string;
  let factId: string;
  let eventId: string;
  let eventId2: string;

  beforeAll(async () => {
    const entity = await createTestEntity({
      canonicalName: 'B06 MCP Entity',
      entityType: 'person',
    });
    entityId = entity.id;

    const fact = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'relocated_to',
      objectValue: 'Auckland',
    });
    factId = fact.id;

    const [ev1] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${factId}::uuid, 'created', ${entityId}::uuid, 'relocated_to', 'Moved to Auckland because of work')
      RETURNING id
    `;
    eventId = ev1!.id;

    const fact2 = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'started_at',
      objectValue: 'New company',
    });
    const [ev2] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${fact2.id}::uuid, 'created', ${entityId}::uuid, 'started_at', 'Started new role')
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

  it('handleToolCall dispatches query_entity_facts correctly', async () => {
    const result = await handleToolCall('query_entity_facts', { entity_id: entityId });
    const parsed = JSON.parse(result);
    // Handler returns { summary, aliases, facts } — the enriched shape added
    // alongside reasoning-agent work. Accept either the array-only legacy
    // shape or the enriched object form.
    const facts = Array.isArray(parsed) ? parsed : parsed.facts;
    expect(Array.isArray(facts)).toBe(true);
    expect(facts.length).toBeGreaterThanOrEqual(1);
  });

  it('handleToolCall dispatches get_causal_history correctly', async () => {
    const result = await handleToolCall('get_causal_history', { entity_id: entityId });
    const parsed = JSON.parse(result);
    expect(parsed.events.length).toBeGreaterThanOrEqual(1);
  });

  it('handleToolCall dispatches create_causal_edge with full traceability', async () => {
    const reasoning = 'Started new role at the company, which required relocation to Auckland where the office is based';
    const result = await handleToolCall('create_causal_edge', {
      cause_event_id: eventId2,
      effect_event_id: eventId,
      strength: 0.85,
      reasoning,
      source_references: [
        { type: 'fact', id: factId, relevance: 'relocation fact triggered by employment' },
        { type: 'entity', id: entityId, relevance: 'subject of both events' },
      ],
    });

    const parsed = JSON.parse(result);
    expect(parsed.edgeId).toBeDefined();

    // Verify edge in DB meets acceptance criteria
    const [edge] = await testDb`SELECT * FROM causal_edges WHERE id = ${parsed.edgeId}::uuid`;
    expect(edge).toBeDefined();
    expect(edge!.reasoning.length).toBeGreaterThan(50);
    const refs = typeof edge!.source_references === 'string'
      ? JSON.parse(edge!.source_references)
      : edge!.source_references;
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs[0].type).toBeDefined();
    expect(refs[0].id).toBeDefined();
    expect(refs[0].relevance).toBeDefined();
  });

  it('handleToolCall returns error for unknown tool', async () => {
    await expect(handleToolCall('bogus', {})).rejects.toThrow('Unknown tool: bogus');
  });

  it('handleToolCall returns not-found for missing memory', async () => {
    const result = await handleToolCall('get_memory_text', { memory_id: crypto.randomUUID() });
    expect(JSON.parse(result).error).toBe('Memory not found');
  });
});
