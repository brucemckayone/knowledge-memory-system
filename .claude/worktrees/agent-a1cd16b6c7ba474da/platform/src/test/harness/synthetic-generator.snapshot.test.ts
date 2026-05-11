/**
 * Synthetic generator tests (nmemo-j77.2).
 *
 * Doc 28 §4.2 cases applicable to synthetic snapshots:
 *   - generator deterministic (same seed → byte-identical dump + ground truth)
 *   - stats match expectation (entity count exact, fact count within ±2%)
 *   - bridge-pair labelling (count, both IDs exist, no shared facts/memories,
 *     centroids in different cluster modes, NOT in same_as_links)
 *   - ground truth invisible to algorithms (no production-readable table
 *     contains the labels)
 *   - restoration round-trip (generate → dump → drop → restore → counts match)
 *
 * Runs under vitest.snapshot.config.ts (single fork, file-parallelism off).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import postgres from 'postgres';
import {
  loadManifest,
  findEntry,
  entryFileAbsPath,
} from '../../../scripts/lib/manifest.js';
import { sha256File } from '../../../scripts/lib/hash.js';
import { generateSynthetic } from '../../../scripts/generate-synthetic.js';
import { ensureSnapshot } from '../../../scripts/snapshot-ensure.js';
import { verifyAll } from '../../../scripts/snapshot-verify.js';
import { loadSnapshot } from '../../../scripts/load-snapshot.js';

const SYNTHETIC_NAME = 'synthetic-1k';

interface BridgePair {
  a: string;
  b: string;
  reason: string;
}

interface GroundTruth {
  snapshot: string;
  seed: number;
  bridge_pairs: BridgePair[];
}

function readGroundTruth(): GroundTruth {
  const entry = findEntry(loadManifest(), SYNTHETIC_NAME);
  const abs = entryFileAbsPath(entry, 'ground_truth');
  if (!abs) throw new Error('ground_truth path missing for synthetic-1k');
  return JSON.parse(readFileSync(abs, 'utf-8')) as GroundTruth;
}

describe('synthetic generator — synthetic-1k', () => {
  let dumpAbs: string;
  let groundTruthAbs: string;

  beforeAll(async () => {
    const entry = findEntry(loadManifest(), SYNTHETIC_NAME);
    dumpAbs = entryFileAbsPath(entry, 'postgres')!;
    groundTruthAbs = entryFileAbsPath(entry, 'ground_truth')!;
    // First-class ensure so subsequent assertions run against an existing snapshot
    await ensureSnapshot(SYNTHETIC_NAME);
  }, 180_000);

  describe('determinism', () => {
    it('same seed produces byte-identical dump and ground truth', async () => {
      const before = await sha256File(dumpAbs);
      const beforeGt = await sha256File(groundTruthAbs);
      // Wipe and regenerate
      rmSync(dumpAbs);
      rmSync(groundTruthAbs);
      const result = await generateSynthetic(SYNTHETIC_NAME);
      expect(result.entry.name).toBe(SYNTHETIC_NAME);
      const after = await sha256File(dumpAbs);
      const afterGt = await sha256File(groundTruthAbs);
      expect(after).toBe(before);
      expect(afterGt).toBe(beforeGt);
    }, 180_000);
  });

  describe('stats', () => {
    it('total_entities is exactly 1000', async () => {
      const entry = findEntry(loadManifest(), SYNTHETIC_NAME);
      expect(entry.stats.total_entities).toBe(1000);
    });

    it('total_facts is within ±2% of mean × count', () => {
      const entry = findEntry(loadManifest(), SYNTHETIC_NAME);
      const params = entry.generator_params!;
      const expected = params.facts_per_entity_mean * params.entity_count;
      const actual = entry.stats.total_facts as number;
      const drift = Math.abs(actual - expected) / expected;
      expect(drift).toBeLessThan(0.02);
    });

    it('bridge_pairs_count matches manifest generator_params', () => {
      const entry = findEntry(loadManifest(), SYNTHETIC_NAME);
      expect(entry.stats.bridge_pairs_count).toBe(entry.generator_params!.bridge_pairs);
    });
  });

  describe('bridge-pair labelling', () => {
    let groundTruth: GroundTruth;

    beforeAll(async () => {
      // Bridge-pair invariants are checked against a freshly-loaded DB so we
      // can query entities, facts, memory_entities, and same_as_links.
      await loadSnapshot(SYNTHETIC_NAME);
      groundTruth = readGroundTruth();
    }, 180_000);

    it('exactly bridge_pairs entries appear in ground_truth.json', () => {
      const entry = findEntry(loadManifest(), SYNTHETIC_NAME);
      expect(groundTruth.bridge_pairs.length).toBe(entry.generator_params!.bridge_pairs);
    });

    it('every bridge entity exists in entities table', async () => {
      const sql = postgres('postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test');
      try {
        for (const pair of groundTruth.bridge_pairs) {
          const rows = await sql<{ id: string }[]>`
            SELECT id FROM public.entities WHERE id IN (${pair.a}::uuid, ${pair.b}::uuid)
          `;
          expect(rows.length).toBe(2);
        }
      } finally {
        await sql.end();
      }
    });

    it('bridge entities share no memories', async () => {
      const sql = postgres('postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test');
      try {
        for (const pair of groundTruth.bridge_pairs) {
          const sharedRows = await sql<{ memory_id: string }[]>`
            SELECT memory_id FROM public.memory_entities WHERE entity_id = ${pair.a}::uuid
            INTERSECT
            SELECT memory_id FROM public.memory_entities WHERE entity_id = ${pair.b}::uuid
          `;
          expect(sharedRows.length).toBe(0);
        }
      } finally {
        await sql.end();
      }
    });

    it('bridge entities share no facts', async () => {
      const sql = postgres('postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test');
      try {
        for (const pair of groundTruth.bridge_pairs) {
          const sharedRows = await sql<{ predicate: string }[]>`
            SELECT predicate, object_entity_id FROM public.facts WHERE subject_entity_id = ${pair.a}::uuid
            INTERSECT
            SELECT predicate, object_entity_id FROM public.facts WHERE subject_entity_id = ${pair.b}::uuid
          `;
          expect(sharedRows.length).toBe(0);
        }
      } finally {
        await sql.end();
      }
    });

    it('bridge entities are NOT linked by same_as_links', async () => {
      const sql = postgres('postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test');
      try {
        for (const pair of groundTruth.bridge_pairs) {
          const [low, high] = pair.a < pair.b ? [pair.a, pair.b] : [pair.b, pair.a];
          const links = await sql<{ id: string }[]>`
            SELECT id FROM public.same_as_links
            WHERE entity_a_id = ${low}::uuid AND entity_b_id = ${high}::uuid
          `;
          expect(links.length).toBe(0);
        }
      } finally {
        await sql.end();
      }
    });

    it('bridge entities have centroids in different cluster modes', async () => {
      const sql = postgres('postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test');
      try {
        for (const pair of groundTruth.bridge_pairs) {
          const rows = await sql<{ id: string; cluster: number }[]>`
            SELECT id, (properties->>'cluster')::int AS cluster
            FROM public.entities WHERE id IN (${pair.a}::uuid, ${pair.b}::uuid)
          `;
          expect(rows.length).toBe(2);
          expect(rows[0]!.cluster).not.toBe(rows[1]!.cluster);
        }
      } finally {
        await sql.end();
      }
    });
  });

  describe('ground truth invisible to algorithms', () => {
    it('no production-readable table contains bridge_pair labels', async () => {
      const groundTruth = readGroundTruth();
      const sql = postgres('postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test');
      try {
        // The label format the generator uses inside ground_truth.json:
        // bridge_pair_<index>. Verify no production table holds that string.
        for (const pair of groundTruth.bridge_pairs) {
          const reason = pair.reason;
          // entities.merged_from is a UUID array — check via name/description/properties text
          const entityHits = await sql<{ c: string }[]>`
            SELECT COUNT(*)::text AS c FROM public.entities
            WHERE canonical_name LIKE ${'%' + reason + '%'}
               OR description LIKE ${'%' + reason + '%'}
               OR properties::text LIKE ${'%' + reason + '%'}
          `;
          expect(parseInt(entityHits[0]!.c, 10)).toBe(0);

          const aliasHits = await sql<{ c: string }[]>`
            SELECT COUNT(*)::text AS c FROM public.entity_aliases
            WHERE alias LIKE ${'%' + reason + '%'}
          `;
          expect(parseInt(aliasHits[0]!.c, 10)).toBe(0);

          const sameAsHits = await sql<{ c: string }[]>`
            SELECT COUNT(*)::text AS c FROM public.same_as_links
            WHERE reasoning LIKE ${'%' + reason + '%'}
          `;
          expect(parseInt(sameAsHits[0]!.c, 10)).toBe(0);

          const factHits = await sql<{ c: string }[]>`
            SELECT COUNT(*)::text AS c FROM public.facts
            WHERE source_text LIKE ${'%' + reason + '%'}
          `;
          expect(parseInt(factHits[0]!.c, 10)).toBe(0);
        }
      } finally {
        await sql.end();
      }
    });
  });

  describe('restoration roundtrip', () => {
    it('generate → drop → load returns matching row counts', async () => {
      const entry = findEntry(loadManifest(), SYNTHETIC_NAME);
      const result = await loadSnapshot(SYNTHETIC_NAME);
      expect(result.rowCounts.total_entities).toBe(entry.stats.total_entities);
      // Facts can have ON CONFLICT DO NOTHING dedupe, so we use the manifest
      // recorded value (truth-of-record from generation) directly.
      expect(result.rowCounts.total_facts).toBe(entry.stats.total_facts);
    }, 180_000);
  });

  describe('verify after ensure', () => {
    it('verify reports OK', async () => {
      const { ok, results } = await verifyAll(SYNTHETIC_NAME);
      const failures = results.filter((r) => r.status !== 'ok' && r.status !== 'no-hash');
      expect(failures).toEqual([]);
      expect(ok).toBe(true);
    });
  });
});

// Suppress unused-import lint for existsSync — kept available for future cases.
void existsSync;
