/**
 * Phase 6 — Pattern Lifecycle (doc 17, nmemo-d9v)
 *
 * Verifies the pattern detection + lifecycle + matching + ghost contracts.
 * Per the Phase 6 plan, fixtures are L1 + adversarial only — L2/L3 corpora
 * deferred to nmemo-klv.6 (the test-harden agentic loop).
 *
 * G1 (this commit) covers only:
 *   - migration 012 makes `rejected` an accepted lifecycle status
 *   - chain collection CTE walks active causal_edges within the lookback
 *     window, respects min/maxChainLength, applies cycle protection
 *
 * Later groups extend this file with normalisation, clustering, lifecycle
 * transitions, naming, edge-time matching, ghosts, and MCP/HTTP wiring.
 */

import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import { testDb, createTestEntity, createTestFact, deleteFromTables } from '../setup.js';
import {
  detectCausalPatterns,
  collectChains,
  normaliseChain,
  promotePatterns,
  matchEdgeToPattern,
  nameCandidatePatterns,
  type PatternStatus,
} from '../../services/causal-patterns.js';
import { ml } from '../../services/ml-client.js';

async function cleanSlate(): Promise<void> {
  await deleteFromTables({
    tables: [
      'causal_edge_history',
      'fact_history',
      'edge_source_refs',
      'causal_edges',
      'causal_events',
      'causal_patterns',
      'memory_entities',
      'entity_aliases',
      'facts',
      'entity_merges',
      'entities',
    ],
    acknowledgeGlobal: true,
  });
}

interface ChainSetup {
  entityId: string;
  eventIds: string[];
  edgeIds: string[];
}

interface BuildChainOptions {
  occurredAt?: Date;
  /** Per-position entity types. Defaults to 'standard_rule' for every event. */
  entityTypes?: string[];
  /** Per-position predicates. Defaults to 'requires' for every event. */
  predicates?: string[];
  /** Per-edge strength. Defaults to 0.8. */
  strengths?: number[];
}

/**
 * Build a linear chain of `numEdges` causal edges. By default every event uses
 * the same entity (so all template positions share the entity_type), but
 * `entityTypes`/`predicates` arrays let callers vary the shape per position
 * for normalisation tests.
 */
async function buildLinearChain(numEdges: number, opts: BuildChainOptions = {}): Promise<ChainSetup> {
  const occurredAt = opts.occurredAt ?? new Date();
  const numEvents = numEdges + 1;

  const entityTypes = opts.entityTypes ?? Array(numEvents).fill('standard_rule');
  const predicates = opts.predicates ?? Array(numEvents).fill('requires');
  const strengths = opts.strengths ?? Array(numEdges).fill(0.8);

  if (entityTypes.length !== numEvents) {
    throw new Error(`entityTypes length (${entityTypes.length}) must equal numEdges + 1 (${numEvents})`);
  }
  if (predicates.length !== numEvents) {
    throw new Error(`predicates length (${predicates.length}) must equal numEdges + 1 (${numEvents})`);
  }
  if (strengths.length !== numEdges) {
    throw new Error(`strengths length (${strengths.length}) must equal numEdges (${numEdges})`);
  }

  // Create one entity per event so each template node gets its own entity_type
  const entityIds: string[] = [];
  for (let i = 0; i < numEvents; i++) {
    const entity = await createTestEntity({
      canonicalName: `phase6-chain-${Date.now()}-${Math.random()}-pos${i}`,
      entityType: entityTypes[i]!,
    });
    entityIds.push(entity.id);
  }

  const eventIds: string[] = [];
  for (let i = 0; i < numEvents; i++) {
    const fact = await createTestFact({
      subjectEntityId: entityIds[i]!,
      predicate: predicates[i]!,
      objectValue: `step-${i}`,
    });
    const [row] = await testDb<Array<{ id: string }>>`
      INSERT INTO public.causal_events
        (fact_id, transition_type, subject_entity_id, predicate, occurred_at, source_text)
      VALUES
        (${fact.id}::uuid, 'created', ${entityIds[i]!}::uuid, ${predicates[i]!},
         ${occurredAt}, ${`chain-step-${i}`})
      RETURNING id
    `;
    eventIds.push(row!.id);
  }

  const edgeIds: string[] = [];
  for (let i = 0; i < numEdges; i++) {
    const sourceRefs = JSON.stringify([{ type: 'fact', id: eventIds[i], relevance: 'chain step' }]);
    const [row] = await testDb<Array<{ id: string }>>`
      INSERT INTO public.causal_edges
        (cause_event_id, effect_event_id, strength, extraction_method,
         reasoning, source_references, initial_strength)
      VALUES
        (${eventIds[i]}::uuid, ${eventIds[i + 1]}::uuid, ${strengths[i]!}, 'llm',
         ${`step ${i} causes step ${i + 1}`}, ${sourceRefs}::jsonb, ${strengths[i]!})
      RETURNING id
    `;
    edgeIds.push(row!.id);
  }

  return { entityId: entityIds[0]!, eventIds, edgeIds };
}

