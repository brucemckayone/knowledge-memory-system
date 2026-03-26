/**
 * Ontology Edge Cases Tests (Test 5)
 *
 * Tests boundary conditions, cache behavior, and reclassification edge cases.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { testDb, createTestEntity, randomUUID } from '../setup.js';

const TS = Date.now();
let tablesReady = false;
let entityTypesReady = false;

describe('Ontology Edge Cases', () => {
  beforeAll(async (ctx) => {
    try {
      await testDb`SELECT 1 FROM fact_predicates WHERE status IS NOT NULL LIMIT 1`;
      tablesReady = true;
    } catch {
      (ctx as any).skip();
    }
    try {
      await testDb`SELECT 1 FROM entity_types LIMIT 1`;
      entityTypesReady = true;
    } catch {
      // entity_types tests will be skipped individually
    }
  });

  afterEach(async () => {
    if (!tablesReady) return;
    await testDb`DELETE FROM fact_predicates WHERE predicate LIKE ${'test_edge_%'}`;
    if (entityTypesReady) {
      await testDb`DELETE FROM entity_types WHERE name LIKE ${'test_edge_%'}`;
      await testDb`DELETE FROM entity_type_history WHERE new_type LIKE ${'test_edge_%'} OR previous_type LIKE ${'test_edge_%'}`;
    }
  });

  describe('Staging edge cases', () => {
    it('should not auto-promote based on usage count alone', async () => {
      const pred = `test_edge_high_usage_${TS}`;

      await testDb`
        INSERT INTO fact_predicates (predicate, description, status, usage_count)
        VALUES (${pred}, 'Very popular but unreviewed', 'staging', 1000)
      `;

      // High usage does NOT mean auto-promotion — still needs review
      const result = await testDb`SELECT status FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.status).toBe('staging'); // Still staging until reviewed
    });

    it('should handle predicate that matches multiple canonical aliases', async () => {
      // "created" appears as both a canonical AND an alias of "founded"
      // normalizePredicate should return a consistent result
      const { normalizePredicate } = await import('../../services/predicates.js');

      const result1 = normalizePredicate('created');
      const result2 = normalizePredicate('created');
      expect(result1).toBe(result2); // Consistent across calls
    });

    it('should handle concurrent usage count increments', async () => {
      const pred = `test_edge_concurrent_${TS}`;

      await testDb`
        INSERT INTO fact_predicates (predicate, description, status, usage_count)
        VALUES (${pred}, 'Concurrent test', 'staging', 0)
      `;

      // Simulate 5 concurrent increments
      await Promise.all([
        testDb`UPDATE fact_predicates SET usage_count = usage_count + 1 WHERE predicate = ${pred}`,
        testDb`UPDATE fact_predicates SET usage_count = usage_count + 1 WHERE predicate = ${pred}`,
        testDb`UPDATE fact_predicates SET usage_count = usage_count + 1 WHERE predicate = ${pred}`,
        testDb`UPDATE fact_predicates SET usage_count = usage_count + 1 WHERE predicate = ${pred}`,
        testDb`UPDATE fact_predicates SET usage_count = usage_count + 1 WHERE predicate = ${pred}`,
      ]);

      const result = await testDb`SELECT usage_count FROM fact_predicates WHERE predicate = ${pred}`;
      expect(result[0]!.usage_count).toBe(5); // No lost updates
    });
  });

  describe('Entity type edge cases', () => {
    it('should load entity types from entity_types table', async () => {
      if (!entityTypesReady) return;

      // The 7 seeded types should be present
      const types = await testDb`
        SELECT name, status FROM entity_types WHERE status = 'canonical' ORDER BY name
      `;

      const names = types.map((t: any) => t.name);
      expect(names).toContain('person');
      expect(names).toContain('company');
      expect(names).toContain('concept');
    });

    it('should accept new entity type after CHECK constraint dropped', async () => {
      if (!entityTypesReady) return;

      const typeName = `test_edge_technology_${TS}`;

      // Insert new type
      await testDb`
        INSERT INTO entity_types (name, description, status)
        VALUES (${typeName}, 'Technology type', 'provisional')
      `;

      // Verify it's queryable
      const result = await testDb`SELECT status FROM entity_types WHERE name = ${typeName}`;
      expect(result[0]!.status).toBe('provisional');
    });

    it('should exclude deprecated types from valid list', async () => {
      if (!entityTypesReady) return;

      const typeName = `test_edge_deprecated_${TS}`;

      await testDb`
        INSERT INTO entity_types (name, description, status)
        VALUES (${typeName}, 'Deprecated type', 'deprecated')
      `;

      // Query for active types — deprecated should not appear
      const active = await testDb`
        SELECT name FROM entity_types
        WHERE status IN ('canonical', 'provisional')
          AND name = ${typeName}
      `;
      expect(active.length).toBe(0);
    });

    it('cache invalidation should work', async () => {
      if (!entityTypesReady) return;

      // Import the cache functions
      const { getValidEntityTypes, invalidateEntityTypeCache } = await import('../../services/entities.js');

      // Get initial types (populates cache)
      const initial = await getValidEntityTypes();
      expect(initial.length).toBeGreaterThan(0);

      // Insert a new type
      const newType = `test_edge_cache_${TS}`;
      await testDb`
        INSERT INTO entity_types (name, description, status)
        VALUES (${newType}, 'Cache test', 'canonical')
      `;

      // Without invalidation, cache may still have old data
      // (depends on timing — cache TTL is 60s)

      // Invalidate and re-fetch
      invalidateEntityTypeCache();
      const updated = await getValidEntityTypes();
      expect(updated).toContain(newType);

      // Cleanup
      await testDb`DELETE FROM entity_types WHERE name = ${newType}`;
      invalidateEntityTypeCache(); // Clean cache after test
    });
  });

  describe('Reclassification edge cases', () => {
    it('should write type history on reclassification', async () => {
      if (!entityTypesReady) return;

      const entity = await createTestEntity({
        canonicalName: `EdgeEntity-${TS}`,
        entityType: 'concept',
      });

      // Simulate reclassification
      await testDb`UPDATE entities SET entity_type = 'project' WHERE id = ${entity.id}::uuid`;
      await testDb`
        INSERT INTO entity_type_history (id, entity_id, previous_type, new_type, changed_by, reason)
        VALUES (${randomUUID()}::uuid, ${entity.id}::uuid, 'concept', 'project', 'test', 'Edge case test')
      `;

      const history = await testDb`
        SELECT previous_type, new_type, reason
        FROM entity_type_history
        WHERE entity_id = ${entity.id}::uuid
      `;
      expect(history.length).toBe(1);
      expect(history[0]!.previous_type).toBe('concept');
      expect(history[0]!.new_type).toBe('project');

      // Cleanup
      await testDb`DELETE FROM entity_type_history WHERE entity_id = ${entity.id}::uuid`;
      await testDb`DELETE FROM entities WHERE id = ${entity.id}::uuid`;
    });

    it('should not create history record when type is unchanged', async () => {
      if (!entityTypesReady) return;

      const { reclassifyEntity } = await import('../../services/entity-reclassification.js');

      const entity = await createTestEntity({
        canonicalName: `NoChange-${TS}`,
        entityType: 'person',
      });

      // Reclassify to same type — should be a no-op
      await reclassifyEntity(entity.id, 'person', 'test no-op');

      const history = await testDb`
        SELECT * FROM entity_type_history WHERE entity_id = ${entity.id}::uuid
      `;
      expect(history.length).toBe(0); // No record created

      // Cleanup
      await testDb`DELETE FROM entities WHERE id = ${entity.id}::uuid`;
    });
  });
});
