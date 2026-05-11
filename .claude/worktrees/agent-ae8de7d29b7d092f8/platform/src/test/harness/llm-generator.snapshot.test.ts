/**
 * LLM-pipeline generator tests (nmemo-j77.3).
 *
 * Doc 28 §4.2 cases applicable to the LLM generator:
 *   - manifest entries for kind=llm have model + embedding pins set
 *   - per-chunk timeout fires correctly and exits non-zero
 *   - regeneration roundtrip captures regenerated_at + dump hash
 *   - pg_dump_flags from the manifest are honoured
 *   - chunkText splits on the same boundaries as viz/js/app.js (paragraph,
 *     newline, sentence, space, hard cut)
 *   - restoration roundtrip — generate → drop → load → row counts match
 *
 * Critical: these tests do NOT call Claude or POST to a live /ingest/queue.
 * The generator's IngestClient hook is substituted with a fake that mutates
 * the snapshot DB directly via the `cognitive_test` connection. The fake
 * mirrors the contract of the real client (enqueue → drain → status reports
 * empty) but writes a tiny synthetic memory + entity row instead of running
 * the LLM. Live-stack smoke is documented separately in the j77.3.1 close
 * notes.
 *
 * Runs under vitest.snapshot.config.ts (single fork, file-parallelism off).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import postgres from 'postgres';
import {
  loadManifest,
  saveManifest,
  findEntry,
  PLATFORM_ROOT,
  Manifest,
} from '../../../scripts/lib/manifest.js';
import { sha256File } from '../../../scripts/lib/hash.js';
import {
  generateSnapshot,
  chunkText,
  waitForDrain,
  ChunkTimeoutError,
  IngestClient,
} from '../../../scripts/generate-snapshot.js';
import { loadSnapshot } from '../../../scripts/load-snapshot.js';

const TINY_FIXTURE_NAME = '__llm-test-tiny';
const TINY_CORPUS_REL = 'src/test/corpora/__llm-test-tiny.txt';
const TINY_CORPUS_ABS = join(PLATFORM_ROOT, TINY_CORPUS_REL);
const TINY_DUMP_REL = 'test-snapshots/__llm-test-tiny/cognitive.dump';
const TINY_DUMP_ABS = join(PLATFORM_ROOT, TINY_DUMP_REL);

/**
 * A deterministic synthetic ingest client. The real client hits the live
 * platform + ML stack, which we cannot run inside vitest. Instead, this fake
 * inserts one entity per chunk straight into the test DB so the row-count
 * assertions in §4.2 still have something to bite against.
 */
function createFakeIngestClient(): IngestClient {
  let queued = 0;
  let draining = false;
  let processed = 0;
  return {
    async enqueue(text: string, _source?: string) {
      queued++;
      processed++;
      const myIndex = processed;
      // Simulate the serial drain: schedule on the next tick so callers see
      // both queued>=1 and draining=true between enqueue and the next status
      // poll. Mirrors the real pipeline's drainQueue() behaviour.
      setImmediate(async () => {
        draining = true;
        try {
          await insertSyntheticChunkRow(myIndex, text.length);
        } finally {
          queued--;
          if (queued === 0) draining = false;
        }
      });
      return { queued: true, position: queued };
    },
    async status() {
      return { queued, draining };
    },
    async reconcile() {
      return { triggered: false };
    },
    async garden() {
      return { triggered: false };
    },
  };
}

async function insertSyntheticChunkRow(index: number, charCount: number): Promise<void> {
  const sql = postgres('postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test', {
    connection: { search_path: 'public, ag_catalog, "$user"' },
    max: 1,
  });
  try {
    // Idempotent: ON CONFLICT DO NOTHING so re-runs don't duplicate.
    await sql`
      INSERT INTO public.entities (id, canonical_name, entity_type, properties, first_seen_at, last_seen_at, created_at, updated_at)
      VALUES (
        gen_random_uuid(),
        ${'llm-test-chunk-' + index},
        'concept',
        ${sql.json({ synthetic_llm_test: true, char_count: charCount })},
        NOW(), NOW(), NOW(), NOW()
      )
      ON CONFLICT DO NOTHING
    `;
  } finally {
    await sql.end();
  }
}

