/**
 * Unit Tests: Entity Profile Service
 *
 * Tests for profile assembly and formatting.
 * Uses mocked dependencies to avoid requiring DB/Qdrant.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Entity, Fact } from '../../db/schema.js';

// Mock dependencies before importing the module under test
vi.mock('../../db/index.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([])),
          })),
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
    execute: vi.fn(() => Promise.resolve({ rows: [] })),
  },
}));

vi.mock('../../services/qdrant.js', () => ({
  qdrant: {
    retrieve: vi.fn(() => Promise.resolve([])),
  },
  COLLECTIONS: { MEMORIES: 'memories', CONTEXTS: 'contexts' },
}));

vi.mock('../../services/entities.js', () => ({
  getEntityById: vi.fn(),
  findEntitiesByName: vi.fn(),
}));

vi.mock('../../services/facts.js', () => ({
  getEntityFacts: vi.fn(),
}));

vi.mock('../../services/graph.js', () => ({
  findConnectedEntities: vi.fn(),
}));

vi.mock('../../services/ml-client.js', () => ({
  ml: { embed: vi.fn(() => Promise.resolve({ vector: [] })) },
}));

import { getEntityProfile, formatEntityProfile, searchEntities, getEntityMemories, type EntityProfile } from '../../services/entity-profile.js';
import { getEntityById, findEntitiesByName } from '../../services/entities.js';
import { getEntityFacts } from '../../services/facts.js';
import { findConnectedEntities } from '../../services/graph.js';

const mockGetEntityById = vi.mocked(getEntityById);
const mockGetEntityFacts = vi.mocked(getEntityFacts);
const mockFindConnected = vi.mocked(findConnectedEntities);
const mockFindByName = vi.mocked(findEntitiesByName);

function makeEntity(overrides: Partial<Entity> = {}): Entity & { aliases: string[] } {
  return {
    id: 'ent-001',
    canonicalName: 'Bruce McKay',
    entityType: 'person',
    description: null,
    properties: {},
    mergedFrom: [],
    confidence: 1.0,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    aliases: ['Bruce', 'BM'],
    ...overrides,
  };
}

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: 'fact-001',
    subjectEntityId: 'ent-001',
    predicate: 'works_at',
    objectEntityId: 'ent-002',
    objectValue: null,
    validAt: null,
    invalidAt: null,
    createdAt: new Date(),
    expiredAt: null,
    sourceMemoryId: null,
    sourceText: null,
    extractionMethod: 'llm',
    confidence: 1.0,
    ...overrides,
  };
}

describe('Entity Profile Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getEntityProfile', () => {
    it('should return null when entity does not exist', async () => {
      mockGetEntityById.mockResolvedValue(null);

      const result = await getEntityProfile('nonexistent-id');
      expect(result).toBeNull();
    });

    it('should assemble profile from all data sources', async () => {
      const entity = makeEntity();
      const facts = [makeFact()];
      const connected = [{ entityId: 'ent-002', name: 'Acme Corp', type: 'company' }];

      mockGetEntityById.mockResolvedValue(entity);
      mockGetEntityFacts.mockResolvedValue(facts);
      mockFindConnected.mockResolvedValue(connected);

      const result = await getEntityProfile('ent-001');

      expect(result).not.toBeNull();
      expect(result!.entity.canonicalName).toBe('Bruce McKay');
      expect(result!.facts).toHaveLength(1);
      expect(result!.relatedEntities).toHaveLength(1);
      expect(result!.relatedEntities[0]!.name).toBe('Acme Corp');
    });

    it('should call all data sources in parallel', async () => {
      mockGetEntityById.mockResolvedValue(makeEntity());
      mockGetEntityFacts.mockResolvedValue([]);
      mockFindConnected.mockResolvedValue([]);

      await getEntityProfile('ent-001');

      expect(mockGetEntityById).toHaveBeenCalledWith('ent-001');
      expect(mockGetEntityFacts).toHaveBeenCalledWith('ent-001');
      expect(mockFindConnected).toHaveBeenCalledWith('ent-001');
    });
  });

  describe('searchEntities', () => {
    it('should delegate to findEntitiesByName', async () => {
      const entities = [makeEntity()];
      mockFindByName.mockResolvedValue(entities);

      const result = await searchEntities('Bruce');

      expect(mockFindByName).toHaveBeenCalledWith('Bruce', undefined);
      expect(result).toHaveLength(1);
    });

    it('should pass options through', async () => {
      mockFindByName.mockResolvedValue([]);

      await searchEntities('test', { limit: 5, type: 'person' });

      expect(mockFindByName).toHaveBeenCalledWith('test', { limit: 5, type: 'person' });
    });
  });

  describe('getEntityMemories', () => {
    it('should return empty array when no memory links exist', async () => {
      // db.select mock already returns []
      const result = await getEntityMemories('ent-001');
      expect(result).toEqual([]);
    });
  });

  describe('formatEntityProfile', () => {
    it('should include entity name, type, and aliases', () => {
      const profile: EntityProfile = {
        entity: makeEntity(),
        facts: [],
        relatedEntities: [],
        recentMemories: [],
      };

      const text = formatEntityProfile(profile);

      expect(text).toContain('Bruce McKay');
      expect(text).toContain('person');
      expect(text).toContain('Bruce, BM');
    });

    it('should include facts grouped by category', () => {
      const profile: EntityProfile = {
        entity: makeEntity(),
        facts: [
          makeFact({ predicate: 'works_at', objectValue: 'Acme Corp' }),
          makeFact({ id: 'fact-002', predicate: 'has_role', objectValue: 'Engineer' }),
        ],
        relatedEntities: [],
        recentMemories: [],
      };

      const text = formatEntityProfile(profile);

      expect(text).toContain('Relationships');
      expect(text).toContain('works_at: Acme Corp');
      expect(text).toContain('Attributes');
      expect(text).toContain('has_role: Engineer');
    });

    it('should include related entities', () => {
      const profile: EntityProfile = {
        entity: makeEntity(),
        facts: [],
        relatedEntities: [
          { entityId: 'ent-002', name: 'Acme Corp', type: 'company' },
          { entityId: 'ent-003', name: 'Project X', type: 'project' },
        ],
        recentMemories: [],
      };

      const text = formatEntityProfile(profile);

      expect(text).toContain('Connected');
      expect(text).toContain('Acme Corp');
      expect(text).toContain('Project X');
    });

    it('should include recent memories', () => {
      const profile: EntityProfile = {
        entity: makeEntity(),
        facts: [],
        relatedEntities: [],
        recentMemories: [
          { memoryId: 'm1', content: 'Discussed the new architecture with Bruce', type: 'thought', createdAt: '2026-03-10T12:00:00Z' },
        ],
      };

      const text = formatEntityProfile(profile);

      expect(text).toContain('Recent mentions');
      expect(text).toContain('Discussed the new architecture');
    });

    it('should truncate output that exceeds 4000 chars', () => {
      const longFacts = Array.from({ length: 100 }, (_, i) =>
        makeFact({ id: `fact-${i}`, predicate: 'related_to', objectValue: `A very long value entry number ${i} with lots of detail to fill space` })
      );

      const profile: EntityProfile = {
        entity: makeEntity(),
        facts: longFacts,
        relatedEntities: [],
        recentMemories: [],
      };

      const text = formatEntityProfile(profile);

      expect(text.length).toBeLessThanOrEqual(4020); // 4000 + "...truncated" margin
    });

    it('should handle entity with no aliases', () => {
      const entityWithNoAliases = { ...makeEntity(), aliases: [] as string[] };

      const profile: EntityProfile = {
        entity: entityWithNoAliases,
        facts: [],
        relatedEntities: [],
        recentMemories: [],
      };

      const text = formatEntityProfile(profile);

      expect(text).toContain('Bruce McKay');
      expect(text).not.toContain('aka:');
    });

    it('should use appropriate emoji for entity type', () => {
      const personProfile: EntityProfile = {
        entity: makeEntity({ entityType: 'person' }),
        facts: [],
        relatedEntities: [],
        recentMemories: [],
      };
      expect(formatEntityProfile(personProfile)).toMatch(/^👤/);

      const companyProfile: EntityProfile = {
        entity: makeEntity({ entityType: 'company' }),
        facts: [],
        relatedEntities: [],
        recentMemories: [],
      };
      expect(formatEntityProfile(companyProfile)).toMatch(/^🏢/);
    });
  });
});
