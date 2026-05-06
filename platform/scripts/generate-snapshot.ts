#!/usr/bin/env tsx
/**
 * snapshot:generate <name> — LLM-pipeline (or empty) snapshot generator.
 *
 * Doc 28 §3.4. Drops + recreates the target DB, applies migrations, optionally
 * runs the LLM ingest pipeline against the manifest's source corpus, then
 * dumps Postgres (and Qdrant when present). For the `empty` entry there is no
 * source corpus, so steps 4-7 of §3.4 are skipped and the dump captures the
 * post-migration schema-only state.
 *
 * The full LLM ingest path (chunking + /ingest/queue with timeouts) lands in
 * j77.2 (synthetic generator) and j77.3 (LLM generator with bridge-pair
 * injection support and post-ingest reconciliation/gardener hooks). This
 * skeleton is sufficient for the `empty` baseline that gates Phase 1 close.
 */

import { mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  loadManifest,
  saveManifest,
  findEntry,
  entryFileAbsPath,
  SnapshotEntry,
  Manifest,
} from './lib/manifest.js';
import { sha256File } from './lib/hash.js';
import { loadAndAssertDatabaseUrl } from './lib/db-guard.js';
import { resolvePgTools, runPgDump, ConnInfo } from './lib/pg-tools.js';
import {
  dropAndRecreateDatabase,
  enableExtensionsAndMigrate,
  countEntitiesAndFacts,
} from './lib/db-bootstrap.js';

const DEFAULT_PG_DUMP_FLAGS = ['--format=custom', '--no-sync', '--no-comments'];

export async function generateSnapshot(name: string): Promise<{
  entry: SnapshotEntry;
  durationMs: number;
}> {
  const start = Date.now();
  const manifest = loadManifest();
  const entry = findEntry(manifest, name);
  if (entry.kind !== 'llm') {
    throw new Error(
      `generate-snapshot only handles kind="llm" entries; "${name}" is "${entry.kind}". ` +
      `Use generate-synthetic for synthetic entries.`
    );
  }
  const conn = loadAndAssertDatabaseUrl();
  const pgTools = resolvePgTools();
  console.log(`  pg_dump: ${pgTools.note}`);

  console.log(`  → drop + recreate ${conn.database}`);
  await dropAndRecreateDatabase(conn);

  console.log(`  → apply migrations`);
  const { migrationsApplied } = await enableExtensionsAndMigrate(conn);
  console.log(`    applied ${migrationsApplied} migration files`);

  if (entry.source_corpus) {
    throw new Error(
      `LLM ingest path not implemented in skeleton. Tracked under nmemo-j77.3. ` +
      `The "${name}" entry references source_corpus=${entry.source_corpus} but this ` +
      `skeleton only supports source_corpus=null (the "empty" baseline).`
    );
  }

  const dumpAbs = entryFileAbsPath(entry, 'postgres');
  if (!dumpAbs) {
    throw new Error(`entry "${name}" has no files.postgres path`);
  }
  mkdirSync(dirname(dumpAbs), { recursive: true });

  const flags = entry.pg_dump_flags ?? DEFAULT_PG_DUMP_FLAGS;
  console.log(`  → pg_dump → ${dumpAbs}`);
  await runPgDump(pgTools, conn as ConnInfo, flags, dumpAbs);

  const counts = await countEntitiesAndFacts(conn);
  const dumpHash = await sha256File(dumpAbs);

  entry.expected_hashes = { ...entry.expected_hashes, 'cognitive.dump': dumpHash };
  entry.regenerated_at = new Date().toISOString();
  entry.stats = {
    ...entry.stats,
    total_entities: counts.total_entities,
    total_facts: counts.total_facts,
    ingest_time_ms: 0,
  };
  saveManifest(manifest);

  const durationMs = Date.now() - start;
  console.log(`  ✓ generated "${name}" in ${durationMs}ms (entities=${counts.total_entities}, facts=${counts.total_facts})`);
  return { entry, durationMs };
}

const invokedDirectly = process.argv[1]?.endsWith('generate-snapshot.ts')
  || process.argv[1]?.endsWith('generate-snapshot.js');

if (invokedDirectly) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: pnpm snapshot:generate <name>');
    process.exit(2);
  }
  generateSnapshot(name).catch((err) => {
    console.error(`generate-snapshot failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