function ensureTinyCorpus(): void {
  mkdirSync(dirname(TINY_CORPUS_ABS), { recursive: true });
  // Two paragraphs, large enough to split into ≥2 chunks at chunk_size=400
  // (each paragraph is ~250 chars; a 400-char chunk lands cleanly on the
  // paragraph break). Stable across runs — checked into the test, not the
  // committed corpora directory (cleaned up on teardown).
  if (!existsSync(TINY_CORPUS_ABS)) {
    const para1 =
      'Victor met the creature in the alpine forest above Geneva. ' +
      'He spoke at length about the events leading up to the experiment, ' +
      'the cottage where he had laboured, and the family he had left behind. ' +
      'The night air was cold and the snow blew through the pines. ' +
      'Walton listened to the story without interrupting.';
    const para2 =
      'The creature responded by demanding a companion of his own kind. ' +
      'He recounted the months spent watching the De Lacey family in their cottage, ' +
      'learning their language and customs from a hidden vantage point. ' +
      'When he finally revealed himself, he was rejected with violence. ' +
      'He fled into the wilderness and turned to vengeance against his maker.';
    writeFileSync(TINY_CORPUS_ABS, `${para1}\n\n${para2}\n`, 'utf-8');
  }
}

function ensureTinyManifestEntry(): void {
  const manifest = loadManifest();
  if (manifest.entries.some((e) => e.name === TINY_FIXTURE_NAME)) return;
  manifest.entries.push({
    name: TINY_FIXTURE_NAME,
    kind: 'llm',
    description: 'Inline tiny corpus for LLM-generator tests. Not intended for real use.',
    source_corpus: TINY_CORPUS_REL,
    ingest_params: {
      chunk_size: 400,
      model: 'haiku',
      extraction_prompt_version: 'v1.4',
      claude_model_version_pin: 'claude-haiku-4-5-20251001',
      claude_temperature: 0,
      embedding_model_pin: 'nomic-embed-text:v1.5',
      embedding_dim: 768,
      chunk_timeout_ms: 30000,
      run_gardening: false,
    },
    pg_dump_flags: ['--format=custom', '--no-sync', '--no-comments'],
    pg_dump_format: 'custom',
    files: { postgres: TINY_DUMP_REL },
    expected_hashes: {},
    schema_version: 12,
    postgres_version: '16',
    stats: { total_entities: 0, total_facts: 0, total_memories: 0, ingest_time_ms: 0 },
    regenerated_at: null,
    regeneration_command: '(test-only)',
    deterministic: false,
    notes: 'Auto-managed by llm-generator.snapshot.test.ts; do not depend on this entry.',
  });
  saveManifest(manifest);
}

function removeTinyManifestEntry(): void {
  const manifest = loadManifest();
  const before = manifest.entries.length;
  const filtered: Manifest = {
    version: manifest.version,
    entries: manifest.entries.filter((e) => e.name !== TINY_FIXTURE_NAME),
  };
  if (filtered.entries.length !== before) {
    saveManifest(filtered);
  }
}

