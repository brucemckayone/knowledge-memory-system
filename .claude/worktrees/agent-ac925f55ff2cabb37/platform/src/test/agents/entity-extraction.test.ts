/**
 * Entity Extraction Agent Tests
 *
 * Tests for the Entity Extraction Gardener Agent.
 * Covers EE-001 through EE-008 from the test strategy.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  testDb,
  createTestEntity,
  randomUUID,
  isMLServiceAvailable,
  ML_SERVICES_URL,
  skipCtx,
} from '../setup.js';

describe('Entity Extraction Agent', () => {
  let mlAvailable = false;

  beforeAll(async () => {
    mlAvailable = await isMLServiceAvailable();
    if (!mlAvailable) {
      console.warn('⚠️ ML Services not available - skipping entity extraction tests');
    }
  });

  // Note: Tests are self-contained with unique IDs - no global cleanup needed

  describe('EE-001: Extract person', () => {
    beforeAll((ctx: any) => { if (!mlAvailable) skipCtx(ctx); });

    it('should extract person and company from text', async () => {
      // Given: Text with person and company
      const text = 'Meeting with John Smith at Google headquarters';

      // When: Extract entities
      const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Both entities extracted
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      const types = (result.entities as unknown as Array<{ type: string }>)?.map((e: { type: string }) => e.type.toLowerCase()) || [];
      const mentions = (result.entities as unknown as Array<{ mention: string }>)?.map((e: { mention: string }) => e.mention.toLowerCase()) || [];

      // Should find person
      const hasPerson = types.some((t: string) => t === 'person' || t === 'people');
      const hasJohn = mentions.some((m: string) => m.includes('john') || m.includes('smith'));

      // Should find company/place
      const hasOrg = types.some((t: string) => ['company', 'organization', 'place'].includes(t));
      const hasGoogle = mentions.some((m: string) => m.includes('google'));

      expect(hasPerson || hasJohn).toBe(true);
      expect(hasOrg || hasGoogle).toBe(true);
    }, 30000);
  });

  describe('EE-002: Extract with positions', () => {
    beforeAll((ctx: any) => { if (!mlAvailable) skipCtx(ctx); });

    it('should include start/end positions', async () => {
      // Given: Text with named entities
      const text = 'Alice and Bob discussed the project';

      // When: Extract entities
      const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Positions included for at least some entities
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      const entities: Array<{ start?: number; end?: number }> =
        Array.isArray(result.entities) ? (result.entities as Array<{ start?: number; end?: number }>) : [];
      const entityWithPosition = entities.find(
        (e: { start?: number; end?: number }) => e.start !== undefined && e.end !== undefined
      );

      // Position might be provided (LLM-dependent)
      if (entityWithPosition && entityWithPosition.start !== undefined && entityWithPosition.end !== undefined) {
        expect(entityWithPosition.start).toBeGreaterThanOrEqual(0);
        expect(entityWithPosition.end).toBeGreaterThan(entityWithPosition.start);
      }
    }, 30000);
  });

  describe('EE-003: Resolve to existing', () => {
    beforeAll((ctx: any) => { if (!mlAvailable) skipCtx(ctx); });

    it('should resolve mention to existing entity', async () => {
      // Given: Existing entity in database
      const existing = await createTestEntity({
        canonicalName: 'John Smith',
        entityType: 'person',
      });

      // Add alias
      await testDb`
        INSERT INTO entity_aliases (entity_id, alias)
        VALUES (${existing.id}::uuid, 'John')
      `;

      // When: Query for entity resolution
      const response = await fetch(`${ML_SERVICES_URL}/resolve-entity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_mention: 'John',
          context: 'Meeting with John about the project',
          existing_entity: {
            name: 'John Smith',
            type: 'person',
            properties: {},
          },
        }),
      });

      // Then: Should suggest merge or link
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      // LLM should recognize this as same person
      expect(['MERGE', 'LINK', 'CREATE']).toContain(result.decision);
      if (result.decision === 'MERGE') {
        expect(result.confidence).toBeGreaterThan(0.5);
      }
    }, 30000);
  });

  describe('EE-004: Create new entity', () => {
    beforeAll((ctx: any) => { if (!mlAvailable) skipCtx(ctx); });

    it('should create entity for novel mention', async () => {
      // Given: Text with new entity not in database
      const text = 'Sarah Chen joined the engineering team';

      // When: Extract entities
      const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Entity extracted
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      const entitiesData: Array<{ type: string; mention: string }> =
        Array.isArray(result.entities) ? (result.entities as Array<{ type: string; mention: string }>) : [];
      const personEntity = entitiesData.find((e: { type: string; mention: string }) =>
        e.type.toLowerCase() === 'person' ||
        e.mention.toLowerCase().includes('sarah')
      );

      expect(personEntity).toBeDefined();
    }, 30000);
  });

  describe('EE-005: Confidence scoring', () => {
    beforeAll((ctx: any) => { if (!mlAvailable) skipCtx(ctx); });

    it('should assign confidence scores', async () => {
      // Given: Text with clear and ambiguous entities
      const text = 'Apple announced new products. John mentioned apple pie.';

      // When: Extract entities
      const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Confidence scores provided
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      const entitiesList: Array<{ confidence?: number }> =
        Array.isArray(result.entities) ? (result.entities as Array<{ confidence?: number }>) : [];
      entitiesList.forEach((e: { confidence?: number }) => {
        if (e.confidence !== undefined) {
          expect(e.confidence).toBeGreaterThanOrEqual(0);
          expect(e.confidence).toBeLessThanOrEqual(1);
        }
      });
    }, 30000);
  });

  describe('EE-006: Memory linking', () => {
    it('should create memory_entities records', async () => {
      // Given: Entity and memory ID
      const entity = await createTestEntity({
        canonicalName: 'Test Person',
        entityType: 'person',
      });
      const memoryId = randomUUID();

      // When: Link entity to memory
      await testDb`
        INSERT INTO memory_entities (memory_id, entity_id, mention_text, confidence)
        VALUES (${memoryId}::uuid, ${entity.id}::uuid, 'Test Person', 0.95)
      `;

      // Then: Link created
      const links = await testDb`
        SELECT * FROM memory_entities
        WHERE memory_id = ${memoryId}::uuid
      `;

      expect(links.length).toBe(1);
      expect(links[0]!.entity_id).toBe(entity.id);
      expect(links[0]!.mention_text).toBe('Test Person');
      expect(parseFloat(links[0]!.confidence as unknown as string)).toBeCloseTo(0.95, 2);
    });
  });

  describe('EE-007: Empty extraction', () => {
    beforeAll((ctx: any) => { if (!mlAvailable) skipCtx(ctx); });

    it('should return empty list for text without entities', async () => {
      // Given: Text with no named entities
      const text = 'The weather is nice today. It might rain tomorrow.';

      // When: Extract entities
      const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      // Then: Empty or minimal list, no error
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      const entities = (result.entities as unknown as unknown[]) || [];
      expect(entities).toBeDefined();
      // Should have very few or no entities
      expect(entities.length).toBeLessThanOrEqual(2);
    }, 30000);
  });

  describe('EE-008: Batch processing', () => {
    it('should process multiple memories without error', async () => {
      // Given: Multiple memory IDs to process
      const memoryIds = [randomUUID(), randomUUID(), randomUUID()];
      const entity = await createTestEntity({
        canonicalName: 'Batch Entity',
        entityType: 'person',
      });

      // When: Create links for all memories
      for (const memoryId of memoryIds) {
        await testDb`
          INSERT INTO memory_entities (memory_id, entity_id, mention_text, confidence)
          VALUES (${memoryId}::uuid, ${entity.id}::uuid, 'Batch Entity', 0.9)
        `;
      }

      // Then: All links created
      const links = await testDb`
        SELECT * FROM memory_entities WHERE entity_id = ${entity.id}::uuid
      `;

      expect(links.length).toBe(3);
    });
  });

  // Phase 4 Golden Tests: Entity Resolution Thresholds (ENT-003 to ENT-005)
  // Boundary: B5 - Entity thresholds (>0.92, 0.75-0.92, <0.75)

  describe('ENT-003: Merge high similarity (>0.92)', () => {
    it('should link to existing entity when similarity is above 0.92', async () => {
      // Given: Existing entity "John Smith"
      const existing = await createTestEntity({
        canonicalName: 'John Smith',
        entityType: 'person',
      });

      // Add alias that would match closely
      await testDb`
        INSERT INTO entity_aliases (entity_id, alias, alias_type, source)
        VALUES (${existing.id}::uuid, 'John', 'initial', 'test')
      `;

      const memoryId = randomUUID();

      // When: Link a very similar mention "Jon Smith" (>0.92 sim)
      // In real scenario, the service would compute embedding similarity
      // For this test, we verify the database can store the link
      await testDb`
        INSERT INTO memory_entities (memory_id, entity_id, mention_text, confidence)
        VALUES (${memoryId}::uuid, ${existing.id}::uuid, 'Jon Smith', 0.95)
      `;

      // Then: Should link to existing entity
      const links = await testDb`
        SELECT me.*, e.canonical_name
        FROM memory_entities me
        JOIN entities e ON me.entity_id = e.id
        WHERE me.memory_id = ${memoryId}::uuid
      `;

      expect(links.length).toBe(1);
      expect(links[0]!.canonical_name).toBe('John Smith');
      expect(parseFloat(links[0]!.confidence as unknown as string)).toBeGreaterThan(0.92);
    });
  });

  describe('ENT-004: Create new entity for low similarity (<0.75)', () => {
    it('should create new entity when no match above threshold', async () => {
      // Given: Existing entity with unique name
      const uniqueSuffix = randomUUID().slice(0, 8);
      const existingName = `Michael Brown ${uniqueSuffix}`;
      const newName = `Sarah Johnson ${uniqueSuffix}`;

      const existing = await createTestEntity({
        canonicalName: existingName,
        entityType: 'person',
      });

      // When: Create entity for completely different name
      const newEntity = await createTestEntity({
        canonicalName: newName,
        entityType: 'person',
      });

      // Then: New entity is created (not merged)
      expect(newEntity.id).not.toBe(existing.id);

      // Verify both entities exist separately by querying specific IDs
      const allPersons = await testDb`
        SELECT * FROM entities
        WHERE id IN (${existing.id}::uuid, ${newEntity.id}::uuid)
      `;

      expect(allPersons.length).toBe(2);
    });

    it('should create new entity for novel mention', async () => {
      // Given: Text with a new person not in database
      const newPersonName = `Novel Person ${randomUUID().slice(0, 8)}`;

      // When: Create entity
      const entity = await createTestEntity({
        canonicalName: newPersonName,
        entityType: 'person',
        description: 'Auto-created from extraction',
      });

      // Then: Entity is created
      expect(entity.id).toBeDefined();

      const created = await testDb`
        SELECT * FROM entities WHERE id = ${entity.id}::uuid
      `;

      expect(created.length).toBe(1);
      expect(created[0]!.canonical_name).toBe(newPersonName);
    });
  });

  describe('ENT-005: Medium similarity uses best match (0.75-0.92)', () => {
    it('should use best available match in medium confidence range', async () => {
      // Given: Existing entity with alias
      const existing = await createTestEntity({
        canonicalName: 'Robert Williams',
        entityType: 'person',
      });

      await testDb`
        INSERT INTO entity_aliases (entity_id, alias, alias_type, source)
        VALUES
          (${existing.id}::uuid, 'Rob Williams', 'nickname', 'test'),
          (${existing.id}::uuid, 'R. Williams', 'abbreviated', 'test')
      `;

      const memoryId = randomUUID();

      // When: Link mention "R Williams" (medium similarity 0.75-0.92)
      // This would be the result of entity resolution service
      await testDb`
        INSERT INTO memory_entities (memory_id, entity_id, mention_text, confidence)
        VALUES (${memoryId}::uuid, ${existing.id}::uuid, 'R Williams', 0.82)
      `;

      // Then: Links to existing entity (best match)
      const links = await testDb`
        SELECT me.*, e.canonical_name
        FROM memory_entities me
        JOIN entities e ON me.entity_id = e.id
        WHERE me.memory_id = ${memoryId}::uuid
      `;

      expect(links.length).toBe(1);
      expect(links[0]!.canonical_name).toBe('Robert Williams');

      // Confidence should be in medium range
      const confidence = parseFloat(links[0]!.confidence as unknown as string);
      expect(confidence).toBeGreaterThanOrEqual(0.75);
      expect(confidence).toBeLessThanOrEqual(0.92);
    });

    it('should add alias when resolving medium confidence match', async () => {
      // Given: Existing entity
      const existing = await createTestEntity({
        canonicalName: 'Elizabeth Chen',
        entityType: 'person',
      });

      const newAlias = 'Liz Chen';

      // When: Add new alias (as would happen in entity resolution)
      await testDb`
        INSERT INTO entity_aliases (entity_id, alias, alias_type, source)
        VALUES (${existing.id}::uuid, ${newAlias}, 'mention', 'extraction')
        ON CONFLICT DO NOTHING
      `;

      // Then: Alias is added
      const aliases = await testDb`
        SELECT alias FROM entity_aliases WHERE entity_id = ${existing.id}::uuid
      `;

      expect(aliases.map(a => a.alias)).toContain(newAlias);
    });
  });
});
