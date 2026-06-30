/**
 * Durable ledger for resumable batch ingest (scripts/ingest-resumable.ts).
 *
 * A long corpus is split into fixed-size SUB-BATCHES; each sub-batch is one
 * `/ingest/batch/<mode>` call (for the epoch arm, one epoch — store → propose →
 * promote, atomic at promote). The ledger records which sub-batches have
 * PROMOTED to canonical so an interrupted run resumes from the next unfinished
 * one instead of starting over on a clean DB.
 *
 * Two tables:
 *   public.ingest_jobs        — one row per (named) corpus run.
 *   public.ingest_sub_batches — one row per sub-batch, the checkpoint unit.
 *
 * The tables are SELF-ENSURED (CREATE TABLE IF NOT EXISTS) rather than shipped
 * as a graph migration: this is operational job-tracking state, not graph data,
 * and the live cognitive DB does not run migrations on boot (it can lag the
 * migration set — see CLAUDE.md "Migrate drift"). Self-ensuring keeps the
 * resumable-ingest tool self-contained and immune to that drift.
 *
 * Every object is `public.`-qualified: the session search_path puts ag_catalog
 * first (CLAUDE.md "AGE / search_path Gotchas"), so an unqualified CREATE would
 * land the table in ag_catalog and the FK would fail cross-schema.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { planSubBatches, corpusHash } from './ingest-plan.js';

// Re-export the pure planning helpers so callers can pull everything from the
// ledger module; their implementations live in ingest-plan.ts (DB-free, so they
// unit-test without infra).
export { planSubBatches, corpusHash, type PlannedSubBatch } from './ingest-plan.js';

export type JobStatus = 'running' | 'paused' | 'completed' | 'failed';
export type SubBatchStatus = 'pending' | 'running' | 'done' | 'failed';

export interface IngestJob {
  id: string;
  name: string;
  corpusHash: string;
  mode: string;
  subBatchSize: number;
  totalSubBatches: number;
  status: JobStatus;
}

export interface SubBatch {
  seq: number;
  chunkStart: number;
  chunkEnd: number;
  status: SubBatchStatus;
  attempts: number;
  /**
   * Stable per-sub-batch source id, minted once at job creation. The driver
   * passes it on EVERY attempt so store() derives deterministic memory ids
   * (windowPointId) — a retried sub-batch then upserts the same Qdrant points
   * instead of leaking duplicates.
   */
  sourceId: string;
}

function rows(result: unknown): Array<Record<string, unknown>> {
  return result as unknown as Array<Record<string, unknown>>;
}

async function relExists(qualifiedName: string): Promise<boolean> {
  const r = rows(await db.execute(sql`SELECT to_regclass(${qualifiedName}) AS oid`));
  return r[0]?.oid != null;
}

/**
 * Idempotently create the ledger tables. Safe to call on every run. Guards each
 * CREATE with a to_regclass existence check rather than CREATE TABLE IF NOT
 * EXISTS so a resume run does not spam a "relation already exists" NOTICE
 * (postgres-js forwards NOTICEs to the console).
 */
export async function ensureLedger(): Promise<void> {
  if (!(await relExists('public.ingest_jobs'))) {
    await db.execute(sql`
      CREATE TABLE public.ingest_jobs (
        id                UUID PRIMARY KEY,
        name              TEXT NOT NULL,
        corpus_hash       TEXT NOT NULL,
        mode              TEXT NOT NULL,
        sub_batch_size    INTEGER NOT NULL,
        total_sub_batches INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'running',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (name)
      )
    `);
  }
  if (!(await relExists('public.ingest_sub_batches'))) {
    await db.execute(sql`
      CREATE TABLE public.ingest_sub_batches (
        id           UUID PRIMARY KEY,
        job_id       UUID NOT NULL REFERENCES public.ingest_jobs(id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        chunk_start  INTEGER NOT NULL,
        chunk_end    INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        source_id    UUID,
        attempts     INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT,
        started_at   TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        UNIQUE (job_id, seq)
      )
    `);
  }
}

function toJob(r: Record<string, unknown>): IngestJob {
  return {
    id: r.id as string,
    name: r.name as string,
    corpusHash: r.corpus_hash as string,
    mode: r.mode as string,
    subBatchSize: Number(r.sub_batch_size),
    totalSubBatches: Number(r.total_sub_batches),
    status: r.status as JobStatus,
  };
}

/**
 * Find the job named `name`, or create it (plus its full sub-batch plan) if it
 * does not exist. Re-running with an existing name RESUMES that job — but only
 * if the corpus + mode + sub-batch size still match; a mismatch throws rather
 * than silently resuming against different inputs.
 */
