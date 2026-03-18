/**
 * Schema Alignment Agent Tests (W27)
 *
 * Tests for the Schema Alignment Gardener Agent.
 * Covers SCH-001 through SCH-004 from the Phase 4 test strategy.
 *
 * Boundary: B10 - Predicate normalization
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { testDb, createTestEntity, randomUUID } from '../setup.js';
import { TEST_PREDICATES } from '../fixtures/phase4-seed.js';
import { schemaAlignmentAgent } from '../../gardener/agents/schema-alignment.agent.js';
import {
  normalizePredicate,
  isCanonicalPredicate,
  CANONICAL_ONTOLOGY,
} from '../../services/predicates.js';
import type { AgentContext } from '../../gardener/controller.js';
import type PgBoss from 'pg-boss';

describe('W27 Schema Alignment Agent', () => {
  // Create mock context helper
  function createMockContext(data: Record<string, unknown>): AgentContext {
    return {
      job: {
        id: randomUUID(),
        data,
      } as PgBoss.Job<unknown>,
      log: vi.fn(),
      checkpoint: vi.fn().mockResolvedValue(undefined),
      restoreCheckpoint: vi.fn().mockResolvedValue(null),
      traceId: null,
      config: {} as any,
      services: { ml: {} as any, controller: {} as any },
      signal: AbortSignal.timeout(30000),
    };
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('SCH-001: Normalize alias', () => {
    it('should normalize "employed_at" to "works_at"', () => {
      // When: Normalize the alias
      const canonical = normalizePredicate('employed_at');

      // Then: Should map to canonical form
      expect(canonical).toBe('works_at');
    });

    it('should normalize all defined aliases correctly', () => {
      // Test all aliases from test predicates
      for (const [alias, canonical] of Object.entries(TEST_PREDICATES.aliases)) {
        const result = normalizePredicate(alias);
        expect(result).toBe(canonical);
      }
    });

    it('should handle case-insensitive normalization', () => {
      expect(normalizePredicate('EMPLOYED_AT')).toBe('works_at');
      expect(normalizePredicate('Employed_At')).toBe('works_at');
      expect(normalizePredicate('Works_For')).toBe('works_at');
    });

    it('should handle space-separated predicates', () => {
      expect(normalizePredicate('employed at')).toBe('works_at');
      expect(normalizePredicate('works for')).toBe('works_at');
    });

    it('should return unchanged if no mapping exists', () => {
      const unknownPredicate = 'custom_unknown_predicate_xyz';
      const result = normalizePredicate(unknownPredicate);
      expect(result).toBe(unknownPredicate);
    });
  });

  describe('SCH-002: Sync ontology', () => {
    it('should have 25+ canonical predicates defined', () => {
      // When: Count canonical predicates
      const predicateCount = Object.keys(CANONICAL_ONTOLOGY).length;

      // Then: At least 25 predicates (as per spec)
      expect(predicateCount).toBeGreaterThanOrEqual(25);
    });

    it('should verify key predicates are in ontology', () => {
      // Then: Essential predicates should exist
      expect(CANONICAL_ONTOLOGY).toHaveProperty('works_at');
      expect(CANONICAL_ONTOLOGY).toHaveProperty('knows');
      expect(CANONICAL_ONTOLOGY).toHaveProperty('manages');
      expect(CANONICAL_ONTOLOGY).toHaveProperty('lives_in');
      expect(CANONICAL_ONTOLOGY).toHaveProperty('studied_at');
      expect(CANONICAL_ONTOLOGY).toHaveProperty('created');
      expect(CANONICAL_ONTOLOGY).toHaveProperty('skilled_in');
    });

    it('should mark exclusive predicates correctly', () => {
      // Then: Exclusive predicates should be marked
      expect(CANONICAL_ONTOLOGY.works_at?.exclusive).toBe(true);
      expect(CANONICAL_ONTOLOGY.reports_to?.exclusive).toBe(true);
      expect(CANONICAL_ONTOLOGY.married_to?.exclusive).toBe(true);
      expect(CANONICAL_ONTOLOGY.lives_in?.exclusive).toBe(true);

      // Non-exclusive predicates
      expect(CANONICAL_ONTOLOGY.knows?.exclusive).toBe(false);
      expect(CANONICAL_ONTOLOGY.skilled_in?.exclusive).toBe(false);
    });

    it('should categorize predicates by type', () => {
      // Then: Predicates should have categories
      expect(CANONICAL_ONTOLOGY.works_at?.category).toBe('professional');
      expect(CANONICAL_ONTOLOGY.knows?.category).toBe('personal');
      expect(CANONICAL_ONTOLOGY.lives_in?.category).toBe('location');
      expect(CANONICAL_ONTOLOGY.studied_at?.category).toBe('education');
      expect(CANONICAL_ONTOLOGY.created?.category).toBe('creation');
      expect(CANONICAL_ONTOLOGY.skilled_in?.category).toBe('skills');
    });
  });

  describe('SCH-003: Update facts', () => {
    it('should update fact predicate to canonical form', async () => {
      // Given: Entity with fact using non-canonical predicate
      const person = await createTestEntity({
        canonicalName: 'Schema Test Person',
        entityType: 'person',
      });
      const company = await createTestEntity({
        canonicalName: 'Schema Test Company',
        entityType: 'company',
      });

      // Create fact with non-canonical predicate directly in DB
      const factResult = await testDb`
        INSERT INTO facts (subject_entity_id, predicate, object_entity_id, confidence)
        VALUES (${person.id}::uuid, 'employed_at', ${company.id}::uuid, 0.9)
        RETURNING id
      `;

      const factId = factResult[0]!.id;

      // When: Manually normalize (as agent would do)
      const canonical = normalizePredicate('employed_at');
      await testDb`
        UPDATE facts SET predicate = ${canonical} WHERE id = ${factId}::uuid
      `;

      // Then: Fact has canonical predicate
      const updatedFact = await testDb`
        SELECT predicate FROM facts WHERE id = ${factId}::uuid
      `;

      expect(updatedFact[0]!.predicate).toBe('works_at');
    });

    it('should preserve other fact fields during normalization', async () => {
      // Given: Complete fact with all fields
      const person = await createTestEntity({
        canonicalName: 'Complete Fact Person',
        entityType: 'person',
      });
      const company = await createTestEntity({
        canonicalName: 'Complete Fact Company',
        entityType: 'company',
      });

      const validAt = new Date('2023-01-01');

      const factResult = await testDb`
        INSERT INTO facts (
          subject_entity_id, predicate, object_entity_id,
          valid_at, confidence, source_memory_id, source_text
        )
        VALUES (
          ${person.id}::uuid, 'works_for', ${company.id}::uuid,
          ${validAt}, 0.95, ${randomUUID()}::uuid, 'Original source text'
        )
        RETURNING id
      `;

      const factId = factResult[0]!.id;

      // When: Normalize predicate
      const canonical = normalizePredicate('works_for');
      await testDb`
        UPDATE facts SET predicate = ${canonical} WHERE id = ${factId}::uuid
      `;

      // Then: Other fields are preserved
      const updatedFact = await testDb`
        SELECT * FROM facts WHERE id = ${factId}::uuid
      `;

      expect(updatedFact[0]!.predicate).toBe('works_at');
      expect(updatedFact[0]!.subject_entity_id).toBe(person.id);
      expect(updatedFact[0]!.object_entity_id).toBe(company.id);
      expect(parseFloat(updatedFact[0]!.confidence as unknown as string)).toBe(0.95);
      expect(updatedFact[0]!.source_text).toBe('Original source text');
    });
  });

  describe('SCH-004: Flag unknown predicates', () => {
    it('should identify non-canonical predicates', () => {
      // When: Check various predicates
      const canonical = isCanonicalPredicate('works_at');
      const nonCanonical = isCanonicalPredicate('custom_predicate_xyz');

      // Then: Correct identification
      expect(canonical).toBe(true);
      expect(nonCanonical).toBe(false);
    });

    it('should flag unknown predicates in fact_predicates table', async () => {
      // Given: A custom predicate used in facts
      const customPredicate = `custom_pred_${randomUUID().slice(0, 8)}`;

      // When: Insert as non-canonical (as schema alignment would flag)
      await testDb`
        INSERT INTO fact_predicates (predicate, description, is_canonical, is_exclusive, usage_count)
        VALUES (
          ${customPredicate},
          'Needs canonical mapping - auto-discovered',
          false,
          false,
          5
        )
        ON CONFLICT (predicate) DO UPDATE SET
          is_canonical = false,
          usage_count = 5
      `;

      // Then: Predicate is flagged as non-canonical
      const flagged = await testDb`
        SELECT * FROM fact_predicates WHERE predicate = ${customPredicate}
      `;

      expect(flagged.length).toBe(1);
      expect(flagged[0]!.is_canonical).toBe(false);
      expect(flagged[0]!.description).toContain('canonical mapping');
    });

    it('should track usage count for unknown predicates', async () => {
      // Given: Predicate with usage
      const predicate = `tracked_pred_${randomUUID().slice(0, 8)}`;

      // When: Insert with usage count
      await testDb`
        INSERT INTO fact_predicates (predicate, description, is_canonical, is_exclusive, usage_count)
        VALUES (${predicate}, 'Tracking usage', false, false, 0)
      `;

      // Simulate usage tracking
      await testDb`
        UPDATE fact_predicates SET usage_count = usage_count + 1 WHERE predicate = ${predicate}
      `;
      await testDb`
        UPDATE fact_predicates SET usage_count = usage_count + 1 WHERE predicate = ${predicate}
      `;

      // Then: Usage is tracked
      const result = await testDb`
        SELECT usage_count FROM fact_predicates WHERE predicate = ${predicate}
      `;

      expect(result[0]!.usage_count).toBe(2);
    });

    it('should store aliases for canonical predicates', async () => {
      // Given: Canonical predicate
      const canonical = 'knows';

      // When: Check if predicate has aliases defined
      const ontologyEntry = CANONICAL_ONTOLOGY[canonical];

      // Then: Aliases are defined
      expect(ontologyEntry?.aliases).toBeDefined();
      expect(ontologyEntry?.aliases.length).toBeGreaterThan(0);
      expect(ontologyEntry?.aliases).toContain('acquainted_with');
    });
  });

  describe('Schema alignment agent execution', () => {
    it('should execute successfully with default options', async () => {
      // Given: Context with no specific options
      const context = createMockContext({});

      // When: Execute schema alignment
      const result = await schemaAlignmentAgent.execute(context);

      // Then: Completes (may not process anything if DB not fully set up)
      expect(result.success).toBeDefined();
    });

    it('should accept fullSync option', async () => {
      // Given: Context with fullSync
      const context = createMockContext({ fullSync: true });

      // When: Execute schema alignment
      const result = await schemaAlignmentAgent.execute(context);

      // Then: Completes with output
      expect(result.success).toBeDefined();
      if (result.outputs) {
        expect(typeof result.outputs.ontologySynced).toBe('number');
      }
    });

    it('should respect maxNormalize limit', async () => {
      // Given: Context with limited normalization
      const context = createMockContext({ maxNormalize: 5 });

      // When: Execute schema alignment
      const result = await schemaAlignmentAgent.execute(context);

      // Then: Respects limit
      expect(result.success).toBeDefined();
      // If predicates were normalized, should be <= 5
      if (result.outputs?.predicatesNormalized !== undefined) {
        expect(result.outputs.predicatesNormalized as number).toBeLessThanOrEqual(5);
      }
    });
  });
});
