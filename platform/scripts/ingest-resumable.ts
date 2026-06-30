#!/usr/bin/env tsx
/**
 * ingest-resumable.ts — durable, session-limit-aware batch ingest.
 *
 * Pushes a corpus (a JSON array of chunk strings) through the platform's
 * /ingest/batch/<mode> route in fixed-size SUB-BATCHES, checkpointing every
 * completion in a Postgres ledger (services/ingest-ledger.ts). An interrupted
 * run RESUMES from the next unfinished sub-batch instead of starting over.
 *
 * Motivating failure: a Claude session/usage limit mid-run. When a sub-batch
 * comes back as a limit hit, the driver does NOT retry in a tight loop (the
 * limit resets HOURS away) — it parses the reset time from the error, sleeps
 * until then (+ buffer), and re-runs the SAME sub-batch. A kill or reboot during
 * the wait loses nothing: re-running this command resumes from the ledger.
 *
 * Unlike compare-ingestion.ts this NEVER calls /api/reset — it appends to the
 * live graph and is meant to run one large corpus to completion (e.g. a full
 * LOTR stress test of the epoch arm).
 *
 * Usage:
 *   tsx scripts/ingest-resumable.ts --chunks corpus.json --job lotr-epoch \
 *     [--sub-batch 20] [--mode epoch] [--url http://127.0.0.1:3000] \
 *     [--concurrency N] [--stream <id>] [--content-type <t>] \
 *     [--default-wait-min 30] [--max-wait-min 360] [--max-attempts 3] [--no-wait]
 *
 * Requires the full stack (platform + ml-services + Postgres/Qdrant/Ollama) and
 * DATABASE_URL in the environment (config.ts loads platform/.env).
 */

import { readFileSync } from 'node:fs';
import { Agent, setGlobalDispatcher } from 'undici';
import { isSessionLimitError, parseResetAt } from '../src/services/session-limit.js';
import {
  ensureLedger,
  createOrLoadJob,
  nextPendingSubBatch,
  markSubBatchStarted,
  markSubBatchDone,
  markSubBatchPending,
  markSubBatchFailed,
  setJobStatus,
  jobProgress,
} from '../src/services/ingest-ledger.js';

// A sub-batch holds one HTTP request open until every chunk has stored +
// proposed + promoted — minutes for an epoch of 20. Disable undici's client
// response timeouts so the driver waits as long as the run needs (mirrors
// compare-ingestion.ts).
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const intArg = (name: string, dflt: number): number => {
  const v = Number(arg(name));
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : dflt;
};

const URL = arg('url', process.env.PLATFORM_URL ?? 'http://127.0.0.1:3000')!;
const chunksFile = arg('chunks');
const jobName = arg('job');
const mode = arg('mode', 'epoch')!;
const subBatchSize = intArg('sub-batch', 20);
const concurrencyArg = Number(arg('concurrency'));
const concurrency =
  Number.isInteger(concurrencyArg) && concurrencyArg > 0 ? concurrencyArg : undefined;
const streamId = arg('stream');
const contentType = arg('content-type');
const defaultWaitMin = intArg('default-wait-min', 30);
const maxWaitMin = intArg('max-wait-min', 360);
const maxAttempts = intArg('max-attempts', 3);
const noWait = has('no-wait');

if (!chunksFile || !jobName) {
  console.error('Usage: tsx scripts/ingest-resumable.ts --chunks <file.json> --job <name> [opts]');
  console.error('  --chunks is required (a JSON array of chunk strings); --job names the resumable run.');
  process.exit(1);
}

const parsed: unknown = JSON.parse(readFileSync(chunksFile, 'utf-8'));
if (!Array.isArray(parsed) || parsed.some((c) => typeof c !== 'string')) {
  console.error('--chunks must be a JSON array of strings.');
  process.exit(1);
}
const corpus = parsed as string[];

