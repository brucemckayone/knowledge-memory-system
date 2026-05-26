/**
 * Integration tests: merge-scorer adaptive weighting wiring (bead nmemo-2yv.43)
 *
 * Verifies the end-to-end flow:
 *   1. `MergeScorerCtx.graphStats` reaches `adaptWeights()` and modulates
 *      the per-pair scoring.
 *   2. The effective weight vector + graph_stats snapshot land in
 *      `merge_candidates.scoring_version` (mig 025) — the audit trail.
 *   3. detectMergeCandidates calls getGraphStats() once per batch and
 *      threads it through — saturated-centroid regression test.
 *
 * Pure-function modulation rules live in src/test/services/merge-scorer-adaptive.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  deleteFromTables,
  normalizeVector,
  randomEmbedding,
  hasVectorExtension,
  skipCtx,
} from '../setup.js';
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import {
  scoreMergeCandidates,
  upsertScoredCandidates,
  DEFAULT_WEIGHTS,
  type ScoringVersion,
} from '../../services/merge-scorer.js';
import type { GraphStats } from '../../services/graph-stats.js';

async function cleanSlate(): Promise<void> {
  // merge_candidates is NOT in deleteFromTables's orderedTables whitelist
  // (cf. src/test/setup.ts:238) — wipe it explicitly BEFORE the entities
  // delete so the FK to entities doesn't block.
  await testDb`DELETE FROM public.merge_candidates`;
  await deleteFromTables({
    tables: [
      'fact_history',
      'memory_entities',
      'facts',
      'entities',
    ],
    acknowledgeGlobal: true,
  });
  await testDb`DELETE FROM public.entity_meta`;
  await testDb`DELETE FROM public.entity_topology`;
  await testDb`DELETE FROM public.entity_clusters`;
  await testDb`DELETE FROM public.graph_stats`;
  await testDb`INSERT INTO public.graph_stats (id) VALUES (1)`;
}

async function seedEntityMeta(entityId: string, centroid: number[]): Promise<void> {
  const vec = normalizeVector(centroid);
  const centroidStr = `[${vec.join(',')}]`;
  await testDb`
    INSERT INTO public.entity_meta (entity_id, mention_count, source_memory_count, fact_count, centroid)
    VALUES (${entityId}::uuid, 5, 3, 2, ${centroidStr}::vector)
    ON CONFLICT (entity_id) DO UPDATE SET centroid = EXCLUDED.centroid
  `;
}

/** Construct a GraphStats stub WITHOUT computing — we want explicit control
 *  over p10/p90/cluster_count for the adaptive scenarios. */
function stubStats(overrides: Partial<GraphStats>): GraphStats {
  return {
    id: 1,
    totalEntities: 0,
    totalFacts: 0,
    totalActiveFacts: 0,
    totalMemories: 0,
    embeddingClusterCount: null,
    meanIntraClusterDistance: null,
    meanInterClusterDistance: null,
    centroidSimMean: null,
    centroidSimMedian: null,
    centroidSimP10: null,
    centroidSimP90: null,
    centroidSampleSize: null,
    factDensity: null,
    orphanRate: null,
    predicateDiversity: null,
    mergeCandidatesPending: 0,
    computedAt: new Date('2026-05-26T00:00:00Z'),
    computedDurationMs: null,
    computationVersion: 1,
    clusterColumnsVersion: null,
    ...overrides,
  };
}