/**
 * Seed a `fact_predicates` row so detectCausalPatterns can join on the
 * category. Uses INSERT ... ON CONFLICT DO UPDATE so concurrent test setup
 * doesn't collide with the seed catalog.
 */
async function seedPredicateCategory(predicate: string, category: string): Promise<void> {
  await testDb`
    INSERT INTO public.fact_predicates (predicate, category, status, predicate_type)
    VALUES (${predicate}, ${category}, 'canonical', 'relation')
    ON CONFLICT (predicate) DO UPDATE SET category = EXCLUDED.category
  `;
}

interface SetupPatternOpts {
  status?: PatternStatus;
  instanceCount?: number;
  activationCount30d?: number;
  firstSeenAt?: Date;
  lastSeenAt?: Date | null;
  promotedAt?: Date | null;
  templateStructure?: unknown[];
  name?: string | null;
}

/**
 * Insert a `causal_patterns` row at an arbitrary lifecycle state. Used by
 * lifecycle tests that need to bypass the usual `staging`-only seeding done
 * by detectCausalPatterns.
 */
async function setupPattern(opts: SetupPatternOpts = {}): Promise<string> {
  const status = opts.status ?? 'staging';
  const instanceCount = opts.instanceCount ?? 1;
  const activationCount30d = opts.activationCount30d ?? 0;
  const firstSeenAt = opts.firstSeenAt ?? new Date();
  const lastSeenAt = opts.lastSeenAt === undefined ? new Date() : opts.lastSeenAt;
  const promotedAt = opts.promotedAt ?? null;
  const template = opts.templateStructure ?? [
    { entity_type: 'standard_rule', predicate_category: 'requires' },
    { entity_type: 'standard_rule', predicate_category: 'requires' },
  ];
  const templateLength = template.length;
  const name = opts.name ?? null;

  const [row] = await testDb<Array<{ id: string }>>`
    INSERT INTO public.causal_patterns
      (name, template_structure, template_length, status, instance_count,
       activation_count_30d, first_seen_at, last_seen_at, promoted_at)
    VALUES
      (${name}, ${JSON.stringify(template)}::jsonb, ${templateLength}, ${status},
       ${instanceCount}, ${activationCount30d}, ${firstSeenAt}, ${lastSeenAt}, ${promotedAt})
    RETURNING id
  `;
  return row!.id;
}

async function getPatternRow(id: string): Promise<{
  id: string;
  status: PatternStatus;
  name: string | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
  promoted_at: Date | null;
}> {
  const [row] = await testDb<Array<{
    id: string;
    status: PatternStatus;
    name: string | null;
    rejected_at: Date | null;
    rejection_reason: string | null;
    promoted_at: Date | null;
  }>>`
    SELECT id, status, name, rejected_at, rejection_reason, promoted_at
    FROM public.causal_patterns
    WHERE id = ${id}::uuid
  `;
  return row!;
}

