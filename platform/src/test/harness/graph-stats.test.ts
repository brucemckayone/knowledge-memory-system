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
import { computeGraphStats, getGraphStats } from '../../services/graph-stats.js';

/**
 * Wipe everything graph-stats touches and reseed the singleton. The default
 * `deleteFromTables` ordered list does NOT include `graph_stats` or
 * `entity_meta`, so we handle those explicitly here.
 */
async function cleanSlate(): Promise<void> {
  await deleteFromTables({
    tables: [
      'fact_history',
      'memory_entities',
      'facts',
      'merge_candidates',
      'entities',
    ],
    acknowledgeGlobal: true,
  });
  // entity_meta is FK'd to entities ON DELETE CASCADE — the entities wipe takes
  // care of it, but we DELETE again to be defensive against test ordering.
  await testDb`DELETE FROM public.entity_meta`;
  // Reset the singleton to the seeded zero-state. Migration 013's
  // INSERT ... ON CONFLICT DO NOTHING means we can't re-seed via re-running
  // the migration; we DELETE + INSERT here.
  await testDb`DELETE FROM public.graph_stats`;
  await testDb`INSERT INTO public.graph_stats (id) VALUES (1)`;
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
});
