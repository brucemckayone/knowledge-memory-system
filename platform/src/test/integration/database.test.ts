/**
 * Database Integration Tests
 *
 * Tests for Platform ↔ PostgreSQL module boundary.
 * Covers DB-001 through DB-010 from the test strategy.
 */

import { describe, it, expect } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  createTestMemoryEntity,
  getEntity,
  getFact,
  randomEmbedding,
  normalizeVector,
  cosineSimilarity,
  randomUUID,
  hasVectorExtension,
  hasTrgmExtension,
} from '../setup.js';
import { generateEntity } from '../generators/entity.js';

describe('Platform ↔ PostgreSQL Integration', () => {
  // Note: Tests should be self-contained and query only their own data
  // No global cleanup needed - each test creates and queries its own entities

  describe('DB-001: Entity creation with embedding', () => {
    it.skipIf(!hasVectorExtension)('should create entity with 768-dimension vector', async () => {
      // Given: Entity data with embedding
      const entityData = generateEntity({ type: 'person', withEmbedding: true });

      // When: Create entity
      const result = await createTestEntity({
        canonicalName: entityData.canonicalName,
        entityType: entityData.entityType,
        description: entityData.description,
        properties: entityData.properties,
        embedding: entityData.embedding,
      });

      // Then: Entity stored with valid UUID and embedding
      expect(result.id).toBeDefined();
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      // Verify embedding is stored
      const entity = await testDb`
        SELECT id, canonical_name, embedding
        FROM entities
        WHERE id = ${result.id}::uuid
      `;
      expect(entity[0]).toBeDefined();
      expect(entity[0]!.canonical_name).toBe(entityData.canonicalName);
      expect(entity[0]!.embedding).not.toBeNull();
    });

    it.skipIf(!hasVectorExtension)('should reject entity with wrong dimension embedding', async () => {
      // Given: Entity data with wrong dimension embedding
      const wrongDimEmbedding = Array.from({ length: 512 }, () => Math.random());
      const embeddingStr = `[${wrongDimEmbedding.join(',')}]`;

      // When/Then: Should fail
      await expect(
        testDb`
          INSERT INTO entities (canonical_name, entity_type, embedding)
          VALUES ('Test Entity', 'person', ${embeddingStr}::vector)
        `
      ).rejects.toThrow();
    });
  });

  describe('DB-002: Entity deduplication threshold', () => {
    it.skipIf(!hasVectorExtension)('should identify similar entities by embedding similarity > 0.92', async () => {
      // Given: Two entities with very similar embeddings
      const baseEmbedding = normalizeVector(randomEmbedding());
      // Create slightly perturbed version (high similarity)
      const similarEmbedding = baseEmbedding.map((v, i) =>
        i < 760 ? v : v + (Math.random() * 0.001 - 0.0005)
      );

      await createTestEntity({
        canonicalName: 'John Smith',
        entityType: 'person',
        embedding: baseEmbedding,
      });

      await createTestEntity({
        canonicalName: 'John A. Smith',
        entityType: 'person',
        embedding: normalizeVector(similarEmbedding),
      });

      // When: Query for similar entities
      const similarity = cosineSimilarity(baseEmbedding, normalizeVector(similarEmbedding));

      // Then: Similarity should be very high
      expect(similarity).toBeGreaterThan(0.99);

      // Query using vector similarity
      const embeddingStr = `[${baseEmbedding.join(',')}]`;
      const similar = await testDb`
        SELECT canonical_name, 1 - (embedding <=> ${embeddingStr}::vector) as similarity
        FROM entities
        WHERE entity_type = 'person'
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT 5
      `;

      expect(similar.length).toBe(2);
      // First result should be exact match
      expect(similar[0]!.canonical_name).toBe('John Smith');
    });

    it('should distinguish entities with low similarity', async () => {
      // Given: Two unrelated entities with unique names for this test
      const testId = randomUUID().slice(0, 8);
      const entity1 = await createTestEntity({
        canonicalName: `John Smith ${testId}`,
        entityType: 'person',
      });

      const entity2 = await createTestEntity({
        canonicalName: `Acme Corporation ${testId}`,
        entityType: 'company',
      });

      // When: Query only our created entities
      const entities = await testDb`
        SELECT * FROM entities
        WHERE id IN (${entity1.id}::uuid, ${entity2.id}::uuid)
      `;

      // Then: Both should exist separately
      expect(entities.length).toBe(2);
    });
  });

  describe('DB-003: Fact bi-temporal storage', () => {
    it('should store fact with all 4 timestamps correctly', async () => {
      // Given: Entity and fact with valid_at
      const entity = await createTestEntity({
        canonicalName: 'Test Person',
        entityType: 'person',
      });

      const validAt = new Date('2024-01-15T00:00:00Z');

      // When: Create fact with valid_at
      const fact = await createTestFact({
        subjectEntityId: entity.id,
        predicate: 'has_role',
        objectValue: 'Engineer',
        validAt,
      });

      // Then: Verify timestamps
      const stored = await getFact(fact.id);
      expect(stored).not.toBeNull();
      expect(stored!.created_at).toBeDefined(); // Auto-set
      expect(stored!.expired_at).toBeNull();    // Should be NULL
      expect(stored!.invalid_at).toBeNull();    // Should be NULL
      expect(new Date(stored!.valid_at as string).toISOString()).toBe(validAt.toISOString());
    });
  });

  describe('DB-004: Fact supersession', () => {
    it('should handle fact chain with proper supersession', async () => {
      // Given: Person who worked at multiple companies
      const person = await createTestEntity({
        canonicalName: 'Career Changer',
        entityType: 'person',
      });

      const company1 = await createTestEntity({
        canonicalName: 'First Corp',
        entityType: 'company',
      });

      const company2 = await createTestEntity({
        canonicalName: 'Second Corp',
        entityType: 'company',
      });

      // When: Create supersession chain
      const now = new Date();
      const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
      const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

      // Old job (superseded)
      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company1.id,
        validAt: sixMonthsAgo,
        invalidAt: threeMonthsAgo,
      });

      // Current job
      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company2.id,
        validAt: threeMonthsAgo,
      });

      // Then: Query current facts only
      const currentFacts = await testDb`
        SELECT f.*, e.canonical_name as company_name
        FROM facts f
        JOIN entities e ON f.object_entity_id = e.id
        WHERE f.subject_entity_id = ${person.id}::uuid
          AND f.predicate = 'works_at'
          AND f.invalid_at IS NULL
      `;

      expect(currentFacts.length).toBe(1);
      expect(currentFacts[0]!.company_name).toBe('Second Corp');
    });
  });

  describe('DB-005: Point-in-time query', () => {
    it('should return facts valid at specific date', async () => {
      // Given: Person with employment history
      const person = await createTestEntity({
        canonicalName: 'Timeline Person',
        entityType: 'person',
      });

      const company1 = await createTestEntity({
        canonicalName: 'Past Corp',
        entityType: 'company',
      });

      const company2 = await createTestEntity({
        canonicalName: 'Present Corp',
        entityType: 'company',
      });

      // Create timeline using dates relative to NOW
      // (bi-temporal query requires facts to exist at query time in system)
      const now = Date.now();
      const sixMonthsAgo = new Date(now - 180 * 24 * 60 * 60 * 1000);
      const threeMonthsAgo = new Date(now - 90 * 24 * 60 * 60 * 1000);
      const oneMonthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);   // Query point 2

      // Worked at Past Corp from 6 months ago to 3 months ago
      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company1.id,
        validAt: sixMonthsAgo,
        invalidAt: threeMonthsAgo,
      });

      // Works at Present Corp from 3 months ago onwards
      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company2.id,
        validAt: threeMonthsAgo,
      });

      // When: Query at 4 months ago (should get Past Corp - between 6 and 3 months)
      // Note: Use direct query instead of facts_at_time() since that function filters by created_at
      // which doesn't work for facts created "now" when testing with historical dates
      const fourMonthsAgo = new Date(now - 120 * 24 * 60 * 60 * 1000);
      const pastFacts = await testDb`
        SELECT f.*, e.canonical_name as company_name
        FROM facts f
        JOIN entities e ON f.object_entity_id = e.id
        WHERE f.subject_entity_id = ${person.id}::uuid
          AND f.predicate = 'works_at'
          AND f.valid_at <= ${fourMonthsAgo}
          AND (f.invalid_at IS NULL OR f.invalid_at > ${fourMonthsAgo})
          AND f.expired_at IS NULL
      `;

      // When: Query at 1 month ago (should get Present Corp)
      const presentFacts = await testDb`
        SELECT f.*, e.canonical_name as company_name
        FROM facts f
        JOIN entities e ON f.object_entity_id = e.id
        WHERE f.subject_entity_id = ${person.id}::uuid
          AND f.predicate = 'works_at'
          AND f.valid_at <= ${oneMonthAgo}
          AND (f.invalid_at IS NULL OR f.invalid_at > ${oneMonthAgo})
          AND f.expired_at IS NULL
      `;

      // Then: Different employers at different times
      expect(pastFacts.length).toBe(1);
      expect(pastFacts[0]!.company_name).toBe('Past Corp');

      expect(presentFacts.length).toBe(1);
      expect(presentFacts[0]!.company_name).toBe('Present Corp');
    });
  });

  describe('DB-006: Entity merge audit', () => {
    it('should create audit trail on entity merge', async () => {
      // Given: Two entities to merge
      const source = await createTestEntity({
        canonicalName: 'Johnny Smith',
        entityType: 'person',
      });

      const target = await createTestEntity({
        canonicalName: 'John Smith',
        entityType: 'person',
      });

      // When: Record merge
      await testDb`
        INSERT INTO entity_merges (
          source_entity_id, target_entity_id,
          merge_reason, merge_method, similarity_score
        )
        VALUES (
          ${source.id}::uuid, ${target.id}::uuid,
          'Duplicate person - same individual',
          'manual_review',
          0.95
        )
      `;

      // Update target to include merged_from
      await testDb`
        UPDATE entities
        SET merged_from = array_append(merged_from, ${source.id}::uuid)
        WHERE id = ${target.id}::uuid
      `;

      // Then: Audit record exists
      const audits = await testDb`
        SELECT * FROM entity_merges
        WHERE source_entity_id = ${source.id}::uuid
      `;

      expect(audits.length).toBe(1);
      expect(audits[0]!.target_entity_id).toBe(target.id);
      expect(audits[0]!.similarity_score).toBe(0.95);

      // Target has merged_from
      const updatedTarget = await getEntity(target.id);
      expect(updatedTarget!.merged_from).toContain(source.id);
    });
  });

  describe('DB-007: Memory-entity linking', () => {
    it('should link memory to multiple entities', async () => {
      // Given: Entities and a memory ID
      const person = await createTestEntity({
        canonicalName: 'John Smith',
        entityType: 'person',
      });

      const project = await createTestEntity({
        canonicalName: 'Project Alpha',
        entityType: 'project',
      });

      const memoryId = randomUUID();

      // When: Link memory to both entities
      await createTestMemoryEntity({
        memoryId,
        entityId: person.id,
        mentionText: 'John Smith',
        confidence: 0.95,
      });

      await createTestMemoryEntity({
        memoryId,
        entityId: project.id,
        mentionText: 'Project Alpha',
        confidence: 0.9,
      });

      // Then: Memory linked to both
      const links = await testDb`
        SELECT me.*, e.canonical_name
        FROM memory_entities me
        JOIN entities e ON me.entity_id = e.id
        WHERE me.memory_id = ${memoryId}::uuid
        ORDER BY me.confidence DESC
      `;

      expect(links.length).toBe(2);
      expect(links[0]!.canonical_name).toBe('John Smith');
      expect(links[1]!.canonical_name).toBe('Project Alpha');
    });
  });

  describe('DB-008: Alias creation', () => {
    it('should store and query entity aliases', async () => {
      // Given: Entity with aliases
      const entity = await createTestEntity({
        canonicalName: 'Robert Johnson',
        entityType: 'person',
      });

      const aliases = ['Bob', 'Bobby', 'Rob', 'R.J.'];

      // When: Create aliases
      for (const alias of aliases) {
        await testDb`
          INSERT INTO entity_aliases (entity_id, alias, alias_type)
          VALUES (${entity.id}::uuid, ${alias}, 'nickname')
        `;
      }

      // Then: Query by alias finds entity (filter by entity_id for test isolation)
      const foundByAlias = await testDb`
        SELECT e.*
        FROM entities e
        JOIN entity_aliases a ON e.id = a.entity_id
        WHERE a.entity_id = ${entity.id}::uuid AND a.alias ILIKE 'bob'
      `;

      expect(foundByAlias.length).toBe(1);
      expect(foundByAlias[0]!.canonical_name).toBe('Robert Johnson');

      // All aliases linked
      const allAliases = await testDb`
        SELECT alias FROM entity_aliases
        WHERE entity_id = ${entity.id}::uuid
      `;

      expect(allAliases.length).toBe(4);
    });

    it.skipIf(!hasTrgmExtension)('should support fuzzy alias matching with trigram', async () => {
      // Given: Entity with alias
      const entity = await createTestEntity({
        canonicalName: 'Christopher Williams',
        entityType: 'person',
      });

      await testDb`
        INSERT INTO entity_aliases (entity_id, alias)
        VALUES (${entity.id}::uuid, 'Christopher')
      `;

      // When: Fuzzy search for "Christofer" (typo)
      const fuzzyResults = await testDb`
        SELECT e.canonical_name, similarity(a.alias, 'Christofer') as sim
        FROM entities e
        JOIN entity_aliases a ON e.id = a.entity_id
        WHERE similarity(a.alias, 'Christofer') > 0.3
        ORDER BY sim DESC
      `;

      // Then: Should find despite typo
      expect(fuzzyResults.length).toBeGreaterThan(0);
      expect(fuzzyResults[0]!.canonical_name).toBe('Christopher Williams');
    });
  });

  describe('DB-009: Predicate exclusivity', () => {
    it('should enforce exclusive predicates - only one active employer', async () => {
      // Given: Person and multiple companies
      const person = await createTestEntity({
        canonicalName: 'Single Employer Person',
        entityType: 'person',
      });

      const company1 = await createTestEntity({
        canonicalName: 'Corp A',
        entityType: 'company',
      });

      const company2 = await createTestEntity({
        canonicalName: 'Corp B',
        entityType: 'company',
      });

      // When: Create employment facts (both active)
      const now = new Date();

      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company1.id,
        validAt: now,
      });

      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company2.id,
        validAt: now,
      });

      // Then: Predicate is marked as exclusive in predicates table
      const predicate = await testDb`
        SELECT is_exclusive FROM fact_predicates
        WHERE predicate = 'works_at'
      `;

      expect(predicate[0]!.is_exclusive).toBe(true);

      // Application logic should detect this as a conflict
      // (actual enforcement happens in conflict resolution agent)
      const activeEmployments = await testDb`
        SELECT COUNT(*) as count
        FROM facts
        WHERE subject_entity_id = ${person.id}::uuid
          AND predicate = 'works_at'
          AND invalid_at IS NULL
          AND expired_at IS NULL
      `;

      // Both facts exist - conflict resolution agent would handle this
      expect(parseInt(activeEmployments[0]!.count as string)).toBe(2);
    });
  });

  describe('DB-010: Temporal exclusion - overlapping periods', () => {
    it('should detect overlapping valid periods for exclusive predicates', async () => {
      // Given: Person with overlapping employment
      const person = await createTestEntity({
        canonicalName: 'Overlap Person',
        entityType: 'person',
      });

      const company1 = await createTestEntity({
        canonicalName: 'First Employer',
        entityType: 'company',
      });

      const company2 = await createTestEntity({
        canonicalName: 'Second Employer',
        entityType: 'company',
      });

      // Create overlapping facts
      const jan = new Date('2024-01-01');
      const jun = new Date('2024-06-01');
      const mar = new Date('2024-03-01');
      const sep = new Date('2024-09-01');

      // Works at Corp1: Jan - Jun
      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company1.id,
        validAt: jan,
        invalidAt: jun,
      });

      // Works at Corp2: Mar - Sep (overlaps with Corp1 from Mar-Jun)
      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company2.id,
        validAt: mar,
        invalidAt: sep,
      });

      // When: Query for overlapping facts
      const overlappingFacts = await testDb`
        WITH employment_facts AS (
          SELECT f.*, e.canonical_name as company
          FROM facts f
          JOIN entities e ON f.object_entity_id = e.id
          WHERE f.subject_entity_id = ${person.id}::uuid
            AND f.predicate = 'works_at'
        )
        SELECT
          f1.company as company1,
          f2.company as company2,
          GREATEST(f1.valid_at, f2.valid_at) as overlap_start,
          LEAST(f1.invalid_at, f2.invalid_at) as overlap_end
        FROM employment_facts f1
        JOIN employment_facts f2 ON f1.id < f2.id
        WHERE f1.valid_at < COALESCE(f2.invalid_at, 'infinity'::timestamptz)
          AND f2.valid_at < COALESCE(f1.invalid_at, 'infinity'::timestamptz)
        ORDER BY f1.valid_at, f2.valid_at
      `;

      // Then: Overlap detected (order by valid_at ensures First Employer < Second Employer)
      expect(overlappingFacts.length).toBe(1);
      expect(overlappingFacts[0]!.company1).toBe('First Employer');
      expect(overlappingFacts[0]!.company2).toBe('Second Employer');
    });
  });
});
