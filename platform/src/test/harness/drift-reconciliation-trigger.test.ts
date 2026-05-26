/**
 * Bead nmemo-2yv.83 — drift-reconciliation post-compute trigger.
 *
 * Three integration tests covering the locked behaviours:
 *   1. Happy path: stubbed 200 → reasoning_reports row inserted +
 *      entity_drift_events.reconciliation_run_id set.
 *   2. Retry: stubbed 503 (transient) twice, then 200 → run_id set,
 *      reconciliation_attempt_count = 2 (not exceeding MAX).
 *   3. Permanent failure: stubbed 404 → triggered_action transitions
 *      to 'reconciliation_failed' on first failure (no retry).
 *
 * The helper invocation accepts an injectable ReconciliationDriftInvoker
 * so the tests can drive the full state machine without hitting
 * ml-services. Acceptance criteria #7, #8, #9 from the bead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, createTestEntity, randomEmbedding } from '../setup.js';
import { triggerReconciliationDriftAfterCompute } from '../../index.js';
import type {
  ReconciliationDriftAgentParams,
  ReconciliationDriftAgentResponse,
  ReconciliationDriftInvoker,
} from '../../services/causal-agent.js';

const CENTROID_DIM = 768;

interface DriftEventRow {
  id: string;
  entity_id: string;
  triggered_action: string;
  reconciliation_run_id: string | null;
  reconciliation_attempt_count: number;
  error_detail: string | null;
}

async function getDriftEvent(eventId: string): Promise<DriftEventRow | null> {
  const rows = (await testDb`
    SELECT id::text                    AS id,
           entity_id::text             AS entity_id,
           triggered_action,
           reconciliation_run_id,
           reconciliation_attempt_count,
           error_detail
    FROM public.entity_drift_events
    WHERE id = ${eventId}::uuid
  `) as unknown as DriftEventRow[];
  return rows[0] ?? null;
}

interface ReasoningReportRow {
  id: string;
  mode: string;
  report: string;
  actions_taken: Record<string, unknown>;
  entity_ids: string[];
}

async function getReasoningReport(reportId: string): Promise<ReasoningReportRow | null> {
  const rows = (await testDb`
    SELECT id::text          AS id,
           mode,
           report,
           actions_taken,
           ARRAY(SELECT unnest(entity_ids)::text) AS entity_ids
    FROM public.reasoning_reports
    WHERE id = ${reportId}::uuid
  `) as unknown as Array<Omit<ReasoningReportRow, 'actions_taken'> & { actions_taken: string | Record<string, unknown> }>;
  const r = rows[0];
  if (!r) return null;
  // postgres.js returns the JSONB column as a string in this setup; parse
  // so the matcher can compare structurally.
  const actions_taken = typeof r.actions_taken === 'string'
    ? (JSON.parse(r.actions_taken) as Record<string, unknown>)
    : r.actions_taken;
  return { ...r, actions_taken };
}

/**
 * Seed an entity_drift_events row in the same shape /api/drift/compute would
 * write it: triggered_action='reconciliation_invoked', run_id NULL,
 * attempt_count default 0. Returns the inserted row id.
 */
async function seedDriftEvent(args: {
  entityId: string;
  driftMagnitude?: number;
  sourceClusterId?: number | null;
  targetClusterId?: number | null;
}): Promise<string> {
  const snapshotVec = randomEmbedding();
  const currentVec = randomEmbedding();
  if (snapshotVec.length !== CENTROID_DIM || currentVec.length !== CENTROID_DIM) {
    throw new Error(`randomEmbedding() returned wrong dim: ${snapshotVec.length}`);
  }
  const snapLit = `[${snapshotVec.join(',')}]`;
  const currLit = `[${currentVec.join(',')}]`;
  const rows = (await testDb`
    INSERT INTO public.entity_drift_events (
      entity_id,
      drift_magnitude,
      centroid_snapshot,
      centroid_current,
      cluster_id_at_detection,
      target_cluster_id,
      triggered_action
    ) VALUES (
      ${args.entityId}::uuid,
      ${args.driftMagnitude ?? 0.4321},
      ${snapLit}::vector,
      ${currLit}::vector,
      ${args.sourceClusterId ?? null},
      ${args.targetClusterId ?? null},
      'reconciliation_invoked'
    )
    RETURNING id::text AS id
  `) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error('seed insert returned no id');
  return rows[0].id;
}