const log = (m: string): void => console.log(`[resumable] ${m}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Sleep `ms`, logging a heartbeat with the remaining time every ~5 minutes. */
async function sleepWithHeartbeat(ms: number, resumeAt: Date): Promise<void> {
  const tick = 5 * 60 * 1000;
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(tick, remaining);
    await sleep(step);
    remaining -= step;
    if (remaining > 0) {
      log(`  …still paused, ~${Math.ceil(remaining / 60000)} min until ${resumeAt.toISOString()}`);
    }
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Pull the human-readable error out of a platform response body. */
function extractError(bodyText: string): string {
  try {
    const j = JSON.parse(bodyText) as { error?: unknown };
    if (typeof j.error === 'string') return j.error;
  } catch {
    /* not JSON — fall through */
  }
  return bodyText;
}

/** ms to wait for a limit reset: until the parsed reset (+buffer), clamped. */
function waitMsFor(resetAt: Date | null, now: Date): { ms: number; resumeAt: Date } {
  const maxMs = maxWaitMin * 60_000;
  if (resetAt) {
    const buffered = resetAt.getTime() + 60_000 - now.getTime(); // +60s past the reset
    const ms = Math.min(Math.max(buffered, 30_000), maxMs); // floor 30s (reset already passed), cap maxWait
    return { ms, resumeAt: new Date(now.getTime() + ms) };
  }
  const ms = Math.min(defaultWaitMin * 60_000, maxMs);
  return { ms, resumeAt: new Date(now.getTime() + ms) };
}

async function main(): Promise<void> {
  await ensureLedger();
  const { job, created } = await createOrLoadJob({ name: jobName!, chunks: corpus, mode, subBatchSize });
  const prog0 = await jobProgress(job.id);
  log(
    `job "${job.name}" ${created ? 'created' : 'resumed'} — mode=${mode} chunks=${corpus.length} ` +
      `sub-batches=${job.totalSubBatches}(×${subBatchSize}) done=${prog0.done}/${prog0.total} url=${URL}`,
  );
  await setJobStatus(job.id, 'running');

  for (;;) {
    const sb = await nextPendingSubBatch(job.id);
    if (!sb) break; // all sub-batches done

    const chunks = corpus.slice(sb.chunkStart, sb.chunkEnd);
    await markSubBatchStarted(job.id, sb.seq);
    log(
      `▶ sub-batch ${sb.seq + 1}/${job.totalSubBatches} chunks[${sb.chunkStart}..${sb.chunkEnd}) ` +
        `(${chunks.length}) attempt ${sb.attempts + 1}`,
    );

    let res: Response;
    try {
      res = await post(`/ingest/batch/${mode}`, {
        chunks,
        source: `${job.name}-sb${sb.seq}`,
        // Stable ledger-minted source id → deterministic memory ids in store(),
        // so retrying this sub-batch after a pause upserts the same Qdrant
        // points instead of leaking duplicates.
        sourceId: sb.sourceId,
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(streamId !== undefined ? { stream_id: streamId } : {}),
        ...(contentType !== undefined ? { contentType } : {}),
      });
    } catch (err) {
      // Network-level failure (platform down, connection reset). Treat as a
      // genuine retryable failure subject to the attempt budget.
      const msg = err instanceof Error ? err.message : String(err);
      if (await handleGenuineFailure(job.id, sb.seq, sb.attempts, `network error: ${msg}`)) return;
      continue;
    }

    if (res.ok) {
      const result = (await res.json().catch(() => ({}))) as {
        sourceId?: string;
        results?: Array<{ entities?: unknown[]; facts?: unknown[] }>;
      };
      const ents = result.results?.reduce((s, r) => s + (r.entities?.length ?? 0), 0) ?? 0;
      const facts = result.results?.reduce((s, r) => s + (r.facts?.length ?? 0), 0) ?? 0;
      await markSubBatchDone(job.id, sb.seq);
      const prog = await jobProgress(job.id);
      log(`  ✓ promoted (sourceId=${result.sourceId ?? '?'} ents=${ents} facts=${facts}) — ${prog.done}/${prog.total} done`);
      continue;
    }

    const bodyText = await res.text().catch(() => res.statusText);
    const errText = extractError(bodyText);

    // Session/usage limit — pause until reset, then retry the SAME sub-batch.
    // The platform tags it 503 (handleBatch), but also pattern-match in case it
    // arrived as a 500 carrying the limit text.
    if (res.status === 503 || isSessionLimitError(errText)) {
      const now = new Date();
      const resetAt = parseResetAt(errText, now);
      // A limit pause is NOT a failed attempt — return to pending without
      // bumping the attempt counter, so it never exhausts the failure budget.
      await markSubBatchPending(job.id, sb.seq, errText.slice(0, 1000), false);
      await setJobStatus(job.id, 'paused');

      if (noWait) {
        log(`  ⏸ session limit hit; --no-wait set. Re-run this command after ${resetAt ? resetAt.toISOString() : 'the reset'} to resume.`);
        log(`     ${errText.slice(0, 200)}`);
        process.exitCode = 0;
        return;
      }

      const { ms, resumeAt } = waitMsFor(resetAt, now);
      log(
        `  ⏸ session limit hit — pausing ~${Math.ceil(ms / 60000)} min, resuming at ${resumeAt.toISOString()}` +
          `${resetAt ? '' : ' (reset time not parseable; using default wait)'}`,
      );
      log(`     ${errText.slice(0, 200)}`);
      await sleepWithHeartbeat(ms, resumeAt);
      await setJobStatus(job.id, 'running');
      log(`  ▷ resuming sub-batch ${sb.seq + 1}/${job.totalSubBatches}`);
      continue; // nextPendingSubBatch returns this same seq again
    }

    // Genuine failure — bounded retry, then stop the job (leave it resumable).
    if (await handleGenuineFailure(job.id, sb.seq, sb.attempts, `${res.status}: ${errText}`)) return;
  }

  await setJobStatus(job.id, 'completed');
  const prog = await jobProgress(job.id);
  log(`✓ job "${job.name}" complete — ${prog.done}/${prog.total} sub-batches promoted`);
}

/**
 * A non-limit failure. Retry (return to pending) until the attempt budget is
 * exhausted, then mark the sub-batch + job failed and abort with a non-zero
 * exit. The ledger stays intact, so a later re-run resumes from this sub-batch.
 *
 * Returns true when the job was STOPPED (terminal failure) — callers must stop
 * the loop; false when the sub-batch was returned to pending for another try.
 */
async function handleGenuineFailure(
  jobId: string,
  seq: number,
  attempts: number,
  errText: string,
): Promise<boolean> {
  if (attempts + 1 >= maxAttempts) {
    await markSubBatchFailed(jobId, seq, errText.slice(0, 2000));
    await setJobStatus(jobId, 'failed');
    log(`  ✗ sub-batch ${seq} failed after ${attempts + 1} attempt(s): ${errText.slice(0, 300)}`);
    log(`     fix the cause and re-run the same command to resume from here.`);
    process.exitCode = 1;
    return true;
  }
  const backoffMs = 2000 * 2 ** attempts;
  await markSubBatchPending(jobId, seq, errText.slice(0, 1000), true);
  log(`  ⚠ sub-batch ${seq} failed (attempt ${attempts + 1}/${maxAttempts}); retrying in ${backoffMs / 1000}s: ${errText.slice(0, 200)}`);
  await sleep(backoffMs);
  return false;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error('[resumable] fatal:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  },
);