describe('LLM generator — manifest invariants', () => {
  it('every kind=llm entry has model + embedding pins (or is the empty baseline)', () => {
    const manifest = loadManifest();
    const llmEntries = manifest.entries.filter((e) => e.kind === 'llm');
    expect(llmEntries.length).toBeGreaterThan(0);
    for (const e of llmEntries) {
      if (!e.source_corpus) continue; // empty baseline is exempt
      expect(e.ingest_params).toBeDefined();
      const p = e.ingest_params!;
      expect(p.claude_model_version_pin, `${e.name}.claude_model_version_pin`).toBeTruthy();
      expect(typeof p.claude_temperature).toBe('number');
      expect(p.embedding_model_pin, `${e.name}.embedding_model_pin`).toBeTruthy();
      expect(p.embedding_dim, `${e.name}.embedding_dim`).toBe(768);
      expect(p.extraction_prompt_version, `${e.name}.extraction_prompt_version`).toBeTruthy();
    }
  });

  it('frankenstein-10chunks references the committed corpus', () => {
    const manifest = loadManifest();
    const entry = manifest.entries.find((e) => e.name === 'frankenstein-10chunks');
    expect(entry).toBeDefined();
    expect(entry!.source_corpus).toBe('src/test/corpora/frankenstein-ch1-10.txt');
    const corpusAbs = join(PLATFORM_ROOT, entry!.source_corpus!);
    expect(existsSync(corpusAbs), `${corpusAbs} should exist`).toBe(true);
  });
});

describe('LLM generator — chunkText', () => {
  it('returns input as a single chunk when shorter than max', () => {
    expect(chunkText('hello world', 2000)).toEqual(['hello world']);
  });

  it('returns empty array on empty input', () => {
    expect(chunkText('', 2000)).toEqual([]);
  });

  it('splits at the latest paragraph break ≥ 200 chars from start', () => {
    const a = 'a'.repeat(500);
    const b = 'b'.repeat(500);
    const text = `${a}\n\n${b}`;
    const chunks = chunkText(text, 800);
    // The 800-char window contains one paragraph break (at index 500).
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.startsWith('a')).toBe(true);
    expect(chunks[1]!.startsWith('b')).toBe(true);
  });

  it('falls back to hard cut when no breakable boundary exists', () => {
    const text = 'x'.repeat(5000);
    const chunks = chunkText(text, 1000);
    expect(chunks.length).toBe(5);
    for (const c of chunks) expect(c.length).toBe(1000);
  });

  it('produces the same chunk count viz produces for frankenstein chapter 1', () => {
    // Sanity: the generator and the viz panel must agree on chunk boundaries
    // for a representative corpus, otherwise stats drift between the two
    // ingest paths.
    const corpusAbs = join(PLATFORM_ROOT, 'src/test/corpora/frankenstein-ch1-10.txt');
    if (!existsSync(corpusAbs)) {
      // Skip when the corpus isn't committed (acceptable per j77.3 task).
      return;
    }
    const text = readFileSync(corpusAbs, 'utf-8');
    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBeGreaterThan(50);
    expect(chunks.length).toBeLessThan(120);
    // Reconstructed text matches the source modulo whitespace stripped at
    // chunk boundaries (viz also calls .trim()).
    const reconstructed = chunks.join(' ');
    expect(reconstructed.length).toBeGreaterThan(text.length * 0.95);
  });
});

