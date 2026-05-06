#!/usr/bin/env tsx
/**
 * snapshot:verify [name] — hash-check manifest entries against the on-disk
 * cache. Reports mismatches without regenerating (doc 28 §3.5 / §4.2).
 *
 * Exit code 0 = all entries OK, 1 = at least one mismatch / missing file.
 */

import { existsSync } from 'fs';
import {
  loadManifest,
  findEntry,
  entryFileAbsPath,
  SnapshotEntry,
} from './lib/manifest.js';
import { sha256File } from './lib/hash.js';

export type VerifyStatus = 'ok' | 'missing' | 'mismatch' | 'no-hash';

export interface VerifyResult {
  name: string;
  fileKey: string;
  status: VerifyStatus;
  expected?: string;
  actual?: string;
  path?: string;
}

export async function verifyEntry(entry: SnapshotEntry): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const [fileKey, relPath] of Object.entries(entry.files)) {
    if (!relPath) continue;
    const abs = entryFileAbsPath(entry, fileKey as keyof SnapshotEntry['files']);
    if (!abs) continue;
    const fileBaseName = abs.split(/[\\/]/).pop() ?? abs;
    const expected = entry.expected_hashes[fileBaseName];
    if (!existsSync(abs)) {
      results.push({ name: entry.name, fileKey, status: 'missing', expected, path: abs });
      continue;
    }
    const actual = await sha256File(abs);
    if (!expected) {
      results.push({ name: entry.name, fileKey, status: 'no-hash', actual, path: abs });
      continue;
    }
    results.push({
      name: entry.name,
      fileKey,
      status: actual === expected ? 'ok' : 'mismatch',
      expected,
      actual,
      path: abs,
    });
  }
  return results;
}

export async function verifyAll(name?: string): Promise<{
  results: VerifyResult[];
  ok: boolean;
}> {
  const manifest = loadManifest();
  const entries = name ? [findEntry(manifest, name)] : manifest.entries;
  const results: VerifyResult[] = [];
  for (const entry of entries) {
    if (entry.deprecated) continue;
    results.push(...await verifyEntry(entry));
  }
  const ok = results.every((r) => r.status === 'ok' || r.status === 'no-hash');
  return { results, ok };
}

function formatLine(r: VerifyResult): string {
  const sigil = r.status === 'ok' ? '✓' : r.status === 'no-hash' ? '·' : '✗';
  const detail =
    r.status === 'mismatch'
      ? ` (expected ${r.expected?.slice(0, 23)}…, got ${r.actual?.slice(0, 23)}…)`
      : r.status === 'missing'
        ? ` (file not found: ${r.path})`
        : r.status === 'no-hash'
          ? ` (no expected_hash recorded — run snapshot:ensure to populate)`
          : '';
  return `  ${sigil} ${r.name}.${r.fileKey} ${r.status}${detail}`;
}

const invokedDirectly = process.argv[1]?.endsWith('snapshot-verify.ts')
  || process.argv[1]?.endsWith('snapshot-verify.js');

if (invokedDirectly) {
  const name = process.argv[2];
  verifyAll(name).then(({ results, ok }) => {
    for (const r of results) console.log(formatLine(r));
    if (results.length === 0) {
      console.log(`  (no entries to verify${name ? ` — "${name}" not found` : ''})`);
    }
    process.exit(ok ? 0 : 1);
  }).catch((err) => {
    console.error(`snapshot-verify failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
