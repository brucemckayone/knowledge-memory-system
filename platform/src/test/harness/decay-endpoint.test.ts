/**
 * nmemo-e2i.6 — POST /api/decay endpoint shape verification.
 *
 * The endpoint is a thin wrapper around applyConfidenceDecay (already
 * exhaustively tested in edge-lifecycle.test.ts). This test only verifies
 * that the HTTP surface returns the canonical structured shape so the
 * reasoning agent and viz can rely on the field names.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';
import { app } from '../../index.js';

describe('nmemo-e2i.6: POST /api/decay endpoint', () => {
  let entityId: string;
  let edgeId: string;

  beforeAll(async () => {
    // Build a single-source decay-eligible edge so applyConfidenceDecay
    // has something to act on. Direct SQL because the test has to plant
    // a stale last_corroborated and corroboration_count = 1 — both of
    // which the public createCausalEdge API does not let you override.
    const entity = await createTestEntity({
      canonicalName: 'e2i.6 endpoint test entity',
      entityType: 'person',
    });
    entityId = entity.id;

    const f1 = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'reads',
      objectValue: 'a book',
    });
    const f2 = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'finishes',
      objectValue: 'the book',
    });

    const [e1] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${f1.id}::uuid, 'created', ${entityId}::uuid, 'reads', 'started reading')
      RETURNING id
    `;
    const [e2] = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${f2.id}::uuid, 'created', ${entityId}::uuid, 'finishes', 'finished reading')
      RETURNING id
    `;

    const [edge] = await testDb`
      INSERT INTO causal_edges (
        cause_event_id, effect_event_id, strength, extraction_method,
        reasoning, source_references,
        corroboration_count, last_corroborated, initial_strength
      ) VALUES (
        ${e1!.id}::uuid, ${e2!.id}::uuid, 0.5, 'llm',
        'e2i.6 endpoint shape test', '[]'::jsonb,
        1, NOW() - INTERVAL '60 days', 0.5
      )
      RETURNING id
    `;
    edgeId = edge!.id as string;
  });

  afterAll(async () => {
    await testDb.unsafe(`DELETE FROM causal_edge_history WHERE edge_id = '${edgeId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM causal_edges WHERE id = '${edgeId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM causal_events WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityId}'`).catch(() => {});
  });

  it('returns structured DecayResult shape with arrays of edge IDs', async () => {
    const res = await app.request('/api/decay', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      triggered: boolean;
      decayed: number;
      expired: number;
      decayedEdgeIds: string[];
      expiredEdgeIds: string[];
      durationMs: number;
    };

    expect(body.triggered).toBe(true);
    expect(typeof body.decayed).toBe('number');
    expect(typeof body.expired).toBe('number');
    expect(Array.isArray(body.decayedEdgeIds)).toBe(true);
    expect(Array.isArray(body.expiredEdgeIds)).toBe(true);
    expect(typeof body.durationMs).toBe('number');

    // The seeded edge had strength 0.5, lastCorroborated 60 days ago,
    // corroborationCount 1 — must be touched by this run (decayed or
    // expired depending on the env-tuned rate/floor/ageDays).
    const totalTouched = body.decayed + body.expired;
    expect(totalTouched).toBeGreaterThanOrEqual(1);
    const allTouched = [...body.decayedEdgeIds, ...body.expiredEdgeIds];
    expect(allTouched).toContain(edgeId);
  });
});
