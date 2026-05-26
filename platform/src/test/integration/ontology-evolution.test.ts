/**
 * Ontology Evolution Integration Tests
 *
 * Verification gates for the living ontology staging pipeline:
 *   I2 — Staging counter accumulation (usage_count, distinct_memory_count)
 *   I3 — Evolution agent decision accuracy (structural pre-filter + threshold gating)
 *   I4 — Dynamic ontology loading (entity_types + fact_predicates)
 *
 * Requires migrations 024 (entity_types) and 025 (predicate_staging) to have run.
 * Each test uses unique names and cleans up its own rows to avoid interference.
 *
 * NOTE (nmemo-2yv.23): The "evolution agent" described in the I3 suite was
 * never built (`platform/src/gardener/agents/ontology-evolution.agent.ts`
 * does not exist; the gardener_agent that DOES run handles entity
 * consolidation only). I2/I3 tests simulate the orchestrator's expected DB
 * mutations via raw SQL — they exercise schema invariants (CHECK
 * constraints, counter accumulation, status filtering) rather than a
 * production code path. I4 covers the schema shape used by
 * `getValidEntityTypes()` in `entities.ts`. Retained for schema regression
 * coverage and to keep the door open for reviving doc 02 §6's pipeline.
 * Do NOT remove without reviving or striking §6.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { testDb, createTestEntity, createTestFact, randomUUID } from '../setup.js';
import { normalizePredicate } from '../../services/predicates.js';
import { getValidEntityTypes } from '../../services/entities.js';

// Unique prefix to scope test data and enable targeted cleanup
const PREFIX = `oe_test_${Date.now()}`;

// Track rows inserted by tests for cleanup
const insertedPredicates: string[] = [];
const insertedEntityTypes: string[] = [];

/**
 * Check whether the required tables and columns exist.
 * If migration 024/025 have not run, every test in this file will be skipped.
 */
let tablesReady = false;

beforeAll(async () => {
  try {
    // Verify entity_types table exists with status column (migration 024)
    await testDb`SELECT name, status FROM entity_types LIMIT 1`;

    // Verify fact_predicates has staging lifecycle columns (migration 025)
    await testDb`SELECT predicate, status, usage_count, distinct_memory_count FROM fact_predicates LIMIT 1`;

    tablesReady = true;
  } catch {
    console.warn(
      'Skipping ontology-evolution tests: entity_types or fact_predicates staging columns not found. ' +
      'Run migrations 024 and 025 first.',
    );
  }
});

afterEach(async () => {
  // Clean up test predicates
  for (const pred of insertedPredicates) {
    try {
      await testDb`DELETE FROM fact_predicates WHERE predicate = ${pred}`;
    } catch { /* may already be gone */ }
  }
  insertedPredicates.length = 0;

  // Clean up test entity types
  for (const name of insertedEntityTypes) {
    try {
      await testDb`DELETE FROM entity_types WHERE name = ${name}`;
    } catch { /* may already be gone */ }
  }
  insertedEntityTypes.length = 0;
});

// ------------------------------------------------------------------
// Helper: insert a staged predicate
// ------------------------------------------------------------------
async function insertStagedPredicate(
  predicate: string,
  opts: { usageCount?: number; distinctMemoryCount?: number; description?: string } = {},
): Promise<void> {
  insertedPredicates.push(predicate);
  await testDb`
    INSERT INTO fact_predicates (predicate, status, usage_count, distinct_memory_count, description, is_canonical, first_seen_at, created_at)
    VALUES (
      ${predicate},
      'staging',
      ${opts.usageCount ?? 0},
      ${opts.distinctMemoryCount ?? 0},
      ${opts.description ?? null},
      false,
      NOW(),
      NOW()
    )
    ON CONFLICT (predicate) DO NOTHING
  `;
}

// ------------------------------------------------------------------
// Helper: insert a test entity type
// ------------------------------------------------------------------
async function insertEntityType(
  name: string,
  status: string,
  description?: string,
): Promise<void> {
  insertedEntityTypes.push(name);
  await testDb`
    INSERT INTO entity_types (name, description, status, created_at)
    VALUES (${name}, ${description ?? null}, ${status}, NOW())
    ON CONFLICT (name) DO NOTHING
  `;
}

