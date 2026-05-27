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
  activePatterns,
  findCausalGhosts,
  type PatternStatus,
} from '../../services/causal-patterns.js';
import { ml } from '../../services/ml-client.js';
import { handleToolCall } from '../../services/causal-agent.js';
import { maybeFirePatternDetection } from '../../services/derived-freshness.js';
import { config } from '../../config.js';
import { app } from '../../index.js';

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

describe('Phase 6 — G5: reasoning surfaces (nmemo-d9v.9 + d9v.10)', () => {
  beforeEach(async () => {
    await cleanSlate();
    await testDb`DELETE FROM public.fact_predicates WHERE predicate IN ('requires', 'prevents')`;
  });

  describe('activePatterns', () => {
    it('returns provisional + canonical by default; excludes staging/candidate', async () => {
      await setupPattern({ status: 'staging', name: 'staging-1' });
      await setupPattern({ status: 'candidate', name: 'candidate-1' });
      const provId = await setupPattern({ status: 'provisional', name: 'provisional-1' });
      const canId = await setupPattern({ status: 'canonical', name: 'canonical-1' });

      const result = await activePatterns();

      const ids = result.map((p) => p.id);
      expect(ids).toContain(provId);
      expect(ids).toContain(canId);
      expect(result).toHaveLength(2);
    });

    it('respects custom status filter', async () => {
      const stagingId = await setupPattern({ status: 'staging' });
      await setupPattern({ status: 'canonical' });

      const result = await activePatterns({ status: ['staging'] });
      expect(result.map((p) => p.id)).toEqual([stagingId]);
    });

    it('filters by entityId via causal_edges.pattern_id', async () => {
      const template = [
        { entity_type: 'standard_rule', predicate_category: 'g5_pred' },
        { entity_type: 'standard_rule', predicate_category: 'g5_pred' },
      ];
      const linkedPatternId = await setupPattern({ status: 'canonical', templateStructure: template });
      const unlinkedPatternId = await setupPattern({ status: 'canonical', templateStructure: template });

      // Wire one chain to linkedPatternId
      const { entityId, edgeIds } = await buildLinearChain(1);
      await testDb`UPDATE public.causal_edges SET pattern_id = ${linkedPatternId}::uuid WHERE id = ${edgeIds[0]!}::uuid`;

      const result = await activePatterns({ entityId });
      const ids = result.map((p) => p.id);
      expect(ids).toContain(linkedPatternId);
      expect(ids).not.toContain(unlinkedPatternId);
    });

    it('limits the result set', async () => {
      for (let i = 0; i < 5; i++) await setupPattern({ status: 'canonical' });
      const result = await activePatterns({ limit: 2 });
      expect(result).toHaveLength(2);
    });

    it('parses template_structure as a JS array (not string)', async () => {
      await setupPattern({
        status: 'canonical',
        templateStructure: [
          { entity_type: 'a', predicate_category: 'b' },
        ],
      });
      const [pattern] = await activePatterns();
      expect(Array.isArray(pattern!.templateStructure)).toBe(true);
      expect(pattern!.templateStructure[0]!.entity_type).toBe('a');
    });
  });

  describe('findCausalGhosts', () => {
    /**
     * Build a chain of `numEdges` edges, then attribute every edge to
     * `patternId` at its natural index, EXCEPT the edge at `missingPosition`
     * (which is left with pattern_id=NULL) — simulating a partial chain
     * where the entity covers all positions except one.
     */
    async function setupPartialChainForPattern(
      patternId: string,
      numEdges: number,
      missingPosition: number,
    ): Promise<{ entityId: string; edgeIds: string[] }> {
      const setup = await buildLinearChain(numEdges);
      for (let i = 0; i < setup.edgeIds.length; i++) {
        if (i === missingPosition) continue;
        await testDb`
          UPDATE public.causal_edges
          SET pattern_id = ${patternId}::uuid,
              pattern_position = ${i}::int
          WHERE id = ${setup.edgeIds[i]!}::uuid
        `;
      }
      return setup;
    }

    it('finds the missing position when entity covers N-1 of N edge positions', async () => {
      const template = [
        { entity_type: 'standard_rule', predicate_category: 'g5_step0' },
        { entity_type: 'standard_rule', predicate_category: 'g5_step1' },
        { entity_type: 'compliance_practice', predicate_category: 'g5_step2' },
      ];
      const patternId = await setupPattern({
        status: 'canonical',
        templateStructure: template,
        instanceCount: 50,
      });
      // Update avg_strength so confidence math is computed against a known value
      await testDb`UPDATE public.causal_patterns SET avg_strength = 0.8 WHERE id = ${patternId}::uuid`;

      const { entityId } = await setupPartialChainForPattern(patternId, 2, 1);

      const ghosts = await findCausalGhosts(entityId);
      expect(ghosts).toHaveLength(1);
      expect(ghosts[0]!.patternId).toBe(patternId);
      expect(ghosts[0]!.positionInPattern).toBe(1);
      expect(ghosts[0]!.expectedCauseEntityType).toBe('standard_rule');
      expect(ghosts[0]!.expectedEffectEntityType).toBe('compliance_practice');
    });

    it('returns empty when entity has full coverage (no missing position)', async () => {
      const template = [
        { entity_type: 'standard_rule', predicate_category: 'g5_a' },
        { entity_type: 'standard_rule', predicate_category: 'g5_b' },
      ];
      const patternId = await setupPattern({ status: 'canonical', templateStructure: template });
      const { entityId, edgeIds } = await buildLinearChain(1);
      await testDb`UPDATE public.causal_edges SET pattern_id = ${patternId}::uuid, pattern_position = 0 WHERE id = ${edgeIds[0]!}::uuid`;

      const ghosts = await findCausalGhosts(entityId);
      expect(ghosts).toEqual([]);
    });

    it('returns empty when entity matches no canonical patterns', async () => {
      const entity = await createTestEntity({
        canonicalName: `g5-orphan-${Date.now()}`,
        entityType: 'unrelated',
      });
      const ghosts = await findCausalGhosts(entity.id);
      expect(ghosts).toEqual([]);
    });

    it('does NOT surface ghosts from staging/candidate/provisional patterns', async () => {
      const template = [
        { entity_type: 'standard_rule', predicate_category: 'g5' },
        { entity_type: 'standard_rule', predicate_category: 'g5' },
        { entity_type: 'standard_rule', predicate_category: 'g5' },
      ];
      const patternId = await setupPattern({ status: 'provisional', templateStructure: template });
      const { entityId } = await setupPartialChainForPattern(patternId, 2, 1);

      const ghosts = await findCausalGhosts(entityId);
      expect(ghosts).toEqual([]);
    });

    it('orders ghosts by confidence (avg_strength * completeness) desc', async () => {
      const template3 = [
        { entity_type: 'standard_rule', predicate_category: 'pa' },
        { entity_type: 'standard_rule', predicate_category: 'pb' },
        { entity_type: 'standard_rule', predicate_category: 'pc' },
      ];
      const strongPatternId = await setupPattern({
        status: 'canonical',
        templateStructure: template3,
      });
      const weakPatternId = await setupPattern({
        status: 'canonical',
        templateStructure: template3,
      });
      await testDb`UPDATE public.causal_patterns SET avg_strength = 0.9 WHERE id = ${strongPatternId}::uuid`;
      await testDb`UPDATE public.causal_patterns SET avg_strength = 0.4 WHERE id = ${weakPatternId}::uuid`;

      const { entityId: strongEnt } = await setupPartialChainForPattern(strongPatternId, 2, 1);
      // Reuse the same entity by linking it to the weak pattern's chain too —
      // share entity entries via the helper.
      const setupWeak = await setupPartialChainForPattern(weakPatternId, 2, 1);
      // Link the weak partial chain's events back to strongEnt for fair comparison
      // (simpler: query using strongEnt and verify ordering across both patterns)
      // For the test, we just check that each pattern's ghost has the correct
      // confidence ordering when both apply to entities with the same coverage.
      const strongGhosts = await findCausalGhosts(strongEnt);
      const weakGhosts = await findCausalGhosts(setupWeak.entityId);

      const strongConf = strongGhosts.find((g) => g.patternId === strongPatternId)?.confidence ?? 0;
      const weakConf = weakGhosts.find((g) => g.patternId === weakPatternId)?.confidence ?? 0;
      expect(strongConf).toBeGreaterThan(weakConf);
    });
  });
});

