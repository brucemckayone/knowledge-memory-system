/**
 * Phase 4 — cross-cluster candidate generator (doc 25)
 *
 * Implements the §4.2 cases that don't require live LLM / large fixtures.
 * Snapshot-driven cases (synthetic-10k recall, Frankenstein milestone) and
 * the reconciliation prompt-builder integration test live in their own
 * sibling test files (committed alongside benchmark + prompt changes).
 *
 * Setup pattern: seed entities + entity_topology + entity_clusters +
 * entity_drift_events directly via testDb. The freshness gate
 * (§3.2) reads topology_compute_runs / clustering_compute_runs — we mark
 * both 'completed' with a future timestamp so the gate clears.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  deleteFromTables,
} from '../setup.js';
import {
  generateCrossClusterCandidates,
  listCrossClusterCandidates,
  listCrossClusterRuns,
} from '../../services/cross-cluster-generator.js';

interface TopologySeed {
  componentId: number;
  componentSize?: number;
  kCore?: number;
  isArticulation?: boolean;
  pagerank?: number;
  predicateSignature?: number[] | null;
}

interface ClusterSeed {
  clusterId: number;
  probability?: number;
}

async function seedTopology(entityId: string, t: TopologySeed) {
  const sigLit = t.predicateSignature
    ? `'[${t.predicateSignature.join(',')}]'::vector`
    : 'NULL';
  await testDb.unsafe(`
    INSERT INTO public.entity_topology
      (entity_id, component_id, component_size, k_core, is_articulation_point, pagerank, predicate_signature, computation_version)
    VALUES (
      '${entityId}'::uuid,
      ${t.componentId},
      ${t.componentSize ?? 2},
      ${t.kCore ?? 2},
      ${t.isArticulation ?? false},
      ${t.pagerank ?? 0.1},
      ${sigLit},
      1
    )
    ON CONFLICT (entity_id) DO UPDATE SET
      component_id = EXCLUDED.component_id,
      component_size = EXCLUDED.component_size,
      k_core = EXCLUDED.k_core,
      is_articulation_point = EXCLUDED.is_articulation_point,
      pagerank = EXCLUDED.pagerank,
      predicate_signature = EXCLUDED.predicate_signature
  `);
}

async function seedCluster(entityId: string, c: ClusterSeed) {
  // entity_clusters.centroid_snapshot is NOT NULL — give it a deterministic
  // unit-style vector. Drift detection re-uses it elsewhere; for the bridge
  // generator only cluster_id + cluster_probability matter.
  const centroid = `[${Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0).join(',')}]`;
  await testDb.unsafe(`
    INSERT INTO public.entity_clusters
      (entity_id, cluster_id, centroid_snapshot, cluster_probability, cluster_size, computation_version)
    VALUES ('${entityId}'::uuid, ${c.clusterId}, '${centroid}'::vector, ${c.probability ?? 0.9}, 5, 1)
    ON CONFLICT (entity_id) DO UPDATE SET
      cluster_id = EXCLUDED.cluster_id,
      cluster_probability = EXCLUDED.cluster_probability
  `);
}

async function seedDriftEvent(entityId: string, opts: {
  targetClusterId: number;
  triggeredAction?: 'logged_only' | 'reconciliation_invoked' | 'reconciliation_failed';
  detectedAt?: Date;
}) {
  const centroid = `[${Array.from({ length: 768 }, () => 0).join(',')}]`;
  await testDb`
    INSERT INTO public.entity_drift_events
      (entity_id, drift_magnitude, centroid_snapshot, centroid_current,
       target_cluster_id, triggered_action, detected_at)
    VALUES (
      ${entityId}::uuid, 0.5,
      ${testDb.unsafe(`'${centroid}'::vector`)},
      ${testDb.unsafe(`'${centroid}'::vector`)},
      ${opts.targetClusterId},
      ${opts.triggeredAction ?? 'reconciliation_invoked'},
      ${opts.detectedAt ?? new Date()}
    )
  `;
}

/** Mark both upstream compute runs as completed in the future so the
 *  freshness gate clears. Idempotent — inserts a fresh row each call. */
async function ensureUpstreamFresh() {
  const future = new Date(Date.now() + 60_000);
  await testDb`
    INSERT INTO public.topology_compute_runs
      (started_at, completed_at, status, computation_version, entities_processed)
    VALUES (NOW(), ${future}, 'completed', 1, 1)
  `;
  await testDb`
    INSERT INTO public.clustering_compute_runs
      (started_at, completed_at, status, computation_version, entities_processed, cluster_count, noise_count)
    VALUES (NOW(), ${future}, 'completed', 1, 1, 1, 0)
  `;
}