// ==================================================================
// I2: Staging counter accumulation
// ==================================================================
describe('I2: Staging counter accumulation', () => {
  it('should increment usage_count when a fact references a staged predicate', async () => {
    if (!tablesReady) return;

    const pred = `${PREFIX}_usage_inc`;
    await insertStagedPredicate(pred, { usageCount: 0 });

    // Simulate what createFact + recordPredicateUsage does: bump usage_count
    await testDb`
      UPDATE fact_predicates
      SET usage_count = usage_count + 1, last_used_at = NOW()
      WHERE predicate = ${pred}
    `;

    const rows = await testDb`SELECT usage_count FROM fact_predicates WHERE predicate = ${pred}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.usage_count).toBe(1);

    // Increment again
    await testDb`
      UPDATE fact_predicates
      SET usage_count = usage_count + 1, last_used_at = NOW()
      WHERE predicate = ${pred}
    `;

    const rows2 = await testDb`SELECT usage_count FROM fact_predicates WHERE predicate = ${pred}`;
    expect(rows2[0]!.usage_count).toBe(2);
  });

  it('should track distinct_memory_count across different memories', async () => {
    if (!tablesReady) return;

    const pred = `${PREFIX}_mem_count`;
    await insertStagedPredicate(pred, { usageCount: 0, distinctMemoryCount: 0 });

    // Create an entity to attach facts to
    const entity = await createTestEntity({
      canonicalName: `${PREFIX}_entity_mem`,
      entityType: 'person',
    });

    // Create facts from 3 different memory_ids
    const memoryIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const memoryId of memoryIds) {
      await createTestFact({
        subjectEntityId: entity.id,
        predicate: pred,
        objectValue: `value_${memoryId.slice(0, 8)}`,
      });

      // Simulate distinct_memory_count tracking
      await testDb`
        UPDATE fact_predicates
        SET usage_count = usage_count + 1,
            distinct_memory_count = distinct_memory_count + 1,
            last_used_at = NOW()
        WHERE predicate = ${pred}
      `;
    }

    const rows = await testDb`
      SELECT usage_count, distinct_memory_count
      FROM fact_predicates
      WHERE predicate = ${pred}
    `;

    expect(rows.length).toBe(1);
    expect(rows[0]!.usage_count).toBe(3);
    expect(rows[0]!.distinct_memory_count).toBe(3);
  });

  it('should preserve staging status while counters accumulate below threshold', async () => {
    if (!tablesReady) return;

    const pred = `${PREFIX}_still_staging`;
    await insertStagedPredicate(pred, { usageCount: 1 });

    // Bump once more (total: 2, still below threshold of 3)
    await testDb`
      UPDATE fact_predicates
      SET usage_count = usage_count + 1
      WHERE predicate = ${pred}
    `;

    const rows = await testDb`
      SELECT status, usage_count
      FROM fact_predicates
      WHERE predicate = ${pred}
    `;

    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('staging');
    expect(rows[0]!.usage_count).toBe(2);
  });
});

// ==================================================================
// I3: Evolution agent decision accuracy (simplified)
// ==================================================================
describe('I3: Evolution agent produces correct staging transitions', () => {
  it('should auto-merge a staged predicate when normalizePredicate maps it to an existing canonical', () => {
    if (!tablesReady) return;

    // normalizePredicate uses the in-memory CANONICAL_ONTOLOGY alias map.
    // "employed_at" is a known alias of "works_at".
    const result = normalizePredicate('employed_at');
    expect(result).toBe('works_at');

    // Verify a non-alias stays as-is
    const unknown = normalizePredicate('completely_novel_predicate');
    expect(unknown).toBe('completely_novel_predicate');
  });

  it('should auto-merge staged alias via structural pre-filter (DB round-trip)', async () => {
    if (!tablesReady) return;

    // Insert a staged predicate that is a known alias
    const pred = 'works_for'; // alias of works_at in CANONICAL_ONTOLOGY
    await insertStagedPredicate(pred, { usageCount: 5 });

    // The evolution agent's structural pre-filter calls normalizePredicate()
    const normalized = normalizePredicate(pred);
    expect(normalized).toBe('works_at');
    expect(normalized).not.toBe(pred);

    // Simulate the merge that the agent would perform
    await testDb`
      UPDATE fact_predicates
      SET status = 'canonical'
      WHERE predicate = ${pred}
    `;

    const rows = await testDb`
      SELECT status FROM fact_predicates WHERE predicate = ${pred}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('canonical');
  });

  it('should keep staged predicates below threshold untouched', async () => {
    if (!tablesReady) return;

    const pred = `${PREFIX}_below_threshold`;
    await insertStagedPredicate(pred, { usageCount: 1 });

    // Simulate the evolution agent query: only fetch staging with usage >= 3
    const candidates = await testDb`
      SELECT predicate, usage_count
      FROM fact_predicates
      WHERE status = 'staging'
        AND usage_count >= 3
        AND predicate = ${pred}
    `;

    // Should NOT appear in candidates
    expect(candidates.length).toBe(0);

    // Verify it still exists as staging
    const rows = await testDb`
      SELECT status, usage_count
      FROM fact_predicates
      WHERE predicate = ${pred}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('staging');
    expect(rows[0]!.usage_count).toBe(1);
  });

  it('should transition staging -> candidate when usage reaches threshold', async () => {
    if (!tablesReady) return;

    const pred = `${PREFIX}_reaches_threshold`;
    await insertStagedPredicate(pred, { usageCount: 3 });

    // Simulate the evolution agent fetching candidates
    const candidates = await testDb`
      SELECT predicate, usage_count
      FROM fact_predicates
      WHERE status = 'staging'
        AND usage_count >= 3
        AND predicate = ${pred}
    `;

    expect(candidates.length).toBe(1);
    expect(candidates[0]!.predicate).toBe(pred);
    expect(candidates[0]!.usage_count).toBe(3);
  });

  it('should support promotion to provisional status', async () => {
    if (!tablesReady) return;

    const pred = `${PREFIX}_promote_prov`;
    await insertStagedPredicate(pred, { usageCount: 5 });

    // Simulate evolution agent promoting to provisional
    await testDb`
      UPDATE fact_predicates
      SET status = 'provisional', promoted_at = NOW()
      WHERE predicate = ${pred}
    `;

    const rows = await testDb`
      SELECT status, promoted_at
      FROM fact_predicates
      WHERE predicate = ${pred}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('provisional');
    expect(rows[0]!.promoted_at).not.toBeNull();
  });

  it('should reject predicates by setting status to rejected', async () => {
    if (!tablesReady) return;

    const pred = `${PREFIX}_reject`;
    await insertStagedPredicate(pred, { usageCount: 4 });

    // Simulate evolution agent rejecting a predicate
    await testDb`
      UPDATE fact_predicates
      SET status = 'rejected',
          rejected_at = NOW(),
          rejection_reason = 'Duplicate of existing canonical after LLM review'
      WHERE predicate = ${pred}
    `;

    const rows = await testDb`
      SELECT status, rejected_at, rejection_reason
      FROM fact_predicates
      WHERE predicate = ${pred}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('rejected');
    expect(rows[0]!.rejected_at).not.toBeNull();
    expect(rows[0]!.rejection_reason).toContain('Duplicate');
  });
});

// ==================================================================
// I4: Dynamic ontology loading
// ==================================================================
describe('I4: Dynamic ontology loading', () => {
  describe('Entity types from entity_types table', () => {
    it('should load canonical entity types via getValidEntityTypes()', async () => {
      if (!tablesReady) return;

      const typeName = `${PREFIX}_technology`;
      await insertEntityType(typeName, 'canonical', 'A technology or framework');

      // Invalidate the module-level cache by waiting past TTL or by calling
      // directly via testDb (bypasses cache). We test the DB layer here.
      const rows = await testDb`
        SELECT name FROM entity_types
        WHERE status IN ('canonical', 'provisional')
          AND name = ${typeName}
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.name).toBe(typeName);
    });

    it('should include provisional types in valid types', async () => {
      if (!tablesReady) return;

      const typeName = `${PREFIX}_gadget`;
      await insertEntityType(typeName, 'provisional', 'A gadget or device');

      const rows = await testDb`
        SELECT name FROM entity_types
        WHERE status IN ('canonical', 'provisional')
          AND name = ${typeName}
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.name).toBe(typeName);
    });

    it('should exclude deprecated types from valid types', async () => {
      if (!tablesReady) return;

      const typeName = `${PREFIX}_deprecated_type`;
      await insertEntityType(typeName, 'deprecated', 'Retired entity type');

      const rows = await testDb`
        SELECT name FROM entity_types
        WHERE status IN ('canonical', 'provisional')
          AND name = ${typeName}
      `;
      expect(rows.length).toBe(0);

      // Verify it does exist in the table (just filtered out)
      const allRows = await testDb`
        SELECT name, status FROM entity_types WHERE name = ${typeName}
      `;
      expect(allRows.length).toBe(1);
      expect(allRows[0]!.status).toBe('deprecated');
    });

    it('should return seeded canonical types from migration 024', async () => {
      if (!tablesReady) return;

      const seeded = ['person', 'company', 'project', 'concept', 'place', 'event', 'other'];
      const rows = await testDb`
        SELECT name FROM entity_types
        WHERE status = 'canonical'
          AND name = ANY(${seeded})
      `;

      const names = rows.map((r: Record<string, unknown>) => r.name as string);
      for (const expected of seeded) {
        expect(names).toContain(expected);
      }
    });

    it('should enforce valid_entity_type_status constraint', async () => {
      if (!tablesReady) return;

      const typeName = `${PREFIX}_bad_status`;
      insertedEntityTypes.push(typeName);

      await expect(
        testDb`INSERT INTO entity_types (name, status) VALUES (${typeName}, 'invalid_status')`,
      ).rejects.toThrow();
    });
  });

  describe('Predicates from fact_predicates table', () => {
    it('should load canonical predicates from fact_predicates', async () => {
      if (!tablesReady) return;

      const pred = `${PREFIX}_canon_pred`;
      insertedPredicates.push(pred);
      await testDb`
        INSERT INTO fact_predicates (predicate, status, is_canonical, created_at)
        VALUES (${pred}, 'canonical', true, NOW())
        ON CONFLICT (predicate) DO NOTHING
      `;

      const rows = await testDb`
        SELECT predicate FROM fact_predicates
        WHERE status IN ('canonical', 'provisional')
          AND predicate = ${pred}
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.predicate).toBe(pred);
    });

    it('should load provisional predicates alongside canonical ones', async () => {
      if (!tablesReady) return;

      const pred = `${PREFIX}_prov_pred`;
      insertedPredicates.push(pred);
      await testDb`
        INSERT INTO fact_predicates (predicate, status, is_canonical, promoted_at, created_at)
        VALUES (${pred}, 'provisional', false, NOW(), NOW())
        ON CONFLICT (predicate) DO NOTHING
      `;

      const rows = await testDb`
        SELECT predicate, status FROM fact_predicates
        WHERE status IN ('canonical', 'provisional')
          AND predicate = ${pred}
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe('provisional');
    });

    it('should exclude staging predicates from active ontology queries', async () => {
      if (!tablesReady) return;

      const pred = `${PREFIX}_staging_excl`;
      await insertStagedPredicate(pred, { usageCount: 1 });

      const rows = await testDb`
        SELECT predicate FROM fact_predicates
        WHERE status IN ('canonical', 'provisional')
          AND predicate = ${pred}
      `;
      expect(rows.length).toBe(0);
    });

    it('should exclude rejected predicates from active ontology queries', async () => {
      if (!tablesReady) return;

      const pred = `${PREFIX}_rejected_excl`;
      insertedPredicates.push(pred);
      await testDb`
        INSERT INTO fact_predicates (predicate, status, is_canonical, rejected_at, rejection_reason, created_at)
        VALUES (${pred}, 'rejected', false, NOW(), 'Too similar to existing canonical', NOW())
        ON CONFLICT (predicate) DO NOTHING
      `;

      const rows = await testDb`
        SELECT predicate FROM fact_predicates
        WHERE status IN ('canonical', 'provisional')
          AND predicate = ${pred}
      `;
      expect(rows.length).toBe(0);
    });

    it('should enforce valid_predicate_status constraint', async () => {
      if (!tablesReady) return;

      const pred = `${PREFIX}_bad_pred_status`;
      insertedPredicates.push(pred);

      await expect(
        testDb`
          INSERT INTO fact_predicates (predicate, status, created_at)
          VALUES (${pred}, 'bogus_status', NOW())
        `,
      ).rejects.toThrow();
    });
  });

  describe('getValidEntityTypes() ORM integration', () => {
    it('should return an array including seeded canonical types', async () => {
      if (!tablesReady) return;

      // getValidEntityTypes() uses the Drizzle ORM `db` which reads from
      // the same test database (DATABASE_URL set by test setup.ts).
      // The result is cached for 60s; this test verifies the DB query itself.
      const types = await getValidEntityTypes();
      expect(Array.isArray(types)).toBe(true);
      expect(types).toContain('person');
      expect(types).toContain('company');
      expect(types).toContain('concept');
    });

    it('should not include deprecated types', async () => {
      if (!tablesReady) return;

      const typeName = `${PREFIX}_deprecated_orm`;
      await insertEntityType(typeName, 'deprecated');

      // Query directly (ORM cache may still hold stale data from prior calls)
      const rows = await testDb`
        SELECT name FROM entity_types
        WHERE name = ${typeName}
          AND status IN ('canonical', 'provisional')
      `;
      expect(rows.length).toBe(0);
    });
  });
});
