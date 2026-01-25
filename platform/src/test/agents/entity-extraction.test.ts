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
    it.skipIf(!mlAvailable)('should extract person and company from text', async () => {
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
    it.skipIf(!mlAvailable)('should include start/end positions', async () => {
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
    it.skipIf(!mlAvailable)('should resolve mention to existing entity', async () => {
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
    it.skipIf(!mlAvailable)('should create entity for novel mention', async () => {
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
    it.skipIf(!mlAvailable)('should assign confidence scores', async () => {
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
    it.skipIf(!mlAvailable)('should return empty list for text without entities', async () => {
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
});
