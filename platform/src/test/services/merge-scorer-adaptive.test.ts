/**
 * Unit Tests: merge-scorer adaptive weighting (bead nmemo-2yv.43)
 *
 * Pure-function tests for `adaptWeights()`. No DB, no Qdrant — these only
 * exercise the modulation rules from doc 22 §2.2 row 2:
 *
 *   Rule 1: centroid_sim_p90 - p10 < 0.1 → halve W_CENTROID, redistribute.
 *   Rule 2: embedding_cluster_count <= 1 (or null) → zero W_CLUSTER, redistribute.
 *
 * The integration tests in src/test/harness/graph-meta-adaptive.test.ts cover
 * the end-to-end wiring (graph_stats → scorer → merge_candidates row); this
 * file isolates the pure logic.
 */

import { describe, it, expect } from 'vitest';
import {
  adaptWeights,
  DEFAULT_WEIGHTS,
  type MergeScorerWeights,
} from '../../services/merge-scorer.js';
import type { GraphStats } from '../../services/graph-stats.js';

/** Helper — build a GraphStats stub with overrides over the empty-graph base. */
function makeStats(overrides: Partial<GraphStats> = {}): GraphStats {
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

function sum(w: MergeScorerWeights): number {
  return (
    w.centroidSimilarity +
    w.memoryOverlap +
    w.structuralSimilarity +
    w.clusterMatch +
    w.predicateSignatureCosine +
    w.driftRecencyEither +
    w.centralityMatch +
    w.articulationBonus +
    w.componentMatch
  );
}

describe('adaptWeights — bead nmemo-2yv.43', () => {
  it('null stats: returns base unchanged, adapted=false', () => {
    const { weights, adapted } = adaptWeights(DEFAULT_WEIGHTS, null);
    expect(weights).toEqual(DEFAULT_WEIGHTS);
    expect(adapted).toBe(false);
  });

  it('undefined stats: returns base unchanged, adapted=false', () => {
    const { weights, adapted } = adaptWeights(DEFAULT_WEIGHTS, undefined);
    expect(weights).toEqual(DEFAULT_WEIGHTS);
    expect(adapted).toBe(false);
  });

  it('wide centroid spread + multi-cluster: neither rule fires, adapted=false', () => {
    const stats = makeStats({
      centroidSimP10: 0.1,
      centroidSimP90: 0.9, // spread 0.8 >> threshold
      embeddingClusterCount: 5,
    });
    const { weights, adapted } = adaptWeights(DEFAULT_WEIGHTS, stats);
    expect(weights).toEqual(DEFAULT_WEIGHTS);
    expect(adapted).toBe(false);
  });

  it('Rule 1 only: saturated centroid (multi-cluster) halves W_CENTROID and redistributes', () => {
    const stats = makeStats({
      centroidSimP10: 0.85,
      centroidSimP90: 0.90, // spread 0.05 < 0.1
      embeddingClusterCount: 5,
    });
    const { weights, adapted } = adaptWeights(DEFAULT_WEIGHTS, stats);

    expect(adapted).toBe(true);
    // Centroid weight halved
    expect(weights.centroidSimilarity).toBeCloseTo(DEFAULT_WEIGHTS.centroidSimilarity / 2, 10);
    // Total still sums to 1.0 (redistribution preserves the budget)
    expect(sum(weights)).toBeCloseTo(1.0, 10);
    // Cluster weight increased (received its share of the redistribution)
    expect(weights.clusterMatch).toBeGreaterThan(DEFAULT_WEIGHTS.clusterMatch);
  });

  it('Rule 2 only: single cluster zeroes W_CLUSTER and redistributes', () => {
    const stats = makeStats({
      centroidSimP10: 0.1,
      centroidSimP90: 0.9, // wide — rule 1 inactive
      embeddingClusterCount: 1,
    });
    const { weights, adapted } = adaptWeights(DEFAULT_WEIGHTS, stats);

    expect(adapted).toBe(true);
    expect(weights.clusterMatch).toBe(0);
    expect(sum(weights)).toBeCloseTo(1.0, 10);
    // Centroid weight grew (received share); not halved (rule 1 inactive)
    expect(weights.centroidSimilarity).toBeGreaterThan(DEFAULT_WEIGHTS.centroidSimilarity);
  });

  it('Rule 2: null embedding_cluster_count treated as no-cluster-info (zero W_CLUSTER)', () => {
    const stats = makeStats({
      centroidSimP10: 0.1,
      centroidSimP90: 0.9,
      embeddingClusterCount: null,
    });
    const { weights, adapted } = adaptWeights(DEFAULT_WEIGHTS, stats);
    expect(adapted).toBe(true);
    expect(weights.clusterMatch).toBe(0);
  });

  it('Both rules fire: saturated centroid + single cluster — both adjustments applied', () => {
    const stats = makeStats({
      centroidSimP10: 0.92,
      centroidSimP90: 0.95, // spread 0.03 — saturated
      embeddingClusterCount: 1, // single cluster
    });
    const { weights, adapted } = adaptWeights(DEFAULT_WEIGHTS, stats);

    expect(adapted).toBe(true);
    expect(weights.centroidSimilarity).toBeLessThan(DEFAULT_WEIGHTS.centroidSimilarity);
    expect(weights.clusterMatch).toBe(0);
    expect(sum(weights)).toBeCloseTo(1.0, 10);
  });

  it('Rule 1 abstains when p10 or p90 is null (cannot measure spread)', () => {
    const stats = makeStats({
      centroidSimP10: null,
      centroidSimP90: 0.95,
      embeddingClusterCount: 5, // rule 2 inactive
    });
    const { weights, adapted } = adaptWeights(DEFAULT_WEIGHTS, stats);
    expect(weights.centroidSimilarity).toBe(DEFAULT_WEIGHTS.centroidSimilarity);
    expect(adapted).toBe(false);
  });

  it('Threshold boundary: spread just above 0.1 does NOT trigger rule 1', () => {
    // Using 0.4 and 0.5 hits FP imprecision (0.5-0.4 = 0.09999...); pick
    // values that comfortably exceed the threshold so the boundary case is
    // well-defined either side of FP noise.
    const stats = makeStats({
      centroidSimP10: 0.4,
      centroidSimP90: 0.51, // spread 0.11 > 0.1
      embeddingClusterCount: 5,
    });
    const { weights, adapted } = adaptWeights(DEFAULT_WEIGHTS, stats);
    expect(weights.centroidSimilarity).toBe(DEFAULT_WEIGHTS.centroidSimilarity);
    expect(adapted).toBe(false);
  });

  it('Threshold boundary: spread just below 0.1 (0.099) DOES trigger rule 1', () => {
    const stats = makeStats({
      centroidSimP10: 0.4,
      centroidSimP90: 0.499,
      embeddingClusterCount: 5,
    });
    const { weights, adapted } = adaptWeights(DEFAULT_WEIGHTS, stats);
    expect(adapted).toBe(true);
    expect(weights.centroidSimilarity).toBeCloseTo(DEFAULT_WEIGHTS.centroidSimilarity / 2, 10);
  });

  it('Pure function: does not mutate the base weights', () => {
    const stats = makeStats({
      centroidSimP10: 0.85,
      centroidSimP90: 0.90,
      embeddingClusterCount: 1,
    });
    const baseSnapshot = { ...DEFAULT_WEIGHTS };
    adaptWeights(DEFAULT_WEIGHTS, stats);
    expect(DEFAULT_WEIGHTS).toEqual(baseSnapshot);
  });

  it('Custom base weights propagate through redistribution', () => {
    // Caller-overridden weights (e.g. cross-cluster's vector) — adaptive
    // modulation must work against ANY base, not just DEFAULT_WEIGHTS.
    const customBase: MergeScorerWeights = {
      centroidSimilarity:        0.1,
      memoryOverlap:             0.1,
      structuralSimilarity:      0.1,
      clusterMatch:              0.4,  // weight-heavy on cluster
      predicateSignatureCosine:  0.1,
      driftRecencyEither:        0.1,
      centralityMatch:           0.05,
      articulationBonus:         0.025,
      componentMatch:            0.025,
    };
    expect(sum(customBase)).toBeCloseTo(1.0, 10);

    const stats = makeStats({
      centroidSimP10: 0.1,
      centroidSimP90: 0.9,
      embeddingClusterCount: 1, // rule 2 fires
    });
    const { weights, adapted } = adaptWeights(customBase, stats);
    expect(adapted).toBe(true);
    expect(weights.clusterMatch).toBe(0);
    expect(sum(weights)).toBeCloseTo(1.0, 10);
    // Other weights all grew (0.4 redistributed across 8 signals)
    expect(weights.centroidSimilarity).toBeGreaterThan(customBase.centroidSimilarity);
  });
});