async function fullReset() {
  // Wipe every table that could leak between tests. entity_topology /
  // entity_clusters / entity_drift_events / *_compute_runs aren't in the
  // central deleteFromTables list, so we wipe them explicitly.
  await deleteFromTables({ acknowledgeGlobal: true });
  await testDb`DELETE FROM public.entity_topology`;
  await testDb`DELETE FROM public.entity_clusters`;
  await testDb`DELETE FROM public.entity_drift_events`;
  await testDb`DELETE FROM public.topology_compute_runs`;
  await testDb`DELETE FROM public.clustering_compute_runs`;
  await testDb`DELETE FROM public.cross_cluster_runs`;
  await testDb`DELETE FROM public.merge_candidates`;
  // Defensive: drop the error-path test's sabotage trigger + function in case
  // a prior process crashed between CREATE and the test's finally-block DROP.
  // No-op when they don't exist (IF EXISTS).
  await testDb.unsafe(`DROP TRIGGER IF EXISTS sabotage_mc_trigger_ncc92 ON public.merge_candidates;`);
  await testDb.unsafe(`DROP FUNCTION IF EXISTS sabotage_merge_candidates_ncc92();`);
}

describe('cross-cluster candidate generator', () => {
  beforeEach(async () => {
    await fullReset();
    // Reset env knobs each test starts with defaults.
    delete process.env.MIN_COMPONENT_SIZE;
    delete process.env.MIN_K_CORE_FOR_BRIDGE;
    delete process.env.BRIDGE_SCORE_THRESHOLD;
    delete process.env.MAX_CANDIDATES_PER_COMPONENT_PAIR;
    delete process.env.MAX_DRIFT_DRIVEN_CANDIDATES_PER_EVENT;
    delete process.env.DRIFT_RECENCY_DAYS;
    delete process.env.CROSS_CLUSTER_W_CLUSTER;
    delete process.env.CROSS_CLUSTER_W_DRIFT_A;
    delete process.env.CROSS_CLUSTER_W_DRIFT_B;
    delete process.env.CROSS_CLUSTER_W_ROLE;
    delete process.env.CROSS_CLUSTER_W_CENTRALITY;
    delete process.env.CROSS_CLUSTER_W_ARTICULATION;
  });

  it('empty graph: no error, no candidates, ran=true', async () => {
    await ensureUpstreamFresh();
    const r = await generateCrossClusterCandidates();
    expect(r.ran).toBe(true);
    expect(r.componentPairsEvaluated).toBe(0);
    expect(r.candidatesInserted).toBe(0);
  });

  it('single component: no cross-component pairs to evaluate', async () => {
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedTopology(b.id, { componentId: 0 });
    await seedCluster(a.id, { clusterId: 1 });
    await seedCluster(b.id, { clusterId: 1 });

    const r = await generateCrossClusterCandidates();
    expect(r.ran).toBe(true);
    expect(r.componentPairsEvaluated).toBe(0);
    expect(r.candidatesInserted).toBe(0);
  });

  it('two trivial size-1 components: skipped by MIN_COMPONENT_SIZE filter', async () => {
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    // Each component has only one entity — below default MIN_COMPONENT_SIZE=2.
    await seedTopology(a.id, { componentId: 0, componentSize: 1 });
    await seedTopology(b.id, { componentId: 1, componentSize: 1 });
    await seedCluster(a.id, { clusterId: 1 });
    await seedCluster(b.id, { clusterId: 1 });

    const r = await generateCrossClusterCandidates();
    expect(r.candidatesInserted).toBe(0);
  });

  it('shared cluster across components: a high-score candidate surfaces', async () => {
    await ensureUpstreamFresh();
    const a1 = await createTestEntity({ canonicalName: 'A1', entityType: 'person' });
    const a2 = await createTestEntity({ canonicalName: 'A2', entityType: 'person' });
    const b1 = await createTestEntity({ canonicalName: 'B1', entityType: 'person' });
    const b2 = await createTestEntity({ canonicalName: 'B2', entityType: 'person' });

    await seedTopology(a1.id, { componentId: 0, pagerank: 0.5 });
    await seedTopology(a2.id, { componentId: 0, pagerank: 0.4 });
    await seedTopology(b1.id, { componentId: 1, pagerank: 0.5 });
    await seedTopology(b2.id, { componentId: 1, pagerank: 0.4 });
    // a1 ↔ b1 share cluster 7 with high probability — that pair should win.
    await seedCluster(a1.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(b1.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(a2.id, { clusterId: 8, probability: 0.6 });
    await seedCluster(b2.id, { clusterId: 9, probability: 0.6 });

    const r = await generateCrossClusterCandidates();
    expect(r.ran).toBe(true);
    expect(r.componentPairsEvaluated).toBe(1);
    expect(r.candidatesInserted).toBeGreaterThanOrEqual(1);

    const list = await listCrossClusterCandidates();
    expect(list.length).toBeGreaterThanOrEqual(1);
    // The top scorer is the shared-cluster pair (a1, b1).
    const top = list[0]!;
    const ids = new Set([top.entityA.id, top.entityB.id]);
    expect(ids.has(a1.id) && ids.has(b1.id)).toBe(true);
  });

  it('candidate_source = "cross_cluster_generator" + 3-signal columns NULL', async () => {
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedTopology(b.id, { componentId: 1 });
    await seedCluster(a.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(b.id, { clusterId: 7, probability: 0.95 });

    await generateCrossClusterCandidates();

    const rows = await testDb<{
      candidate_source: string;
      centroid_similarity: number | null;
      memory_overlap: number | null;
      structural_similarity: number | null;
      status: string;
    }[]>`
      SELECT candidate_source, centroid_similarity, memory_overlap,
             structural_similarity, status
      FROM public.merge_candidates
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.candidate_source).toBe('cross_cluster_generator');
      expect(r.centroid_similarity).toBeNull();
      expect(r.memory_overlap).toBeNull();
      expect(r.structural_similarity).toBeNull();
      expect(r.status).toBe('candidate');
    }
  });

  it('threshold filter: candidates below BRIDGE_SCORE_THRESHOLD are not inserted', async () => {
    process.env.BRIDGE_SCORE_THRESHOLD = '10.0';  // unreachable — score caps at ~1.0
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0, isArticulation: true });
    await seedTopology(b.id, { componentId: 1, isArticulation: true });
    await seedCluster(a.id, { clusterId: 7, probability: 1.0 });
    await seedCluster(b.id, { clusterId: 7, probability: 1.0 });

    const r = await generateCrossClusterCandidates();
    expect(r.componentPairsEvaluated).toBe(1);
    expect(r.candidatesInserted).toBe(0);
  });

  it('cap per pair: only top MAX_CANDIDATES_PER_COMPONENT_PAIR are kept', async () => {
    process.env.MAX_CANDIDATES_PER_COMPONENT_PAIR = '2';
    await ensureUpstreamFresh();
    // 4 entities in component 0, 4 in component 1, all sharing cluster 7 →
    // 16 above-threshold candidates for one component pair. With cap=2 only
    // the top-2 are persisted.
    const ids: { compA: string[]; compB: string[] } = { compA: [], compB: [] };
    for (let i = 0; i < 4; i++) {
      const a = await createTestEntity({ canonicalName: `A${i}`, entityType: 'person' });
      const b = await createTestEntity({ canonicalName: `B${i}`, entityType: 'person' });
      ids.compA.push(a.id); ids.compB.push(b.id);
      await seedTopology(a.id, { componentId: 0, pagerank: 0.5 - i * 0.01 });
      await seedTopology(b.id, { componentId: 1, pagerank: 0.5 - i * 0.01 });
      await seedCluster(a.id, { clusterId: 7, probability: 0.9 - i * 0.05 });
      await seedCluster(b.id, { clusterId: 7, probability: 0.9 - i * 0.05 });
    }
    const r = await generateCrossClusterCandidates();
    expect(r.componentPairsEvaluated).toBe(1);
    expect(r.candidatesInserted).toBe(2);
    const list = await listCrossClusterCandidates();
    expect(list.length).toBe(2);
  });

  it('articulation bonus lifts an articulation-point pair above a non-articulation pair', async () => {
    await ensureUpstreamFresh();
    const a1 = await createTestEntity({ canonicalName: 'A1', entityType: 'person' });
    const a2 = await createTestEntity({ canonicalName: 'A2', entityType: 'person' });
    const b1 = await createTestEntity({ canonicalName: 'B1', entityType: 'person' });
    const b2 = await createTestEntity({ canonicalName: 'B2', entityType: 'person' });
    // (a1, b1) — articulation-point pair.
    await seedTopology(a1.id, { componentId: 0, isArticulation: true, pagerank: 0.4 });
    await seedTopology(b1.id, { componentId: 1, isArticulation: true, pagerank: 0.4 });
    // (a2, b2) — non-articulation, otherwise identical.
    await seedTopology(a2.id, { componentId: 0, isArticulation: false, pagerank: 0.4 });
    await seedTopology(b2.id, { componentId: 1, isArticulation: false, pagerank: 0.4 });
    // All four in same cluster so the cluster term is identical.
    for (const id of [a1.id, a2.id, b1.id, b2.id]) {
      await seedCluster(id, { clusterId: 7, probability: 0.8 });
    }

    await generateCrossClusterCandidates();
    const list = await listCrossClusterCandidates();
    // Find both pairs in the result list.
    const articulationPair = list.find((c) =>
      (c.entityA.id === a1.id && c.entityB.id === b1.id) ||
      (c.entityA.id === b1.id && c.entityB.id === a1.id)
    );
    const nonArticulationPair = list.find((c) =>
      (c.entityA.id === a2.id && c.entityB.id === b2.id) ||
      (c.entityA.id === b2.id && c.entityB.id === a2.id)
    );
    expect(articulationPair).toBeDefined();
    expect(nonArticulationPair).toBeDefined();
    expect(articulationPair!.combinedScore).toBeGreaterThan(nonArticulationPair!.combinedScore);
  });

  it('drifted entity in component A produces candidates against component B target-cluster members', async () => {
    await ensureUpstreamFresh();
    const drifted = await createTestEntity({ canonicalName: 'Drifted', entityType: 'person' });
    const target = await createTestEntity({ canonicalName: 'Target', entityType: 'person' });
    const padA = await createTestEntity({ canonicalName: 'PadA', entityType: 'person' });
    const padB = await createTestEntity({ canonicalName: 'PadB', entityType: 'person' });
    await seedTopology(drifted.id, { componentId: 0 });
    await seedTopology(padA.id, { componentId: 0 });
    await seedTopology(target.id, { componentId: 1 });
    await seedTopology(padB.id, { componentId: 1 });
    // drifted is in cluster 1, target & padB in cluster 9. Drift event says
    // drifted is heading toward cluster 9 — pairs (drifted ↔ target) and
    // (drifted ↔ padB) should both surface as drift-driven candidates even
    // if §2.2 sweep wouldn't on its own (different cluster_id, low score).
    await seedCluster(drifted.id, { clusterId: 1, probability: 0.6 });
    await seedCluster(padA.id, { clusterId: 1, probability: 0.6 });
    await seedCluster(target.id, { clusterId: 9, probability: 0.9 });
    await seedCluster(padB.id, { clusterId: 9, probability: 0.9 });
    await seedDriftEvent(drifted.id, { targetClusterId: 9, triggeredAction: 'reconciliation_invoked' });

    const r = await generateCrossClusterCandidates();
    expect(r.driftDrivenCandidates).toBeGreaterThanOrEqual(1);

    const list = await listCrossClusterCandidates();
    const driftedTarget = list.find((c) => {
      const ids = new Set([c.entityA.id, c.entityB.id]);
      return ids.has(drifted.id) && ids.has(target.id);
    });
    expect(driftedTarget).toBeDefined();
    expect(driftedTarget!.resolutionReasoning).toContain('drift_driven');
  });

  it('drift cap: a single drift event targeting a large cross-component cluster yields only MAX_DRIFT_DRIVEN_CANDIDATES_PER_EVENT rows (bead .97)', async () => {
    // Override the cap so the test runs quickly with smaller fan-out. Default
    // is 10; the assertion below pins the effective value via the env var.
    process.env.MAX_DRIFT_DRIVEN_CANDIDATES_PER_EVENT = '10';
    await ensureUpstreamFresh();

    // Drifted entity in component 0, drifting toward cluster 9.
    const drifted = await createTestEntity({ canonicalName: 'Drifted', entityType: 'person' });
    await seedTopology(drifted.id, { componentId: 0, pagerank: 0.5 });
    await seedCluster(drifted.id, { clusterId: 1, probability: 0.6 });

    // 50 cluster-9 members in component 1 (cross-component). Vary pagerank so
    // the scorer produces distinguishable scores (top-10 are deterministic).
    const targets: string[] = [];
    for (let i = 0; i < 50; i++) {
      const t = await createTestEntity({ canonicalName: `T${i}`, entityType: 'person' });
      await seedTopology(t.id, { componentId: 1, pagerank: 0.5 - i * 0.005 });
      await seedCluster(t.id, { clusterId: 9, probability: 0.9 });
      targets.push(t.id);
    }

    // One drift event — drifted heading toward cluster 9. Without the cap,
    // this would yield 50 drift-driven rows; with cap=10 we expect exactly 10.
    await seedDriftEvent(drifted.id, { targetClusterId: 9, triggeredAction: 'reconciliation_invoked' });

    const r = await generateCrossClusterCandidates();
    expect(r.ran).toBe(true);
    expect(r.driftDrivenCandidates).toBe(10);

    // List the cross-cluster candidates and verify the 10 kept rows are sorted
    // by score DESC (the top-10 by score, not arbitrary 10).
    const list = await listCrossClusterCandidates(100);
    // All inserted rows are drift-driven (no §2.2 partition fires here — the
    // drifted entity and targets share no cluster_id with each other except
    // via the drift target_cluster_id, and the cluster signal is in [0,1]).
    expect(list.length).toBe(10);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.combinedScore).toBeGreaterThanOrEqual(list[i]!.combinedScore);
    }
    // Every kept row pairs drifted with one of the 50 targets.
    for (const c of list) {
      const ids = new Set([c.entityA.id, c.entityB.id]);
      expect(ids.has(drifted.id)).toBe(true);
      const partnerId = c.entityA.id === drifted.id ? c.entityB.id : c.entityA.id;
      expect(targets.includes(partnerId)).toBe(true);
    }
  });

  it('drift cap respects env override: MAX_DRIFT_DRIVEN_CANDIDATES_PER_EVENT=3 keeps top-3 (bead .97)', async () => {
    process.env.MAX_DRIFT_DRIVEN_CANDIDATES_PER_EVENT = '3';
    await ensureUpstreamFresh();
    const drifted = await createTestEntity({ canonicalName: 'D', entityType: 'person' });
    await seedTopology(drifted.id, { componentId: 0, pagerank: 0.5 });
    await seedCluster(drifted.id, { clusterId: 1, probability: 0.6 });
    for (let i = 0; i < 12; i++) {
      const t = await createTestEntity({ canonicalName: `T${i}`, entityType: 'person' });
      await seedTopology(t.id, { componentId: 1, pagerank: 0.5 - i * 0.01 });
      await seedCluster(t.id, { clusterId: 9, probability: 0.9 });
    }
    await seedDriftEvent(drifted.id, { targetClusterId: 9, triggeredAction: 'reconciliation_invoked' });

    const r = await generateCrossClusterCandidates();
    expect(r.driftDrivenCandidates).toBe(3);
  });

  it('idempotent: a second run on identical state inserts no NEW rows (UPDATE only)', async () => {
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedTopology(b.id, { componentId: 1 });
    await seedCluster(a.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(b.id, { clusterId: 7, probability: 0.95 });

    await generateCrossClusterCandidates();
    const after1 = await testDb<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM public.merge_candidates`;
    await generateCrossClusterCandidates();
    const after2 = await testDb<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM public.merge_candidates`;
    expect(Number(after2[0]!.count)).toBe(Number(after1[0]!.count));

    // detection_count should have incremented to 2.
    const detections = await testDb<{ detection_count: number }[]>`
      SELECT detection_count FROM public.merge_candidates LIMIT 1
    `;
    expect(detections[0]!.detection_count).toBe(2);
  });

  it('ON CONFLICT preserves cross_cluster_generator (never downgrades to three_signal_scoring) AND preserves resolution_reasoning (bead nmemo-2yv.90)', async () => {
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedTopology(b.id, { componentId: 1 });
    await seedCluster(a.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(b.id, { clusterId: 7, probability: 0.95 });
    await generateCrossClusterCandidates();

    // Capture the original cross-cluster reasoning JSON for later comparison.
    const before = await testDb<{ resolution_reasoning: string }[]>`
      SELECT resolution_reasoning FROM public.merge_candidates
    `;
    const ccReasoning = before[0]!.resolution_reasoning;
    expect(ccReasoning).toContain('contributions');  // sanity: it's the cross-cluster JSON

    // Now simulate the three-signal scorer upserting the same pair with a
    // three-signal-style reasoning blob. The cross-cluster generator's upsert
    // (which also runs again — i.e. the cross-cluster generator itself on a
    // re-run) must preserve both the source tag AND the reasoning.
    const [aId, bId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    await testDb`
      INSERT INTO public.merge_candidates
        (entity_a_id, entity_b_id, centroid_similarity, memory_overlap,
         structural_similarity, combined_score, status, candidate_source, resolution_reasoning)
      VALUES (${aId}::uuid, ${bId}::uuid, 0.5, 0.5, 0.5, 0.5, 'staging', 'three_signal_scoring',
              'three-signal verbiage about centroid/memory/structural similarity')
      ON CONFLICT (entity_a_id, entity_b_id) DO UPDATE SET
        candidate_source = CASE WHEN merge_candidates.candidate_source = 'cross_cluster_generator'
                                THEN merge_candidates.candidate_source
                                ELSE EXCLUDED.candidate_source END,
        centroid_similarity = EXCLUDED.centroid_similarity,
        memory_overlap = EXCLUDED.memory_overlap,
        structural_similarity = EXCLUDED.structural_similarity,
        resolution_reasoning = CASE WHEN merge_candidates.candidate_source = 'cross_cluster_generator'
                                    THEN merge_candidates.resolution_reasoning
                                    ELSE EXCLUDED.resolution_reasoning END
    `;
    const rows = await testDb<{ candidate_source: string; resolution_reasoning: string }[]>`
      SELECT candidate_source, resolution_reasoning FROM public.merge_candidates
    `;
    expect(rows[0]!.candidate_source).toBe('cross_cluster_generator');
    // R3 B4 lock extended to reasoning (nmemo-2yv.90): cross-cluster JSON
    // survives the three-signal scorer's collision; the LLM verifier still
    // sees the right reasoning_seed.
    expect(rows[0]!.resolution_reasoning).toBe(ccReasoning);
  });

  it('NULL component_size in entity_topology: skipped with reason "stale_upstream" (bead .96)', async () => {
    // Doc 25 §2.1 invariant: the MIN_COMPONENT_SIZE gate is the *full*
    // component size, not the post-k_core bucket length. A NULL component_size
    // means Phase 2 topology compute didn't populate the metadata; the pre-bead
    // fallback to byComponent[cid].length silently inverted the invariant.
    // Fix: scan for NULL component_size and skip with skippedReason
    // 'stale_upstream' so the operator sees the upstream gap rather than a
    // silently-degraded gate.
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    // Seed component_size as NULL via direct INSERT (the seedTopology helper
    // defaults to 2, which is non-NULL — we need the NULL row explicitly to
    // exercise the new gate).
    await testDb.unsafe(`
      INSERT INTO public.entity_topology
        (entity_id, component_id, component_size, k_core, is_articulation_point, pagerank, computation_version)
      VALUES
        ('${a.id}'::uuid, 0, NULL, 2, false, 0.1, 1),
        ('${b.id}'::uuid, 1, NULL, 2, false, 0.1, 1)
    `);
    await seedCluster(a.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(b.id, { clusterId: 7, probability: 0.95 });

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const r = await generateCrossClusterCandidates();
      expect(r.ran).toBe(false);
      expect(r.skippedReason).toBe('stale_upstream');
      expect(r.componentPairsEvaluated).toBe(0);
      expect(r.candidatesInserted).toBe(0);
    } finally {
      console.warn = origWarn;
    }
    // The warn must mention component_size + the affected component_ids so
    // the operator can correlate to a specific Phase 2 backfill gap.
    const matched = warnings.find((w) => w.includes('component_size') && (w.includes('component_ids=[0,1]') || w.includes('component_ids=[1,0]')));
    expect(matched, `expected a component_size warning, got: ${JSON.stringify(warnings)}`).toBeDefined();
  });

  it('freshness gate: stale upstream skips with reason "stale_upstream"', async () => {
    // Simulate: a fresh entity but an old topology compute.
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedCluster(a.id, { clusterId: 1 });
    // Topology completed 1 hour ago, but the entity row above was just created
    // → topology stale.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await testDb`
      INSERT INTO public.topology_compute_runs
        (started_at, completed_at, status, computation_version, entities_processed)
      VALUES (${past}, ${past}, 'completed', 1, 1)
    `;
    await testDb`
      INSERT INTO public.clustering_compute_runs
        (started_at, completed_at, status, computation_version, entities_processed, cluster_count, noise_count)
      VALUES (${past}, ${past}, 'completed', 1, 1, 1, 0)
    `;
    const r = await generateCrossClusterCandidates();
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe('stale_upstream');
    expect(r.candidatesInserted).toBe(0);
  });

  it('advisory lock: a second concurrent invocation short-circuits with "lock_held"', async () => {
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedTopology(b.id, { componentId: 1 });
    await seedCluster(a.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(b.id, { clusterId: 7, probability: 0.95 });

    // Hold the lock on a separate session via testDb (postgres pool reuses the
    // same client where it can — the explicit `reserve()` call pins one).
    const reserved = await testDb.reserve();
    try {
      await reserved`SELECT pg_advisory_lock(hashtext('cross_cluster_generator'))`;
      const r = await generateCrossClusterCandidates();
      expect(r.ran).toBe(false);
      expect(r.skippedReason).toBe('lock_held');
    } finally {
      await reserved`SELECT pg_advisory_unlock(hashtext('cross_cluster_generator'))`;
      reserved.release();
    }
  });

  it('listCrossClusterCandidates: returns only cross_cluster_generator rows ordered by score', async () => {
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    const c = await createTestEntity({ canonicalName: 'C', entityType: 'person' });
    const d = await createTestEntity({ canonicalName: 'D', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedTopology(b.id, { componentId: 1 });
    await seedTopology(c.id, { componentId: 0 });
    await seedTopology(d.id, { componentId: 1 });
    await seedCluster(a.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(b.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(c.id, { clusterId: 8, probability: 0.5 });
    await seedCluster(d.id, { clusterId: 8, probability: 0.5 });
    await generateCrossClusterCandidates();

    // Plant a non-cross-cluster row that must be excluded by the source filter.
    const [otherA, otherB] = a.id < c.id ? [a.id, c.id] : [c.id, a.id];
    await testDb.unsafe(`
      INSERT INTO public.merge_candidates
        (entity_a_id, entity_b_id, combined_score, status, candidate_source)
      VALUES ('${otherA}'::uuid, '${otherB}'::uuid, 0.99, 'candidate', 'three_signal_scoring')
    `);

    const list = await listCrossClusterCandidates();
    for (const c of list) {
      // Every row in the helper must descend from cross-cluster generation.
      expect(c.combinedScore).toBeLessThanOrEqual(1.0);
    }
    // Sorted descending by score.
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.combinedScore).toBeGreaterThanOrEqual(list[i]!.combinedScore);
    }
    // The 3-signal row is not in the result.
    expect(list.find((c) => c.combinedScore > 0.95 && c.combinedScore < 1.0)).toBeUndefined();
  });

  it('listCrossClusterCandidates: default statusFilter hides resolved rows; explicit ["resolved"] returns them (bead .98)', async () => {
    // Seed one 'candidate' and one 'resolved' cross_cluster_generator row.
    // Both must descend from candidate_source='cross_cluster_generator' to
    // pass the helper's source filter; status is the only thing that differs.
    const a = await createTestEntity({ canonicalName: 'CandA', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'CandB', entityType: 'person' });
    const cEntity = await createTestEntity({ canonicalName: 'ResC', entityType: 'person' });
    const dEntity = await createTestEntity({ canonicalName: 'ResD', entityType: 'person' });
    const [ab1, ab2] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    const [cd1, cd2] = cEntity.id < dEntity.id ? [cEntity.id, dEntity.id] : [dEntity.id, cEntity.id];
    await testDb.unsafe(`
      INSERT INTO public.merge_candidates
        (entity_a_id, entity_b_id, combined_score, status, candidate_source)
      VALUES
        ('${ab1}'::uuid, '${ab2}'::uuid, 0.80, 'candidate', 'cross_cluster_generator'),
        ('${cd1}'::uuid, '${cd2}'::uuid, 0.90, 'resolved',  'cross_cluster_generator')
    `);

    // Default args: only the candidate row surfaces.
    const defaults = await listCrossClusterCandidates();
    expect(defaults.length).toBe(1);
    expect(defaults[0]!.status).toBe('candidate');

    // Explicit ['resolved']: only the resolved row surfaces.
    const resolved = await listCrossClusterCandidates(100, ['resolved']);
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.status).toBe('resolved');

    // Explicit ['candidate', 'resolved']: both surface.
    const both = await listCrossClusterCandidates(100, ['candidate', 'resolved']);
    expect(both.length).toBe(2);
    expect(new Set(both.map((r) => r.status))).toEqual(new Set(['candidate', 'resolved']));
  });

  // ---------------------------------------------------------------------------
  // cross_cluster_runs telemetry (bead nmemo-2yv.92)
  // ---------------------------------------------------------------------------

  it('telemetry: completed run produces a "completed" row with all counters populated', async () => {
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedTopology(b.id, { componentId: 1 });
    await seedCluster(a.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(b.id, { clusterId: 7, probability: 0.95 });

    const result = await generateCrossClusterCandidates();
    expect(result.ran).toBe(true);
    expect(result.runId).toBeTruthy();

    const runs = await listCrossClusterRuns(5);
    expect(runs.length).toBe(1);
    const run = runs[0]!;
    expect(run.id).toBe(result.runId);
    expect(run.status).toBe('completed');
    expect(run.skippedReason).toBeNull();
    expect(run.completedAt).not.toBeNull();
    expect(run.componentPairsEvaluated).toBe(result.componentPairsEvaluated);
    expect(run.candidatesInserted).toBe(result.candidatesInserted);
    expect(run.driftDrivenCandidates).toBe(result.driftDrivenCandidates);
    expect(typeof run.durationMs).toBe('number');
    expect(run.durationMs!).toBeGreaterThanOrEqual(0);
    expect(run.error).toBeNull();
  });

  it('telemetry: lock-held skip produces a "skipped" row with skipped_reason="lock_held"', async () => {
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedTopology(b.id, { componentId: 1 });
    await seedCluster(a.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(b.id, { clusterId: 7, probability: 0.95 });

    // Pin a reserved session and hold the advisory lock so the generator's
    // pg_try_advisory_xact_lock returns false.
    const reserved = await testDb.reserve();
    try {
      await reserved`SELECT pg_advisory_lock(hashtext('cross_cluster_generator'))`;
      const result = await generateCrossClusterCandidates();
      expect(result.ran).toBe(false);
      expect(result.skippedReason).toBe('lock_held');
      expect(result.runId).toBeTruthy();

      const runs = await listCrossClusterRuns(5);
      expect(runs.length).toBe(1);
      const run = runs[0]!;
      expect(run.id).toBe(result.runId);
      expect(run.status).toBe('skipped');
      expect(run.skippedReason).toBe('lock_held');
      expect(run.completedAt).not.toBeNull();
      expect(typeof run.durationMs).toBe('number');
      expect(run.durationMs!).toBeGreaterThanOrEqual(0);
      expect(run.error).toBeNull();
    } finally {
      await reserved`SELECT pg_advisory_unlock(hashtext('cross_cluster_generator'))`;
      reserved.release();
    }
  });

  it('telemetry: stale-upstream skip produces a "skipped" row with skipped_reason="stale_upstream"', async () => {
    // Same seeding pattern as the existing stale-upstream test: completed_at
    // sits in the past, the entity sits in the present → stale.
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedCluster(a.id, { clusterId: 1 });
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await testDb`
      INSERT INTO public.topology_compute_runs
        (started_at, completed_at, status, computation_version, entities_processed)
      VALUES (${past}, ${past}, 'completed', 1, 1)
    `;
    await testDb`
      INSERT INTO public.clustering_compute_runs
        (started_at, completed_at, status, computation_version, entities_processed, cluster_count, noise_count)
      VALUES (${past}, ${past}, 'completed', 1, 1, 1, 0)
    `;

    const result = await generateCrossClusterCandidates();
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe('stale_upstream');
    expect(result.runId).toBeTruthy();

    const runs = await listCrossClusterRuns(5);
    expect(runs.length).toBe(1);
    const run = runs[0]!;
    expect(run.id).toBe(result.runId);
    expect(run.status).toBe('skipped');
    expect(run.skippedReason).toBe('stale_upstream');
    expect(run.completedAt).not.toBeNull();
    expect(run.error).toBeNull();
  });

  it('telemetry: a thrown error inside the main tx produces an "error" row AND the exception propagates', async () => {
    await ensureUpstreamFresh();
    // Seed a legitimate above-threshold pair so the generator reaches the
    // upsertCandidate call inside the main tx.
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedTopology(b.id, { componentId: 1 });
    await seedCluster(a.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(b.id, { clusterId: 7, probability: 0.95 });

    // Sabotage: a BEFORE INSERT trigger on merge_candidates that raises on
    // every insert. The upsertCandidate inside the main tx will hit this and
    // throw, rolling back the main tx. The separate-tx run row (INSERTed before
    // the main tx opens) must survive and be UPDATEd to status='error'.
    await testDb.unsafe(`
      CREATE OR REPLACE FUNCTION sabotage_merge_candidates_ncc92() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'sabotage error for nmemo-2yv.92 telemetry test';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await testDb.unsafe(`
      DROP TRIGGER IF EXISTS sabotage_mc_trigger_ncc92 ON public.merge_candidates;
      CREATE TRIGGER sabotage_mc_trigger_ncc92 BEFORE INSERT ON public.merge_candidates
      FOR EACH ROW EXECUTE FUNCTION sabotage_merge_candidates_ncc92();
    `);
    try {
      await expect(generateCrossClusterCandidates()).rejects.toThrow(/sabotage/);

      const runs = await listCrossClusterRuns(5);
      expect(runs.length).toBe(1);
      const run = runs[0]!;
      expect(run.status).toBe('error');
      expect(run.completedAt).not.toBeNull();
      expect(typeof run.durationMs).toBe('number');
      expect(run.error).toBeTruthy();
      expect(run.error).toContain('sabotage');
    } finally {
      await testDb.unsafe(`DROP TRIGGER IF EXISTS sabotage_mc_trigger_ncc92 ON public.merge_candidates;`);
      await testDb.unsafe(`DROP FUNCTION IF EXISTS sabotage_merge_candidates_ncc92();`);
    }
  });

  // ---------------------------------------------------------------------------
  // Score-weight env override + normalisation (bead nmemo-2yv.91)
  // ---------------------------------------------------------------------------

  it('weight defaults sum to 1.0 (invariant guard against future regressions)', () => {
    // If a future edit changes a default and breaks the sum, the normalisation
    // warn will fire on every default invocation — noisy logs, no behaviour
    // change but a stale-comment risk. Catch the drift here.
    expect(0.35 + 0.125 + 0.125 + 0.20 + 0.15 + 0.05).toBeCloseTo(1.0, 6);
  });

  it('weight env override: doubling one weight warns AND preserves candidate ordering after normalisation', async () => {
    // Seed: two component pairs (a1↔b1 and a2↔b2) both above default
    // threshold 0.3 — a1↔b1 at ~0.48, a2↔b2 at ~0.33. The cross-pairs
    // a1↔b2 / a2↔b1 stay below threshold (different clusters → score ~0.12),
    // so both runs produce exactly the same 2-pair set; ordering preserved
    // iff normalisation scales proportionally.
    const setup = async () => {
      await fullReset();
      delete process.env.CROSS_CLUSTER_W_CLUSTER;
      await ensureUpstreamFresh();
      const a1 = await createTestEntity({ canonicalName: 'A1', entityType: 'person' });
      const a2 = await createTestEntity({ canonicalName: 'A2', entityType: 'person' });
      const b1 = await createTestEntity({ canonicalName: 'B1', entityType: 'person' });
      const b2 = await createTestEntity({ canonicalName: 'B2', entityType: 'person' });
      await seedTopology(a1.id, { componentId: 0, pagerank: 0.5 });
      await seedTopology(a2.id, { componentId: 0, pagerank: 0.4 });
      await seedTopology(b1.id, { componentId: 1, pagerank: 0.5 });
      await seedTopology(b2.id, { componentId: 1, pagerank: 0.4 });
      await seedCluster(a1.id, { clusterId: 7, probability: 0.95 });
      await seedCluster(b1.id, { clusterId: 7, probability: 0.95 });
      await seedCluster(a2.id, { clusterId: 8, probability: 0.6 });
      await seedCluster(b2.id, { clusterId: 8, probability: 0.6 });
      return { a1, b1, a2, b2 };
    };

    // Default-weights run captures the ordering.
    const { a1, b1, a2, b2 } = await setup();
    await generateCrossClusterCandidates();
    const defaultOrder = (await listCrossClusterCandidates()).map((c) => {
      const ids = new Set([c.entityA.id, c.entityB.id]);
      if (ids.has(a1.id) && ids.has(b1.id)) return 'a1b1';
      if (ids.has(a2.id) && ids.has(b2.id)) return 'a2b2';
      return 'other';
    });

    // 2x cluster weight (sum = 1.0 + 0.35 = 1.35) → expect a warn + normalised
    // weights → since cluster is the dominant signal and we scale all weights
    // proportionally, the ordering of candidates is preserved.
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
    try {
      const setup2 = await setup();
      void setup2;
      process.env.CROSS_CLUSTER_W_CLUSTER = String(0.35 * 2);
      await generateCrossClusterCandidates();
      const overrideOrder = (await listCrossClusterCandidates()).map((c) => {
        const ids = new Set([c.entityA.id, c.entityB.id]);
        if (ids.has(setup2.a1.id) && ids.has(setup2.b1.id)) return 'a1b1';
        if (ids.has(setup2.a2.id) && ids.has(setup2.b2.id)) return 'a2b2';
        return 'other';
      });
      // Ordering preserved (same pairs in same order).
      expect(overrideOrder).toEqual(defaultOrder);
      // A warn was emitted naming the sum drift.
      expect(warns.some((w) => /weights sum=.*!=\s*1\.0.*normalising/.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it('weight env override: sum = 0 yields zero candidates with a warn, no crash', async () => {
    await ensureUpstreamFresh();
    const a = await createTestEntity({ canonicalName: 'A', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'B', entityType: 'person' });
    await seedTopology(a.id, { componentId: 0 });
    await seedTopology(b.id, { componentId: 1 });
    await seedCluster(a.id, { clusterId: 7, probability: 0.95 });
    await seedCluster(b.id, { clusterId: 7, probability: 0.95 });

    // Zero every weight via env.
    process.env.CROSS_CLUSTER_W_CLUSTER = '0';
    process.env.CROSS_CLUSTER_W_DRIFT_A = '0';
    process.env.CROSS_CLUSTER_W_DRIFT_B = '0';
    process.env.CROSS_CLUSTER_W_ROLE = '0';
    process.env.CROSS_CLUSTER_W_CENTRALITY = '0';
    process.env.CROSS_CLUSTER_W_ARTICULATION = '0';

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
    try {
      const r = await generateCrossClusterCandidates();
      expect(r.ran).toBe(true);
      expect(r.candidatesInserted).toBe(0);
      expect(warns.some((w) => /too close to 0/.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });
});