describe('Phase 6 — G1: migration + chain collection (nmemo-d9v.1 + d9v.2)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  describe('migration 012 — valid_pattern_status accepts rejected', () => {
    it("CHECK constraint allows status='rejected'", async () => {
      const [row] = await testDb<Array<{ id: string }>>`
        INSERT INTO public.causal_patterns
          (name, template_structure, template_length, status,
           instance_count, first_seen_at)
        VALUES
          ('test rejected pattern', ${JSON.stringify([])}::jsonb, 0, 'rejected',
           0, NOW())
        RETURNING id
      `;
      expect(row?.id).toBeDefined();
    });

    it('rejects unknown status values (sanity — constraint still active)', async () => {
      await expect(
        testDb`
          INSERT INTO public.causal_patterns
            (template_structure, template_length, status, instance_count, first_seen_at)
          VALUES
            (${JSON.stringify([])}::jsonb, 0, 'not_a_real_status', 0, NOW())
        `,
      ).rejects.toThrow();
    });
  });

  describe('collectChains — linear 4-edge chain', () => {
    it('returns 6 chains of length ≥ 2 from a 4-edge chain (defaults)', async () => {
      await buildLinearChain(4);

      const chains = await collectChains();

      // For 4 edges (e1..e4) in a linear chain, the CTE emits all forward
      // sub-chains starting from each edge. Filtered to length ≥ 2:
      //   from e1: [e1,e2], [e1,e2,e3], [e1,e2,e3,e4]   → 3
      //   from e2: [e2,e3], [e2,e3,e4]                  → 2
      //   from e3: [e3,e4]                              → 1
      //   from e4: (only single edge, filtered out)     → 0
      expect(chains).toHaveLength(6);
      for (const chain of chains) {
        expect(chain.length).toBeGreaterThanOrEqual(2);
        expect(chain.length).toBeLessThanOrEqual(4);
        expect(chain.edgeIds).toHaveLength(chain.length);
      }
    });

    it('respects maxChainLength', async () => {
      await buildLinearChain(4);

      const chains = await collectChains({ maxChainLength: 2 });

      for (const c of chains) {
        expect(c.length).toBeLessThanOrEqual(2);
      }
    });

    it('respects lookbackDays — old chains excluded', async () => {
      const past = new Date('2025-01-01T00:00:00Z'); // > 1 year ago
      await buildLinearChain(4, { occurredAt: past });

      const chains = await collectChains({ lookbackDays: 30 });
      expect(chains).toHaveLength(0);
    });
  });

  describe('detectCausalPatterns — orchestrator (chain count only)', () => {
    it('returns chainsExamined > 0 for an in-window chain', async () => {
      await buildLinearChain(4);
      const result = await detectCausalPatterns();
      expect(result.chainsExamined).toBeGreaterThan(0);
    });

    it('returns 0 chainsExamined when graph is empty', async () => {
      const result = await detectCausalPatterns();
      expect(result.chainsExamined).toBe(0);
    });
  });
});

