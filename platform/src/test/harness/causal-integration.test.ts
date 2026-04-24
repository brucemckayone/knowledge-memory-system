/**
 * B06 Integration: Causal MCP server + Claude Code end-to-end
 *
 * Spawns the real MCP server, calls the ML service /causal-reason endpoint,
 * and verifies Claude Code creates causal edges from explicit causal language.
 *
 * Requires: ML service on port 8000, PostgreSQL, claude CLI on PATH.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';
import {
  checkCausalMcpHealth,
  invokeCausalAgent,
  type CausalDelta,
} from '../../services/causal-agent.js';

/**
 * Check if the ML service is running and has the /causal-reason endpoint.
 */
async function isMlCausalAvailable(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:8000/health', {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const health = await res.json() as { endpoints?: string[] };
    return health.endpoints?.includes('causal-reason') ?? false;
  } catch {
    return false;
  }
}

describe('B06 Integration: Causal MCP + Claude Code', () => {
  let entityId: string;
  let factA: string, factB: string;
  let eventA: string, eventB: string;
  let mlAvailable: boolean;

  beforeAll(async () => {
    mlAvailable = await isMlCausalAvailable();

    const entity = await createTestEntity({
      canonicalName: 'B06 Integration Person',
      entityType: 'person',
    });
    entityId = entity.id;

    const fA = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'started_at',
      objectValue: 'Acme Corp',
    });
    const fB = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'relocated_to',
      objectValue: 'Wellington',
    });
    factA = fA.id;
    factB = fB.id;

    const [evA] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${factA}::uuid, 'created', ${entityId}::uuid, 'started_at', 'Got a new job at Acme Corp')
      RETURNING id
    `;
    const [evB] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${factB}::uuid, 'created', ${entityId}::uuid, 'relocated_to', 'Moved to Wellington because of the new job')
      RETURNING id
    `;
    eventA = evA!.id;
    eventB = evB!.id;
  });

  afterAll(async () => {
    await testDb.unsafe(`DELETE FROM causal_edges WHERE cause_event_id IN (SELECT id FROM causal_events WHERE subject_entity_id = '${entityId}')`).catch(() => {});
    await testDb.unsafe(`DELETE FROM causal_events WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityId}'`).catch(() => {});
  });

  // --- MCP Health Check ---

  it('causal MCP server starts and exposes the seven causal tools', async () => {
    const health = await checkCausalMcpHealth();

    expect(health.ok).toBe(true);
    expect(health.tools).toBeDefined();
    // Server now hosts the unified tool set (causal + extraction + reconciliation
    // + gardener + reasoning); assert the seven original causal tools are present.
    for (const t of [
      'create_causal_edge', 'query_entity_facts', 'query_entity_neighbours',
      'search_similar_entities', 'search_memories', 'get_memory_text', 'get_causal_history',
    ]) {
      expect(health.tools).toContain(t);
    }
    expect(health.durationMs).toBeLessThan(15_000);
  }, 20_000);

  // --- Full Integration: ML Service → Claude Code → MCP → DB ---

  it('Claude Code creates causal edge from explicit causal language', async () => {
    if (!mlAvailable) {
      console.log('Skipping: ML service /causal-reason not available (restart ML service to pick up new endpoint)');
      return;
    }

    const delta: CausalDelta = {
      sourceText: 'Moved to Wellington because of the new job at Acme Corp.',
      newEntities: [
        { id: entityId, canonicalName: 'B06 Integration Person', entityType: 'person' },
      ],
      newFacts: [
        { id: factA, subjectEntityId: entityId, predicate: 'started_at', objectValue: 'Acme Corp' },
        { id: factB, subjectEntityId: entityId, predicate: 'relocated_to', objectValue: 'Wellington' },
      ],
      modifiedFacts: [],
      causalEvents: [
        {
          id: eventA,
          factId: factA,
          transitionType: 'created',
          subjectEntityId: entityId,
          predicate: 'started_at',
          sourceText: 'Got a new job at Acme Corp',
        },
        {
          id: eventB,
          factId: factB,
          transitionType: 'created',
          subjectEntityId: entityId,
          predicate: 'relocated_to',
          sourceText: 'Moved to Wellington because of the new job',
        },
      ],
    };

    const result = await invokeCausalAgent(delta);
    console.log('Agent result:', JSON.stringify(result).slice(0, 500));
    expect(result.result).toBeDefined();

    // Check DB for edges created by Claude Code via MCP tools
    const edges = await testDb`
      SELECT * FROM causal_edges
      WHERE cause_event_id IN (${eventA}::uuid, ${eventB}::uuid)
         OR effect_event_id IN (${eventA}::uuid, ${eventB}::uuid)
      ORDER BY created_at
    `;

    // Claude Code should have created at least 1 edge from "because of the new job"
    expect(edges.length).toBeGreaterThanOrEqual(1);

    const edge = edges[0]!;
    expect(edge.reasoning.length).toBeGreaterThan(50);

    const refs = typeof edge.source_references === 'string'
      ? JSON.parse(edge.source_references)
      : edge.source_references;
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs[0].type).toBeDefined();
    expect(refs[0].id).toBeDefined();
    expect(refs[0].relevance).toBeDefined();
  }, 120_000); // 2 min timeout for Claude Code round-trip
});
