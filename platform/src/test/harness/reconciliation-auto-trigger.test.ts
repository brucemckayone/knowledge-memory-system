/**
 * Bead nmemo-2yv.61 — reconciliation agent auto-trigger via pipeline.
 *
 * Tests exercise maybeTriggerReconciliation() directly with a stubbed
 * invoker so the conditional gating + cooldown behaviour can be asserted
 * without spinning up ml-services. The behavioural acceptance bullets
 * (agent fires async, candidates trend down across ingests) are best
 * verified via /verify against a live stack; these tests cover the
 * deterministic logic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  maybeTriggerReconciliation,
  _resetReconciliationCooldown,
  type ReconciliationAgentInvoker,
} from '../../pipeline.js';
import { testDb, createTestEntity } from '../setup.js';

interface StubCall {
  candidateCount: number;
}

function buildStubInvoker(result = 'agent ran'): {
  invoker: ReconciliationAgentInvoker;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const invoker: ReconciliationAgentInvoker = async (params) => {
    calls.push({ candidateCount: params.candidates.length });
    return { result };
  };
  return { invoker, calls };
}

async function seedMergeCandidate(status: 'staging' | 'candidate'): Promise<void> {
  const a = await createTestEntity({ canonicalName: `recon-test-${Date.now()}-a-${Math.random()}`, entityType: 'Concept' });
  const b = await createTestEntity({ canonicalName: `recon-test-${Date.now()}-b-${Math.random()}`, entityType: 'Concept' });
  // Honour the entity_a_id < entity_b_id ordering CHECK constraint.
  const [aId, bId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  await testDb`
    INSERT INTO public.merge_candidates (entity_a_id, entity_b_id, status, combined_score)
    VALUES (${aId}::uuid, ${bId}::uuid, ${status}, 0.5)
  `;
}

describe('bead nmemo-2yv.61 — maybeTriggerReconciliation', () => {
  beforeEach(async () => {
    _resetReconciliationCooldown();
    // Scoped cleanup — entities filtered to our seeded names. The
    // merge_candidates rows cascade-delete via FK.
    await testDb`DELETE FROM public.entities WHERE canonical_name LIKE 'recon-test-%'`;
  });

  it('skips with no_pending_work when no candidates and no unconfirmed aliases exist', async () => {
    const { invoker, calls } = buildStubInvoker();
    const result = await maybeTriggerReconciliation(invoker);
    expect(result?.triggered).toBe(false);
    expect(result?.skippedReason).toBe('no_pending_work');
    expect(calls).toHaveLength(0);
  });

  it('triggers when a staging-status merge_candidate exists (broader than /api/reconcile)', async () => {
    await seedMergeCandidate('staging');
    const { invoker, calls } = buildStubInvoker('staging-run-result');
    const result = await maybeTriggerReconciliation(invoker);
    expect(result?.triggered).toBe(true);
    expect(result?.candidateCount).toBeGreaterThanOrEqual(1);
    expect(result?.report).toBe('staging-run-result');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.candidateCount).toBeGreaterThanOrEqual(1);
  });

  it('triggers when a candidate-status merge_candidate exists', async () => {
    await seedMergeCandidate('candidate');
    const { invoker, calls } = buildStubInvoker();
    const result = await maybeTriggerReconciliation(invoker);
    expect(result?.triggered).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('cooldown gate: second invocation within RECONCILIATION_MIN_INTERVAL_MS skips with cooldown reason (acceptance bullet 3)', async () => {
    await seedMergeCandidate('candidate');
    const { invoker, calls } = buildStubInvoker();

    // First call: triggers, sets cooldown.
    const r1 = await maybeTriggerReconciliation(invoker);
    expect(r1?.triggered).toBe(true);
    expect(calls).toHaveLength(1);

    // Second call within the cooldown window: must skip without re-invoking.
    const r2 = await maybeTriggerReconciliation(invoker);
    expect(r2?.triggered).toBe(false);
    expect(r2?.skippedReason).toMatch(/^cooldown /);
    expect(calls).toHaveLength(1); // invoker NOT called again
  });

  it('error path: invoker throws → triggered=false with skippedReason=error; cooldown still consumed (no retry storm)', async () => {
    await seedMergeCandidate('candidate');
    const throwingInvoker: ReconciliationAgentInvoker = async () => {
      throw new Error('simulated agent failure');
    };

    const r1 = await maybeTriggerReconciliation(throwingInvoker);
    expect(r1?.triggered).toBe(false);
    expect(r1?.skippedReason).toBe('error');

    // Subsequent call within cooldown also skips — failed invocations don't
    // get a retry pass; the next cycle (after cooldown) gets the next try.
    const r2 = await maybeTriggerReconciliation(throwingInvoker);
    expect(r2?.triggered).toBe(false);
    expect(r2?.skippedReason).toMatch(/^cooldown /);
  });
});
