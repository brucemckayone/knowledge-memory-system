/**
 * Restoration helper tests (nmemo-j77.4).
 *
 * Doc 28 §3.6 helper contract:
 *   - ensureSnapshot(name) closes the existing testDb pool, runs
 *     snapshot:ensure (regenerating if missing/hash-mismatched), restores
 *     the snapshot into cognitive_test, and reopens the pool. After it
 *     resolves, testDb queries see the snapshot's state.
 *   - loadGroundTruth(name) reads the side-channel ground_truth.json for
 *     synthetic snapshots, errors clearly when missing.
 *
 * Doc 28 §4.2 cases covered here:
 *   - empty snapshot loads cleanly (zero rows in entities/facts)
 *   - synthetic-1k restores 1000 entities
 *   - schema-version mismatch detected (manually rewrite manifest, restore
 *     fails with explicit instruction to regenerate)
 *   - loadGroundTruth returns 10 BridgePair objects for synthetic-1k
 *   - loadGroundTruth errors clearly when ground_truth.json is missing
 *
 * Runs under vitest.snapshot.config.ts (single fork, file-parallelism off).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, renameSync } from 'fs';
import {
  testDb,
  ensureSnapshot,
  loadGroundTruth,
  closeTestDbPool,
  openTestDbPool,
} from '../setup.js';
import {
  loadManifest,
  saveManifest,
  findEntry,
  entryFileAbsPath,
} from '../../../scripts/lib/manifest.js';
import { loadSnapshot } from '../../../scripts/load-snapshot.js';

describe('ensureSnapshot — empty', () => {
  beforeAll(async () => {
    await ensureSnapshot('empty');
  }, 90_000);

  it('leaves the test DB at zero rows', async () => {
    const entities = await testDb<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM public.entities`;
    expect(parseInt(entities[0]!.c, 10)).toBe(0);
    const facts = await testDb<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM public.facts`;
    expect(parseInt(facts[0]!.c, 10)).toBe(0);
  });

  it('leaves the testDb pool open after ensureSnapshot resolves', async () => {
    // testDb proxy must forward to a live handle — a follow-up query succeeds
    const r = await testDb<{ x: number }[]>`SELECT 1::int AS x`;
    expect(r[0]!.x).toBe(1);
  });
});

describe('ensureSnapshot — synthetic-1k', () => {
  beforeAll(async () => {
    await ensureSnapshot('synthetic-1k');
  }, 180_000);

  it('restores exactly 1000 entities', async () => {
    const rows = await testDb<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM public.entities`;
    expect(parseInt(rows[0]!.c, 10)).toBe(1000);
  });

  it('restores facts at the manifest-recorded count', async () => {
    const entry = findEntry(loadManifest(), 'synthetic-1k');
    const rows = await testDb<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM public.facts`;
    expect(parseInt(rows[0]!.c, 10)).toBe(entry.stats.total_facts);
  });

  it('the testDb proxy supports unsafe + tagged template + begin', async () => {
    // Tagged template — already exercised above
    // unsafe()
    const u = await testDb.unsafe('SELECT 7::int AS x');
    expect(u[0]!.x).toBe(7);
    // begin() (the fixture loader path)
    let txCount = 0;
    await testDb.begin(async (tx) => {
      const r = await tx<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM public.entities`;
      txCount = parseInt(r[0]!.c, 10);
    });
    expect(txCount).toBe(1000);
  });
});

describe('loadGroundTruth — synthetic-1k', () => {
  beforeAll(async () => {
    // Make sure the synthetic-1k file exists locally
    await ensureSnapshot('synthetic-1k');
  }, 180_000);

  it('returns the bridge-pair list with a/b/reason fields', async () => {
    const pairs = await loadGroundTruth('synthetic-1k');
    expect(Array.isArray(pairs)).toBe(true);
    expect(pairs.length).toBe(10);
    for (const pair of pairs) {
      expect(typeof pair.a).toBe('string');
      expect(typeof pair.b).toBe('string');
      expect(typeof pair.reason).toBe('string');
      expect(pair.a).not.toBe(pair.b);
      // Both IDs must look like UUIDs (synthetic generator emits v5-style)
      expect(pair.a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(pair.b).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(pair.reason).toMatch(/^bridge_pair_\d+$/);
    }
  });

  it('errors clearly when ground_truth.json is missing on disk', async () => {
    const entry = findEntry(loadManifest(), 'synthetic-1k');
    const groundTruthAbs = entryFileAbsPath(entry, 'ground_truth');
    expect(groundTruthAbs).toBeTruthy();
    const tempPath = groundTruthAbs! + '.bak';
    expect(existsSync(groundTruthAbs!)).toBe(true);
    renameSync(groundTruthAbs!, tempPath);
    try {
      await expect(loadGroundTruth('synthetic-1k')).rejects.toThrow(
        /ground_truth\.json missing for "synthetic-1k"/,
      );
    } finally {
      renameSync(tempPath, groundTruthAbs!);
    }
  });

  it('errors clearly when the snapshot has no ground_truth path (e.g. empty)', async () => {
    await expect(loadGroundTruth('empty')).rejects.toThrow(
      /no files\.ground_truth/,
    );
  });
});

describe('schema-version mismatch detection', () => {
  // Loading a snapshot whose manifest entry's schema_version disagrees with
  // the current migrations directory must fail with a clear "regenerate"
  // message (doc 28 §3.5 / §4.2).
  let originalSchemaVersion: number;

  beforeAll(async () => {
    // Make sure the synthetic-1k cache file exists.
    await ensureSnapshot('synthetic-1k');
    const manifest = loadManifest();
    const entry = findEntry(manifest, 'synthetic-1k');
    originalSchemaVersion = entry.schema_version;
  }, 180_000);

  afterAll(() => {
    // Restore the manifest no matter what so other tests are unaffected.
    const manifest = loadManifest();
    const entry = findEntry(manifest, 'synthetic-1k');
    if (entry.schema_version !== originalSchemaVersion) {
      entry.schema_version = originalSchemaVersion;
      saveManifest(manifest);
    }
  });

  it('rewriting schema_version → load fails with explicit error', async () => {
    const manifest = loadManifest();
    const entry = findEntry(manifest, 'synthetic-1k');
    entry.schema_version = 999;
    saveManifest(manifest);
    try {
      // Close the pool so loadSnapshot can drop+recreate the DB cleanly even
      // though the assertion will fire before that step.
      await closeTestDbPool();
      await expect(loadSnapshot('synthetic-1k')).rejects.toThrow(
        /schema_version mismatch.*Regenerate/i,
      );
    } finally {
      // Restore for downstream tests
      const restoreManifest = loadManifest();
      const restoreEntry = findEntry(restoreManifest, 'synthetic-1k');
      restoreEntry.schema_version = originalSchemaVersion;
      saveManifest(restoreManifest);
      // Reopen the pool against the test DB (the failed loadSnapshot did not
      // mutate state — schema check happens before the drop).
      await openTestDbPool();
    }
  }, 90_000);
});
