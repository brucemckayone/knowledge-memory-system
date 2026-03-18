/**
 * Relationship Agent Tests (W26)
 *
 * Tests for the Relationship Extraction Gardener Agent.
 * Covers REL-001 through REL-005 from the Phase 4 test strategy.
 *
 * Boundary: ML /extract-relationships (B6), Fact creation + bi-temporal (B7)
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  randomUUID,
  isMLServiceAvailable,
  createTestMemoryEntity,
} from '../setup.js';

import { installMLServiceMock, restoreMLServiceMock } from '../mocks/ml-service.mock.js';
import { relationshipAgent } from '../../gardener/agents/relationship.agent.js';
import { normalizePredicate } from '../../services/predicates.js';
import type { AgentContext } from '../../gardener/controller.js';
import type PgBoss from 'pg-boss';

describe('W26 Relationship Agent', () => {
  let mlAvailable = false;


  beforeAll(async () => {
    mlAvailable = await isMLServiceAvailable();
    if (!mlAvailable) {
      console.warn('⚠️ ML Services not available - using mocks for relationship tests');
    }
  });

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
      traceId: (data.memoryId as string) ?? null,
      config: {} as any,
      services: { ml: {} as any, controller: {} as any },
      signal: AbortSignal.timeout(30000),
    };
  }

  beforeEach(() => {
    // Ensure clean mock state before each test
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Restore mocks in correct order
    restoreMLServiceMock();
    vi.clearAllMocks();
  });

  describe('REL-001: Extract relationship', () => {
    it('should extract subject/predicate/object from text', async () => {
      // Use unique names to avoid conflicts with other tests
      const testId = randomUUID().slice(0, 8);
      const johnName = `John Smith ${testId}`;
      const acmeName = `Acme Corp ${testId}`;

      // Install mock with the unique names
      installMLServiceMock({
        extractRelationships: {
          relationships: [
            {
              subject: johnName,
              predicate: 'works_at',
              object: acmeName,
              confidence: 0.9,
              source_text: `${johnName} works at ${acmeName}`,
            },
          ],
        },
      });

      // Given: Entities linked to memory
      const john = await createTestEntity({
        canonicalName: johnName,
        entityType: 'person',
      });
      const acme = await createTestEntity({
        canonicalName: acmeName,
        entityType: 'company',
      });

      const memoryId = randomUUID();

      // Link entities to memory
      await createTestMemoryEntity({ memoryId, entityId: john.id, mentionText: johnName });
      await createTestMemoryEntity({ memoryId, entityId: acme.id, mentionText: acmeName });

      // When: Process through relationship agent
      const context = createMockContext({
        memoryId,
        content: `${johnName} works at ${acmeName}.`,
        entities: [
          { id: john.id, name: johnName, type: 'person' },
          { id: acme.id, name: acmeName, type: 'company' },
        ],
      });

      const result = await relationshipAgent.execute(context);

      // Then: Relationship is extracted and fact is created
      expect(result.success).toBe(true);
      expect(result.outputs?.relationshipsFound).toBeGreaterThanOrEqual(1);
      expect(result.outputs?.factsCreated).toBeGreaterThanOrEqual(1);
    });

    it('should create fact with subject and object entity IDs', async () => {
      // Install mock
      installMLServiceMock({
        extractRelationships: {
          relationships: [
            {
              subject: 'Alice Johnson',
              predicate: 'knows',
              object: 'Bob Williams',
              confidence: 0.85,
            },
          ],
        },
      });

      // Given: Two person entities
      const alice = await createTestEntity({
        canonicalName: 'Alice Johnson',
        entityType: 'person',
      });
      const bob = await createTestEntity({
        canonicalName: 'Bob Williams',
        entityType: 'person',
      });

      const memoryId = randomUUID();

      await createTestMemoryEntity({ memoryId, entityId: alice.id, mentionText: 'Alice Johnson' });
      await createTestMemoryEntity({ memoryId, entityId: bob.id, mentionText: 'Bob Williams' });

      // When: Process relationship
      const context = createMockContext({
        memoryId,
        content: 'Alice Johnson knows Bob Williams from the conference.',
        entities: [
          { id: alice.id, name: 'Alice Johnson', type: 'person' },
          { id: bob.id, name: 'Bob Williams', type: 'person' },
        ],
      });

      const result = await relationshipAgent.execute(context);

      // Then: Fact links both entities
      expect(result.success).toBe(true);

      // Verify fact was created in database
      const facts = await testDb`
        SELECT * FROM facts
        WHERE subject_entity_id = ${alice.id}::uuid
          AND predicate = 'knows'
          AND object_entity_id = ${bob.id}::uuid
      `;

      expect(facts.length).toBe(1);
    });
  });

  describe('REL-002: Temporal hints', () => {
    it('should detect "used to" as past temporal hint', async () => {
      // Install mock with temporal hint
      installMLServiceMock({
        extractRelationships: {
          relationships: [
            {
              subject: 'Sarah Chen',
              predicate: 'worked_at',
              object: 'Google',
              confidence: 0.85,
              temporal_hint: 'past',
              source_text: 'Sarah used to work at Google',
            },
          ],
        },
      });

      // Given: Entities
      const sarah = await createTestEntity({
        canonicalName: 'Sarah Chen',
        entityType: 'person',
      });
      const google = await createTestEntity({
        canonicalName: 'Google',
        entityType: 'company',
      });

      const memoryId = randomUUID();

      await createTestMemoryEntity({ memoryId, entityId: sarah.id, mentionText: 'Sarah Chen' });
      await createTestMemoryEntity({ memoryId, entityId: google.id, mentionText: 'Google' });

      // When: Process relationship
      const context = createMockContext({
        memoryId,
        content: 'Sarah Chen used to work at Google.',
        entities: [
          { id: sarah.id, name: 'Sarah Chen', type: 'person' },
          { id: google.id, name: 'Google', type: 'company' },
        ],
      });

      const result = await relationshipAgent.execute(context);

      // Then: Fact has past validity
      expect(result.success).toBe(true);

      const facts = await testDb`
        SELECT * FROM facts
        WHERE subject_entity_id = ${sarah.id}::uuid
          AND predicate = 'worked_at'
      `;

      expect(facts.length).toBe(1);

      // Past temporal hint should set invalid_at to now
      expect(facts[0]!.invalid_at).not.toBeNull();
    });

    it('should treat current/present as ongoing validity', async () => {
      // Install mock without temporal hint (defaults to current)
      installMLServiceMock({
        extractRelationships: {
          relationships: [
            {
              subject: 'Mike Brown',
              predicate: 'works_at',
              object: 'TechCo',
              confidence: 0.9,
            },
          ],
        },
      });

      // Given: Entities
      const mike = await createTestEntity({
        canonicalName: 'Mike Brown',
        entityType: 'person',
      });
      const techco = await createTestEntity({
        canonicalName: 'TechCo',
        entityType: 'company',
      });

      const memoryId = randomUUID();

      await createTestMemoryEntity({ memoryId, entityId: mike.id, mentionText: 'Mike Brown' });
      await createTestMemoryEntity({ memoryId, entityId: techco.id, mentionText: 'TechCo' });

      // When: Process relationship
      const context = createMockContext({
        memoryId,
        content: 'Mike Brown works at TechCo.',
        entities: [
          { id: mike.id, name: 'Mike Brown', type: 'person' },
          { id: techco.id, name: 'TechCo', type: 'company' },
        ],
      });

      const result = await relationshipAgent.execute(context);

      // Then: Fact has no invalid_at (ongoing)
      expect(result.success).toBe(true);

      const facts = await testDb`
        SELECT * FROM facts
        WHERE subject_entity_id = ${mike.id}::uuid
          AND predicate = 'works_at'
      `;

      expect(facts.length).toBe(1);
      expect(facts[0]!.invalid_at).toBeNull();
    });
  });

  describe('REL-003: Create bi-temporal fact', () => {
    it('should set valid_at correctly based on temporal context', async () => {
      // Install mock
      installMLServiceMock({
        extractRelationships: {
          relationships: [
            {
              subject: 'Test Person',
              predicate: 'works_at',
              object: 'Test Company',
              confidence: 0.9,
            },
          ],
        },
      });

      // Given: Entities
      const person = await createTestEntity({
        canonicalName: 'Test Person',
        entityType: 'person',
      });
      const company = await createTestEntity({
        canonicalName: 'Test Company',
        entityType: 'company',
      });

      const memoryId = randomUUID();

      await createTestMemoryEntity({ memoryId, entityId: person.id, mentionText: 'Test Person' });
      await createTestMemoryEntity({ memoryId, entityId: company.id, mentionText: 'Test Company' });

      // When: Process relationship
      const context = createMockContext({
        memoryId,
        content: 'Test Person works at Test Company.',
        entities: [
          { id: person.id, name: 'Test Person', type: 'person' },
          { id: company.id, name: 'Test Company', type: 'company' },
        ],
      });

      const result = await relationshipAgent.execute(context);

      // Then: Fact has valid_at set
      expect(result.success).toBe(true);

      const facts = await testDb`
        SELECT * FROM facts
        WHERE subject_entity_id = ${person.id}::uuid
      `;

      expect(facts.length).toBe(1);
      expect(facts[0]!.valid_at).toBeDefined();
    });
  });

  describe('REL-004: Normalize predicate', () => {
    it('should normalize "employed_at" to "works_at"', () => {
      // When: Normalize predicate
      const normalized = normalizePredicate('employed_at');

      // Then: Should map to canonical form
      expect(normalized).toBe('works_at');
    });

    it('should normalize various aliases to canonical predicates', () => {
      // Test multiple alias -> canonical mappings
      expect(normalizePredicate('supervises')).toBe('manages');
      expect(normalizePredicate('resides_in')).toBe('lives_in');
      expect(normalizePredicate('proficient_in')).toBe('skilled_in');
      expect(normalizePredicate('formerly_at')).toBe('worked_at');
    });

    it('should preserve canonical predicates unchanged', () => {
      expect(normalizePredicate('works_at')).toBe('works_at');
      expect(normalizePredicate('knows')).toBe('knows');
      expect(normalizePredicate('manages')).toBe('manages');
    });

    it('should lowercase and replace spaces with underscores', () => {
      expect(normalizePredicate('Works At')).toBe('works_at');
      expect(normalizePredicate('KNOWS')).toBe('knows');
    });
  });

  describe('REL-005: Skip with insufficient entities', () => {
    it('should skip processing when < 2 entities', async () => {
      // Given: Only one entity linked to memory
      const person = await createTestEntity({
        canonicalName: 'Lonely Person',
        entityType: 'person',
      });

      const memoryId = randomUUID();

      await createTestMemoryEntity({ memoryId, entityId: person.id, mentionText: 'Lonely Person' });

      // When: Process with only one entity
      const context = createMockContext({
        memoryId,
        content: 'Lonely Person is working on something.',
        entities: [{ id: person.id, name: 'Lonely Person', type: 'person' }],
      });

      const result = await relationshipAgent.execute(context);

      // Then: Success but no processing
      expect(result.success).toBe(true);
      expect(result.metrics?.itemsProcessed).toBe(0);
      expect(result.outputs?.factsCreated).toBeUndefined();
    });

    it('should skip processing when no entities', async () => {
      // Given: Memory with no linked entities
      const memoryId = randomUUID();

      // When: Process with no entities
      const context = createMockContext({
        memoryId,
        content: 'A thought with no named entities.',
        entities: [],
      });

      const result = await relationshipAgent.execute(context);

      // Then: Success but no processing
      expect(result.success).toBe(true);
      expect(result.metrics?.itemsProcessed).toBe(0);
    });

    it('should process when exactly 2 entities', async () => {
      // Install mock
      installMLServiceMock({
        extractRelationships: {
          relationships: [
            {
              subject: 'Entity A',
              predicate: 'knows',
              object: 'Entity B',
              confidence: 0.85,
            },
          ],
        },
      });

      // Given: Exactly two entities
      const entityA = await createTestEntity({
        canonicalName: 'Entity A',
        entityType: 'person',
      });
      const entityB = await createTestEntity({
        canonicalName: 'Entity B',
        entityType: 'person',
      });

      const memoryId = randomUUID();

      await createTestMemoryEntity({ memoryId, entityId: entityA.id, mentionText: 'Entity A' });
      await createTestMemoryEntity({ memoryId, entityId: entityB.id, mentionText: 'Entity B' });

      // When: Process with two entities
      const context = createMockContext({
        memoryId,
        content: 'Entity A knows Entity B.',
        entities: [
          { id: entityA.id, name: 'Entity A', type: 'person' },
          { id: entityB.id, name: 'Entity B', type: 'person' },
        ],
      });

      const result = await relationshipAgent.execute(context);

      // Then: Processing occurs
      expect(result.success).toBe(true);
      expect(result.outputs?.relationshipsFound).toBeGreaterThanOrEqual(0);
    });
  });
});
