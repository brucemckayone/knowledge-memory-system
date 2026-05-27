/**
 * Unit Tests: Entity Profile Service
 *
 * Tests for profile assembly and formatting.
 * Uses mocked dependencies to avoid requiring DB/Qdrant.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Entity, Fact } from '../../db/schema.js';

// Mock dependencies before importing the module under test.
//
// db.select() is consumed by getEntitySummary's chained drizzle call:
//   db.select(...).from(entityMeta).where(eq(...)).limit(1)
// We stage a single Promise.resolve([...]) at the .limit() leaf — tests
// override the leaf per-case with vi.mocked(db.select)... where needed.
const mockSummaryLimit = vi.fn(() => Promise.resolve([] as Array<{ summary: string | null; summaryUpdatedAt: Date | null }>));
vi.mock('../../db/index.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve([])),
          })),
          limit: mockSummaryLimit,
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
    // Default: no entity_meta row exists for the test entity. Individual
    // tests staging a summary override via mockSummaryLimit.mockResolvedValueOnce.
    mockSummaryLimit.mockResolvedValue([]);
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

    // bead nmemo-2yv.51 — surface entity_meta.summary on the assembled profile
    it('should surface summary + summaryUpdatedAt from entity_meta when present', async () => {
      const summaryUpdatedAt = new Date('2026-05-20T10:00:00Z');
      mockGetEntityById.mockResolvedValue(makeEntity());
      mockGetEntityFacts.mockResolvedValue([]);
      mockFindConnected.mockResolvedValue([]);
      mockSummaryLimit.mockResolvedValueOnce([{
        summary: 'Bruce is a staff engineer at Hexagon focused on the Mnemo platform.',
        summaryUpdatedAt,
      }]);

      const result = await getEntityProfile('ent-001');

      expect(result).not.toBeNull();
      expect(result!.summary).toBe(
        'Bruce is a staff engineer at Hexagon focused on the Mnemo platform.',
      );
      expect(result!.summaryUpdatedAt).toBe(summaryUpdatedAt);
    });

    // bead nmemo-2yv.51 — null fields when no entity_meta row exists yet
    it('should return null summary + summaryUpdatedAt when entity_meta has no row', async () => {
      mockGetEntityById.mockResolvedValue(makeEntity());
      mockGetEntityFacts.mockResolvedValue([]);
      mockFindConnected.mockResolvedValue([]);
      // Default beforeEach already stages [] — leaving it explicit for clarity.
      mockSummaryLimit.mockResolvedValueOnce([]);

      const result = await getEntityProfile('ent-001');

      expect(result).not.toBeNull();
      expect(result!.summary).toBeNull();
      expect(result!.summaryUpdatedAt).toBeNull();
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
    // Test fixtures default to a profile with no summary so prior assertions
    // still pass. Summary-specific tests below override summary explicitly.
    function makeProfile(overrides: Partial<EntityProfile> = {}): EntityProfile {
      return {
        entity: makeEntity(),
        facts: [],
        relatedEntities: [],
        recentMemories: [],
        summary: null,
        summaryUpdatedAt: null,
        ...overrides,
      };
    }

    it('should include entity name, type, and aliases', () => {
      const text = formatEntityProfile(makeProfile());

      expect(text).toContain('Bruce McKay');
      expect(text).toContain('person');
      expect(text).toContain('Bruce, BM');
    });

    it('should include facts grouped by category', () => {
      const text = formatEntityProfile(makeProfile({
        facts: [
          makeFact({ predicate: 'works_at', objectValue: 'Acme Corp' }),
          makeFact({ id: 'fact-002', predicate: 'has_role', objectValue: 'Engineer' }),
        ],
      }));

      expect(text).toContain('Relationships');
      expect(text).toContain('works_at: Acme Corp');
      expect(text).toContain('Attributes');
      expect(text).toContain('has_role: Engineer');
    });

    it('should include related entities', () => {
      const text = formatEntityProfile(makeProfile({
        relatedEntities: [
          { entityId: 'ent-002', name: 'Acme Corp', type: 'company' },
          { entityId: 'ent-003', name: 'Project X', type: 'project' },
        ],
      }));

      expect(text).toContain('Connected');
      expect(text).toContain('Acme Corp');
      expect(text).toContain('Project X');
    });

    it('should include recent memories', () => {
      const text = formatEntityProfile(makeProfile({
        recentMemories: [
          { memoryId: 'm1', content: 'Discussed the new architecture with Bruce', type: 'thought', createdAt: '2026-03-10T12:00:00Z' },
        ],
      }));

      expect(text).toContain('Recent mentions');
      expect(text).toContain('Discussed the new architecture');
    });

    it('should truncate output that exceeds 4000 chars', () => {
      const longFacts = Array.from({ length: 100 }, (_, i) =>
        makeFact({ id: `fact-${i}`, predicate: 'related_to', objectValue: `A very long value entry number ${i} with lots of detail to fill space` })
      );

      const text = formatEntityProfile(makeProfile({ facts: longFacts }));

      expect(text.length).toBeLessThanOrEqual(4020); // 4000 + "...truncated" margin
    });

    it('should handle entity with no aliases', () => {
      const entityWithNoAliases = { ...makeEntity(), aliases: [] as string[] };

      const text = formatEntityProfile(makeProfile({ entity: entityWithNoAliases }));

      expect(text).toContain('Bruce McKay');
      expect(text).not.toContain('aka:');
    });

    it('should use appropriate emoji for entity type', () => {
      expect(formatEntityProfile(makeProfile({
        entity: makeEntity({ entityType: 'person' }),
      }))).toMatch(/^👤/);

      expect(formatEntityProfile(makeProfile({
        entity: makeEntity({ entityType: 'company' }),
      }))).toMatch(/^🏢/);
    });

    // bead nmemo-2yv.51 — summary rendering
    describe('summary block (bead nmemo-2yv.51)', () => {
      it('renders summary section above facts when present', () => {
        const text = formatEntityProfile(makeProfile({
          summary: 'Bruce is a staff engineer at Hexagon focused on the Mnemo platform.',
          summaryUpdatedAt: new Date('2026-05-20T10:00:00Z'),
          facts: [makeFact({ predicate: 'works_at', objectValue: 'Hexagon' })],
        }));

        expect(text).toContain('Summary');
        expect(text).toContain('Bruce is a staff engineer at Hexagon');

        const summaryIdx = text.indexOf('Summary');
        const factsIdx = text.indexOf('Relationships');
        expect(summaryIdx).toBeGreaterThan(-1);
        expect(factsIdx).toBeGreaterThan(-1);
        expect(summaryIdx).toBeLessThan(factsIdx);
      });

      it('omits the summary section when summary is null', () => {
        const text = formatEntityProfile(makeProfile({ summary: null }));
        expect(text).not.toContain('Summary');
      });

      it('omits the summary section when summary is an empty string', () => {
        const text = formatEntityProfile(makeProfile({ summary: '' }));
        expect(text).not.toContain('Summary');
      });

      it('respects the 4000-char budget even when summary is long', () => {
        // 5000-char summary alone would blow the budget. The formatter caps
        // the summary internally; total output stays under MAX_LENGTH + margin.
        const longSummary = 'word '.repeat(1000); // 5000 chars
        const text = formatEntityProfile(makeProfile({
          summary: longSummary,
          facts: [makeFact({ predicate: 'works_at', objectValue: 'Acme' })],
        }));

        expect(text.length).toBeLessThanOrEqual(4020);
        // Facts section still rendered — summary cap protects structured content
        expect(text).toContain('works_at');
      });
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
