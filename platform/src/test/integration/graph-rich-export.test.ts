/**
 * Rich graph export smoke (doc 39 §3.1, bead nmemo-hm4.1).
 *
 * Round-trips the live graph through GET /api/graph/full and asserts the rich
 * export surfaces exactly what the validity harness needs and the canonical
 * export deliberately omits: EXPIRED facts (with expire_reason), causal edge
 * `reasoning` + `source_references`, contradictions, same_as links, and the
 * report buckets.
 *
 * Lives under src/test/integration/ (live DB) — intentionally NOT a
 * *.unit.test.ts, so it stays out of the pure unit suite whose 47 tests must
 * remain unchanged (acceptance criterion).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../../index.js';
import { testDb, createTestEntity, createTestFact, deleteFromTables } from '../setup.js';

describe('GET /api/graph/full — rich graph export', () => {
  // Full FK-safe wipe so counts are exact. The blessed helper deletes audit
  // tables (causal_edge_history / fact_history) BEFORE causal_edges / facts —
  // a hand-rolled order trips causal_edge_history's RESTRICT FK. entity_meta
  // and same_as_links clear via ON DELETE CASCADE when entities go.
  beforeEach(async () => {
    await deleteFromTables({ acknowledgeGlobal: true });
  });

  it('returns expired facts, edge reasoning + source_references, contradictions, same_as, reports', async () => {
    // --- seed a minimal graph with an expired (superseded) fact + a causal edge ---
    const person = await createTestEntity({ canonicalName: `Elena ${Date.now()}`, entityType: 'person' });
    const company = await createTestEntity({ canonicalName: `Helix ${Date.now()}`, entityType: 'company' });

    const activeFact = await createTestFact({
      subjectEntityId: person.id,
      predicate: 'works_at',
      objectEntityId: company.id,
    });

    // Insert the expired fact directly so we control expire_reason (the helper
    // sets expired_at but not expire_reason).
    const expiredRows = await testDb`
      INSERT INTO facts
        (subject_entity_id, predicate, object_value, valid_at, created_at, expired_at, expire_reason, confidence)
      VALUES
        (${person.id}::uuid, 'job_title', 'junior engineer',
         ${new Date('2022-01-01')}, ${new Date('2022-01-02')},
         ${new Date('2023-01-01')}, 'superseded by senior engineer', 0.9)
      RETURNING id`;
    const expiredFactId = expiredRows[0]!.id as string;

    const ev1 = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate)
      VALUES (${activeFact.id}::uuid, 'created', ${person.id}::uuid, 'works_at')
      RETURNING id`;
    const ev2 = await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate)
      VALUES (${expiredFactId}::uuid, 'expired', ${person.id}::uuid, 'job_title')
      RETURNING id`;

    const sourceRefs = [{ memoryId: '00000000-0000-0000-0000-000000000001', quote: 'she was promoted' }];
    const edgeRows = await testDb`
      INSERT INTO causal_edges
        (cause_event_id, effect_event_id, strength, extraction_method, reasoning, source_references, initial_strength)
      VALUES
        (${ev1[0]!.id}::uuid, ${ev2[0]!.id}::uuid, 0.7, 'test',
         'the new role followed directly from the project win',
         ${JSON.stringify(sourceRefs)}::jsonb, 0.7)
      RETURNING id`;
    const edgeId = edgeRows[0]!.id as string;

    await testDb`
      INSERT INTO contradictions
        (contradiction_type, fact_a_id, fact_b_id, detected_by, detection_reasoning, severity)
      VALUES
        ('opposing_object', ${activeFact.id}::uuid, ${expiredFactId}::uuid, 'sql_heuristic',
         'two job titles active at once', 'high')`;

    await testDb`
      INSERT INTO same_as_links (entity_a_id, entity_b_id, reasoning)
      VALUES (${person.id}::uuid, ${company.id}::uuid, 'smoke-test link')`;

    // --- round-trip through the route ---
    const res = await app.request('/api/graph/full');
    expect(res.status).toBe(200);
    const body: any = await res.json();

    // shape: the rich superset — every bucket present
    for (const key of ['entities', 'facts', 'events', 'edges', 'sameAs', 'contradictions', 'reports', 'counts']) {
      expect(body).toHaveProperty(key);
    }
    expect(body.reports).toHaveProperty('extraction');
    expect(body.reports).toHaveProperty('gardening');
    expect(body.reports).toHaveProperty('reasoning');

    // EXPIRED fact is included (the supersession audit signal canonical export drops)
    const expired = body.facts.find((f: any) => f.id === expiredFactId);
    expect(expired).toBeDefined();
    expect(expired.expiredAt).toBeTruthy();
    expect(expired.expireReason).toBe('superseded by senior engineer');
    // active fact present and NOT expired
    const active = body.facts.find((f: any) => f.id === activeFact.id);
    expect(active).toBeDefined();
    expect(active.expiredAt).toBeNull();
    expect(body.counts.expiredFacts).toBeGreaterThanOrEqual(1);
    expect(body.counts.activeFacts).toBeGreaterThanOrEqual(1);

    // causal edge carries reasoning + source_references (the doc-01 invariant)
    const edge = body.edges.find((e: any) => e.id === edgeId);
    expect(edge).toBeDefined();
    expect(edge.reasoning).toBe('the new role followed directly from the project win');
    expect(edge.sourceReferences).toEqual(sourceRefs);

    // contradictions + same_as surfaced
    expect(body.contradictions.length).toBeGreaterThanOrEqual(1);
    expect(body.contradictions.some((c: any) => c.contradictionType === 'opposing_object')).toBe(true);
    expect(body.sameAs.length).toBeGreaterThanOrEqual(1);

    // both causal transitions present
    expect(body.events.length).toBeGreaterThanOrEqual(2);

    // entities include our two, with the rich-only fields present
    expect(body.entities.length).toBeGreaterThanOrEqual(2);
    const p = body.entities.find((e: any) => e.id === person.id);
    expect(p).toBeDefined();
    expect(p.type).toBe('person');
    expect(p).toHaveProperty('summary'); // entity_meta.summary (null here — no meta row)
    expect(p).toHaveProperty('mergedFrom');
  });
});
