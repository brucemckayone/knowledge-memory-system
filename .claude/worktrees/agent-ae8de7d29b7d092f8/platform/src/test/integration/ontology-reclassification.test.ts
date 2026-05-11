/**
 * Ontology Reclassification Tests
 *
 * I5: Convergence indicators — proves the data model can track predicate
 *     lifecycle (canonical / provisional / rejected) and that low-usage
 *     provisionals are identifiable for demotion.
 *
 * I6: Entity type reclassification — exercises reclassifyEntity and
 *     batchReclassify from the entity-reclassification service, verifying
 *     that type changes are persisted and audited in entity_type_history.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { testDb, createTestEntity, randomUUID } from '../setup.js';
import { reclassifyEntity, batchReclassify } from '../../services/entity-reclassification.js';

// ─── Helpers ─────────────────────────────────────────────────────────

/** Insert a predicate with explicit lifecycle fields. */
async function insertPredicate(fields: {
  predicate: string;
  status: string;
  usageCount?: number;
  promotedAt?: Date | null;
  rejectedAt?: Date | null;
  rejectionReason?: string | null;
}) {
  await testDb`
    INSERT INTO fact_predicates (
      predicate, description, status, usage_count,
      promoted_at, rejected_at, rejection_reason,
      first_seen_at, created_at
    )
    VALUES (
      ${fields.predicate},
      ${'test predicate'},
      ${fields.status},
      ${fields.usageCount ?? 0},
      ${fields.promotedAt ?? null},
      ${fields.rejectedAt ?? null},
      ${fields.rejectionReason ?? null},
      ${new Date()},
      ${new Date()}
    )
    ON CONFLICT (predicate) DO NOTHING
  `;
}

/** Ensure the entity_types table accepts the given type name. */
async function ensureEntityType(name: string) {
  await testDb`
    INSERT INTO entity_types (name, description, status)
    VALUES (${name}, ${'test type'}, 'canonical')
    ON CONFLICT (name) DO NOTHING
  `;
}

// Track created test data for per-test cleanup
let createdPredicates: string[] = [];
let createdEntityIds: string[] = [];

// ─── Setup / Teardown ────────────────────────────────────────────────

beforeAll(async () => {
  // Ensure 'technology' type exists so reclassification won't violate any FK
  await ensureEntityType('technology');
});

afterEach(async () => {
  // Clean up entity_type_history for entities created in the test
  if (createdEntityIds.length > 0) {
    await testDb`
      DELETE FROM entity_type_history
      WHERE entity_id = ANY(${createdEntityIds}::uuid[])
    `;
    await testDb`
      DELETE FROM entities
      WHERE id = ANY(${createdEntityIds}::uuid[])
    `;
  }

  // Clean up test predicates
  if (createdPredicates.length > 0) {
    await testDb`
      DELETE FROM fact_predicates
      WHERE predicate = ANY(${createdPredicates})
    `;
  }

  createdPredicates = [];
  createdEntityIds = [];
});

// =====================================================================
// I5: Ontology convergence indicators
// =====================================================================

describe('I5: Ontology convergence indicators', () => {
  it('should track promotion and rejection counts in fact_predicates', async () => {
    const suffix = randomUUID().slice(0, 8);
    const canonicalPred = `test_canonical_${suffix}`;
    const provisionalPred = `test_provisional_${suffix}`;
    const rejectedPred = `test_rejected_${suffix}`;

    createdPredicates.push(canonicalPred, provisionalPred, rejectedPred);

    await insertPredicate({ predicate: canonicalPred, status: 'canonical', usageCount: 50 });
    await insertPredicate({
      predicate: provisionalPred,
      status: 'provisional',
      usageCount: 10,
      promotedAt: new Date(),
    });
    await insertPredicate({
      predicate: rejectedPred,
      status: 'rejected',
      usageCount: 1,
      rejectedAt: new Date(),
      rejectionReason: 'duplicate of canonical predicate',
    });

    // Query counts by status for the test predicates
    const counts = await testDb`
      SELECT status, COUNT(*)::int AS cnt
      FROM fact_predicates
      WHERE predicate = ANY(${[canonicalPred, provisionalPred, rejectedPred]})
      GROUP BY status
    `;

    const byStatus = Object.fromEntries(
      counts.map((r: Record<string, unknown>) => [r.status, r.cnt]),
    );

    expect(byStatus['canonical']).toBe(1);
    expect(byStatus['provisional']).toBe(1);
    expect(byStatus['rejected']).toBe(1);
  });

  it('should identify provisional predicates with low usage past probation for demotion', async () => {
    const suffix = randomUUID().slice(0, 8);
    const stalePred = `test_stale_prov_${suffix}`;
    const healthyPred = `test_healthy_prov_${suffix}`;

    createdPredicates.push(stalePred, healthyPred);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Stale provisional: promoted 30 days ago, usage_count = 1
    await insertPredicate({
      predicate: stalePred,
      status: 'provisional',
      usageCount: 1,
      promotedAt: thirtyDaysAgo,
    });

    // Healthy provisional: promoted 30 days ago, usage_count = 25
    await insertPredicate({
      predicate: healthyPred,
      status: 'provisional',
      usageCount: 25,
      promotedAt: thirtyDaysAgo,
    });

    // Simulate the evolution agent's demotion query:
    // "provisional predicates promoted > 14 days ago with usage_count < 5"
    const demotionCandidates = await testDb`
      SELECT predicate, usage_count
      FROM fact_predicates
      WHERE status = 'provisional'
        AND promoted_at < NOW() - INTERVAL '14 days'
        AND usage_count < 5
        AND predicate = ANY(${[stalePred, healthyPred]})
    `;

    expect(demotionCandidates).toHaveLength(1);
    expect(demotionCandidates[0]!.predicate).toBe(stalePred);

    // Simulate demotion: set status back to 'rejected'
    await testDb`
      UPDATE fact_predicates
      SET status = 'rejected',
          rejected_at = NOW(),
          rejection_reason = 'low usage after probation period'
      WHERE predicate = ${stalePred}
    `;

    const demoted = await testDb`
      SELECT status, rejection_reason
      FROM fact_predicates
      WHERE predicate = ${stalePred}
    `;
    expect(demoted[0]!.status).toBe('rejected');
    expect(demoted[0]!.rejection_reason).toBe('low usage after probation period');
  });
});

