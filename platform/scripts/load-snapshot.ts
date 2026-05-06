#!/usr/bin/env tsx
/**
 * snapshot:load <name> — restore Postgres (and Qdrant when present) from a
 * cached snapshot. Doc 28 §3.5.
 *
 * Sequence:
 *   1. Resolve manifest entry; verify file present + hash matches
 *   2. Verify schema_version against the migrations directory
 *   3. Drop + recreate target Postgres database (clears connections first)
 *   4. pg_restore --clean --if-exists into target DB
 *   5. Drop Qdrant target collection unconditionally (skipped when no Qdrant
 *      file is recorded — empty baseline)
 *   6. Verify row counts match manifest stats
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  loadManifest,
  findEntry,
  entryFileAbsPath,
  PLATFORM_ROOT,
  SnapshotEntry,
} from './lib/manifest.js';
import { sha256File } from './lib/hash.js';
import { loadAndAssertDatabaseUrl } from './lib/db-guard.js';
import { resolvePgTools, runPgRestore, ConnInfo } from './lib/pg-tools.js';
import { dropAndRecreateDatabase, loadExtensions, countEntitiesAndFacts } from './lib/db-bootstrap.js';
import { deleteCollection } from './lib/qdrant.js';

const DEFAULT_PG_RESTORE_FLAGS = ['--clean', '--if-exists', '--no-owner', '--no-privileges'];

export async function loadSnapshot(name: string): Promise<{
  entry: SnapshotEntry;
  durationMs: number;
  rowCounts: { total_entities: number; total_facts: number };
}> {
  const start = Date.now();
  const manifest = loadManifest();
  const entry = findEntry(manifest, name);

  const dumpAbs = entryFileAbsPath(entry, 'postgres');
  if (!dumpAbs) throw new Error(`entry "${name}" has no files.postgres path`);
  if (!existsSync(dumpAbs)) {
    throw new Error(
      `snapshot file missing: ${dumpAbs} — run pnpm snapshot:ensure ${name} first`
    );
  }
  const expectedHash = entry.expected_hashes['cognitive.dump'];
  if (expectedHash) {
    const actual = await sha256File(dumpAbs);
    if (actual !== expectedHash) {
      throw new Error(
        `snapshot hash mismatch for ${name} — expected ${expectedHash}, got ${actual}. ` +
        `Run snapshot:ensure to regenerate, or snapshot:verify to triage.`
      );
    }
  }

  const migrationCount = readdirSync(join(PLATFORM_ROOT, 'src', 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql') && !f.includes('apache_age')).length;
  if (entry.schema_version !== migrationCount) {
    throw new Error(
      `schema_version mismatch: snapshot manifest says ${entry.schema_version}, ` +
      `migrations directory has ${migrationCount} files. Regenerate the snapshot ` +
      `against the current migrations or check out the matching commit.`
    );
  }

  const conn = loadAndAssertDatabaseUrl();
  const pgTools = resolvePgTools();
  console.log(`  pg_restore: ${pgTools.note}`);

  console.log(`  → drop + recreate ${conn.database}`);
  await dropAndRecreateDatabase(conn);

  console.log(`  → preload extensions (so pg_restore's --clean DROPs succeed)`);
  await loadExtensions(conn);

  console.log(`  → pg_restore from ${dumpAbs}`);
  await runPgRestore(pgTools, conn as ConnInfo, DEFAULT_PG_RESTORE_FLAGS, dumpAbs);

  if (entry.files.qdrant_memories) {
    const qdrantCollection = entry.name === 'empty' ? 'memories' : 'memories';
    console.log(`  → drop Qdrant collection "${qdrantCollection}"`);
    await deleteCollection(qdrantCollection);
  }

  const rowCounts = await countEntitiesAndFacts(conn);
  if (typeof entry.stats.total_entities === 'number' && rowCounts.total_entities !== entry.stats.total_entities) {
    throw new Error(
      `row-count check failed for ${name}: expected ${entry.stats.total_entities} entities, ` +
      `got ${rowCounts.total_entities}. Snapshot may be corrupt or out of date.`
    );
  }

  const durationMs = Date.now() - start;
  console.log(`  ✓ loaded "${name}" in ${durationMs}ms (entities=${rowCounts.total_entities}, facts=${rowCounts.total_facts})`);
  return { entry, durationMs, rowCounts };
}

const invokedDirectly = process.argv[1]?.endsWith('load-snapshot.ts')
  || process.argv[1]?.endsWith('load-snapshot.js');

if (invokedDirectly) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: pnpm snapshot:load <name>');
    process.exit(2);
  }
  loadSnapshot(name).catch((err) => {
    console.error(`snapshot-load failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
