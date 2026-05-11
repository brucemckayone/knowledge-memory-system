#!/usr/bin/env tsx
/**
 * Phase 1 graph-stats benchmark runner (doc 22 §5.2, nmemo-a7f.1.1.2).
 *
 * Single-stage: this script runs ONE benchmark per invocation. The wrapper
 * shell loop sets DATABASE_URL appropriately for each stage so the postgres
 * pool inside src/db/index.ts opens against the right DB. Without that
 * isolation, the import-cached pool would stick to whichever DATABASE_URL
 * was set at first import.
 *
 * Usage:
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-graph-stats.ts empty
 *   DATABASE_URL=...cognitive      tsx scripts/bench-graph-stats.ts canonical-corpus
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-graph-stats.ts synthetic-10k
 *
 * Output: platform/src/test/data/phase1-graph-stats/benchmark-reports/<stage>.json
 *
 * Each report is the JSON schema from doc 22 §5.2:
 *   { computed_at, total_entities, computed_duration_ms, ...numeric snapshot }
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '..', 'src', 'test', 'data', 'phase1-graph-stats', 'benchmark-reports');

interface StageConfig {
  load: 'snapshot' | 'live';
  source_detail: string;
  thresholds: { target_ms: number; hard_cap_ms: number };
  notes?: string;
}

const STAGES: Record<string, StageConfig> = {
  'empty': {
    load: 'snapshot',
    source_detail: 'manifest entry "empty"',
    thresholds: { target_ms: 50, hard_cap_ms: 200 }, // doc 22 §5.1, ≤100 entities
    notes: 'Schema-only baseline; every numeric column is zero or NULL.',
  },
  'canonical-corpus': {
    load: 'live',
    source_detail: 'live cognitive DB at benchmark time — MISRA/AUTOSAR/C++ technical-standards corpus',
    thresholds: { target_ms: 200, hard_cap_ms: 1000 }, // §5.1, ~1k entities (live is ~140)
    notes: 'Stand-in for the production-shape canonical corpus until j77.5 ships mixed-narrative-technical-1k. Re-run this stage against that snapshot once j77.5 closes.',
  },
  'synthetic-10k': {
    load: 'snapshot',
    source_detail: 'manifest entry "synthetic-10k"',
    thresholds: { target_ms: 2000, hard_cap_ms: 10000 }, // §5.1, 10k entities
    notes: '10k deterministic synthetic entities, 5 cluster modes, 50 bridge pairs (seed=42).',
  },
};

async function main(): Promise<void> {
  const stage = process.argv[2];
  if (!stage || !(stage in STAGES)) {
    console.error('Usage: tsx scripts/bench-graph-stats.ts <empty|canonical-corpus|synthetic-10k>');
    process.exit(2);
  }
  const cfg = STAGES[stage]!;

  if (cfg.load === 'snapshot') {
    const { loadSnapshot } = await import('./load-snapshot.js');
    await loadSnapshot(stage);
  }

  const { computeGraphStats } = await import('../src/services/graph-stats.js');
  const stats = await computeGraphStats();

  const report = {
    name: stage,
    source: cfg.load === 'snapshot' ? 'snapshot' : 'live-dev-db',
    source_detail: cfg.source_detail,
    computed_at: stats.computedAt.toISOString(),
    computed_duration_ms: stats.computedDurationMs,
    total_entities: stats.totalEntities,
    total_facts: stats.totalFacts,
    total_active_facts: stats.totalActiveFacts,
    total_memories: stats.totalMemories,
    embedding_cluster_count: stats.embeddingClusterCount,
    mean_intra_cluster_distance: stats.meanIntraClusterDistance,
    mean_inter_cluster_distance: stats.meanInterClusterDistance,
    centroid_sim_mean: stats.centroidSimMean,
    centroid_sim_median: stats.centroidSimMedian,
    centroid_sim_p10: stats.centroidSimP10,
    centroid_sim_p90: stats.centroidSimP90,
    centroid_sample_size: stats.centroidSampleSize,
    fact_density: stats.factDensity,
    orphan_rate: stats.orphanRate,
    predicate_diversity: stats.predicateDiversity,
    merge_candidates_pending: stats.mergeCandidatesPending,
    computation_version: stats.computationVersion,
    cluster_columns_version: stats.clusterColumnsVersion,
    thresholds: cfg.thresholds,
    notes: cfg.notes,
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${stage}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`✓ ${stage}: entities=${report.total_entities} active_facts=${report.total_active_facts} duration_ms=${report.computed_duration_ms}`);
  console.log(`  → ${path}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