// =====================================================================
// I6: Entity type reclassification
// =====================================================================

describe('I6: Entity type reclassification', () => {
  it('should reclassify entity and write type history', async () => {
    const suffix = randomUUID().slice(0, 8);
    const entity = await createTestEntity({
      canonicalName: `reclassify_target_${suffix}`,
      entityType: 'concept',
    });
    createdEntityIds.push(entity.id);

    await reclassifyEntity(entity.id, 'technology', 'Matched technology centroid');

    // Verify entity type updated
    const updated = await testDb`
      SELECT entity_type FROM entities WHERE id = ${entity.id}::uuid
    `;
    expect(updated[0]!.entity_type).toBe('technology');

    // Verify history record
    const history = await testDb`
      SELECT previous_type, new_type, reason, changed_by
      FROM entity_type_history
      WHERE entity_id = ${entity.id}::uuid
      ORDER BY changed_at DESC
      LIMIT 1
    `;
    expect(history).toHaveLength(1);
    expect(history[0]!.previous_type).toBe('concept');
    expect(history[0]!.new_type).toBe('technology');
    expect(history[0]!.reason).toBe('Matched technology centroid');
    expect(history[0]!.changed_by).toBe('ontology-evolution');
  });

  it('should not reclassify if entity already has the target type', async () => {
    const suffix = randomUUID().slice(0, 8);
    const entity = await createTestEntity({
      canonicalName: `noop_reclass_${suffix}`,
      entityType: 'person',
    });
    createdEntityIds.push(entity.id);

    await reclassifyEntity(entity.id, 'person', 'should be a no-op');

    // Entity type unchanged
    const unchanged = await testDb`
      SELECT entity_type FROM entities WHERE id = ${entity.id}::uuid
    `;
    expect(unchanged[0]!.entity_type).toBe('person');

    // No history record should exist
    const history = await testDb`
      SELECT id FROM entity_type_history
      WHERE entity_id = ${entity.id}::uuid
    `;
    expect(history).toHaveLength(0);
  });

  it('should batch reclassify multiple entities', async () => {
    const suffix = randomUUID().slice(0, 8);

    const e1 = await createTestEntity({ canonicalName: `batch_a_${suffix}`, entityType: 'concept' });
    const e2 = await createTestEntity({ canonicalName: `batch_b_${suffix}`, entityType: 'concept' });
    const e3 = await createTestEntity({ canonicalName: `batch_c_${suffix}`, entityType: 'concept' });
    const ids = [e1.id, e2.id, e3.id];
    createdEntityIds.push(...ids);

    const count = await batchReclassify(ids, 'technology', 'batch centroid match');
    expect(count).toBe(3);

    // Verify all types changed
    const updated = await testDb`
      SELECT id, entity_type FROM entities
      WHERE id = ANY(${ids}::uuid[])
    `;
    for (const row of updated) {
      expect(row.entity_type).toBe('technology');
    }

    // Verify 3 history records
    const history = await testDb`
      SELECT entity_id, previous_type, new_type, reason
      FROM entity_type_history
      WHERE entity_id = ANY(${ids}::uuid[])
      ORDER BY changed_at
    `;
    expect(history).toHaveLength(3);
    for (const row of history) {
      expect(row.previous_type).toBe('concept');
      expect(row.new_type).toBe('technology');
      expect(row.reason).toBe('batch centroid match');
    }
  });
});
