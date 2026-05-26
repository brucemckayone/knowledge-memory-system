#!/usr/bin/env tsx
/**
 * Phase 1 merge-scorer benchmark runner (bead nmemo-2yv.42; mirrors
 * scripts/bench-graph-stats.ts).
 *
 * Each invocation runs ONE benchmark stage. The wrapper shell loop sets
 * DATABASE_URL appropriately for each stage so the postgres pool inside
 * src/db/index.ts opens against the right DB. Without that isolation, the
 * import-cached pool would stick to whichever DATABASE_URL was set at first
 * import (same gotcha bench-graph-stats works around).
 *
 * Usage:
 *   DATABASE_URL=...cognitive      tsx scripts/bench-merge-scorer.ts canonical-corpus
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-merge-scorer.ts synthetic-1k
 *   DATABASE_URL=...cognitive_test tsx scripts/bench-merge-scorer.ts synthetic-10k
 *
 * Output: platform/src/test/data/phase1-merge-scorer/benchmark-reports/<stage>.json
 *
 * Stages map to the bead's three entity-count scales (100 / 1k / 10k). The
 * 100-scale substitutes canonical-corpus — the live cognitive DB carries
 * ~145 entities (close enough to 100 for the small-scale measurement; live
 * is also the only place a representative MISRA/AUTOSAR/C++ corpus exists
 * pre-`j77.5`). Each stage scores `target_pair_count` pairs sampled from the
 * loaded snapshot's entity pool — pair_count ≈ entity_count keeps both
 * dimensions of the join cost growing together.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '..', 'src', 'test', 'data', 'phase1-merge-scorer', 'benchmark-reports');

interface StageConfig {
  load: 'snapshot' | 'live';
  source_detail: string;
  target_pair_count: number;
  thresholds: { target_ms: number; hard_cap_ms: number };
  notes?: string;
}

const STAGES: Record<string, StageConfig> = {
  'canonical-corpus': {
    load: 'live',
    source_detail: 'live cognitive DB at benchmark time — MISRA/AUTOSAR/C++ technical-standards corpus (~145 entities)',
    target_pair_count: 100,
    thresholds: { target_ms: 100, hard_cap_ms: 500 }, // bead .42 added-acceptance, ~100 entities
    notes: 'Stands in for the bead\'s "100-entity scale" — the live cognitive DB carries ~145 entities. A future synthetic-100 snapshot would let this stage stop borrowing live data.',
  },
  'synthetic-1k': {
    load: 'snapshot',
    source_detail: 'manifest entry "synthetic-1k"',
    target_pair_count: 1000,
    thresholds: { target_ms: 1000, hard_cap_ms: 5000 }, // bead .42, 1k entities
    notes: '1k synthetic entities (seed=42, 5 cluster modes, 50 bridge pairs).',
  },
  'synthetic-10k': {
    load: 'snapshot',
    source_detail: 'manifest entry "synthetic-10k"',
    target_pair_count: 10000,
    thresholds: { target_ms: 10000, hard_cap_ms: 30000 }, // bead .42, 10k entities
    notes: '10k deterministic synthetic entities, same generator family as synthetic-1k.',
  },
};

async function main(): Promise<void> {
  const stage = process.argv[2];
  if (!stage || !(stage in STAGES)) {
    console.error('Usage: tsx scripts/bench-merge-scorer.ts <canonical-corpus|synthetic-1k|synthetic-10k>');
    process.exit(2);
  }
  const cfg = STAGES[stage]!;

  if (cfg.load === 'snapshot') {
    const { loadSnapshot } = await import('./load-snapshot.js');
    await loadSnapshot(stage);
  }

  const { db } = await import('../src/db/index.js');
  const { sql } = await import('drizzle-orm');
  const { scoreMergeCandidates } = await import('../src/services/merge-scorer.js');

  // Pull a deterministic sample of entity IDs. We use ORDER BY id::text so the
  // sample is stable across runs (random would let the bench report drift on
  // every invocation). LIMIT bounds the working set; for canonical-corpus
  // (~145 entities) we take all and form pairs from them.
  const entitySample = (await db.execute(sql`
    SELECT id::text AS id
    FROM public.entities
    ORDER BY id::text
    LIMIT 2000
  `)) as unknown as Array<{ id: string }>;
  const entityIds = entitySample.map((r) => r.id);

  if (entityIds.length < 2) {
    // No entities — report zero-pair timing as a sanity baseline.
    writeReport(stage, cfg, {
      entity_count: entityIds.length,
      pair_count: 0,
      duration_ms: 0,
      target_pair_count: cfg.target_pair_count,
      sample_size: entityIds.length,
    });
    process.exit(0);
  }

  // Form pairs: deterministic round-robin walk over the entity list, producing
  // up to `target_pair_count` canonical-ordered pairs without repetition.
  const pairs: Array<{ entityAId: string; entityBId: string }> = [];
  const seen = new Set<string>();
  outer: for (let stride = 1; stride < entityIds.length; stride++) {
    for (let i = 0; i + stride < entityIds.length; i++) {
      const a = entityIds[i]!;
      const b = entityIds[i + stride]!;
      const [x, y] = a < b ? [a, b] : [b, a];
      const k = `${x}|${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push({ entityAId: x, entityBId: y });
      if (pairs.length >= cfg.target_pair_count) break outer;
    }
  }

  // Time the scoring call. Two roundtrips (max-pagerank + main CTE) is the
  // contract — timing captures both.
  const t0 = Date.now();
  const scored = await scoreMergeCandidates(pairs, { runner: db });
  const duration_ms = Date.now() - t0;

  writeReport(stage, cfg, {
    entity_count: entityIds.length,
    pair_count: pairs.length,
    duration_ms,
    target_pair_count: cfg.target_pair_count,
    sample_size: entityIds.length,
    sampled_signal_distribution: summariseSignals(scored),
  });
  process.exit(0);
}

function summariseSignals(scored: Awaited<ReturnType<typeof import('../src/services/merge-scorer.js').scoreMergeCandidates>>) {
  const keys: Array<keyof typeof scored[number]['signals']> = [
    'centroid_similarity',
    'memory_overlap',
    'structural_similarity',
    'cluster_match',
    'predicate_signature_cosine',
    'drift_recency_either',
    'centrality_match',
    'articulation_bonus',
    'component_match',
  ];
  const out: Record<string, { non_null: number; mean: number | null; max: number | null }> = {};
  for (const k of keys) {
    const values = scored
      .map((s) => s.signals[k])
      .filter((v): v is number => typeof v === 'number');
    if (values.length === 0) {
      out[k] = { non_null: 0, mean: null, max: null };
      continue;
    }
    let sum = 0;
    let max = -Infinity;
    for (const v of values) {
      sum += v;
      if (v > max) max = v;
    }
    out[k] = { non_null: values.length, mean: sum / values.length, max };
  }
  return out;
}

interface ReportShape {
  entity_count: number;
  pair_count: number;
  duration_ms: number;
  target_pair_count: number;
  sample_size: number;
  sampled_signal_distribution?: Record<string, { non_null: number; mean: number | null; max: number | null }>;
}

function writeReport(stage: string, cfg: StageConfig, payload: ReportShape) {
  const report = {
    name: stage,
    source: cfg.load === 'snapshot' ? 'snapshot' : 'live-dev-db',
    source_detail: cfg.source_detail,
    computed_at: new Date().toISOString(),
    ...payload,
    thresholds: cfg.thresholds,
    notes: cfg.notes,
  };
  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${stage}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`✓ ${stage}: entities=${payload.entity_count} pairs=${payload.pair_count} duration_ms=${payload.duration_ms}`);
  console.log(`  → ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