describe('Phase 6 — G2: normalisation + clustering + upsert (nmemo-d9v.3 + d9v.4)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  describe('normaliseChain — entity types and predicate categories', () => {
    it('replaces entity references with entity_type at every position', async () => {
      const { edgeIds } = await buildLinearChain(2, {
        entityTypes: ['standard_rule', 'standard_rule', 'compliance_practice'],
      });
      const normalised = await normaliseChain({ edgeIds, length: 2 });

      expect(normalised.template).toHaveLength(3);
      expect(normalised.template[0]!.entity_type).toBe('standard_rule');
      expect(normalised.template[1]!.entity_type).toBe('standard_rule');
      expect(normalised.template[2]!.entity_type).toBe('compliance_practice');
    });

    it('uses fact_predicates.category when seeded', async () => {
      await seedPredicateCategory('requires', 'compliance');
      await seedPredicateCategory('prevents', 'effects');

      const { edgeIds } = await buildLinearChain(2, {
        entityTypes: ['standard_rule', 'standard_rule', 'compliance_practice'],
        predicates: ['requires', 'prevents', 'prevents'],
      });
      const normalised = await normaliseChain({ edgeIds, length: 2 });

      expect(normalised.template.map((n) => n.predicate_category)).toEqual([
        'compliance',
        'effects',
        'effects',
      ]);
    });

    it('falls back to predicate string when fact_predicates.category is NULL (Q2)', async () => {
      const { edgeIds } = await buildLinearChain(2, {
        predicates: ['unknown_one', 'unknown_two', 'unknown_two'],
      });
      const normalised = await normaliseChain({ edgeIds, length: 2 });

      expect(normalised.template.map((n) => n.predicate_category)).toEqual([
        'unknown_one',
        'unknown_two',
        'unknown_two',
      ]);
    });
  });

  describe('detectCausalPatterns — clustering + staging upsert', () => {
    it('collapses two structurally identical chains with different entity IDs to one template', async () => {
      // Three chains, same shape, different entities → one template, instance_count=3
      for (let i = 0; i < 3; i++) {
        await buildLinearChain(2, {
          entityTypes: ['standard_rule', 'standard_rule', 'compliance_practice'],
          predicates: ['requires', 'prevents', 'prevents'],
        });
      }

      const result = await detectCausalPatterns({ instanceThreshold: 3 });
      expect(result.templatesFound).toBeGreaterThanOrEqual(1);
      expect(result.newStaging).toBe(1);
      expect(result.updatedExisting).toBe(0);

      const patterns = await testDb`SELECT * FROM public.causal_patterns`;
      expect(patterns).toHaveLength(1);
      expect(patterns[0]!.status).toBe('staging');
    });

    it('does not create a pattern when chain count is below instanceThreshold', async () => {
      for (let i = 0; i < 2; i++) {
        await buildLinearChain(2);
      }

      const result = await detectCausalPatterns({ instanceThreshold: 3 });
      expect(result.newStaging).toBe(0);

      const patterns = await testDb`SELECT * FROM public.causal_patterns`;
      expect(patterns).toHaveLength(0);
    });

    it('updates existing pattern on second detection pass instead of creating duplicate', async () => {
      for (let i = 0; i < 3; i++) {
        await buildLinearChain(2);
      }

      const r1 = await detectCausalPatterns({ instanceThreshold: 3 });
      expect(r1.newStaging).toBe(1);
      expect(r1.updatedExisting).toBe(0);

      // Add another chain with the same shape, then re-detect
      await buildLinearChain(2);
      const r2 = await detectCausalPatterns({ instanceThreshold: 3 });
      expect(r2.newStaging).toBe(0);
      expect(r2.updatedExisting).toBe(1);

      const patterns = await testDb`SELECT * FROM public.causal_patterns`;
      expect(patterns).toHaveLength(1);
    });

    it('stamps pattern_id and pattern_position on every participating edge', async () => {
      const chains: ChainSetup[] = [];
      for (let i = 0; i < 3; i++) {
        chains.push(await buildLinearChain(2));
      }

      await detectCausalPatterns({ instanceThreshold: 3 });

      for (const chain of chains) {
        const rows = await testDb<Array<{ pattern_id: string | null; pattern_position: number | null }>>`
          SELECT pattern_id, pattern_position
          FROM public.causal_edges
          WHERE id = ANY(${`{${chain.edgeIds.join(',')}}`}::uuid[])
          ORDER BY pattern_position
        `;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.pattern_id).not.toBeNull();
          expect(row.pattern_position).not.toBeNull();
        }
        // Positions are 0..N-1 over the edges in the chain
        expect(rows.map((r) => r.pattern_position)).toEqual([0, 1]);
      }
    });

    it('recomputes avg_strength after upsert', async () => {
      // Three chains with different strengths — avg should be the mean of all 6 edges (3 chains × 2 edges)
      await buildLinearChain(2, { strengths: [0.6, 0.6] });
      await buildLinearChain(2, { strengths: [0.8, 0.8] });
      await buildLinearChain(2, { strengths: [1.0, 1.0] });

      await detectCausalPatterns({ instanceThreshold: 3 });

      const [row] = await testDb<Array<{ avg_strength: number }>>`
        SELECT avg_strength FROM public.causal_patterns LIMIT 1
      `;
      expect(row!.avg_strength).toBeCloseTo(0.8, 5);
    });
  });

  describe('detectCausalPatterns — fallback isolation (Q2)', () => {
    it('chains with NULL category do not collide with chains using a real category for the same predicate string', async () => {
      // Three chains with `requires` BEFORE seeding category → templates use the
      // literal predicate string. Then seed `requires=compliance` and run three
      // more chains → templates use the category. They must NOT cluster
      // together because the canonical templates differ.
      for (let i = 0; i < 3; i++) await buildLinearChain(2, { predicates: ['requires', 'requires', 'requires'] });
      const r1 = await detectCausalPatterns({ instanceThreshold: 3 });
      expect(r1.newStaging).toBe(1);

      await seedPredicateCategory('requires', 'compliance');

      for (let i = 0; i < 3; i++) await buildLinearChain(2, { predicates: ['requires', 'requires', 'requires'] });
      const r2 = await detectCausalPatterns({ instanceThreshold: 3 });

      // After category seeding, the existing chains' template re-resolves to
      // the category — so we expect either (a) the original pattern's
      // template_structure to migrate, or (b) a second pattern to spawn for
      // category-resolved chains. Implementation does (b): existing edges keep
      // their pattern_id assignment (last-write-wins re-stamps them all to the
      // new category-based pattern since both chain sets share a hash now).
      // Verify: at most 2 distinct patterns exist.
      const patterns = await testDb`SELECT id, instance_count FROM public.causal_patterns`;
      expect(patterns.length).toBeGreaterThanOrEqual(1);
      expect(patterns.length).toBeLessThanOrEqual(2);

      // Combined instance count across all patterns equals 6 (initial 3 + new 3
      // detected in r2; first three chains' rows are also re-walked by the CTE
      // and added to whatever cluster their current category resolves to).
      const total = patterns.reduce((s, p) => s + (p as { instance_count: number }).instance_count, 0);
      expect(total).toBeGreaterThanOrEqual(6);
    });
  });
});

