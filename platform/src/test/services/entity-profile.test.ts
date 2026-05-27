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
    execute: vi.fn(() => Promise.resolve([])),
  },
}));

// rawQuery() in entity-profile.ts wraps db.execute() with snake_case→camelCase
// transformation. Mock it directly so tests can stage the dedup-query result
// without having to spin up the full mock chain.
vi.mock('../../db/raw.js', () => ({
  rawQuery: vi.fn(() => Promise.resolve([])),
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

import { getEntityProfile, formatEntityProfile, searchEntities, getEntityMemories, categorize, type EntityProfile } from '../../services/entity-profile.js';
import { getEntityById, findEntitiesByName } from '../../services/entities.js';
import { getEntityFacts } from '../../services/facts.js';
import { findConnectedEntities } from '../../services/graph.js';
import { qdrant } from '../../services/qdrant.js';
import { rawQuery } from '../../db/raw.js';

const mockGetEntityById = vi.mocked(getEntityById);
const mockGetEntityFacts = vi.mocked(getEntityFacts);
const mockFindConnected = vi.mocked(findConnectedEntities);
const mockFindByName = vi.mocked(findEntitiesByName);
const mockQdrantRetrieve = vi.mocked(qdrant.retrieve);
const mockRawQuery = vi.mocked(rawQuery);

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
    expireReason: null,
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
      // rawQuery mock returns [] by default — short-circuits before qdrant.retrieve
      mockRawQuery.mockResolvedValueOnce([]);
      const result = await getEntityMemories('ent-001');
      expect(result).toEqual([]);
    });

    // bead nmemo-2yv.58 H6 — Qdrant errors must be logged before the swallow
    it('should log a warn-level message and return [] when qdrant.retrieve throws', async () => {
      const entityId = 'ent-h6-warn';
      const upstreamErr = new Error('qdrant connection refused');

      mockRawQuery.mockResolvedValueOnce([{ memoryId: 'mem-001' }]);
      mockQdrantRetrieve.mockRejectedValueOnce(upstreamErr);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await getEntityMemories(entityId);

      // Graceful degradation: still returns [] (existing contract)
      expect(result).toEqual([]);

      // Logging: warn was called with a stable prefix, the entity_id, and the
      // underlying error message
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [msg, errArg] = warnSpy.mock.calls[0]!;
      expect(String(msg)).toContain('entity-profile.getEntityMemories');
      expect(String(msg)).toContain('qdrant.retrieve failed');
      expect(String(msg)).toContain(entityId);
      expect(String(errArg)).toContain('qdrant connection refused');

      warnSpy.mockRestore();
    });

    // bead nmemo-2yv.56 — Qdrant retrieve→map happy path
    //
    // The error case (H6 above) and the empty-links short-circuit (the first
    // test) bracket the unhappy paths, but the happy mapping of Qdrant
    // payloads to EntityMemory shape was never asserted directly. Subtle
    // changes to qdrant.retrieve's return shape (point.id type, payload key
    // names like content vs text) would silently break consumers without a
    // unit failure here. The fixture covers:
    //   - point.id: numeric → coerced to string
    //   - payload.content: present → preferred over payload.text
    //   - payload.text fallback: when content is absent
    //   - missing type: defaults to 'thought'
    //   - missing created_at: defaults to ''
    it('maps qdrant.retrieve points to EntityMemory shape on the happy path', async () => {
      mockRawQuery.mockResolvedValueOnce([
        { memoryId: 'mem-001' },
        { memoryId: 'mem-002' },
      ]);
      mockQdrantRetrieve.mockResolvedValueOnce([
        {
          id: 'mem-001',
          payload: {
            content: 'Discussed onboarding with Bruce',
            type: 'thought',
            created_at: '2026-04-10T09:00:00Z',
          },
          vector: null,
        },
        {
          // Numeric id (some Qdrant configurations) — must coerce to string.
          // Falls back to payload.text when content is absent, and defaults
          // type / createdAt when their keys are missing.
          id: 42 as unknown as string,
          payload: {
            text: 'Followup conversation, no agenda',
          },
          vector: null,
        },
      ] as unknown as Awaited<ReturnType<typeof qdrant.retrieve>>);

      const result = await getEntityMemories('ent-001');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        memoryId: 'mem-001',
        content: 'Discussed onboarding with Bruce',
        type: 'thought',
        createdAt: '2026-04-10T09:00:00Z',
      });
      expect(result[1]).toEqual({
        memoryId: '42',
        content: 'Followup conversation, no agenda',
        type: 'thought',
        createdAt: '',
      });

      // The service handed Qdrant the memory_ids it got from the dedup query,
      // in the order they were returned. Order matters because the caller
      // expects DESC-by-created_at semantics from the DB layer.
      expect(mockQdrantRetrieve).toHaveBeenCalledTimes(1);
      const [collection, params] = mockQdrantRetrieve.mock.calls[0]!;
      expect(collection).toBe('memories');
      expect((params as { ids: string[] }).ids).toEqual(['mem-001', 'mem-002']);
      expect((params as { with_payload: boolean }).with_payload).toBe(true);
      expect((params as { with_vector: boolean }).with_vector).toBe(false);
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

  // bead nmemo-2yv.57 — categorize must cover the observed-predicate corpus.
  // The grep that drives this is documented in the bead description:
  //   git grep -nE "predicate: '[a-z_]+'" -- 'platform/src/' \
  //     | awk -F"predicate: '" '{print $2}' | awk -F"'" '{print $1}' | sort -u
  // If that command surfaces a predicate that isn't in PREDICATE_CATEGORIES,
  // the "every observed predicate categorises to non-Other" test below will
  // surface it.
  describe('categorize (bead nmemo-2yv.57)', () => {
    it('returns Identity for is_a', () => {
      expect(categorize('is_a')).toBe('Identity');
    });

    it('returns Relationships for works_at', () => {
      expect(categorize('works_at')).toBe('Relationships');
    });

    it('returns Attributes for has_role', () => {
      expect(categorize('has_role')).toBe('Attributes');
    });

    it('returns Activities for works_on', () => {
      expect(categorize('works_on')).toBe('Activities');
    });

    it('returns Other for an unknown predicate', () => {
      expect(categorize('unknown_relationship_xyz')).toBe('Other');
    });

    // Acceptance bullet: every predicate observed in the source/test corpus
    // (as of bead .57) categorises to something other than 'Other'.
    //
    // To extend this list when the LLM coins a new predicate, append it and
    // ensure PREDICATE_CATEGORIES has a home for it. The list omits known
    // non-predicate matches (single-letter test placeholders 'p', 'q',
    // benchmark sentinels 'p_init', 'p_drift', and the explicit unknown
    // 'unknown_relationship_xyz' which is asserted above to return 'Other').
    const OBSERVED_PREDICATES = [
      'amount', 'caused', 'employed_at', 'employs', 'experiences',
      'finishes', 'has', 'has_label', 'has_role', 'has_status',
      'knows', 'links', 'lives_in', 'located_in', 'manages',
      'member_of', 'mentions', 'next', 'opens', 'reads',
      'related', 'related_to', 'relocated_to', 'reports_to',
      'scheduled_for', 'started_at', 'status', 'uses', 'visited',
      'was_active', 'worked_at', 'works_at', 'works_on',
    ];
    it.each(OBSERVED_PREDICATES)(
      'observed predicate %s does not fall to Other',
      (predicate) => {
        expect(categorize(predicate)).not.toBe('Other');
      },
    );
  });
});