/**
 * Build a stub invoker that returns a sequence of responses (one per call,
 * looping on the last entry once exhausted). The invoker also records every
 * params it received, for cross-checking payload shape.
 */
function buildStubInvoker(responses: ReconciliationDriftAgentResponse[]): {
  invoker: ReconciliationDriftInvoker;
  calls: ReconciliationDriftAgentParams[];
} {
  const calls: ReconciliationDriftAgentParams[] = [];
  let i = 0;
  const invoker: ReconciliationDriftInvoker = async (params) => {
    calls.push(params);
    const r = responses[Math.min(i, responses.length - 1)] ?? { status: 500, error: 'no stub configured' };
    i += 1;
    return r;
  };
  return { invoker, calls };
}

describe('bead nmemo-2yv.83 — triggerReconciliationDriftAfterCompute', () => {
  beforeEach(async () => {
    // Scoped cleanup — only touch data this test created. Unscoped
    // DELETE FROM entities trips entity_merges FK constraints from other
    // tests' leftover state. entity_drift_events / entity_drift_state
    // cascade via ON DELETE CASCADE when the parent entity is removed.
    await testDb`
      DELETE FROM public.reasoning_reports
      WHERE actions_taken->>'source' = 'reconciliation_drift_agent'
    `;
    await testDb`DELETE FROM public.entities WHERE canonical_name LIKE 'test-entity-83-%'`;
  });

  it('happy path: 200 response writes reasoning_reports row + sets reconciliation_run_id (acceptance #7)', async () => {
    const entity = await createTestEntity({
      canonicalName: 'test-entity-83-happy',
      entityType: 'Concept',
    });
    const eventId = await seedDriftEvent({
      entityId: entity.id,
      driftMagnitude: 0.6789,
      sourceClusterId: 2,
      targetClusterId: 5,
    });

    const agentText = '### DRIFT INVESTIGATION\n### DECISION\nSAME_ENTITY\n### NOTES\nstub';
    const { invoker, calls } = buildStubInvoker([{ status: 200, result: agentText }]);

    await triggerReconciliationDriftAfterCompute(invoker);

    // Invoker received exactly one call with the seeded payload.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.entity_id).toBe(entity.id);
    expect(calls[0]?.drift_magnitude).toBeCloseTo(0.6789, 4);
    expect(calls[0]?.source_cluster_id).toBe(2);
    expect(calls[0]?.target_cluster_id).toBe(5);
    expect(calls[0]?.centroid_snapshot).toHaveLength(CENTROID_DIM);
    expect(calls[0]?.centroid_current).toHaveLength(CENTROID_DIM);

    // Drift event row got a run_id set; counter untouched.
    const event = await getDriftEvent(eventId);
    expect(event).not.toBeNull();
    expect(event?.reconciliation_run_id).not.toBeNull();
    expect(event?.triggered_action).toBe('reconciliation_invoked');
    expect(event?.reconciliation_attempt_count).toBe(0);

    // reasoning_reports row exists with the agent text, references back to
    // the drift event via actions_taken.drift_event_id.
    const report = await getReasoningReport(event!.reconciliation_run_id!);
    expect(report).not.toBeNull();
    expect(report?.mode).toBe('patrol');
    expect(report?.report).toBe(agentText);
    expect(report?.entity_ids).toContain(entity.id);
    expect(report?.actions_taken).toMatchObject({
      drift_event_id: eventId,
      source: 'reconciliation_drift_agent',
    });
  });

  it('retry: transient 503 twice then 200 leaves attempt_count = 2, run_id set (acceptance #8)', async () => {
    const entity = await createTestEntity({
      canonicalName: 'test-entity-83-retry',
      entityType: 'Concept',
    });
    const eventId = await seedDriftEvent({ entityId: entity.id });

    // Cycle 1: 503 transient. Counter 0→1, row still pending.
    {
      const { invoker } = buildStubInvoker([{ status: 503, error: 'service busy' }]);
      await triggerReconciliationDriftAfterCompute(invoker);
      const row = await getDriftEvent(eventId);
      expect(row?.triggered_action).toBe('reconciliation_invoked');
      expect(row?.reconciliation_run_id).toBeNull();
      expect(row?.reconciliation_attempt_count).toBe(1);
      expect(row?.error_detail).toContain('503');
    }

    // Cycle 2: another 503. Counter 1→2.
    {
      const { invoker } = buildStubInvoker([{ status: 503, error: 'still busy' }]);
      await triggerReconciliationDriftAfterCompute(invoker);
      const row = await getDriftEvent(eventId);
      expect(row?.triggered_action).toBe('reconciliation_invoked');
      expect(row?.reconciliation_run_id).toBeNull();
      expect(row?.reconciliation_attempt_count).toBe(2);
    }

    // Cycle 3: 200 success. run_id set, counter stays at 2 (not incremented).
    {
      const { invoker } = buildStubInvoker([{ status: 200, result: 'agent text' }]);
      await triggerReconciliationDriftAfterCompute(invoker);
      const row = await getDriftEvent(eventId);
      expect(row?.triggered_action).toBe('reconciliation_invoked');
      expect(row?.reconciliation_run_id).not.toBeNull();
      // Bead acceptance #8: attempt_count == N (failure count), not exceeding MAX.
      expect(row?.reconciliation_attempt_count).toBe(2);
    }
  });

  it('permanent failure: 404 transitions triggered_action=reconciliation_failed on first failure (acceptance #9)', async () => {
    const entity = await createTestEntity({
      canonicalName: 'test-entity-83-perm',
      entityType: 'Concept',
    });
    const eventId = await seedDriftEvent({ entityId: entity.id });

    const { invoker, calls } = buildStubInvoker([{ status: 404, error: 'entity not found' }]);
    await triggerReconciliationDriftAfterCompute(invoker);

    expect(calls).toHaveLength(1);

    const row = await getDriftEvent(eventId);
    expect(row).not.toBeNull();
    // Acceptance #5: HTTP 404 → triggered_action='reconciliation_failed' on
    // FIRST failure. The previously-dead enum value (016:87) is now reachable.
    expect(row?.triggered_action).toBe('reconciliation_failed');
    expect(row?.reconciliation_run_id).toBeNull();
    expect(row?.reconciliation_attempt_count).toBe(0);
    expect(row?.error_detail).toContain('404');
    expect(row?.error_detail).toContain('entity not found');

    // A second cycle MUST NOT pick this row back up — selection criterion
    // requires triggered_action='reconciliation_invoked'.
    const { invoker: invoker2, calls: calls2 } = buildStubInvoker([{ status: 200, result: 'should not be called' }]);
    await triggerReconciliationDriftAfterCompute(invoker2);
    expect(calls2).toHaveLength(0);
    const rowAfter = await getDriftEvent(eventId);
    expect(rowAfter?.triggered_action).toBe('reconciliation_failed');
    expect(rowAfter?.reconciliation_run_id).toBeNull();
  });

  it('exhaustion: MAX_RECONCILIATION_ATTEMPTS transient failures transitions to reconciliation_failed (acceptance #5)', async () => {
    // Default MAX_RECONCILIATION_ATTEMPTS=3 per config. After 3 transient
    // failures, the helper should flip triggered_action to
    // reconciliation_failed so the dead enum becomes reachable even when
    // the agent never errors with a specific permanent class.
    const entity = await createTestEntity({
      canonicalName: 'test-entity-83-exhaust',
      entityType: 'Concept',
    });
    const eventId = await seedDriftEvent({ entityId: entity.id });

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const { invoker } = buildStubInvoker([{ status: 503, error: `cycle ${cycle}` }]);
      await triggerReconciliationDriftAfterCompute(invoker);
    }

    const row = await getDriftEvent(eventId);
    expect(row?.reconciliation_attempt_count).toBe(3);
    expect(row?.triggered_action).toBe('reconciliation_failed');
    expect(row?.error_detail).toContain('exhausted');

    // Sanity: row no longer pending.
    const { invoker: nextCycle, calls: nextCalls } = buildStubInvoker([{ status: 200, result: 'noop' }]);
    await triggerReconciliationDriftAfterCompute(nextCycle);
    expect(nextCalls).toHaveLength(0);
  });
});
