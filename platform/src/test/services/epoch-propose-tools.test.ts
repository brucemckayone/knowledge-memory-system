/**
 * E2 (nmemo-vpz.2) — staging tables + propose tool surface + per-actor
 * allow-lists (doc 41 §3, §8a.4, §9.2, §9.5). Encodes the bead acceptance
 * criteria against the real handleToolCall dispatch + testDb:
 *
 *   (2) resolve_anchor / propose_entity / propose_fact registered + working;
 *       propose_fact returns exclusiveGroup (E1 shared module) + the
 *       prior-canonical preview.
 *   (3) handles are server-minted + epoch-local; anchored entities flow
 *       through propose_entity carrying anchorCanonicalId.
 *   (4) the proposer's allow-list excludes every canonical-write tool; a
 *       canonical-write call from extraction_proposer fails structurally.
 *   (5) the preview shape + isolation (no peer in-flight proposals leak in).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  handleToolCall,
  allowlistFor,
  type ToolCallContext,
} from '../../services/causal-agent.js';
import type { Actor } from '../../services/audit.js';
import { testDb, createTestEntity, createTestFact } from '../setup.js';

// The canonical-write tools the propose/promote split removes from agents
// (doc 41 §8a.2). The extraction proposer must hold NONE of these.
const CANONICAL_WRITE_TOOLS = [
  'create_fact', 'resolve_entity', 'execute_merge', 'expire_fact',
  'invalidate_fact', 'create_same_as_link', 'update_entity_summary',
];

// E5 (doc 41 §8a.5): these three move OUT of every agent surface into promotion
// code — "the arbiter decides, promotion executes."
const RETIRED_TO_PROMOTION = ['execute_merge', 'create_same_as_link', 'resolve_contradiction'];
// Legacy canonical writes graph_agent/reasoning_agent KEEP (serial/optimistic arms).
const LEGACY_GRAPH_WRITES = ['create_fact', 'resolve_entity', 'expire_fact', 'invalidate_fact', 'update_entity_summary'];
const ALL_ACTORS: Actor[] = [
  'extraction_proposer', 'graph_agent', 'reasoning_agent', 'gardener_agent',
  'reconciliation_agent', 'user', 'system_trigger', 'cascade', 'promotion',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every epoch id this suite stages into. Staging cleanup is scoped to these.
 *
 * A bare `DELETE FROM staging_proposed_*` with no WHERE clause deletes OTHER
 * writers' rows on the shared test database. On 2026-08-31 that cost real data:
 * a 294-document ingest was running against cognitive_test and a sibling suite's
 * unscoped cleanup wiped the in-flight batch's staging before the ingest could
 * snapshot paper-level attribution from it, leaving 10 documents in the graph
 * with none. Staging is transient by design, so it could not be reconstructed.
 */
const stagedEpochIds = new Set<string>();


async function cleanStaging(): Promise<void> {
  if (stagedEpochIds.size === 0) return;
  const ids = [...stagedEpochIds].map((e) => `'${e}'::uuid`).join(',');
  await testDb.unsafe(`DELETE FROM staging_proposed_facts WHERE epoch_id IN (${ids})`);
  await testDb.unsafe(`DELETE FROM staging_proposed_entities WHERE epoch_id IN (${ids})`);
}

// createTestEntity uses real-world canonical names (not a TAG). The original
// beforeEach only cleared STAGING, so these canonical fixtures accumulated in the
// shared cognitive_test DB across runs — and a later run's resolve_anchor('Globex')
// then matched a STALE duplicate, not the freshly-minted one (the only name-matching
// test; the rest pass ent.id explicitly so leftovers don't bite them). Scoped to this
// file's exact names (no other test uses them), so it is safe under vitest's
// parallel-file workers. Facts first (facts.subject_entity_id is RESTRICT, mig 038).
const FIXTURE_ENTITY_NAMES = ['Dr. Elena Vasquez', 'Helix Corp', 'Acme Inc', 'Globex'];