export async function createOrLoadJob(opts: {
  name: string;
  chunks: string[];
  mode: string;
  subBatchSize: number;
}): Promise<{ job: IngestJob; created: boolean }> {
  const hash = corpusHash(opts.chunks);
  const plan = planSubBatches(opts.chunks.length, opts.subBatchSize);

  const existing = rows(
    await db.execute(sql`
      SELECT id, name, corpus_hash, mode, sub_batch_size, total_sub_batches, status
      FROM public.ingest_jobs WHERE name = ${opts.name}
    `),
  );
  if (existing.length > 0) {
    const job = toJob(existing[0]!);
    if (job.corpusHash !== hash) {
      throw new Error(
        `job "${opts.name}" already exists with a DIFFERENT corpus (hash mismatch). ` +
          `Use a new --job name, or delete the old job, to avoid resuming against the wrong corpus.`,
      );
    }
    if (job.mode !== opts.mode) {
      throw new Error(`job "${opts.name}" exists with mode=${job.mode}, not ${opts.mode}.`);
    }
    if (job.subBatchSize !== opts.subBatchSize) {
      throw new Error(
        `job "${opts.name}" exists with sub-batch size ${job.subBatchSize}, not ${opts.subBatchSize}. ` +
          `Sub-batch boundaries are fixed once a job is created.`,
      );
    }
    return { job, created: false };
  }

  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO public.ingest_jobs (id, name, corpus_hash, mode, sub_batch_size, total_sub_batches, status)
    VALUES (${id}, ${opts.name}, ${hash}, ${opts.mode}, ${opts.subBatchSize}, ${plan.length}, 'running')
  `);
  for (const p of plan) {
    // source_id is minted ONCE here and reused on every attempt of this
    // sub-batch (see SubBatch.sourceId) — it is the stable key behind
    // deterministic, idempotent re-store.
    await db.execute(sql`
      INSERT INTO public.ingest_sub_batches (id, job_id, seq, chunk_start, chunk_end, source_id)
      VALUES (${randomUUID()}, ${id}, ${p.seq}, ${p.chunkStart}, ${p.chunkEnd}, ${randomUUID()})
    `);
  }
  return {
    job: {
      id,
      name: opts.name,
      corpusHash: hash,
      mode: opts.mode,
      subBatchSize: opts.subBatchSize,
      totalSubBatches: plan.length,
      status: 'running',
    },
    created: true,
  };
}

/**
 * The lowest-seq sub-batch not yet `done`, or null when the job is complete.
 * Sub-batches MUST run in seq order (cross-sub-batch entity identity resolves
 * against already-promoted canonical), so a not-done earlier seq always comes
 * first — including a previously `failed` one, which a resume re-attempts.
 */
export async function nextPendingSubBatch(jobId: string): Promise<SubBatch | null> {
  const r = rows(
    await db.execute(sql`
      SELECT seq, chunk_start, chunk_end, status, attempts, source_id
      FROM public.ingest_sub_batches
      WHERE job_id = ${jobId} AND status <> 'done'
      ORDER BY seq ASC LIMIT 1
    `),
  );
  if (r.length === 0) return null;
  const row = r[0]!;
  return {
    seq: Number(row.seq),
    chunkStart: Number(row.chunk_start),
    chunkEnd: Number(row.chunk_end),
    status: row.status as SubBatchStatus,
    attempts: Number(row.attempts),
    sourceId: row.source_id as string,
  };
}

export async function markSubBatchStarted(jobId: string, seq: number): Promise<void> {
  await db.execute(sql`
    UPDATE public.ingest_sub_batches
    SET status = 'running', started_at = now()
    WHERE job_id = ${jobId} AND seq = ${seq}
  `);
}

export async function markSubBatchDone(jobId: string, seq: number): Promise<void> {
  // source_id is set at creation and never changed (it is the stable re-store
  // key), so completion only flips status + stamps the time.
  await db.execute(sql`
    UPDATE public.ingest_sub_batches
    SET status = 'done', completed_at = now(), last_error = NULL
    WHERE job_id = ${jobId} AND seq = ${seq}
  `);
}

/**
 * Return a sub-batch to `pending` after an attempt did not complete (a session
 * limit, or a retryable transient failure). `bumpAttempt` distinguishes a real
 * failed attempt (counts toward the genuine-failure budget) from a
 * session-limit pause (does not — waiting out a limit is not a failed attempt).
 */
export async function markSubBatchPending(
  jobId: string,
  seq: number,
  lastError: string,
  bumpAttempt: boolean,
): Promise<void> {
  if (bumpAttempt) {
    await db.execute(sql`
      UPDATE public.ingest_sub_batches
      SET status = 'pending', attempts = attempts + 1, last_error = ${lastError}
      WHERE job_id = ${jobId} AND seq = ${seq}
    `);
  } else {
    await db.execute(sql`
      UPDATE public.ingest_sub_batches
      SET status = 'pending', last_error = ${lastError}
      WHERE job_id = ${jobId} AND seq = ${seq}
    `);
  }
}

export async function markSubBatchFailed(jobId: string, seq: number, lastError: string): Promise<void> {
  await db.execute(sql`
    UPDATE public.ingest_sub_batches
    SET status = 'failed', attempts = attempts + 1, last_error = ${lastError}
    WHERE job_id = ${jobId} AND seq = ${seq}
  `);
}

export async function setJobStatus(jobId: string, status: JobStatus): Promise<void> {
  await db.execute(sql`
    UPDATE public.ingest_jobs SET status = ${status}, updated_at = now() WHERE id = ${jobId}
  `);
}

export interface JobProgress {
  done: number;
  total: number;
  failed: number;
}

export async function jobProgress(jobId: string): Promise<JobProgress> {
  const r = rows(
    await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'done')   AS done,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*)                                   AS total
      FROM public.ingest_sub_batches WHERE job_id = ${jobId}
    `),
  );
  const row = r[0] ?? {};
  return {
    done: Number(row.done ?? 0),
    failed: Number(row.failed ?? 0),
    total: Number(row.total ?? 0),
  };
}
