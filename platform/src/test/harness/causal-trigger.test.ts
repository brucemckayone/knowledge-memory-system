/**
 * B07: Conditional causal trigger
 *
 * Tests that the causal agent trigger correctly fires/skips based on
 * three conditions: causal language, fact count, entity causal history.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';
import {
  shouldRunCausalAgent,
  containsCausalLanguage,
} from '../../services/causal-trigger.js';

describe('B07: Conditional causal trigger', () => {
  let entityWithHistory: string;
  let entityNoHistory: string;

  beforeAll(async () => {
    // Entity WITH causal history
    const e1 = await createTestEntity({
      canonicalName: 'B07 Entity With History',
      entityType: 'person',
    });
    entityWithHistory = e1.id;

    const fact = await createTestFact({
      subjectEntityId: entityWithHistory,
      predicate: 'works_at',
      objectValue: 'Old Corp',
    });

    // Insert a causal event so this entity has history
    await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${fact.id}::uuid, 'created', ${entityWithHistory}::uuid, 'works_at', 'historical event')
    `;

    // Entity WITHOUT causal history
    const e2 = await createTestEntity({
      canonicalName: 'B07 Entity No History',
      entityType: 'place',
    });
    entityNoHistory = e2.id;
  });

  afterAll(async () => {
    await testDb.unsafe(`DELETE FROM causal_events WHERE subject_entity_id = '${entityWithHistory}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id = '${entityWithHistory}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityWithHistory}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id = '${entityNoHistory}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityNoHistory}'`).catch(() => {});
  });

  // --- Condition (c): Causal language ---

  it('detects "because" as causal language', () => {
    expect(containsCausalLanguage('John quit because his boss was toxic')).toBe(true);
  });

  it('detects "led to" as causal language', () => {
    expect(containsCausalLanguage('The merger led to layoffs')).toBe(true);
  });

  it('detects "as a result" as causal language', () => {
    expect(containsCausalLanguage('As a result, she moved')).toBe(true);
  });

  it('rejects text without causal markers', () => {
    expect(containsCausalLanguage('The sky is blue')).toBe(false);
  });

  // --- Full trigger: agent does NOT run ---

  it('agent does NOT run for "The sky is blue" with no history and 1 fact', async () => {
    const result = await shouldRunCausalAgent({
      sourceText: 'The sky is blue',
      entityIds: [entityNoHistory],
      newFactCount: 1,
    });

    expect(result.shouldRun).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  // --- Full trigger: condition (c) - causal language ---

  it('agent DOES run for explicit causal language', async () => {
    const result = await shouldRunCausalAgent({
      sourceText: 'John quit because his boss was toxic',
      entityIds: [entityNoHistory],
      newFactCount: 1,
    });

    expect(result.shouldRun).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(1);
    expect(result.reasons.some(r => r.includes('causal language'))).toBe(true);
  });

  // --- Full trigger: condition (a) - entity has history ---

  it('agent DOES run when entity has existing causal history', async () => {
    const result = await shouldRunCausalAgent({
      sourceText: 'John moved to London',
      entityIds: [entityWithHistory],
      newFactCount: 1,
    });

    expect(result.shouldRun).toBe(true);
    expect(result.reasons.some(r => r.includes('causal history'))).toBe(true);
  });

  // --- Full trigger: condition (b) - fact threshold ---

  it('agent DOES run when fact count exceeds threshold', async () => {
    const result = await shouldRunCausalAgent({
      sourceText: 'Various things happened',
      entityIds: [entityNoHistory],
      newFactCount: 4,
    });

    expect(result.shouldRun).toBe(true);
    expect(result.reasons.some(r => r.includes('facts created'))).toBe(true);
  });

  it('agent does NOT run when fact count equals threshold', async () => {
    const result = await shouldRunCausalAgent({
      sourceText: 'Some things happened',
      entityIds: [entityNoHistory],
      newFactCount: 3,
    });

    expect(result.shouldRun).toBe(false);
  });

  // --- Multiple conditions ---

  it('reports multiple reasons when multiple conditions met', async () => {
    const result = await shouldRunCausalAgent({
      sourceText: 'He moved because of work',
      entityIds: [entityNoHistory],
      newFactCount: 5,
    });

    expect(result.shouldRun).toBe(true);
    expect(result.reasons.length).toBe(2);
  });
});
