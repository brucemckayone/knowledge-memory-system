/**
 * Phase 1 — Graph Stats foundation (doc 22, nmemo-a7f.1.1)
 *
 * Implements the ten test cases enumerated in 22-graph-stats-foundation.md
 * §4.2. Each test mutates the live test DB schema (the migration 013 row is
 * deleted/reseeded in `cleanSlate` so every case starts from a known empty
 * singleton) and exercises `computeGraphStats` / `getGraphStats` against a
 * minimal hand-seeded graph.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  deleteFromTables,
  randomEmbedding,
  normalizeVector,
  hasVectorExtension,
  skipCtx,
} from '../setup.js';
import { computeGraphStats, getGraphStats, classifyAnomaly } from '../../services/graph-stats.js';

/**
 * Wipe everything graph-stats touches and reseed the singleton. The default
 * `deleteFromTables` ordered list does NOT include `graph_stats` or
 * `entity_meta`, so we handle those explicitly here.
 */
async function cleanSlate(): Promise<void> {
  // TRUNCATE ... CASCADE wipes downstream FK refs unconditionally, which is
  // necessary because the `entities` table is referenced from tables that
  // deleteFromTables's orderedTables doesn't enumerate (e.g. entity_aliases,
  // same_as_links, contradictions, reasoning_reports.entity_ids). DELETE
  // FROM entities on a polluted DB would FK-violate; TRUNCATE CASCADE doesn't.
  // bd memory 'deletefromtables-in-src-test-setup-ts-silently-filters'
  // documents the whitelist pitfall; TRUNCATE is the escape hatch when the
  // test needs a true known-empty baseline.
  await testDb.unsafe(`
    TRUNCATE TABLE
      public.fact_history,
      public.facts,
      public.memory_entities,
      public.entity_meta,
      public.merge_candidates,
      public.entities
    CASCADE
  `);
  // Reset the singleton to the seeded zero-state. Migration 013's
  // INSERT ... ON CONFLICT DO NOTHING means we can't re-seed via re-running
  // the migration; we DELETE + INSERT here.
  await testDb`DELETE FROM public.graph_stats`;
  await testDb`INSERT INTO public.graph_stats (id) VALUES (1)`;
  // bead nmemo-2yv.49 — computeGraphStats now appends a reasoning_reports row
  // per compute. Wipe so the assertion "exactly one new row" is reliable.
  await testDb`DELETE FROM public.reasoning_reports WHERE actions_taken->>'actor' = 'graph-stats'`;
}

/** Insert an entity_meta row with a unit-normalised random centroid. */
async function seedEntityMeta(entityId: string, centroid?: number[]): Promise<void> {
  const vec = centroid ?? normalizeVector(randomEmbedding());
  const centroidStr = `[${vec.join(',')}]`;
  await testDb`
    INSERT INTO public.entity_meta (entity_id, centroid)
    VALUES (${entityId}::uuid, ${centroidStr}::vector)
    ON CONFLICT (entity_id) DO UPDATE SET centroid = EXCLUDED.centroid
  `;
}