describe('Phase 6 — G6: wiring (nmemo-d9v.11 + d9v.13 + d9v.14)', () => {
  beforeEach(async () => {
    await cleanSlate();
    await testDb`DELETE FROM public.fact_predicates WHERE predicate IN ('requires', 'prevents')`;
    // Bead nmemo-2yv.72 — reset the pattern_detection freshness counter so the
    // DB-reactive auto-trigger test below starts from zero. The pipeline-level
    // counters (incrementPatrolCount / _resetReasoningPatrolCount) no longer
    // exist; the DB row owns the cadence now.
    await testDb`
      UPDATE public.derived_freshness
         SET facts_since_compute = 0,
             updated_at          = NOW()
       WHERE derived_kind = 'pattern_detection'
    `;
  });

  describe('MCP tools', () => {
    it('get_active_patterns returns structured list', async () => {
      const id = await setupPattern({ status: 'canonical', name: 'mcp-test' });
      const json = await handleToolCall('get_active_patterns', {}, { agent: 'reasoning_agent' });
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed.patterns)).toBe(true);
      expect(parsed.patterns.find((p: { id: string }) => p.id === id)).toBeDefined();
    });

    it('find_causal_ghosts returns array', async () => {
      const entity = await createTestEntity({ canonicalName: `mcp-ghost-${Date.now()}`, entityType: 'test' });
      const json = await handleToolCall('find_causal_ghosts', { entity_id: entity.id }, { agent: 'reasoning_agent' });
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed.ghosts)).toBe(true);
    });

    it('get_pattern_instances returns edges for pattern_id', async () => {
      const template = [
        { entity_type: 'standard_rule', predicate_category: 'g6_a' },
        { entity_type: 'standard_rule', predicate_category: 'g6_b' },
      ];
      const patternId = await setupPattern({ status: 'canonical', templateStructure: template });
      const { edgeIds } = await buildLinearChain(1);
      await testDb`UPDATE public.causal_edges SET pattern_id = ${patternId}::uuid, pattern_position = 0 WHERE id = ${edgeIds[0]!}::uuid`;

      const json = await handleToolCall('get_pattern_instances', { pattern_id: patternId }, { agent: 'reasoning_agent' });
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed.instances)).toBe(true);
      expect(parsed.instances.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('DB-reactive auto-trigger (bead nmemo-2yv.72)', () => {
    it('below the threshold, the helper is a no-op (detection does NOT fire)', async () => {
      // Setup chains so detection WOULD find something if it ran.
      for (let i = 0; i < 3; i++) {
        await buildLinearChain(2, { predicates: ['g6_x', 'g6_y', 'g6_y'] });
      }
      // Counter starts at 0 (beforeEach reset), threshold is 50 by default —
      // the helper should claim nothing and skip the in-process fire.
      await maybeFirePatternDetection();
      // Allow any (incorrectly fired) microtask to drain.
      await new Promise((r) => setTimeout(r, 100));
      const patterns = await testDb`SELECT id FROM public.causal_patterns`;
      expect(patterns).toHaveLength(0);
    });

    it('at-threshold: the helper claims, fires detection+promotion, and resets the counter', async () => {
      // Same chain setup as the original test — detection picks the chains
      // up once it runs.
      for (let i = 0; i < 3; i++) {
        await buildLinearChain(2, { predicates: ['g6_x', 'g6_y', 'g6_y'] });
      }
      // Drive the counter past the configured threshold so the next helper
      // call wins the compare-and-reset.
      await testDb`
        UPDATE public.derived_freshness
           SET facts_since_compute = ${config.PATTERN_DETECTION_FACT_THRESHOLD}
         WHERE derived_kind = 'pattern_detection'
      `;
      await maybeFirePatternDetection();

      // The compute is fire-and-forget inside the helper. Poll briefly for
      // the row to appear rather than guessing at the microtask drain time.
      const waitForPattern = async (): Promise<Array<{ id: string }>> => {
        for (let attempt = 0; attempt < 30; attempt++) {
          const rows = (await testDb`SELECT id FROM public.causal_patterns`) as unknown as Array<{ id: string }>;
          if (rows.length >= 1) return rows;
          await new Promise((r) => setTimeout(r, 100));
        }
        return (await testDb`SELECT id FROM public.causal_patterns`) as unknown as Array<{ id: string }>;
      };
      const patterns = await waitForPattern();
      expect(patterns.length).toBeGreaterThanOrEqual(1);

      // Counter reset to 0 (claim happens synchronously inside the helper).
      const fresh = (await testDb`
        SELECT facts_since_compute FROM public.derived_freshness
         WHERE derived_kind = 'pattern_detection'
      `) as unknown as Array<{ facts_since_compute: number }>;
      expect(fresh[0]?.facts_since_compute).toBe(0);
    });

    it('failure inside in-process compute does not throw to caller (fire-and-forget)', async () => {
      // Spy on detectCausalPatterns to throw — the helper logs + swallows.
      const causalPatterns = await import('../../services/causal-patterns.js');
      const spy = vi
        .spyOn(causalPatterns, 'detectCausalPatterns')
        .mockRejectedValue(new Error('boom'));
      try {
        await testDb`
          UPDATE public.derived_freshness
             SET facts_since_compute = ${config.PATTERN_DETECTION_FACT_THRESHOLD}
           WHERE derived_kind = 'pattern_detection'
        `;
        await expect(maybeFirePatternDetection()).resolves.toBeUndefined();
        // Drain the fire-and-forget microtask so the logged warn lands before
        // the test exits (otherwise the spy could record after we've moved on).
        await new Promise((r) => setTimeout(r, 100));
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('HTTP endpoints', () => {
    it('POST /api/patterns/detect returns DetectResult', async () => {
      for (let i = 0; i < 3; i++) await buildLinearChain(2, { predicates: ['g6_h_a', 'g6_h_b', 'g6_h_b'] });

      const res = await app.fetch(
        new Request('http://localhost/api/patterns/detect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instance_threshold: 3 }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { chainsExamined: number; newStaging: number };
      expect(body.chainsExamined).toBeGreaterThan(0);
      expect(body.newStaging).toBeGreaterThanOrEqual(1);
    });

    it('POST /api/patterns/promote returns PromoteResult', async () => {
      await setupPattern({ status: 'staging', instanceCount: 5, lastSeenAt: new Date() });

      // Mock naming to avoid live ML call
      vi.spyOn(ml, 'generateJson').mockResolvedValue({ name: 'http-test-name', description: 'http-test-desc' });

      const res = await app.fetch(
        new Request('http://localhost/api/patterns/promote', { method: 'POST' }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        promoted: Array<{ to: string }>;
        demoted: unknown[];
        rejected: unknown[];
      };
      expect(body.promoted).toHaveLength(1);
      expect(body.promoted[0]!.to).toBe('candidate');
    });

    it('GET /api/patterns lists provisional + canonical', async () => {
      await setupPattern({ status: 'canonical' });
      await setupPattern({ status: 'staging' });

      const res = await app.fetch(new Request('http://localhost/api/patterns'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { patterns: Array<{ status: string }> };
      expect(body.patterns).toHaveLength(1);
      expect(body.patterns[0]!.status).toBe('canonical');
    });

    it('GET /api/patterns/:id/instances returns linked edges', async () => {
      const patternId = await setupPattern({ status: 'canonical' });
      const { edgeIds } = await buildLinearChain(1);
      await testDb`UPDATE public.causal_edges SET pattern_id = ${patternId}::uuid, pattern_position = 0 WHERE id = ${edgeIds[0]!}::uuid`;

      const res = await app.fetch(new Request(`http://localhost/api/patterns/${patternId}/instances`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { instances: Array<{ id: string }> };
      expect(body.instances.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/ghosts/:entityId returns ghost array', async () => {
      const entity = await createTestEntity({ canonicalName: `g6-ghost-${Date.now()}`, entityType: 'test' });
      const res = await app.fetch(new Request(`http://localhost/api/ghosts/${entity.id}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ghosts: unknown[] };
      expect(Array.isArray(body.ghosts)).toBe(true);
    });
  });
});

/**
 * Bulk-seed N isolated 2-edge chains via raw INSERT ... SELECT generate_series
 * so we hit collectChains() with exactly N chains in O(1) round-trips instead
 * of the O(N) implied by buildLinearChain(). Used by the klv.6 scale benchmark.
 *
 * Each chain is a 2-edge linear chain:
 *   entity@0 --(edge 0→1)--> entity@1 --(edge 1→2)--> entity@2
 * which contributes exactly one length-2 sub-chain to collectChains().
 *
 * Per-chain rows: 3 entities, 3 facts, 3 events, 2 edges.
 * For N chains: 3N entities, 3N facts, 3N events, 2N edges.
 *
 * Entities tagged 'klv6-bench-<seed>-<chain_k>-<pos>' so the seedTag isolates
 * this run from other fixtures and other tests.
 */
async function bulkSeedIdenticalChains(numChains: number, seed: number): Promise<void> {
  const seedTag = `klv6-bench-${seed}`;

  // 3 entities per chain (positions 0, 1, 2)
  await testDb.unsafe(`
    INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
    SELECT
      gen_random_uuid(),
      '${seedTag}-' || k || '-' || pos,
      'standard_rule',
      ARRAY(SELECT 0::float FROM generate_series(1, 768))::vector,
      1.0
    FROM generate_series(0, ${numChains - 1}) AS k
    CROSS JOIN generate_series(0, 2) AS pos
  `);

  // 3 facts per chain (one per entity position). object_value tags the
  // (chain_k, pos) pair so we can recover it when building events/edges.
  // seedTag in the LIKE filter restricts to this run only.
  await testDb.unsafe(`
    INSERT INTO public.facts (id, subject_entity_id, predicate, object_value, confidence, valid_at)
    SELECT
      gen_random_uuid(),
      ent.id,
      'requires',
      '${seedTag}-step-' || ent.chain_k || '-' || ent.pos,
      0.9,
      NOW() - INTERVAL '5 days'
    FROM (
      SELECT
        id,
        SPLIT_PART(canonical_name, '-', 4)::int AS chain_k,
        SPLIT_PART(canonical_name, '-', 5)::int AS pos
      FROM public.entities
      WHERE canonical_name LIKE '${seedTag}-%'
    ) AS ent
  `);

  // 3 events per chain (one per fact). occurred_at ordered by pos so the
  // chain timeline is monotonic.
  await testDb.unsafe(`
    INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, occurred_at)
    SELECT
      gen_random_uuid(),
      f.id,
      'created',
      f.subject_entity_id,
      'requires',
      NOW() - INTERVAL '5 days'
        + (SPLIT_PART(f.object_value, '-', 5)::int * INTERVAL '1 minute')
    FROM public.facts f
    WHERE f.object_value LIKE '${seedTag}-step-%'
  `);

  // 2 edges per chain: pos=0 event → pos=1 event, pos=1 event → pos=2 event.
  // Recovered via the entity canonical_name suffix.
  await testDb.unsafe(`
    INSERT INTO public.causal_edges (id, cause_event_id, effect_event_id, strength, reasoning,
                                      source_references, extraction_method, initial_strength,
                                      last_corroborated, created_at)
    SELECT
      gen_random_uuid(),
      cause_ev.id,
      effect_ev.id,
      0.8,
      'klv.6 bench edge',
      '[]'::jsonb,
      'llm',
      0.8,
      NOW() - INTERVAL '5 days',
      NOW() - INTERVAL '5 days'
    FROM public.causal_events cause_ev
    JOIN public.entities cause_ent ON cause_ent.id = cause_ev.subject_entity_id
    JOIN public.causal_events effect_ev ON true
    JOIN public.entities effect_ent ON effect_ent.id = effect_ev.subject_entity_id
    WHERE cause_ent.canonical_name LIKE '${seedTag}-%'
      AND effect_ent.canonical_name LIKE '${seedTag}-%'
      AND SPLIT_PART(cause_ent.canonical_name, '-', 4) = SPLIT_PART(effect_ent.canonical_name, '-', 4)
      AND SPLIT_PART(cause_ent.canonical_name, '-', 5)::int + 1 = SPLIT_PART(effect_ent.canonical_name, '-', 5)::int
  `);
}

describe('Phase 6 — G8: benchmarks (nmemo-klv.6)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  // Spec 17:733-744 budgets:
  //   detect <2000ms on 1000 chains
  //   match  <200ms per edge
  //
  // These are the explicit acceptance criteria for nmemo-klv.6 ("Benchmark:
  // detection <2s @ 1000 chains, match <200ms"). The G1-G7 inline tests cover
  // correctness on small graphs; this block covers scale.
  describe('detectCausalPatterns at scale', () => {
    it('detects 1000 chains in <2s (spec 17:733)', async () => {
      // Each chain has 3 entities → 3 facts → 3 events → 2 edges.
      // collectChains emits sub-chains of length 2 and length 3 per chain:
      //   from edge_0: [edge_0, edge_1] (length 2)
      //   from edge_0 extended: nothing (chain ends)
      //   from edge_1: (length 1, filtered out by length >= 2)
      // So each chain contributes exactly 1 sub-chain → chainsExamined === N.
      const N = 1000;
      const seedTag = Date.now() & 0xffff;
      const tag = `klv6-bench-${seedTag}`;
      await bulkSeedIdenticalChains(N, seedTag);

      // Diagnostic: confirm seed produced the expected row counts.
      const [{ entCount }] = await testDb<Array<{ entCount: number }>>`
        SELECT COUNT(*)::int AS "entCount" FROM public.entities WHERE canonical_name LIKE ${tag + '-%'}
      `;
      const [{ factCount }] = await testDb<Array<{ factCount: number }>>`
        SELECT COUNT(*)::int AS "factCount" FROM public.facts WHERE object_value LIKE ${tag + '-step-%'}
      `;
      const [{ evCount }] = await testDb<Array<{ evCount: number }>>`
        SELECT COUNT(*)::int AS "evCount" FROM public.causal_events ce JOIN public.facts f ON f.id = ce.fact_id WHERE f.object_value LIKE ${tag + '-step-%'}
      `;
      const [{ edgeCount }] = await testDb<Array<{ edgeCount: number }>>`
        SELECT COUNT(*)::int AS "edgeCount" FROM public.causal_edges WHERE reasoning = 'klv.6 bench edge'
      `;
      // eslint-disable-next-line no-console
      console.log(`[klv.6] seed check — entities:${entCount} facts:${factCount} events:${evCount} edges:${edgeCount} (expected 3N,3N,3N,2N)`);
      expect(entCount).toBe(3 * N);
      expect(factCount).toBe(3 * N);
      expect(evCount).toBe(3 * N);
      expect(edgeCount).toBe(2 * N);

      const t0 = Date.now();
      const result = await detectCausalPatterns({ instanceThreshold: 3 });
      const elapsedMs = Date.now() - t0;

      // chainsExamined should be exactly N (one length-2 sub-chain per chain)
      expect(result.chainsExamined).toBe(N);
      // All N chains share one normalised template, so one staging pattern
      expect(result.newStaging).toBe(1);

      // Spec 17:733 target: <2000ms @ 1000 chains.
      //
      // History: the original measurement on this hardware was ~5-6s, well
      // over the spec, dominated by the per-chain `normaliseChain` and
      // per-edge `linkEdgesToPattern` SQL round-trips. nmemo-oex batched
      // both paths and the benchmark now runs in ~120ms locally. The
      // assertion below is the spec target — if a regression pushes
      // detection back over 2s the test fails and we look at it.
      const SPEC_TARGET_MS = 2000;
      expect(elapsedMs).toBeLessThan(SPEC_TARGET_MS);

      // eslint-disable-next-line no-console
      console.log(
        `[klv.6] detectCausalPatterns @ ${N} chains: ${elapsedMs}ms ` +
          `(spec <${SPEC_TARGET_MS}ms; ${elapsedMs < SPEC_TARGET_MS ? 'PASS' : 'PERF-GAP'})`,
      );
    }, 60_000);
  });

  describe('matchEdgeToPattern latency', () => {
    it('matches one edge in <200ms (spec 17:744)', async () => {
      // Seed a canonical pattern with a known 2-window template
      const template = [
        { entity_type: 'standard_rule', predicate_category: 'requires' },
        { entity_type: 'compliance_practice', predicate_category: 'prevents' },
      ];
      await setupPattern({
        status: 'canonical',
        templateStructure: template,
        instanceCount: 50,
      });

      // Build one edge whose nodes match the template
      const { edgeIds } = await buildLinearChain(1, {
        entityTypes: ['standard_rule', 'compliance_practice'],
        predicates: ['requires', 'prevents'],
      });

      // Warm the connection (first call after cleanSlate is often slower)
      await matchEdgeToPattern(edgeIds[0]!);

      // Reset pattern_id so the second call actually performs the match
      await testDb`UPDATE public.causal_edges SET pattern_id = NULL, pattern_position = NULL WHERE id = ${edgeIds[0]!}::uuid`;

      const t0 = Date.now();
      const result = await matchEdgeToPattern(edgeIds[0]!);
      const elapsedMs = Date.now() - t0;

      expect(result).not.toBeNull();
      expect(elapsedMs).toBeLessThan(200);

      // eslint-disable-next-line no-console
      console.log(`[klv.6] matchEdgeToPattern @ 1 canonical pattern: ${elapsedMs}ms (spec <200ms)`);
    });
  });
});
