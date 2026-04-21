/**
 * B02: Causal event creation on fact changes
 *
 * Verifies that createFact, expireFact, and invalidateFact
 * create corresponding causal_events rows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity } from '../setup.js';

describe('B02: Causal event creation on fact changes', () => {
  let entityId: string;

  beforeAll(async () => {

    const entity = await createTestEntity({
      canonicalName: 'B02 Test Person',
      entityType: 'person',
    });
    entityId = entity.id;
  });

  afterAll(async () => {
    // Only clean up our own data (scoped by entity)
    await testDb.unsafe(`DELETE FROM causal_events WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityId}'`).catch(() => {});
  });

  it('createFact produces a causal_event with transition_type=created', async () => {
    // Import dynamically to ensure test env is set up first
    const { createFact } = await import('../../services/facts.js');

    const factId = await createFact({
      subjectEntityId: entityId,
      predicate: 'works_at',
      objectValue: 'Acme Corp',
      sourceMemoryId: crypto.randomUUID(),
      sourceText: 'John works at Acme Corp',
      actor: 'graph_agent',
    });

    const events = await testDb`
      SELECT * FROM causal_events
      WHERE fact_id = ${factId}::uuid AND transition_type = 'created'
    `;

    expect(events.length).toBe(1);
    expect(events[0]!.subject_entity_id).toBe(entityId);
    expect(events[0]!.predicate).toBe('works_at');
    expect(events[0]!.source_text).toBe('John works at Acme Corp');
  });

  it('expireFact produces a causal_event with transition_type=expired', async () => {
    const { createFact, expireFact } = await import('../../services/facts.js');

    const factId = await createFact({
      subjectEntityId: entityId,
      predicate: 'lives_in',
      objectValue: 'New York',
      actor: 'graph_agent',
    });

    await expireFact({ factId, reasoning: 'Superseded', actor: 'reasoning_agent' });

    const events = await testDb`
      SELECT * FROM causal_events
      WHERE fact_id = ${factId}::uuid AND transition_type = 'expired'
    `;

    expect(events.length).toBe(1);
    expect(events[0]!.subject_entity_id).toBe(entityId);
    expect(events[0]!.predicate).toBe('lives_in');
  });

  it('invalidateFact produces a causal_event with transition_type=invalidated', async () => {
    const { createFact, invalidateFact } = await import('../../services/facts.js');

    const factId = await createFact({
      subjectEntityId: entityId,
      predicate: 'knows',
      objectValue: 'Jane',
      actor: 'graph_agent',
    });

    await invalidateFact({ factId, reasoning: 'Relationship no longer holds', actor: 'reasoning_agent' });

    const events = await testDb`
      SELECT * FROM causal_events
      WHERE fact_id = ${factId}::uuid AND transition_type = 'invalidated'
    `;

    expect(events.length).toBe(1);
    expect(events[0]!.subject_entity_id).toBe(entityId);
    expect(events[0]!.predicate).toBe('knows');
  });
});