describe('graph-stats §22 — foundation', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('1. empty DB: getGraphStats returns the seeded row with all-zero counts', async () => {
    const stats = await getGraphStats();
    expect(stats).not.toBeNull();
    expect(stats!.id).toBe(1);
    expect(stats!.totalEntities).toBe(0);
    expect(stats!.totalFacts).toBe(0);
    expect(stats!.totalActiveFacts).toBe(0);
    expect(stats!.totalMemories).toBe(0);
    expect(stats!.mergeCandidatesPending).toBe(0);
    // Numeric columns that depend on entity counts are NULL on the seed
    expect(stats!.centroidSimMean).toBeNull();
    expect(stats!.factDensity).toBeNull();
    expect(stats!.orphanRate).toBeNull();
    expect(stats!.predicateDiversity).toBeNull();
  });

  it('2. single entity, zero facts: orphan_rate=1.0, fact_density=0, predicate_diversity=0', async () => {
    await createTestEntity({ canonicalName: 'solo', entityType: 'person' });
    const stats = await computeGraphStats();
    expect(stats.totalEntities).toBe(1);
    expect(stats.totalFacts).toBe(0);
    expect(stats.totalActiveFacts).toBe(0);
    expect(stats.factDensity).toBe(0);
    expect(stats.orphanRate).toBe(1.0);
    expect(stats.predicateDiversity).toBe(0);
  });

  /**
   * "Two entities, one fact between them" with the §4.2 expected values
   * (orphan_rate=0.5) only holds when the single fact involves exactly one
   * of the two entities in either role — i.e. the fact is entity-to-literal
   * (`object_value` set, `object_entity_id` NULL). The other entity is
   * therefore orphan. This interpretation is the only one consistent with
   * doc 22 §3.2's explicit orphan definition (zero facts in *either* role).
   */
  it('3. two entities, one fact (entity-to-literal): density=0.5, orphan_rate=0.5, diversity=1', async () => {
    const e1 = await createTestEntity({ canonicalName: 'a', entityType: 'thing' });
    await createTestEntity({ canonicalName: 'b', entityType: 'thing' });
    await createTestFact({
      subjectEntityId: e1.id,
      predicate: 'has_label',
      objectValue: 'literal',
    });

    const stats = await computeGraphStats();
    expect(stats.totalEntities).toBe(2);
    expect(stats.totalActiveFacts).toBe(1);
    expect(stats.factDensity).toBe(0.5);
    expect(stats.orphanRate).toBe(0.5);
    expect(stats.predicateDiversity).toBe(1);
  });

  it('4. expired fact excluded from active count: total_facts=1, active=0, diversity=0', async () => {
    const e1 = await createTestEntity({ canonicalName: 'x', entityType: 'thing' });
    const fact = await createTestFact({
      subjectEntityId: e1.id,
      predicate: 'was_active',
      objectValue: 'past',
    });
    // Expire it so the active-fact filter excludes it.
    await testDb`UPDATE public.facts SET expired_at = NOW() WHERE id = ${fact.id}::uuid`;

    const stats = await computeGraphStats();
    expect(stats.totalFacts).toBe(1);
    expect(stats.totalActiveFacts).toBe(0);
    expect(stats.predicateDiversity).toBe(0);
    expect(stats.factDensity).toBe(0); // 0/1 entities
  });

  it('5. centroid sample size cap: ≥100 centroid-bearing entities → sample_size <= 10000', async (ctx) => {
    if (!hasVectorExtension) return skipCtx(ctx);
    // Seed 105 entities with centroids — well over the 100-row LIMIT on each
    // half of the CROSS JOIN. Sample = 100 × 100 minus self-joins (where
    // a.entity_id = b.entity_id), so the upper bound on sample_size is 9900,
    // and definitely <= 10000 per the §4.2 spec.
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) {
      const e = await createTestEntity({ canonicalName: `e${i}`, entityType: 'thing' });
      ids.push(e.id);
    }
    for (const id of ids) await seedEntityMeta(id);

    const stats = await computeGraphStats();
    expect(stats.centroidSampleSize).not.toBeNull();
    expect(stats.centroidSampleSize!).toBeLessThanOrEqual(10000);
    expect(stats.centroidSampleSize!).toBeGreaterThan(0);
  });

  it('6. no entity has centroid: every centroid_sim_* is NULL, sample_size = 0', async () => {
    // Entities exist but no entity_meta rows → no centroids to sample.
    await createTestEntity({ canonicalName: 'p', entityType: 'thing' });
    await createTestEntity({ canonicalName: 'q', entityType: 'thing' });

    const stats = await computeGraphStats();
    expect(stats.centroidSimMean).toBeNull();
    expect(stats.centroidSimMedian).toBeNull();
    expect(stats.centroidSimP10).toBeNull();
    expect(stats.centroidSimP90).toBeNull();
    expect(stats.centroidSampleSize).toBe(0);
  });

  it('7. cluster columns stay NULL in Phase 1', async () => {
    const e1 = await createTestEntity({ canonicalName: 'c1', entityType: 'thing' });
    if (hasVectorExtension) await seedEntityMeta(e1.id);
    const stats = await computeGraphStats();
    expect(stats.embeddingClusterCount).toBeNull();
    expect(stats.meanIntraClusterDistance).toBeNull();
    expect(stats.meanInterClusterDistance).toBeNull();
    expect(stats.clusterColumnsVersion).toBeNull();
  });

  it('8. merge candidates counted: 3 staging + 2 resolved → pending = 3', async () => {
    // Build five distinct entity pairs (10 entities total). Three pairs land
    // in `staging`, two in `resolved`.
    const entityIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const e = await createTestEntity({ canonicalName: `mc${i}`, entityType: 'thing' });
      entityIds.push(e.id);
    }
    const pairs: Array<[string, string, string]> = [];
    for (let i = 0; i < 5; i++) {
      const a = entityIds[i * 2]!;
      const b = entityIds[i * 2 + 1]!;
      const [low, high] = a < b ? [a, b] : [b, a];
      const status = i < 3 ? 'staging' : 'resolved';
      pairs.push([low, high, status]);
    }
    for (const [a, b, status] of pairs) {
      await testDb`
        INSERT INTO public.merge_candidates (entity_a_id, entity_b_id, combined_score, status)
        VALUES (${a}::uuid, ${b}::uuid, 0.5, ${status})
      `;
    }

    const stats = await computeGraphStats();
    expect(stats.mergeCandidatesPending).toBe(3);
  });

  it('9. idempotency: two consecutive computes produce identical numeric columns', async () => {
    // Build a small but non-trivial graph so all numeric columns are populated.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await createTestEntity({ canonicalName: `id${i}`, entityType: 'thing' });
      ids.push(e.id);
    }
    if (hasVectorExtension) {
      for (const id of ids) await seedEntityMeta(id);
    }
    await createTestFact({ subjectEntityId: ids[0]!, predicate: 'p1', objectValue: 'v' });
    await createTestFact({ subjectEntityId: ids[1]!, predicate: 'p2', objectEntityId: ids[2]! });

    const a = await computeGraphStats();
    const b = await computeGraphStats();
    expect(b.totalEntities).toBe(a.totalEntities);
    expect(b.totalFacts).toBe(a.totalFacts);
    expect(b.totalActiveFacts).toBe(a.totalActiveFacts);
    expect(b.totalMemories).toBe(a.totalMemories);
    expect(b.factDensity).toBe(a.factDensity);
    expect(b.orphanRate).toBe(a.orphanRate);
    expect(b.predicateDiversity).toBe(a.predicateDiversity);
    expect(b.mergeCandidatesPending).toBe(a.mergeCandidatesPending);
    expect(b.centroidSimMean).toBe(a.centroidSimMean);
    expect(b.centroidSimMedian).toBe(a.centroidSimMedian);
    expect(b.centroidSimP10).toBe(a.centroidSimP10);
    expect(b.centroidSimP90).toBe(a.centroidSimP90);
    expect(b.centroidSampleSize).toBe(a.centroidSampleSize);
    // Timestamps and self-reported durations are *expected* to change.
    expect(b.computedAt.getTime()).toBeGreaterThanOrEqual(a.computedAt.getTime());
  });

  it('10. singleton invariant: inserting id=2 fails CHECK violation', async () => {
    await expect(
      testDb`INSERT INTO public.graph_stats (id) VALUES (2)`,
    ).rejects.toThrow(/graph_stats_singleton/);
  });

  // ============================================
  // Bead nmemo-2yv.49 — reasoning_reports row per compute (doc 22 §7.5)
  // ============================================

  it('49a. every compute writes one reasoning_reports row tagged actor=graph-stats', async () => {
    await createTestEntity({ canonicalName: 'rr1', entityType: 'thing' });
    await computeGraphStats();

    const reports = await testDb<{
      mode: string;
      report: string;
      actions_taken: unknown;
    }[]>`
      SELECT mode, report, actions_taken
      FROM public.reasoning_reports
      WHERE actions_taken->>'actor' = 'graph-stats'
      ORDER BY created_at DESC
    `;
    expect(reports.length).toBe(1);
    expect(reports[0]!.mode).toBe('patrol');
    // Headline matches the pipeline.ts console.log shape so existing grep
    // targets keep working — guards against silently breaking observability.
    expect(reports[0]!.report).toMatch(/\[graph-stats\] total_entities=1/);
    // Fenced JSON snapshot for machine consumers.
    expect(reports[0]!.report).toContain('```json');

    const actions = typeof reports[0]!.actions_taken === 'string'
      ? JSON.parse(reports[0]!.actions_taken as string)
      : (reports[0]!.actions_taken as Record<string, unknown>);
    expect(actions.actor).toBe('graph-stats');
    expect(actions.context_type).toBe('graph_stats_compute');
    expect(actions.anomaly).toBe('normal');
    expect(actions.anomaly_reason).toBe('no_prior_compute');
  });

  it('49b. single-entity orphan_rate=1.0 with no prior compute classifies normal', async () => {
    await createTestEntity({ canonicalName: 'solo49', entityType: 'person' });
    const stats = await computeGraphStats();
    expect(stats.orphanRate).toBe(1.0);

    const rows = await testDb<{ actions_taken: unknown }[]>`
      SELECT actions_taken FROM public.reasoning_reports
      WHERE actions_taken->>'actor' = 'graph-stats'
      ORDER BY created_at DESC LIMIT 1
    `;
    const actions = typeof rows[0]!.actions_taken === 'string'
      ? JSON.parse(rows[0]!.actions_taken as string)
      : (rows[0]!.actions_taken as Record<string, unknown>);
    expect(actions.anomaly).toBe('normal');
  });

  it('49c. orphan_rate jump > 0.3 vs prior row classifies anomaly', async () => {
    // Prior compute: 2 entities connected by one entity-entity fact —
    // orphan_rate = 0.0 (both entities appear in the fact's subject/object).
    const e1 = await createTestEntity({ canonicalName: 'anom-a', entityType: 'thing' });
    const e2 = await createTestEntity({ canonicalName: 'anom-b', entityType: 'thing' });
    await createTestFact({ subjectEntityId: e1.id, predicate: 'links', objectEntityId: e2.id });
    const before = await computeGraphStats();
    expect(before.orphanRate).toBe(0);

    // Add 5 orphan entities; recompute. New orphan_rate = 5/7 ≈ 0.714,
    // delta = 0.714 vs threshold 0.3 → anomaly.
    for (let i = 0; i < 5; i++) {
      await createTestEntity({ canonicalName: `orphan${i}`, entityType: 'thing' });
    }
    const after = await computeGraphStats();
    expect(after.orphanRate!).toBeGreaterThan(0.3);

    const rows = await testDb<{ actions_taken: unknown }[]>`
      SELECT actions_taken FROM public.reasoning_reports
      WHERE actions_taken->>'actor' = 'graph-stats'
      ORDER BY created_at DESC LIMIT 1
    `;
    const actions = typeof rows[0]!.actions_taken === 'string'
      ? JSON.parse(rows[0]!.actions_taken as string)
      : (rows[0]!.actions_taken as Record<string, unknown>);
    expect(actions.anomaly).toBe('anomaly');
    const signals = actions.anomaly_signals as Array<{ signal: string }>;
    expect(signals.some((s) => s.signal === 'orphan_rate')).toBe(true);
  });

  it('49d. classifier is a pure function pinning normal/anomaly thresholds', () => {
    // Unit-test the pure classifier directly so the threshold logic is
    // exercised without DB round-trips.
    const base: Parameters<typeof classifyAnomaly>[1] = {
      id: 1,
      totalEntities: 10,
      totalFacts: 5,
      totalActiveFacts: 5,
      totalMemories: 3,
      embeddingClusterCount: null,
      meanIntraClusterDistance: null,
      meanInterClusterDistance: null,
      centroidSimMean: null,
      centroidSimMedian: null,
      centroidSimP10: null,
      centroidSimP90: null,
      centroidSampleSize: null,
      factDensity: 0.5,
      orphanRate: 0.2,
      predicateDiversity: 3,
      mergeCandidatesPending: 0,
      computedAt: new Date(),
      computedDurationMs: 12,
      computationVersion: 1,
      clusterColumnsVersion: null,
    };
    // null prior → normal/no_prior_compute
    expect(classifyAnomaly(null, base).reason).toBe('no_prior_compute');
    // prior with computed_duration_ms = null (seed row) → normal/no_prior_compute
    expect(classifyAnomaly({ ...base, computedDurationMs: null }, base).reason).toBe('no_prior_compute');
    // identical → normal/all_within_threshold
    expect(classifyAnomaly(base, base).tag).toBe('normal');
    // orphan_rate delta exactly 0.3 → NOT anomaly (strict >, matches the bead
    // acceptance bullet "synthetic orphan_rate jump > 0.3 vs the prior row")
    expect(classifyAnomaly(base, { ...base, orphanRate: 0.5 }).tag).toBe('normal');
    // orphan_rate delta 0.4 → anomaly
    const out = classifyAnomaly(base, { ...base, orphanRate: 0.6 });
    expect(out.tag).toBe('anomaly');
    expect(out.signals[0]!.signal).toBe('orphan_rate');
  });

  it('49e. reasoning_reports insert failure does NOT propagate to compute', async () => {
    // Inject a fault on reasoning_reports INSERT — the compute upsert must
    // still succeed (report writing is observability, not authoritative).
    const e1 = await createTestEntity({ canonicalName: 'rr-fault', entityType: 'thing' });
    await createTestFact({ subjectEntityId: e1.id, predicate: 'has_label', objectValue: 'v' });

    try {
      await testDb.unsafe(`
        CREATE OR REPLACE FUNCTION pg_temp.rr_49_fault() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'nmemo-2yv.49 simulated reasoning_reports write fault';
        END;
        $$;
      `);
      await testDb.unsafe(`
        CREATE TRIGGER rr_49_fault
        BEFORE INSERT ON public.reasoning_reports
        FOR EACH ROW EXECUTE FUNCTION pg_temp.rr_49_fault();
      `);

      // Compute must NOT throw — the report-write failure is swallowed and
      // logged via console.warn.
      const stats = await computeGraphStats();
      expect(stats.totalEntities).toBe(1);
      expect(stats.computedDurationMs).not.toBeNull();
    } finally {
      await testDb.unsafe(`DROP TRIGGER IF EXISTS rr_49_fault ON public.reasoning_reports`);
    }

    // And no graph-stats reasoning_reports row landed (the insert was
    // rejected by the fault trigger).
    const rows = await testDb<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM public.reasoning_reports
      WHERE actions_taken->>'actor' = 'graph-stats'
    `;
    expect(rows[0]!.count).toBe('0');
  });

  it('11. atomicity (nmemo-2yv.48): pre-commit failure leaves aggregates AND duration unchanged', async () => {
    // Seed a known prior state via a successful compute, then capture all
    // observable columns. Any drift between aggregate columns and
    // computed_duration_ms after a failed compute would falsify the option-(a)
    // atomicity guarantee from bead nmemo-2yv.48.
    const e1 = await createTestEntity({ canonicalName: 'atomicity-a', entityType: 'thing' });
    const e2 = await createTestEntity({ canonicalName: 'atomicity-b', entityType: 'thing' });
    await createTestFact({ subjectEntityId: e1.id, predicate: 'p_init', objectEntityId: e2.id });
    const before = await computeGraphStats();
    expect(before.computedDurationMs).not.toBeNull();

    // Inject a pre-commit failure by installing a BEFORE UPDATE trigger on
    // graph_stats that RAISES on the duration-write statement. This forces the
    // outer transaction to roll back AFTER the upsert has been issued — exactly
    // the "process death between commit and post-tx UPDATE" scenario from the
    // bead's premise (mapped into the post-fix world where the duration UPDATE
    // runs inside the same tx).
    try {
      await testDb.unsafe(`
        CREATE OR REPLACE FUNCTION pg_temp.graph_stats_48_fault() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.computed_duration_ms IS DISTINCT FROM OLD.computed_duration_ms THEN
            RAISE EXCEPTION 'nmemo-2yv.48 simulated mid-compute failure';
          END IF;
          RETURN NEW;
        END;
        $$;
      `);
      await testDb.unsafe(`
        CREATE TRIGGER graph_stats_48_fault
        BEFORE UPDATE ON public.graph_stats
        FOR EACH ROW EXECUTE FUNCTION pg_temp.graph_stats_48_fault();
      `);

      // Mutate the source data so that a non-atomic implementation would land
      // new aggregates BEFORE the duration write fails — making any post-fault
      // drift visible.
      await createTestFact({ subjectEntityId: e1.id, predicate: 'p_drift', objectEntityId: e2.id });

      await expect(computeGraphStats()).rejects.toThrow(/nmemo-2yv\.48 simulated/);
    } finally {
      await testDb.unsafe(`DROP TRIGGER IF EXISTS graph_stats_48_fault ON public.graph_stats`);
    }

    // After the failed compute, the row must look identical to `before` — the
    // upsert AND the duration write are atomic, so neither landed.
    const after = await getGraphStats();
    expect(after).not.toBeNull();
    expect(after!.totalEntities).toBe(before.totalEntities);
    expect(after!.totalFacts).toBe(before.totalFacts);
    expect(after!.totalActiveFacts).toBe(before.totalActiveFacts);
    expect(after!.predicateDiversity).toBe(before.predicateDiversity);
    expect(after!.computedDurationMs).toBe(before.computedDurationMs);
    expect(after!.computedAt.getTime()).toBe(before.computedAt.getTime());
  });
});
