#!/usr/bin/env tsx
/**
 * snapshot:generate <name> — LLM-pipeline (or empty) snapshot generator.
 *
 * Doc 28 §3.4. Drops + recreates the target DB, applies migrations, optionally
 * runs the LLM ingest pipeline against the manifest's source corpus, then
 * dumps Postgres. The full §3.4 9-step path:
 *
 *   1. Pre-flight DB guard (cognitive_test or cognitive_snapshot_*)
 *   2. Drop + recreate target DB
 *   3. Apply migrations
 *   4. Read source corpus from manifest.source_corpus (relative to PLATFORM_ROOT)
 *   5. Chunk per ingest_params.chunk_size (paragraph → newline → sentence
 *      → space → hard cut, mirrors viz/js/app.js chunkText)
 *   6. For each chunk: POST /ingest/queue, poll /ingest/queue/status until
 *      drained — per-chunk timeout (default 5 min, override via
 *      ingest_params.chunk_timeout_ms). On timeout: emit "regeneration partial"
 *      warning + non-zero exit
 *   7. Optionally invoke /api/reconcile and /api/garden if
 *      ingest_params.run_gardening: true
 *   8. Compute graph_stats stub (entity + fact counts; phase-1 graph_stats
 *      table not yet present, recorded in manifest stats only)
 *   9. pg_dump using entry.pg_dump_flags (default custom format for LLM —
 *      LLM dumps already aren't deterministic, so the custom-format header
 *      timestamp is irrelevant). Update expected_hashes + regenerated_at.
 *
 * The "empty" entry (no source_corpus) skips steps 4-7 and captures the
 * post-migration schema-only state. That path was the j77.1 baseline and
 * remains the gating fixture for the snapshot infrastructure on a fresh
 * clone.
 */

import { mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join, isAbsolute } from 'path';
import {
  loadManifest,
  saveManifest,
  findEntry,
  entryFileAbsPath,
  PLATFORM_ROOT,
  SnapshotEntry,
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
const DEFAULT_CHUNK_SIZE = 2000;
const DEFAULT_CHUNK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min, doc 28 §3.4 step 6
const DEFAULT_PLATFORM_URL = process.env.PLATFORM_URL || 'http://127.0.0.1:3000';
const QUEUE_POLL_INTERVAL_MS = 250;

/** Hook surface for tests to substitute the HTTP layer. */
export interface IngestClient {
  enqueue(text: string, source?: string): Promise<{ queued: true; position: number }>;
  status(): Promise<{ queued: number; draining: boolean }>;
  reconcile?(): Promise<unknown>;
  garden?(): Promise<unknown>;
}

export interface GenerateSnapshotOptions {
  /** Override the platform HTTP base URL (default http://127.0.0.1:3000). */
  platformUrl?: string;
  /** Test seam: substitute a fake ingest client. Defaults to the HTTP client. */
  ingestClient?: IngestClient;
  /** Force a value of `now` for `regenerated_at`. Tests use this for stability. */
  now?: () => Date;
}

export class ChunkTimeoutError extends Error {
  constructor(
    public readonly chunkIndex: number,
    public readonly chunkCount: number,
    public readonly timeoutMs: number,
  ) {
    super(
      `chunk ${chunkIndex + 1}/${chunkCount} did not drain within ${timeoutMs}ms — ` +
      `regeneration partial`,
    );
    this.name = 'ChunkTimeoutError';
  }
}

export async function generateSnapshot(
  name: string,
  options: GenerateSnapshotOptions = {},
): Promise<{
  entry: SnapshotEntry;
  durationMs: number;
  chunks: number;
  partial: boolean;
}> {
  const start = Date.now();
  const manifest = loadManifest();
  const entry = findEntry(manifest, name);
  if (entry.kind !== 'llm') {
    throw new Error(
      `generate-snapshot only handles kind="llm" entries; "${name}" is "${entry.kind}". ` +
      `Use generate-synthetic for synthetic entries.`,
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

  // Steps 4-7: LLM ingest path. Skipped for the `empty` entry (source_corpus null).
  let chunks = 0;
  let ingestStartMs = 0;
  let ingestEndMs = 0;
  if (entry.source_corpus) {
    const corpusAbs = resolveCorpusPath(entry.source_corpus);
    if (!existsSync(corpusAbs)) {
      throw new Error(
        `manifest entry "${name}" references missing source corpus: ${corpusAbs}. ` +
        `Add it under platform/src/test/corpora/ or update the manifest.`,
      );
    }
    const corpusText = readFileSync(corpusAbs, 'utf-8');
    const chunkSize = entry.ingest_params?.chunk_size ?? DEFAULT_CHUNK_SIZE;
    const chunkList = chunkText(corpusText, chunkSize);
    chunks = chunkList.length;
    console.log(`  → corpus: ${corpusAbs} (${corpusText.length} chars, ${chunks} chunks @ ${chunkSize})`);

    const client = options.ingestClient ?? createHttpIngestClient(options.platformUrl ?? DEFAULT_PLATFORM_URL);
    const timeoutMs = entry.ingest_params?.chunk_timeout_ms ?? DEFAULT_CHUNK_TIMEOUT_MS;
    const corpusSource = entry.source_corpus.replace(/\\/g, '/');

    ingestStartMs = Date.now();
    for (let i = 0; i < chunkList.length; i++) {
      const chunk = chunkList[i]!;
      console.log(`  → chunk ${i + 1}/${chunkList.length}: enqueue (${chunk.length} chars)`);
      await client.enqueue(chunk, corpusSource);
      try {
        await waitForDrain(client, timeoutMs);
      } catch (err) {
        if (err instanceof ChunkTimeoutError) {
          console.error(
            `  ✗ chunk ${i + 1}/${chunkList.length} timeout after ${timeoutMs}ms — ` +
            `regeneration partial`,
          );
          // Doc 28 §3.4 step 6: still record what we have, exit non-zero.
          await finalisePartial(entry, manifest, conn, pgTools, options, start, i);
          throw new ChunkTimeoutError(i, chunkList.length, timeoutMs);
        }
        throw err;
      }
    }
    ingestEndMs = Date.now();
    console.log(`  ✓ all ${chunkList.length} chunks drained in ${ingestEndMs - ingestStartMs}ms`);

    // Step 7: optional reconciliation + gardener
    if (entry.ingest_params?.run_gardening) {
      console.log(`  → run_gardening: true — invoking /api/reconcile + /api/garden`);
      if (client.reconcile) {
        try {
          await client.reconcile();
        } catch (err) {
          console.warn(`  ⚠ /api/reconcile failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (client.garden) {
        try {
          await client.garden();
        } catch (err) {
          console.warn(`  ⚠ /api/garden failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  // Steps 8-9: dump + manifest update
  const dumpAbs = entryFileAbsPath(entry, 'postgres');
  if (!dumpAbs) {
    throw new Error(`entry "${name}" has no files.postgres path`);
  }
  mkdirSync(dirname(dumpAbs), { recursive: true });

  const flags = entry.pg_dump_flags ?? DEFAULT_PG_DUMP_FLAGS;
  console.log(`  → pg_dump → ${dumpAbs} (flags: ${flags.join(' ')})`);
  await runPgDump(pgTools, conn as ConnInfo, flags, dumpAbs);

  const counts = await countEntitiesAndFacts(conn);
  const dumpHash = await sha256File(dumpAbs);
  const dumpBaseName = dumpAbs.split(/[\\/]/).pop()!;

  entry.expected_hashes = { ...entry.expected_hashes, [dumpBaseName]: dumpHash };
  const now = options.now ? options.now() : new Date();
  entry.regenerated_at = now.toISOString();
  entry.stats = {
    ...entry.stats,
    total_entities: counts.total_entities,
    total_facts: counts.total_facts,
    ingest_time_ms: ingestEndMs > 0 ? ingestEndMs - ingestStartMs : 0,
  };
  saveManifest(manifest);

  const durationMs = Date.now() - start;
  console.log(
    `  ✓ generated "${name}" in ${durationMs}ms ` +
    `(entities=${counts.total_entities}, facts=${counts.total_facts}, chunks=${chunks})`,
  );
  return { entry, durationMs, chunks, partial: false };
}

/**
 * Doc 28 §3.4 step 6: on per-chunk timeout we still emit a "regeneration
 * partial" snapshot — capture the partial DB state, update manifest hashes
 * + a `notes` flag, and re-throw so the caller exits non-zero.
 */
async function finalisePartial(
  entry: SnapshotEntry,
  manifest: ReturnType<typeof loadManifest>,
  conn: ReturnType<typeof loadAndAssertDatabaseUrl>,
  pgTools: ReturnType<typeof resolvePgTools>,
  options: GenerateSnapshotOptions,
  start: number,
  partialUntilChunk: number,
): Promise<void> {
  const dumpAbs = entryFileAbsPath(entry, 'postgres');
  if (!dumpAbs) return;
  mkdirSync(dirname(dumpAbs), { recursive: true });
  const flags = entry.pg_dump_flags ?? DEFAULT_PG_DUMP_FLAGS;
  try {
    await runPgDump(pgTools, conn as ConnInfo, flags, dumpAbs);
  } catch (err) {
    console.warn(`  ⚠ partial pg_dump failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const counts = await countEntitiesAndFacts(conn).catch(() => ({ total_entities: 0, total_facts: 0 }));
  const dumpHash = await sha256File(dumpAbs).catch(() => '');
  const dumpBaseName = dumpAbs.split(/[\\/]/).pop()!;
  if (dumpHash) entry.expected_hashes = { ...entry.expected_hashes, [dumpBaseName]: dumpHash };
  const now = options.now ? options.now() : new Date();
  entry.regenerated_at = now.toISOString();
  entry.stats = {
    ...entry.stats,
    total_entities: counts.total_entities,
    total_facts: counts.total_facts,
    ingest_time_ms: Date.now() - start,
    partial: true,
    partial_chunk_index: partialUntilChunk,
  };
  saveManifest(manifest);
}

/**
 * Resolve a manifest source_corpus path. Manifest paths are relative to
 * PLATFORM_ROOT per doc 28 §2.3; absolute paths are honoured for tests.
 */
function resolveCorpusPath(rel: string): string {
  if (isAbsolute(rel)) return rel;
  return join(PLATFORM_ROOT, rel);
}

/**
 * Mirrors `chunkText` in platform/viz/js/app.js (lines 1062-1081). Splits at
 * paragraph (\n\n) → newline → sentence (". ") → space → hard cut, in that
 * preference order, choosing the latest break ≥ 200 chars from the chunk
 * start so chunks don't collapse to single-character slices on edge cases.
 */
export function chunkText(text: string, maxChunk: number = DEFAULT_CHUNK_SIZE): string[] {
  if (text.length <= maxChunk) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChunk) {
    let cut = -1;
    const slice = remaining.slice(0, maxChunk);
    cut = slice.lastIndexOf('\n\n');
    if (cut < 200) cut = slice.lastIndexOf('\n');
    if (cut < 200) cut = slice.lastIndexOf('. ');
    if (cut < 200) cut = slice.lastIndexOf(' ');
    if (cut < 200) cut = maxChunk;
    else cut += 1; // include the break char
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Poll the queue status until it reports drained (queued=0 AND draining=false)
 * or the per-chunk timeout fires. Used between every enqueue.
 */
export async function waitForDrain(
  client: IngestClient,
  timeoutMs: number,
  pollIntervalMs: number = QUEUE_POLL_INTERVAL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Initial small delay so the server has a chance to start draining
  // (drainQueue is async; queueLength==0 immediately after enqueue would be
  // a false positive only if the queue was empty before enqueue, which we
  // can't observe from here — but draining=true catches that case).
  // The first iteration always observes a non-zero state if the enqueue
  // is still in flight.
  while (true) {
    const status = await client.status();
    if (status.queued === 0 && !status.draining) return;
    if (Date.now() >= deadline) {
      throw new ChunkTimeoutError(-1, -1, timeoutMs);
    }
    await sleep(pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Default HTTP-backed ingest client. Talks to the running platform server
 * (default http://127.0.0.1:3000). Tests substitute a fake via
 * GenerateSnapshotOptions.ingestClient.
 */
export function createHttpIngestClient(baseUrl: string): IngestClient {
  return {
    async enqueue(text, source) {
      const res = await fetch(`${baseUrl}/ingest/queue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, ...(source ? { source } : {}) }),
      });
      if (!res.ok) {
        throw new Error(`POST /ingest/queue failed: ${res.status} ${await res.text()}`);
      }
      return res.json() as Promise<{ queued: true; position: number }>;
    },
    async status() {
      const res = await fetch(`${baseUrl}/ingest/queue/status`);
      if (!res.ok) {
        throw new Error(`GET /ingest/queue/status failed: ${res.status}`);
      }
      return res.json() as Promise<{ queued: number; draining: boolean }>;
    },
    async reconcile() {
      const res = await fetch(`${baseUrl}/api/reconcile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        throw new Error(`POST /api/reconcile failed: ${res.status}`);
      }
      return res.json();
    },
    async garden() {
      const res = await fetch(`${baseUrl}/api/garden`, { method: 'POST' });
      if (!res.ok) {
        throw new Error(`POST /api/garden failed: ${res.status}`);
      }
      return res.json();
    },
  };
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
    process.exit(err instanceof ChunkTimeoutError ? 2 : 1);
  });
}