async function cleanFixtureEntities(): Promise<void> {
  const names = FIXTURE_ENTITY_NAMES.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ');
  const ids = `SELECT id FROM entities WHERE canonical_name IN (${names})`;
  // Every table that pins one of these entities has to go first, and the cleanup used
  // to cover only the SUBJECT side of facts. The shared cognitive_test DB is never
  // truncated, so debris from other suites accumulates against these very common
  // fixture names and then this whole file fails in beforeEach rather than in a test:
  //   - a fact whose OBJECT is a fixture entity — object_entity_id is ON DELETE SET
  //     NULL, and nulling it trips the `has_object` CHECK on a fact with no
  //     object_value (observed: a July `works_at` row).
  //   - entity_merges.target_entity_id / source_entity_id are plain FKs with no
  //     cascade, so one merge audit row pins the entity permanently.
  const factIds = `SELECT id FROM facts WHERE subject_entity_id IN (${ids}) OR object_entity_id IN (${ids})`;
  await testDb.unsafe(`DELETE FROM causal_events WHERE fact_id IN (${factIds})`);
  await testDb.unsafe(`DELETE FROM fact_history WHERE fact_id IN (${factIds})`);
  await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id IN (${ids}) OR object_entity_id IN (${ids})`);
  await testDb.unsafe(`DELETE FROM entity_merges WHERE target_entity_id IN (${ids}) OR source_entity_id IN (${ids})`);
  await testDb.unsafe(`DELETE FROM entities WHERE canonical_name IN (${names})`);
}

async function cleanAll(): Promise<void> {
  await cleanStaging();
  await cleanFixtureEntities();
}

function proposerCtx(epochId: string, extra?: Partial<ToolCallContext>): ToolCallContext {
  stagedEpochIds.add(epochId);
  return { agent: 'extraction_proposer', epochId, sourceId: null, chunkIndex: null, ...extra };
}

async function call(tool: string, input: Record<string, unknown>, ctx: ToolCallContext): Promise<any> {
  return JSON.parse(await handleToolCall(tool, input, ctx));
}

describe('epoch-v2 propose tool surface + allow-lists (nmemo-vpz.2 / E2)', () => {
  beforeEach(cleanAll);
  afterAll(cleanAll);

  describe('per-actor allow-list (criterion 4)', () => {
    it('extraction_proposer surface = reads + propose writes, NO canonical writes', () => {
      const surface = allowlistFor('extraction_proposer');
      expect(surface.has('propose_entity')).toBe(true);
      expect(surface.has('propose_fact')).toBe(true);
      expect(surface.has('resolve_anchor')).toBe(true);
      expect(surface.has('query_entity_facts')).toBe(true); // a representative read
      for (const w of CANONICAL_WRITE_TOOLS) {
        expect(surface.has(w), `proposer must NOT hold ${w}`).toBe(false);
      }
    });

    it('legacy graph_agent keeps its non-retired canonical writes, but NOT the E5 promotion-retired tools', () => {
      const surface = allowlistFor('graph_agent');
      for (const w of LEGACY_GRAPH_WRITES) {
        expect(surface.has(w), `graph_agent must keep ${w}`).toBe(true);
      }
      for (const w of RETIRED_TO_PROMOTION) {
        expect(surface.has(w), `graph_agent must NOT hold E5-retired ${w}`).toBe(false);
      }
      // graph_agent also keeps the propose tools — legacy actors are otherwise unrestricted.
      expect(surface.has('propose_entity')).toBe(true);
    });

    it('a canonical-write call from the proposer fails STRUCTURALLY, before any DB work', async () => {
      await expect(
        handleToolCall('create_fact', { subject: 'x' }, proposerCtx(randomUUID())),
      ).rejects.toThrow(/not permitted for actor "extraction_proposer"/);
    });

    // --- E5 (nmemo-vpz.5) criterion 2: the merge/link/contradiction tools leave EVERY agent surface ---

    it('E5 criterion 2: execute_merge / create_same_as_link / resolve_contradiction are absent from EVERY agent allow-list', () => {
      for (const actor of ALL_ACTORS) {
        const surface = allowlistFor(actor);
        for (const w of RETIRED_TO_PROMOTION) {
          expect(surface.has(w), `${actor} must NOT hold ${w} (moved to promotion code)`).toBe(false);
        }
      }
    });

    it('E5: the recast reconciliation_agent (arbiter) holds the verdict tools + reads, no canonical writes', () => {
      const surface = allowlistFor('reconciliation_agent');
      expect(surface.has('propose_identity_verdict')).toBe(true);
      expect(surface.has('propose_conflict_resolution')).toBe(true);
      expect(surface.has('query_entity_facts')).toBe(true); // reads to "go deeper" (§8a.5)
      expect(surface.has('get_reconciliation_context')).toBe(false); // subsumed by the pushed dossier
      for (const w of [...RETIRED_TO_PROMOTION, 'create_fact', 'expire_fact', 'resolve_candidate']) {
        expect(surface.has(w), `arbiter must NOT hold ${w}`).toBe(false);
      }
    });

    it('E5: a retired-tool call from the arbiter fails STRUCTURALLY', async () => {
      await expect(
        handleToolCall(
          'execute_merge',
          { source_entity_id: randomUUID(), target_entity_id: randomUUID(), reasoning: 'x' },
          { agent: 'reconciliation_agent', epochId: null, sourceId: null, chunkIndex: null },
        ),
      ).rejects.toThrow(/not permitted for actor "reconciliation_agent"/);
    });
  });

  describe('propose_entity — server-minted, epoch-local handles (criterion 3)', () => {
    it('mints a server-side handle and persists an epoch-local staging row', async () => {
      const epochId = randomUUID();
      const res = await call('propose_entity', { name: 'Helix', type: 'organization' }, proposerCtx(epochId));
      expect(res.handle).toMatch(UUID_RE);
      const rows = await testDb`SELECT * FROM staging_proposed_entities WHERE handle = ${res.handle}::uuid`;
      expect(rows[0]!.epoch_id).toBe(epochId);
      expect(rows[0]!.name).toBe('Helix');
      expect(rows[0]!.anchor_canonical_id).toBeNull();
      expect(rows[0]!.proposed_by).toBe('extraction_proposer');
    });

    it('two proposals mint distinct handles (server-minted, not agent-chosen)', async () => {
      const epochId = randomUUID();
      const a = await call('propose_entity', { name: 'A', type: 'person' }, proposerCtx(epochId));
      const b = await call('propose_entity', { name: 'A', type: 'person' }, proposerCtx(epochId));
      expect(a.handle).not.toBe(b.handle);
    });

    it('anchored entities flow through propose_entity carrying anchorCanonicalId', async () => {
      const epochId = randomUUID();
      const ent = await createTestEntity({ canonicalName: 'Dr. Elena Vasquez', entityType: 'person' });
      const res = await call('propose_entity',
        { name: 'Elena Vasquez', type: 'person', anchorCanonicalId: ent.id }, proposerCtx(epochId));
      const rows = await testDb`SELECT anchor_canonical_id FROM staging_proposed_entities WHERE handle = ${res.handle}::uuid`;
      expect(rows[0]!.anchor_canonical_id).toBe(ent.id);
    });

    it('requires a harness-injected epoch context', async () => {
      await expect(
        handleToolCall('propose_entity', { name: 'X', type: 'person' }, { agent: 'extraction_proposer' }),
      ).rejects.toThrow(/epoch context/);
    });
  });

  describe('propose_fact — exclusive group + disposal preview (criteria 2, 5)', () => {
    it('returns exclusiveGroup from the E1 shared ontology + persists the staging row', async () => {
      const epochId = randomUUID();
      const subj = await call('propose_entity', { name: 'Sam', type: 'person' }, proposerCtx(epochId));
      const res = await call('propose_fact',
        { subjectHandle: subj.handle, predicate: 'has_job_title', objectValue: 'CEO', validAt: '2024-01-01' },
        proposerCtx(epochId));
      expect(res.stagedFactId).toMatch(UUID_RE);
      expect(res.exclusiveGroup).toBe('role_title'); // has_job_title folds into role_title (E1)
      const rows = await testDb`SELECT * FROM staging_proposed_facts WHERE staged_fact_id = ${res.stagedFactId}::uuid`;
      expect(rows[0]!.predicate).toBe('has_job_title');
      expect(rows[0]!.exclusive_group).toBe('role_title');
      expect(rows[0]!.undated).toBe(false);
    });

    it('undated fact: no validAt → undated=true, valid_at NULL (no silent omission)', async () => {
      const epochId = randomUUID();
      const subj = await call('propose_entity', { name: 'Sam2', type: 'person' }, proposerCtx(epochId));
      const res = await call('propose_fact',
        { subjectHandle: subj.handle, predicate: 'knows', objectValue: 'someone' }, proposerCtx(epochId));
      const rows = await testDb`SELECT undated, valid_at FROM staging_proposed_facts WHERE staged_fact_id = ${res.stagedFactId}::uuid`;
      expect(rows[0]!.undated).toBe(true);
      expect(rows[0]!.valid_at).toBeNull();
    });

    it('preview surfaces PRIOR CANONICAL active facts in the group, cross-predicate', async () => {
      const epochId = randomUUID();
      const ent = await createTestEntity({ canonicalName: 'Helix Corp', entityType: 'organization' });
      // prior canonical active fact in the role_title group via a DIFFERENT predicate
      await createTestFact({ subjectEntityId: ent.id, predicate: 'job_title', objectValue: 'CTO' });
      const subj = await call('propose_entity',
        { name: 'Helix Corp', type: 'organization', anchorCanonicalId: ent.id }, proposerCtx(epochId));
      const res = await call('propose_fact',
        { subjectHandle: subj.handle, predicate: 'has_role', objectValue: 'CEO' }, proposerCtx(epochId));
      expect(res.exclusiveGroup).toBe('role_title');
      expect(res.priorCanonicalActiveInGroup).toHaveLength(1);
      expect(res.priorCanonicalActiveInGroup[0].predicate).toBe('job_title');
    });

    it('isolation: peer in-flight proposals are NOT in the preview (prior canonical only)', async () => {
      const epochId = randomUUID();
      const ent = await createTestEntity({ canonicalName: 'Acme Inc', entityType: 'organization' });
      await createTestFact({ subjectEntityId: ent.id, predicate: 'job_title', objectValue: 'CTO' });
      const subj = await call('propose_entity',
        { name: 'Acme Inc', type: 'organization', anchorCanonicalId: ent.id }, proposerCtx(epochId));
      // a PEER in-flight proposal in the SAME exclusive group
      await call('propose_fact',
        { subjectHandle: subj.handle, predicate: 'role', objectValue: 'Chairman' }, proposerCtx(epochId));
      // the asserted call must still see ONLY the prior canonical, never the peer
      const res = await call('propose_fact',
        { subjectHandle: subj.handle, predicate: 'has_role', objectValue: 'CEO' }, proposerCtx(epochId));
      expect(res.priorCanonicalActiveInGroup).toHaveLength(1);
      expect(res.priorCanonicalActiveInGroup[0].predicate).toBe('job_title');
    });

    it('unanchored (new) subject → empty preview', async () => {
      const epochId = randomUUID();
      const subj = await call('propose_entity', { name: 'BrandNew', type: 'person' }, proposerCtx(epochId));
      const res = await call('propose_fact',
        { subjectHandle: subj.handle, predicate: 'job_title', objectValue: 'Engineer' }, proposerCtx(epochId));
      expect(res.exclusiveGroup).toBe('role_title');
      expect(res.priorCanonicalActiveInGroup).toHaveLength(0);
    });

    it('stores the VERIFY supersession hint (supersedesFactId) when provided (E4)', async () => {
      const epochId = randomUUID();
      const priorFactId = randomUUID(); // no FK — promotion validates it, the row stores it raw
      const subj = await call('propose_entity', { name: 'Hinted Co', type: 'organization' }, proposerCtx(epochId));
      const res = await call('propose_fact',
        { subjectHandle: subj.handle, predicate: 'headquartered_in', objectValue: 'Austin', validAt: '2024-01-01', supersedesFactId: priorFactId },
        proposerCtx(epochId));
      const rows = await testDb`SELECT supersedes_fact_id FROM staging_proposed_facts WHERE staged_fact_id = ${res.stagedFactId}::uuid`;
      expect(rows[0]!.supersedes_fact_id).toBe(priorFactId);
    });

    it('rejects when neither / both of objectHandle and objectValue are provided', async () => {
      const epochId = randomUUID();
      const subj = await call('propose_entity', { name: 'Z', type: 'person' }, proposerCtx(epochId));
      await expect(
        handleToolCall('propose_fact', { subjectHandle: subj.handle, predicate: 'knows' }, proposerCtx(epochId)),
      ).rejects.toThrow(/exactly one/);
    });
  });

  describe('resolve_anchor — epoch-start registry (criterion 2)', () => {
    it('exact canonical-name match → matched with canonicalId + confidence 1.0', async () => {
      const ent = await createTestEntity({ canonicalName: 'Globex', entityType: 'organization' });
      const res = await call('resolve_anchor', { mention: 'globex' }, proposerCtx(randomUUID()));
      expect(res.matched).toBe(true);
      expect(res.canonicalId).toBe(ent.id);
      expect(res.confidence).toBe(1.0);
    });

    it('unknown mention → matched:false (propose a new entity instead)', async () => {
      const res = await call('resolve_anchor',
        { mention: 'Zzqx Nonexistent Entity 4711' }, proposerCtx(randomUUID()));
      expect(res.matched).toBe(false);
    });
  });

  /**
   * resolve_anchor corpus scoping (doc 36 §4). Corpus separation was enforced on the
   * WRITE path (`dcfcfb8`) but not on the READ path the agent uses to decide identity:
   * `resolve_anchor` looked entities up by name with no corpus filter. So an agent
   * extracting corpus B saw "GPT-4", matched corpus A's node, and registered its
   * corpus-B entity as anchored across the boundary; promotion then tried to write an
   * `arxiv-cv` fact whose object lives in `arxiv-nlp` and migration 052's composite FK
   * `facts_object_corpus_fk` rejected the whole batch. This was the fifth unscoped
   * corpus path, and it can only appear once two corpora that discuss the same things
   * coexist — which is the entire point of the feature.
   *
   * Fixtures are inserted with a NULL embedding on purpose, so branch 3 (the semantic
   * fallback) can never match them and the assertions below hold whether or not the ML
   * service is running. Branch 3's own scoping comes from `findSimilarEntities`, which
   * has been corpus-filtered since Phase A.
   */
  describe('resolve_anchor is corpus-scoped (doc 36 §4)', () => {
    const CA = 'anchortest-corpus-a';
    const CB = 'anchortest-corpus-b';
    const SHARED = 'Anchortest Shared Model';
    const SHARED_ALIAS = 'anchortest-shared-alias';

    async function cleanAnchorCorpora(): Promise<void> {
      for (const c of [CA, CB]) {
        await testDb.unsafe(`DELETE FROM entity_aliases WHERE entity_id IN (SELECT id FROM entities WHERE corpus_id = '${c}')`);
        await testDb.unsafe(`DELETE FROM entities WHERE corpus_id = '${c}'`);
      }
    }

    /** Insert a bare entity directly — createTestEntity has no corpus parameter. */
    async function seed(corpusId: string, name: string): Promise<string> {
      const rows = await testDb`
        INSERT INTO entities (canonical_name, entity_type, corpus_id)
        VALUES (${name}, 'other', ${corpusId})
        RETURNING id
      `;
      return rows[0]!.id as string;
    }

    beforeEach(cleanAnchorCorpora);
    afterAll(cleanAnchorCorpora);

    it('does NOT anchor across the corpus boundary — the bug that blocked corpus B', async () => {
      await seed(CA, SHARED);
      const res = await call('resolve_anchor', { mention: SHARED }, proposerCtx(randomUUID(), { corpusId: CB }));
      expect(res.matched).toBe(false);
    });

    it('resolves the same name to each corpus OWN node', async () => {
      const idA = await seed(CA, SHARED);
      const idB = await seed(CB, SHARED);
      expect(idA).not.toBe(idB);

      const inA = await call('resolve_anchor', { mention: SHARED }, proposerCtx(randomUUID(), { corpusId: CA }));
      const inB = await call('resolve_anchor', { mention: SHARED }, proposerCtx(randomUUID(), { corpusId: CB }));
      expect(inA.canonicalId).toBe(idA);
      expect(inB.canonicalId).toBe(idB);
    });

    it('scopes the ALIAS branch too (entity_aliases has no corpus_id of its own)', async () => {
      const idA = await seed(CA, SHARED);
      await testDb`INSERT INTO entity_aliases (entity_id, alias) VALUES (${idA}, ${SHARED_ALIAS})`;

      const inA = await call('resolve_anchor', { mention: SHARED_ALIAS }, proposerCtx(randomUUID(), { corpusId: CA }));
      expect(inA.matched).toBe(true);
      expect(inA.canonicalId).toBe(idA);

      const inB = await call('resolve_anchor', { mention: SHARED_ALIAS }, proposerCtx(randomUUID(), { corpusId: CB }));
      expect(inB.matched).toBe(false);
    });

    it('an absent corpusId still resolves in the default corpus (legacy callers unchanged)', async () => {
      const ent = await createTestEntity({ canonicalName: 'Globex', entityType: 'organization' });
      const res = await call('resolve_anchor', { mention: 'Globex' }, proposerCtx(randomUUID()));
      expect(res.matched).toBe(true);
      expect(res.canonicalId).toBe(ent.id);
    });
  });
});