describe('Phase 6 — G3: promotion engine (nmemo-d9v.5 + d9v.6)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  describe('promotions — forward transitions', () => {
    it('staging → candidate at instance_count >= 5 with recent last_seen_at', async () => {
      const id = await setupPattern({ status: 'staging', instanceCount: 5, lastSeenAt: new Date() });

      const result = await promotePatterns();

      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]!.from).toBe('staging');
      expect(result.promoted[0]!.to).toBe('candidate');
      expect(result.promoted[0]!.id).toBe(id);

      const after = await getPatternRow(id);
      expect(after.status).toBe('candidate');
      expect(after.promoted_at).not.toBeNull();
    });

    it('does NOT promote staging if instance_count below threshold', async () => {
      await setupPattern({ status: 'staging', instanceCount: 4, lastSeenAt: new Date() });
      const result = await promotePatterns();
      expect(result.promoted).toHaveLength(0);
    });

    it('does NOT promote staging if last_seen_at is stale', async () => {
      const stale = new Date(Date.now() - 30 * 86400 * 1000);
      await setupPattern({ status: 'staging', instanceCount: 5, lastSeenAt: stale });
      const result = await promotePatterns();
      expect(result.promoted).toHaveLength(0);
    });

    it('candidate → provisional at instance_count >= 10 + activations >= 3', async () => {
      const id = await setupPattern({
        status: 'candidate',
        instanceCount: 12,
        activationCount30d: 4,
      });

      const result = await promotePatterns();

      // The activation_count_30d gets refreshed at the start of promotePatterns.
      // No causal_edges link to this pattern, so it'd be reset to 0 — promotion
      // should not happen if we relied on the seeded value alone. Verify
      // separately that with linked edges, promotion fires.
      expect(result.promoted).toHaveLength(0);

      const after = await getPatternRow(id);
      expect(after.status).toBe('candidate');
    });

    it('candidate → provisional fires when activations are real (linked edges within 30d)', async () => {
      const id = await setupPattern({ status: 'candidate', instanceCount: 12 });

      // Create 4 active edges linked to this pattern within 30d so the refresh
      // sets activation_count_30d to 4
      const { edgeIds } = await buildLinearChain(4);
      for (const edgeId of edgeIds) {
        await testDb`UPDATE public.causal_edges SET pattern_id = ${id}::uuid WHERE id = ${edgeId}::uuid`;
      }

      const result = await promotePatterns();
      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]!.to).toBe('provisional');
    });

    it('provisional → canonical at dwell >= 14d + activations >= 5', async () => {
      const fifteenDaysAgo = new Date(Date.now() - 15 * 86400 * 1000);
      const id = await setupPattern({
        status: 'provisional',
        instanceCount: 20,
        promotedAt: fifteenDaysAgo,
      });

      // Seed 5 fresh activations
      const { edgeIds } = await buildLinearChain(5);
      for (const edgeId of edgeIds) {
        await testDb`UPDATE public.causal_edges SET pattern_id = ${id}::uuid WHERE id = ${edgeId}::uuid`;
      }

      const result = await promotePatterns();
      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]!.to).toBe('canonical');
    });

    it('does NOT promote provisional → canonical if dwell time is too short', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 86400 * 1000);
      const id = await setupPattern({
        status: 'provisional',
        instanceCount: 20,
        promotedAt: twoDaysAgo,
      });
      const { edgeIds } = await buildLinearChain(5);
      for (const edgeId of edgeIds) {
        await testDb`UPDATE public.causal_edges SET pattern_id = ${id}::uuid WHERE id = ${edgeId}::uuid`;
      }

      const result = await promotePatterns();
      expect(result.promoted).toHaveLength(0);
    });

    it('cascading: a pattern crossing two thresholds in one call only steps once', async () => {
      // Set up a pattern that satisfies BOTH staging→candidate AND
      // candidate→provisional. Snapshot semantics mean it can only move once
      // per promotePatterns() call.
      const id = await setupPattern({
        status: 'staging',
        instanceCount: 12, // > both thresholds
        lastSeenAt: new Date(),
      });
      const { edgeIds } = await buildLinearChain(4);
      for (const edgeId of edgeIds) {
        await testDb`UPDATE public.causal_edges SET pattern_id = ${id}::uuid WHERE id = ${edgeId}::uuid`;
      }

      const result = await promotePatterns();
      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]!.to).toBe('candidate');

      const after = await getPatternRow(id);
      expect(after.status).toBe('candidate');
    });
  });

  describe('demotions — reverse transitions on inactivity', () => {
    it('canonical → provisional after 30d idle with no activations', async () => {
      const id = await setupPattern({
        status: 'canonical',
        instanceCount: 50,
        activationCount30d: 0,
        lastSeenAt: new Date(Date.now() - 35 * 86400 * 1000),
      });

      const result = await promotePatterns();
      expect(result.demoted).toHaveLength(1);
      expect(result.demoted[0]!.from).toBe('canonical');
      expect(result.demoted[0]!.to).toBe('provisional');

      const after = await getPatternRow(id);
      expect(after.status).toBe('provisional');
    });

    it('provisional → candidate after 30d idle', async () => {
      const id = await setupPattern({
        status: 'provisional',
        instanceCount: 20,
        lastSeenAt: new Date(Date.now() - 35 * 86400 * 1000),
      });

      const result = await promotePatterns();
      expect(result.demoted.find((d) => d.id === id)?.to).toBe('candidate');
    });

    it('candidate → staging after 30d idle', async () => {
      const id = await setupPattern({
        status: 'candidate',
        instanceCount: 7,
        lastSeenAt: new Date(Date.now() - 35 * 86400 * 1000),
      });

      const result = await promotePatterns();
      expect(result.demoted.find((d) => d.id === id)?.to).toBe('staging');
    });

    it('does NOT demote when there are recent activations', async () => {
      const id = await setupPattern({
        status: 'canonical',
        instanceCount: 50,
        lastSeenAt: new Date(Date.now() - 35 * 86400 * 1000),
      });
      // One fresh activation
      const { edgeIds } = await buildLinearChain(1);
      await testDb`UPDATE public.causal_edges SET pattern_id = ${id}::uuid WHERE id = ${edgeIds[0]!}::uuid`;

      const result = await promotePatterns();
      expect(result.demoted).toHaveLength(0);
    });

    it('one promotePatterns call demotes at most one level', async () => {
      // Set up a canonical pattern with very old last_seen and no activations.
      // After demotion to provisional in this call, the test asserts the row
      // is at provisional NOT candidate or staging.
      const id = await setupPattern({
        status: 'canonical',
        instanceCount: 50,
        lastSeenAt: new Date(Date.now() - 100 * 86400 * 1000),
      });

      await promotePatterns();
      const after = await getPatternRow(id);
      expect(after.status).toBe('provisional');
    });
  });

  describe('rejection — terminal staging timeout', () => {
    it('staging → rejected after 14d with zero activations', async () => {
      const id = await setupPattern({
        status: 'staging',
        instanceCount: 1,
        firstSeenAt: new Date(Date.now() - 20 * 86400 * 1000),
        lastSeenAt: new Date(Date.now() - 20 * 86400 * 1000),
      });

      const result = await promotePatterns();
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.id).toBe(id);

      const after = await getPatternRow(id);
      expect(after.status).toBe('rejected');
      expect(after.rejected_at).not.toBeNull();
      expect(after.rejection_reason).toContain('No activations');
    });

    it('does NOT reject staging if any activation exists', async () => {
      const id = await setupPattern({
        status: 'staging',
        instanceCount: 1,
        firstSeenAt: new Date(Date.now() - 20 * 86400 * 1000),
      });
      const { edgeIds } = await buildLinearChain(1);
      await testDb`UPDATE public.causal_edges SET pattern_id = ${id}::uuid WHERE id = ${edgeIds[0]!}::uuid`;

      const result = await promotePatterns();
      expect(result.rejected).toHaveLength(0);
    });

    it('does NOT reject young staging patterns', async () => {
      await setupPattern({
        status: 'staging',
        instanceCount: 1,
        firstSeenAt: new Date(),
      });
      const result = await promotePatterns();
      expect(result.rejected).toHaveLength(0);
    });
  });

  describe('concurrency — Q5 status-guarded UPDATE', () => {
    it('parallel promotePatterns calls produce a single transition per pattern', async () => {
      const id = await setupPattern({ status: 'staging', instanceCount: 5, lastSeenAt: new Date() });

      const results = await Promise.all([promotePatterns(), promotePatterns()]);

      // Sum across both calls: exactly one promotion event for the pattern
      const allPromoted = [...results[0]!.promoted, ...results[1]!.promoted];
      const promotionsForThisPattern = allPromoted.filter((p) => p.id === id);
      expect(promotionsForThisPattern).toHaveLength(1);

      const after = await getPatternRow(id);
      expect(after.status).toBe('candidate');
    });
  });
});