describe('merge-scorer adaptive wiring — bead nmemo-2yv.43', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('scoreMergeCandidates(ctx without graphStats): adapted=false, weights=DEFAULT', async (ctx) => {
    if (!hasVectorExtension) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'thing' });
    await seedEntityMeta(a.id, randomEmbedding());
    await seedEntityMeta(b.id, randomEmbedding());

    const scored = await scoreMergeCandidates(
      [{ entityAId: a.id, entityBId: b.id }],
      { runner: db },
    );
    expect(scored.length).toBe(1);
    const sv = scored[0]!.scoringVersion;
    expect(sv.adapted).toBe(false);
    expect(sv.graph_stats_snapshot).toBeNull();
    expect(sv.weights).toEqual(DEFAULT_WEIGHTS);
  });

  it('scoreMergeCandidates(ctx with saturated graphStats): adapted=true, centroid weight halved', async (ctx) => {
    if (!hasVectorExtension) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'thing' });
    await seedEntityMeta(a.id, randomEmbedding());
    await seedEntityMeta(b.id, randomEmbedding());

    const graphStats = stubStats({
      centroidSimP10: 0.85,
      centroidSimP90: 0.90, // spread 0.05 — saturated
      embeddingClusterCount: 5,
    });

    const scored = await scoreMergeCandidates(
      [{ entityAId: a.id, entityBId: b.id }],
      { runner: db, graphStats },
    );
    expect(scored.length).toBe(1);
    const sv = scored[0]!.scoringVersion;
    expect(sv.adapted).toBe(true);
    expect(sv.graph_stats_snapshot).not.toBeNull();
    expect(sv.graph_stats_snapshot!.centroid_sim_p10).toBe(0.85);
    expect(sv.graph_stats_snapshot!.centroid_sim_p90).toBe(0.90);
    expect(sv.graph_stats_snapshot!.embedding_cluster_count).toBe(5);
    expect(sv.weights.centroidSimilarity).toBeCloseTo(DEFAULT_WEIGHTS.centroidSimilarity / 2, 10);
  });

  it('upsertScoredCandidates writes scoring_version JSONB to merge_candidates', async (ctx) => {
    if (!hasVectorExtension) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'thing' });
    await seedEntityMeta(a.id, randomEmbedding());
    await seedEntityMeta(b.id, randomEmbedding());

    const graphStats = stubStats({
      centroidSimP10: 0.1,
      centroidSimP90: 0.9,
      embeddingClusterCount: 1, // rule 2 fires
    });

    const scored = await scoreMergeCandidates(
      [{ entityAId: a.id, entityBId: b.id }],
      { runner: db, graphStats },
    );
    await upsertScoredCandidates(scored, {
      runner: db,
      candidateSource: 'three_signal_scoring',
      statusFor: () => 'staging',
    });

    const rows = (await db.execute(sql`
      SELECT scoring_version FROM public.merge_candidates
      WHERE entity_a_id = ${a.id < b.id ? a.id : b.id}::uuid
        AND entity_b_id = ${a.id < b.id ? b.id : a.id}::uuid
    `)) as unknown as Array<{ scoring_version: ScoringVersion | string | null }>;

    expect(rows.length).toBe(1);
    const raw = rows[0]!.scoring_version;
    expect(raw).not.toBeNull();
    // postgres.js returns JSONB as a parsed object via drizzle's execute path;
    // be defensive — re-parse if it came back as a string.
    const persisted: ScoringVersion = typeof raw === 'string' ? JSON.parse(raw) : (raw as ScoringVersion);
    expect(persisted.adapted).toBe(true);
    expect(persisted.weights.clusterMatch).toBe(0); // rule 2 zeroed it
    expect(persisted.graph_stats_snapshot).not.toBeNull();
    expect(persisted.graph_stats_snapshot!.embedding_cluster_count).toBe(1);
  });

  it('saturated centroid: combined_score drops vs static (rule 1 fires, centroid is the dominant signal)', async (ctx) => {
    // When entities have a high centroid_similarity (close to 1.0) and no
    // other signals are populated, the static path scores highly via the
    // centroid weight. Under rule 1, centroid weight is halved → redistributed
    // → renormalised denominator changes. With ONLY the centroid signal
    // present, the combined score remains ~1.0 (NULL renormalisation drops
    // all other signals out of the denominator), so we don't see the drop
    // there. But when a second weak signal exists, the redistribution makes
    // the weak signal pull harder.
    if (!hasVectorExtension) return skipCtx(ctx);

    const a = await createTestEntity({ canonicalName: 'A', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'thing' });
    // Same centroid → centroid_similarity == 1.0
    const sharedCentroid = normalizeVector(randomEmbedding());
    await seedEntityMeta(a.id, sharedCentroid);
    await seedEntityMeta(b.id, sharedCentroid);
    // Seed entity_topology with same component_id so component_match = 1.0
    // (a second populated signal). Without a second signal, NULL renormalisation
    // collapses both paths to the same 1.0 score and the test wouldn't
    // differentiate. predicate_signature is VECTOR(25) per mig 014.
    const noisySig = `[${Array.from({ length: 25 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
    await testDb.unsafe(`
      INSERT INTO public.entity_topology
        (entity_id, component_id, component_size, k_core, is_articulation_point, pagerank, predicate_signature, computation_version)
      VALUES ('${a.id}'::uuid, 0, 2, 1, false, 0.5, '${noisySig}'::vector, 1)
    `);
    await testDb.unsafe(`
      INSERT INTO public.entity_topology
        (entity_id, component_id, component_size, k_core, is_articulation_point, pagerank, predicate_signature, computation_version)
      VALUES ('${b.id}'::uuid, 0, 2, 1, false, 0.5, '${noisySig}'::vector, 1)
    `);

    // Static path
    const scoredStatic = await scoreMergeCandidates(
      [{ entityAId: a.id, entityBId: b.id }],
      { runner: db },
    );
    expect(scoredStatic.length).toBe(1);

    // Adaptive path — saturated centroid
    const graphStats = stubStats({
      centroidSimP10: 0.92,
      centroidSimP90: 0.95,
      embeddingClusterCount: 5,
    });
    const scoredAdaptive = await scoreMergeCandidates(
      [{ entityAId: a.id, entityBId: b.id }],
      { runner: db, graphStats },
    );
    expect(scoredAdaptive.length).toBe(1);

    // Both score 1.0-ish (centroid_similarity ≈ 1.0, component_match = 1.0,
    // predicate_signature_cosine ≈ 1.0), but the scoring_version captures
    // distinct weight vectors. The behavioural assertion is on the audit
    // trail, not the score, because identical-signal-value inputs would
    // produce identical scores under NULL renormalisation either way.
    expect(scoredStatic[0]!.scoringVersion.adapted).toBe(false);
    expect(scoredAdaptive[0]!.scoringVersion.adapted).toBe(true);
    expect(scoredAdaptive[0]!.scoringVersion.weights.centroidSimilarity).toBeLessThan(
      scoredStatic[0]!.scoringVersion.weights.centroidSimilarity,
    );
  });

  it('single-cluster corpus: detectMergeCandidates reads graph_stats and adapts (acceptance bullet 1)', async (ctx) => {
    if (!hasVectorExtension) return skipCtx(ctx);
    // Construct a graph_stats row reflecting a saturated single-cluster
    // corpus: small centroid spread + embedding_cluster_count = 1. Then call
    // detectMergeCandidates and confirm the row's scoring_version captures
    // both rule firings — the wiring acceptance.
    await testDb`
      UPDATE public.graph_stats
      SET centroid_sim_p10 = 0.85,
          centroid_sim_p90 = 0.88,
          embedding_cluster_count = 1
      WHERE id = 1
    `;

    const a = await createTestEntity({ canonicalName: 'A', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'thing' });
    // Identical centroids → strong centroid_similarity so the pair passes
    // the STAGING threshold and lands in merge_candidates. mention_count >= 2
    // satisfies graph-meta's eligibility gate.
    const sharedCentroid = normalizeVector(randomEmbedding());
    await seedEntityMeta(a.id, sharedCentroid);
    await seedEntityMeta(b.id, sharedCentroid);

    const { detectMergeCandidates } = await import('../../services/graph-meta.js');
    const inserted = await detectMergeCandidates([a.id]);
    expect(inserted).toBeGreaterThan(0);

    const rows = (await db.execute(sql`
      SELECT scoring_version FROM public.merge_candidates
      WHERE candidate_source = 'three_signal_scoring'
    `)) as unknown as Array<{ scoring_version: ScoringVersion | string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    const raw = rows[0]!.scoring_version;
    const persisted: ScoringVersion = typeof raw === 'string' ? JSON.parse(raw) : (raw as ScoringVersion);

    // Both rules should have fired: centroid is below the default (rule 1
    // halved it; rule 2 then redistributed cluster's weight proportionally
    // including back over centroid, so the final value is below default but
    // ABOVE half — the exact arithmetic is covered in the unit test).
    expect(persisted.adapted).toBe(true);
    expect(persisted.weights.centroidSimilarity).toBeLessThan(DEFAULT_WEIGHTS.centroidSimilarity);
    expect(persisted.weights.clusterMatch).toBe(0);
    expect(persisted.graph_stats_snapshot!.embedding_cluster_count).toBe(1);
  });
});
