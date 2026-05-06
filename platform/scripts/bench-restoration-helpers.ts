#!/usr/bin/env tsx
/**
 * Restoration-helpers benchmark (nmemo-j77.4.2).
 *
 * Measures the doc 28 §3.6 helper round-trip for the snapshot ladder:
 *
 *   ensureSnapshot('empty')         → pool close + cache-hit ensure + load + reopen
 *   ensureSnapshot('synthetic-1k')  → pool close + cache-hit ensure + load + reopen
 *   ensureSnapshot('synthetic-10k') → pool close + cache-hit ensure + load + reopen
 *
 * Per doc 28 §5.1 the relevant thresholds are:
 *   - snapshot:ensure (cache hit) target <100ms / hard cap 500ms (just the hash check)
 *   - snapshot:load 1k entities target <1s / hard cap 3s
 *   - snapshot:load 10k entities target <5s / hard cap 15s
 *
 * The composite ensureSnapshot (close+ensure+load+reopen) is a strict superset
 * of `snapshot:load`, so this benchmark captures the helper-level latency
 * floor that downstream §5.1 consumers can budget against.
 *
 * Output: src/test/data/snapshots/benchmark-reports/restoration-helpers-baseline.json
 *
 * Pre-conditions (script aborts otherwise):
 *   - DATABASE_URL points at cognitive_test or cognitive_snapshot_*
 *   - All snapshot files in the manifest are present and hash-match
 *     (run `pnpm snapshot:ensure <name>` once for each before this script)
 *
 * Invocation: `pnpm tsx scripts/bench-restoration-helpers.ts` (NOT a test —
 * the resulting JSON is committed by hand once after measurement).
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { release, type as osType } from 'os';
import postgres from 'postgres';
import { PLATFORM_ROOT } from './lib/manifest.js';
import { ensureSnapshot as runEnsure } from './snapshot-ensure.js';
import { loadSnapshot } from './load-snapshot.js';
import { resolvePgTools } from './lib/pg-tools.js';

interface OperationReport {
  operation: string;
  snapshot: string;
  duration_ms: number;
  components: {
    pool_close_ms: number;
    ensure_ms: number;
    load_ms: number;
    pool_reopen_ms: number;
  };
  threshold_target_ms: number | null;
  threshold_hard_cap_ms: number | null;
  notes?: string;
}

interface Report {
  phase: string;
  machine: {
    platform: string;
    kernel: string;
    node: string;
    postgres_image: string;
    pg_dump_resolution: string;
  };
  thresholds_ref: string;
  operations: OperationReport[];
  captured_at: string;
  commit_at_capture: string;
  follow_ups: string[];
}

const TEST_DB_URL = process.env.DATABASE_URL ||
  'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test';

async function timeIt<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

async function measureEnsureRoundtrip(name: string): Promise<OperationReport['components']> {
  const handle = postgres(TEST_DB_URL, {
    connection: { search_path: 'public, ag_catalog, "$user"' },
  });
  // Warm the pool so close has something to close
  await handle`SELECT 1`;

  const close = await timeIt(() => handle.end({ timeout: 5 }));
  const ensure = await timeIt(() => runEnsure(name));
  const load = await timeIt(() => loadSnapshot(name));
  const reopen = await timeIt(async () => {
    const fresh = postgres(TEST_DB_URL, {
      connection: { search_path: 'public, ag_catalog, "$user"' },
    });
    await fresh`SELECT 1`;
    await fresh.end({ timeout: 5 });
  });

  return {
    pool_close_ms: close.ms,
    ensure_ms: ensure.ms,
    load_ms: load.ms,
    pool_reopen_ms: reopen.ms,
  };
}

async function main(): Promise<void> {
  const targets: Array<{ name: string; target_ms: number | null; cap_ms: number | null; note: string }> = [
    {
      name: 'empty',
      target_ms: null,
      cap_ms: null,
      note: '§5.1 has no helper-roundtrip threshold; load-1k thresholds (<1s target, <3s cap) apply to the load component only. The empty baseline measures the fixed cost of close+ensure+reopen on a tiny dump (~106 KB) so the rest of the ladder can be normalised against it.',
    },
    {
      name: 'synthetic-1k',
      target_ms: 1000,
      cap_ms: 3000,
      note: '§5.1 snapshot:load 1k target <1s / hard cap 3s (applies to load_ms in components). Composite ensureSnapshot is bounded by load_ms + ~50ms of pool work.',
    },
    {
      name: 'synthetic-10k',
      target_ms: 5000,
      cap_ms: 15000,
      note: '§5.1 snapshot:load 10k target <5s / hard cap 15s (applies to load_ms). Plain-format apply via psql is unavoidably slower than custom-format pg_restore; the determinism trade-off is documented in §5.1 follow-ups.',
    },
  ];

  const operations: OperationReport[] = [];
  for (const t of targets) {
    console.log(`\n→ measuring ensureSnapshot('${t.name}') roundtrip`);
    const components = await measureEnsureRoundtrip(t.name);
    const total = components.pool_close_ms + components.ensure_ms + components.load_ms + components.pool_reopen_ms;
    operations.push({
      operation: `ensureSnapshot (cache hit)`,
      snapshot: t.name,
      duration_ms: total,
      components,
      threshold_target_ms: t.target_ms,
      threshold_hard_cap_ms: t.cap_ms,
      notes: t.note,
    });
    console.log(`   total=${total}ms  close=${components.pool_close_ms}ms  ensure=${components.ensure_ms}ms  load=${components.load_ms}ms  reopen=${components.pool_reopen_ms}ms`);
  }

  const pgTools = resolvePgTools();
  const report: Report = {
    phase: 'j77.4 restoration helpers baseline',
    machine: {
      platform: process.platform,
      kernel: `${osType()} ${release()}`,
      node: process.version,
      postgres_image: 'nmemo-postgres (Postgres 16.13, AGE 1.5.0)',
      pg_dump_resolution: pgTools.note,
    },
    thresholds_ref: 'docs/architecture/truth-graph/28-test-data-snapshots.md §5.1',
    operations,
    captured_at: new Date().toISOString(),
    commit_at_capture: 'j77.4 working tree pre-commit',
    follow_ups: [
      'j77.5 — initial dataset roster generation (closes the j77 epic).',
      'Optimisation candidate: if synthetic-10k load consistently breaches the <5s §5.1 target, ship a separate format=directory manifest entry for that dataset (parallel restore via pg_restore --jobs).',
      'Cross-platform note: pg_dump_resolution above records whether host pg_dump was found or the docker-exec fallback was used; load_ms variance dominated by container-exec start-up cost on Windows.',
    ],
  };

  const outAbs = join(PLATFORM_ROOT, 'src', 'test', 'data', 'snapshots', 'benchmark-reports', 'restoration-helpers-baseline.json');
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`\n✓ wrote ${outAbs}`);
}

main().catch((err) => {
  console.error(`bench-restoration-helpers failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