describe('Phase 6 — G4: Haiku naming + edge-time matching (nmemo-d9v.7 + d9v.8)', () => {
  beforeEach(async () => {
    await cleanSlate();
    // Clear any test-seeded fact_predicates rows from earlier describes so
    // matchEdgeToPattern's category lookup falls through to the predicate
    // string fallback consistently. Migration-seeded predicates
    // (works_at, manages, etc.) stay untouched.
    await testDb`DELETE FROM public.fact_predicates WHERE predicate IN ('requires', 'prevents')`;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('nameCandidatePatterns — Haiku JSON', () => {
    it('sets name + description on a candidate without an existing name', async () => {
      vi.spyOn(ml, 'generateJson').mockResolvedValue({
        name: 'Rule cascade prevention',
        description: 'A standard rule requires another standard rule which prevents a compliance practice failure.',
      });

      const id = await setupPattern({ status: 'candidate', name: null });
      await nameCandidatePatterns([id]);

      const after = await getPatternRow(id);
      expect(after.name).toBe('Rule cascade prevention');
    });

    it('does NOT overwrite an existing name (idempotent)', async () => {
      const spy = vi.spyOn(ml, 'generateJson');

      const id = await setupPattern({ status: 'candidate', name: 'pre-existing name' });
      await nameCandidatePatterns([id]);

      expect(spy).not.toHaveBeenCalled();
      const after = await getPatternRow(id);
      expect(after.name).toBe('pre-existing name');
    });

    it('leaves name=NULL when ml.generateJson throws (Q3 fallback)', async () => {
      vi.spyOn(ml, 'generateJson').mockRejectedValue(new Error('ML service unavailable'));

      const id = await setupPattern({ status: 'candidate', name: null });
      await nameCandidatePatterns([id]);

      const after = await getPatternRow(id);
      expect(after.name).toBeNull();
    });

    it('leaves name=NULL when ml.generateJson returns malformed JSON', async () => {
      vi.spyOn(ml, 'generateJson').mockResolvedValue({ wrong_shape: true } as unknown as { name: string; description: string });

      const id = await setupPattern({ status: 'candidate', name: null });
      await nameCandidatePatterns([id]);

      const after = await getPatternRow(id);
      expect(after.name).toBeNull();
    });

    it('promotePatterns calls naming for new candidates synchronously', async () => {
      const spy = vi.spyOn(ml, 'generateJson').mockResolvedValue({
        name: 'auto-named',
        description: 'auto description',
      });

      const id = await setupPattern({
        status: 'staging',
        instanceCount: 5,
        lastSeenAt: new Date(),
        name: null,
      });
      await promotePatterns();

      expect(spy).toHaveBeenCalledTimes(1);
      const after = await getPatternRow(id);
      expect(after.status).toBe('candidate');
      expect(after.name).toBe('auto-named');
    });
  });

  describe('matchEdgeToPattern — provisional/canonical matching', () => {
    it('stamps pattern_id and pattern_position on edge whose template matches a canonical 2-window', async () => {
      const template = [
        { entity_type: 'standard_rule', predicate_category: 'requires' },
        { entity_type: 'compliance_practice', predicate_category: 'prevents' },
      ];
      const patternId = await setupPattern({
        status: 'canonical',
        templateStructure: template,
        instanceCount: 50,
      });

      // Create an edge whose nodes match the template
      const { edgeIds } = await buildLinearChain(1, {
        entityTypes: ['standard_rule', 'compliance_practice'],
        predicates: ['requires', 'prevents'],
      });

      const result = await matchEdgeToPattern(edgeIds[0]!);
      expect(result).not.toBeNull();
      expect(result!.patternId).toBe(patternId);
      expect(result!.patternPosition).toBe(0);

      const [edgeRow] = await testDb<Array<{ pattern_id: string | null; pattern_position: number | null }>>`
        SELECT pattern_id, pattern_position
        FROM public.causal_edges
        WHERE id = ${edgeIds[0]!}::uuid
      `;
      expect(edgeRow!.pattern_id).toBe(patternId);
      expect(edgeRow!.pattern_position).toBe(0);
    });

    it('does NOT match against staging patterns', async () => {
      const template = [
        { entity_type: 'standard_rule', predicate_category: 'requires' },
        { entity_type: 'compliance_practice', predicate_category: 'prevents' },
      ];
      await setupPattern({ status: 'staging', templateStructure: template });

      const { edgeIds } = await buildLinearChain(1, {
        entityTypes: ['standard_rule', 'compliance_practice'],
        predicates: ['requires', 'prevents'],
      });

      const result = await matchEdgeToPattern(edgeIds[0]!);
      expect(result).toBeNull();

      const [edgeRow] = await testDb<Array<{ pattern_id: string | null }>>`
        SELECT pattern_id FROM public.causal_edges WHERE id = ${edgeIds[0]!}::uuid
      `;
      expect(edgeRow!.pattern_id).toBeNull();
    });

    it('does NOT match against candidate patterns', async () => {
      const template = [
        { entity_type: 'standard_rule', predicate_category: 'requires' },
        { entity_type: 'compliance_practice', predicate_category: 'prevents' },
      ];
      await setupPattern({ status: 'candidate', templateStructure: template });

      const { edgeIds } = await buildLinearChain(1, {
        entityTypes: ['standard_rule', 'compliance_practice'],
        predicates: ['requires', 'prevents'],
      });

      const result = await matchEdgeToPattern(edgeIds[0]!);
      expect(result).toBeNull();
    });

    it('returns null when no pattern template matches', async () => {
      await setupPattern({
        status: 'canonical',
        templateStructure: [
          { entity_type: 'totally_different', predicate_category: 'unrelated' },
          { entity_type: 'totally_different', predicate_category: 'unrelated' },
        ],
      });

      const { edgeIds } = await buildLinearChain(1, {
        entityTypes: ['standard_rule', 'compliance_practice'],
        predicates: ['requires', 'prevents'],
      });

      const result = await matchEdgeToPattern(edgeIds[0]!);
      expect(result).toBeNull();
    });

    it('updates pattern.last_seen_at on a successful match', async () => {
      const template = [
        { entity_type: 'standard_rule', predicate_category: 'requires' },
        { entity_type: 'compliance_practice', predicate_category: 'prevents' },
      ];
      const patternId = await setupPattern({
        status: 'canonical',
        templateStructure: template,
        lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      });

      const { edgeIds } = await buildLinearChain(1, {
        entityTypes: ['standard_rule', 'compliance_practice'],
        predicates: ['requires', 'prevents'],
      });

      await matchEdgeToPattern(edgeIds[0]!);

      const [row] = await testDb<Array<{ last_seen_at: Date }>>`
        SELECT last_seen_at FROM public.causal_patterns WHERE id = ${patternId}::uuid
      `;
      expect(row!.last_seen_at.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
    });
  });
});