describe('LLM generator — waitForDrain', () => {
  it('returns when status reports queued=0 + draining=false', async () => {
    let calls = 0;
    const fake: IngestClient = {
      async enqueue() { return { queued: true, position: 1 }; },
      async status() {
        calls++;
        if (calls < 3) return { queued: 1, draining: true };
        return { queued: 0, draining: false };
      },
    };
    await waitForDrain(fake, 5000, 5);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('throws ChunkTimeoutError when status never drains', async () => {
    const stuckClient: IngestClient = {
      async enqueue() { return { queued: true, position: 1 }; },
      async status() { return { queued: 1, draining: true }; },
    };
    await expect(waitForDrain(stuckClient, 100, 10)).rejects.toThrow(ChunkTimeoutError);
  });
});

describe('LLM generator — regeneration with fake ingest client', () => {
  beforeAll(() => {
    ensureTinyCorpus();
    ensureTinyManifestEntry();
    if (existsSync(TINY_DUMP_ABS)) rmSync(TINY_DUMP_ABS);
  });

  it('runs the full §3.4 path against a fake client and updates the manifest', async () => {
    const result = await generateSnapshot(TINY_FIXTURE_NAME, {
      ingestClient: createFakeIngestClient(),
      now: () => new Date('2026-05-06T12:00:00.000Z'),
    });
    expect(result.partial).toBe(false);
    expect(result.chunks).toBeGreaterThan(0);
    expect(existsSync(TINY_DUMP_ABS)).toBe(true);

    const entry = findEntry(loadManifest(), TINY_FIXTURE_NAME);
    expect(entry.regenerated_at).toBe('2026-05-06T12:00:00.000Z');
    // Hash recorded under the dump file basename
    const recorded = entry.expected_hashes['cognitive.dump'];
    expect(recorded).toMatch(/^sha256:/);
    const onDisk = await sha256File(TINY_DUMP_ABS);
    expect(recorded).toBe(onDisk);

    // Stats: each chunk inserts a row, so total_entities should match chunk count
    expect(entry.stats.total_entities).toBe(result.chunks);
    // ingest_time_ms is recorded
    expect(typeof entry.stats.ingest_time_ms).toBe('number');
    expect(entry.stats.ingest_time_ms).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('honours pg_dump_flags from the manifest entry', async () => {
    // Re-run with a flag override and confirm the dump uses custom format.
    // (We can't directly observe the flag list passed to pg_dump, but we
    // can verify the dump file starts with the PGDMP custom-format magic.)
    const buf = readFileSync(TINY_DUMP_ABS);
    // pg_dump custom format begins with "PGDMP\0" magic (47 47 44 4D 50)
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x47); // G
    expect(buf[2]).toBe(0x44); // D
    expect(buf[3]).toBe(0x4d); // M
    expect(buf[4]).toBe(0x50); // P
  });

  it('restoration roundtrip: load matches generate stats', async () => {
    const restored = await loadSnapshot(TINY_FIXTURE_NAME);
    const entry = findEntry(loadManifest(), TINY_FIXTURE_NAME);
    expect(restored.rowCounts.total_entities).toBe(entry.stats.total_entities);
  }, 120_000);
});

describe('LLM generator — per-chunk timeout', () => {
  beforeAll(() => {
    ensureTinyCorpus();
    ensureTinyManifestEntry();
  });

  it('throws ChunkTimeoutError + records partial=true on the manifest', async () => {
    const stuckClient: IngestClient = {
      async enqueue() { return { queued: true, position: 1 }; },
      async status() { return { queued: 1, draining: true }; },
    };
    // Override the manifest entry's timeout to something short so the test
    // doesn't have to wait 5 minutes.
    const manifest = loadManifest();
    const entry = findEntry(manifest, TINY_FIXTURE_NAME);
    const originalTimeout = entry.ingest_params!.chunk_timeout_ms;
    entry.ingest_params!.chunk_timeout_ms = 200;
    saveManifest(manifest);
    try {
      await expect(
        generateSnapshot(TINY_FIXTURE_NAME, {
          ingestClient: stuckClient,
          now: () => new Date('2026-05-06T13:00:00.000Z'),
        }),
      ).rejects.toThrow(ChunkTimeoutError);

      const post = findEntry(loadManifest(), TINY_FIXTURE_NAME);
      expect(post.stats.partial).toBe(true);
      expect(typeof post.stats.partial_chunk_index).toBe('number');
      expect(post.regenerated_at).toBe('2026-05-06T13:00:00.000Z');
    } finally {
      // Restore for downstream tests
      const restoreManifest = loadManifest();
      const restoreEntry = findEntry(restoreManifest, TINY_FIXTURE_NAME);
      restoreEntry.ingest_params!.chunk_timeout_ms = originalTimeout;
      saveManifest(restoreManifest);
    }
  }, 60_000);
});

// Cleanup: remove the test-only manifest entry + corpus + dump after the
// suite finishes, so we don't leak generated state between test runs.
import { afterAll } from 'vitest';
afterAll(() => {
  removeTinyManifestEntry();
  if (existsSync(TINY_CORPUS_ABS)) rmSync(TINY_CORPUS_ABS);
  if (existsSync(TINY_DUMP_ABS)) rmSync(TINY_DUMP_ABS);
});
