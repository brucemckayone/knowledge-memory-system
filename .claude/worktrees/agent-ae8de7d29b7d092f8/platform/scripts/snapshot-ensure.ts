#!/usr/bin/env tsx
/**
 * snapshot:ensure <name> — idempotent "make sure this snapshot exists".
 *
 * Doc 28 §2.4:
 *   - files exist + hashes match → cache hit (return)
 *   - files exist + hashes mismatch → regenerate (warn about drift)
 *   - files missing → regenerate from scratch
 */

import { existsSync } from 'fs';
import {
  loadManifest,
  findEntry,
  entryFileAbsPath,
  SnapshotEntry,
} from './lib/manifest.js';
import { sha256File } from './lib/hash.js';
import { generateSnapshot } from './generate-snapshot.js';
import { generateSynthetic } from './generate-synthetic.js';

export type EnsureOutcome = 'cache-hit' | 'regenerated-missing' | 'regenerated-drift';

export async function ensureSnapshot(name: string): Promise<{
  entry: SnapshotEntry;
  outcome: EnsureOutcome;
  durationMs: number;
}> {
  const start = Date.now();
  const manifest = loadManifest();
  const entry = findEntry(manifest, name);

  const dumpAbs = entryFileAbsPath(entry, 'postgres');
  if (!dumpAbs) throw new Error(`entry "${name}" has no files.postgres path`);

  const expectedHash = entry.expected_hashes['cognitive.dump'];
  const fileExists = existsSync(dumpAbs);

  if (fileExists && expectedHash) {
    const actual = await sha256File(dumpAbs);
    if (actual === expectedHash) {
      const durationMs = Date.now() - start;
      console.log(`  ✓ ${name}: cache hit (${durationMs}ms)`);
      return { entry, outcome: 'cache-hit', durationMs };
    }
    console.warn(`  ⚠ ${name}: hash mismatch (expected ${expectedHash.slice(0, 23)}…, got ${actual.slice(0, 23)}…) — regenerating`);
    await regenerate(entry);
    return { entry: findEntry(loadManifest(), name), outcome: 'regenerated-drift', durationMs: Date.now() - start };
  }

  if (!fileExists) {
    console.log(`  → ${name}: file missing — regenerating`);
    await regenerate(entry);
    return { entry: findEntry(loadManifest(), name), outcome: 'regenerated-missing', durationMs: Date.now() - start };
  }

  console.warn(`  ⚠ ${name}: no expected_hash recorded yet — regenerating to populate manifest`);
  await regenerate(entry);
  return { entry: findEntry(loadManifest(), name), outcome: 'regenerated-missing', durationMs: Date.now() - start };
}

async function regenerate(entry: SnapshotEntry): Promise<void> {
  if (entry.kind === 'llm') {
    await generateSnapshot(entry.name);
  } else {
    await generateSynthetic(entry.name);
  }
}

const invokedDirectly = process.argv[1]?.endsWith('snapshot-ensure.ts')
  || process.argv[1]?.endsWith('snapshot-ensure.js');

if (invokedDirectly) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: pnpm snapshot:ensure <name>');
    process.exit(2);
  }
  ensureSnapshot(name).catch((err) => {
    console.error(`snapshot-ensure failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
