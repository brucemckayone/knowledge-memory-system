/**
 * Skeleton smoke tests for the snapshot infrastructure (nmemo-j77.1).
 *
 * Doc 28 §4.2: covers the subset of automated tests applicable to the
 * skeleton — manifest validity, pg_dump probe resolution, ensure +
 * verify against the empty entry. The full §4.2 test set lands under
 * nmemo-j77.1.1 once the LLM/synthetic generators ship.
 *
 * Runs in the dedicated `vitest.snapshot.config.ts` project (serial,
 * single-fork) so pg_restore can drop+recreate cognitive_test without
 * racing other workers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, rmSync } from 'fs';
import {
  loadManifest,
  findEntry,
  entryFileAbsPath,
  validateManifest,
  ManifestError,
} from '../../../scripts/lib/manifest.js';
import { resolvePgTools } from '../../../scripts/lib/pg-tools.js';
import {
  parseDatabaseUrl,
  isDatabaseAllowed,
  assertDestructiveTargetAllowed,
  DatabaseGuardError,
} from '../../../scripts/lib/db-guard.js';
import { ensureSnapshot } from '../../../scripts/snapshot-ensure.js';
import { verifyAll } from '../../../scripts/snapshot-verify.js';
import { loadSnapshot } from '../../../scripts/load-snapshot.js';

describe('snapshot manifest', () => {
  it('parses and validates', () => {
    const manifest = loadManifest();
    expect(manifest.version).toBeGreaterThan(0);
    expect(manifest.entries.length).toBeGreaterThan(0);
  });

  it('contains the empty entry with required fields', () => {
    const manifest = loadManifest();
    const entry = findEntry(manifest, 'empty');
    expect(entry.name).toBe('empty');
    expect(entry.kind).toBe('llm');
    expect(entry.files.postgres).toBeTruthy();
    expect(entry.schema_version).toBeGreaterThan(0);
    expect(entry.deterministic).toBe(false);
  });

  it('rejects duplicate entry names', () => {
    expect(() =>
      validateManifest({
        version: 1,
        entries: [
          { name: 'a', kind: 'llm', description: '', files: { postgres: 'x' }, expected_hashes: {}, schema_version: 1, stats: {}, deterministic: false },
          { name: 'a', kind: 'llm', description: '', files: { postgres: 'y' }, expected_hashes: {}, schema_version: 1, stats: {}, deterministic: false },
        ],
      }),
    ).toThrow(ManifestError);
  });

  it('rejects entries missing required fields', () => {
    expect(() =>
      validateManifest({
        version: 1,
        entries: [{ name: 'broken' }],
      }),
    ).toThrow(ManifestError);
  });
});

describe('pg_dump resolution', () => {
  it('resolves a usable pg_dump (host PATH, fallback paths, or docker-exec)', () => {
    const resolution = resolvePgTools();
    expect(['host', 'docker']).toContain(resolution.mode);
    expect(resolution.note.length).toBeGreaterThan(0);
    if (resolution.mode === 'docker') {
      expect(resolution.container).toBeTruthy();
    }
  });
});

describe('database guard', () => {
  it('allows cognitive_test', () => {
    expect(isDatabaseAllowed('cognitive_test')).toBe(true);
  });

  it('allows cognitive_snapshot_* names', () => {
    expect(isDatabaseAllowed('cognitive_snapshot_foo')).toBe(true);
    expect(isDatabaseAllowed('cognitive_snapshot_a-b-c')).toBe(true);
  });

  it('refuses cognitive (the dev DB)', () => {
    expect(isDatabaseAllowed('cognitive')).toBe(false);
    expect(() =>
      assertDestructiveTargetAllowed(parseDatabaseUrl('postgres://u:p@h:5432/cognitive')),
    ).toThrow(DatabaseGuardError);
  });

  it('refuses arbitrary databases', () => {
    expect(isDatabaseAllowed('production')).toBe(false);
    expect(isDatabaseAllowed('postgres')).toBe(false);
  });
});

describe('snapshot ensure + verify (empty entry)', () => {
  let dumpAbs: string;

  beforeAll(() => {
    const entry = findEntry(loadManifest(), 'empty');
    const abs = entryFileAbsPath(entry, 'postgres');
    if (!abs) throw new Error('empty entry missing postgres path');
    dumpAbs = abs;
    if (existsSync(dumpAbs)) rmSync(dumpAbs);
  });

  it('regenerates the empty snapshot from scratch on first ensure', async () => {
    const result = await ensureSnapshot('empty');
    expect(result.outcome).toBe('regenerated-missing');
    expect(existsSync(dumpAbs)).toBe(true);
  }, 90_000);

  it('reports cache hit on the second ensure', async () => {
    const result = await ensureSnapshot('empty');
    expect(result.outcome).toBe('cache-hit');
  }, 90_000);

  it('verify reports OK after ensure', async () => {
    const { ok, results } = await verifyAll('empty');
    expect(ok).toBe(true);
    const dumpResult = results.find((r) => r.fileKey === 'postgres');
    expect(dumpResult?.status).toBe('ok');
  });

  it('load-snapshot restores the empty schema with zero rows', async () => {
    const result = await loadSnapshot('empty');
    expect(result.rowCounts.total_entities).toBe(0);
    expect(result.rowCounts.total_facts).toBe(0);
  }, 90_000);
});
