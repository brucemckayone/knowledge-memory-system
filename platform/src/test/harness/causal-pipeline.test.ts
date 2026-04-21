/**
 * B08: Pipeline causal integration
 *
 * Tests that ingest() correctly evaluates trigger conditions and
 * returns causal results. The full Claude Code integration test
 * requires the ML service with /causal-reason endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, createTestEntity, createTestFact } from '../setup.js';
import { shouldRunCausalAgent } from '../../services/causal-trigger.js';

describe('B08: Pipeline causal integration', () => {
  let entityId: string;

  beforeAll(async () => {
    const entity = await createTestEntity({
      canonicalName: 'B08 Pipeline Entity',
      entityType: 'person',
    });
    entityId = entity.id;

    // Give this entity causal history
    const fact = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'employed_at',
      objectValue: 'Test Inc',
    });
    await testDb`
      INSERT INTO causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
      VALUES (${fact.id}::uuid, 'created', ${entityId}::uuid, 'employed_at', 'works at Test Inc')
    `;
  });

  afterAll(async () => {
    await testDb.unsafe(`DELETE FROM causal_edges WHERE cause_event_id IN (SELECT id FROM causal_events WHERE subject_entity_id = '${entityId}')`).catch(() => {});
    await testDb.unsafe(`DELETE FROM causal_events WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id = '${entityId}'`).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityId}'`).catch(() => {});
  });

  // --- Trigger wiring (no ML service needed) ---

  it('trigger evaluates false for neutral text with no history', async () => {
    const result = await shouldRunCausalAgent({
      sourceText: 'The sky is blue',
      entityIds: [],
      newFactCount: 1,
    });
    expect(result.shouldRun).toBe(false);
  });

  it('trigger evaluates true for causal language', async () => {
    const result = await shouldRunCausalAgent({
      sourceText: 'John quit because his boss was toxic',
      entityIds: [],
      newFactCount: 1,
    });
    expect(result.shouldRun).toBe(true);
    expect(result.reasons.some(r => r.includes('causal language'))).toBe(true);
  });

  it('trigger evaluates true for entity with causal history', async () => {
    const result = await shouldRunCausalAgent({
      sourceText: 'Got promoted at work',
      entityIds: [entityId],
      newFactCount: 1,
    });
    expect(result.shouldRun).toBe(true);
    expect(result.reasons.some(r => r.includes('causal history'))).toBe(true);
  });

  it('trigger evaluates true for high fact count', async () => {
    const result = await shouldRunCausalAgent({
      sourceText: 'Many things happened today',
      entityIds: [],
      newFactCount: 5,
    });
    expect(result.shouldRun).toBe(true);
    expect(result.reasons.some(r => r.includes('facts created'))).toBe(true);
  });

  // --- Full integration (requires ML service + Claude Code) ---

  it('ingest with causal language triggers agent and creates edges', async () => {
    let mlAvailable = false;
    try {
      const res = await fetch('http://127.0.0.1:8000/health', {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const health = await res.json() as { endpoints?: string[] };
        mlAvailable = health.endpoints?.includes('causal-reason') ?? false;
      }
    } catch { /* ML service not running */ }

    if (!mlAvailable) {
      console.log('Skipping full integration: ML service /causal-reason not available');
      return;
    }

    // Full pipeline: store → extract (unified graph agent handles causal inline)
    const { ingest } = await import('../../pipeline.js');
    const result = await ingest('John quit because his boss was toxic and the work environment was unbearable');

    expect(result.memoryId).toBeDefined();

    // Agent should have created at least 1 causal edge for explicit causal language
    const edges = await testDb`
      SELECT * FROM causal_edges
      WHERE source_memory_id = ${result.memoryId}
         OR cause_event_id IN (SELECT id FROM causal_events WHERE source_memory_id = ${result.memoryId})
    `;
    expect(edges.length).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
