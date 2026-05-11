// Drives the patrol agent on a setInterval, persisting each cycle to patrol_runs.
// In-process boolean mutex — skip ticks while a patrol is in flight.
// Disabled by default; set PATROL_INTERVAL_MIN=<minutes> to enable.

import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db, patrolRuns } from '../db/index.js';
import { runPatrol } from '../agents/patrol-agent.js';

let inFlight = false;
let timer: NodeJS.Timeout | null = null;

export function isPatrolInFlight(): boolean {
  return inFlight;
}

type PatrolRunRow = typeof patrolRuns.$inferSelect;

/**
 * Run one patrol cycle. Inserts a `running` row synchronously, then invokes the
 * agent and updates the row with the result. Catches all errors so the cron
 * never crashes the server.
 *
 * Returns the runId immediately (after the insert) but completes the agent work
 * asynchronously. The returned promise resolves to the final persisted row when
 * the agent finishes, or null if the mutex was already set.
 *
 * For the manual-trigger endpoint, prefer `startPatrolRun()` which separates
 * the synchronous insert from the async agent work.
 */
export async function runPatrolNow(): Promise<PatrolRunRow | null> {
  const runId = await startPatrolRun();
  if (!runId) return null;
  // Wait for the in-flight work to complete by polling the mutex.
  // (startPatrolRun fires-and-forgets; we await completion here for callers
  // that want the final row.)
  while (inFlight) {
    await new Promise(r => setTimeout(r, 250));
  }
  const [row] = await db.select().from(patrolRuns).where(eq(patrolRuns.id, runId));
  return row ?? null;
}

/**
 * Insert a `running` patrol_runs row, kick off the agent in the background, and
 * return the runId. Respects the in-flight mutex — returns null if a patrol is
 * already running. Does NOT await the agent.
 */
export async function startPatrolRun(): Promise<string | null> {
  if (inFlight) {
    console.log('[patrol-cron] start skipped — already in flight');
    return null;
  }
  inFlight = true;

  const runId = randomUUID();
  const startedAtIso = new Date().toISOString();
  console.log(`[patrol-cron] tick start  (run_id=${runId})`);

  try {
    await db.insert(patrolRuns).values({
      id: runId,
      startedAt: startedAtIso,
      status: 'running',
      insightsProduced: 0,
      mcpCalls: 0,
    });
  } catch (err) {
    inFlight = false;
    throw err;
  }

  // Fire-and-forget. Errors are caught and persisted to the row.
  void executePatrol(runId);
  return runId;
}

async function executePatrol(runId: string): Promise<void> {
  try {
    const result = await runPatrol();
    const finishedAt = new Date().toISOString();
    const status = result.ok ? 'ok' : 'error';

    await db.update(patrolRuns).set({
      status,
      insightsProduced: result.insightsProduced,
      mcpCalls: result.mcpCalls,
      durationMs: result.durationMs,
      finishedAt,
      errorText: result.errorText ?? null,
    }).where(eq(patrolRuns.id, runId));

    console.log(`[patrol-cron] tick done   (run_id=${runId}, insights=${result.insightsProduced}, calls=${result.mcpCalls}, ms=${result.durationMs}, status=${status})`);
  } catch (err) {
    // runPatrol catches its own errors and returns ok:false, so this only fires
    // on truly unexpected failures (e.g. DB write errors after success).
    const errorText = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date().toISOString();
    await db.update(patrolRuns).set({
      status: 'error',
      finishedAt,
      errorText,
    }).where(eq(patrolRuns.id, runId)).catch(() => { /* swallow — already in error path */ });
    console.error(`[patrol-cron] tick crashed (run_id=${runId}): ${errorText}`);
  } finally {
    inFlight = false;
  }
}

/**
 * Start the cron. Idempotent — second call is a no-op while the timer is live.
 * No-op if PATROL_INTERVAL_MIN is unset, 0, NaN, or negative.
 *
 * Does NOT fire immediately — the first tick waits one full interval. This
 * avoids thrashing during `tsx watch` hot-reload and gives the server time to
 * warm up.
 */
export function startPatrolCron(): void {
  if (timer) return;
  const minutes = config.PATROL_INTERVAL_MIN ?? 0;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log('[patrol-cron] disabled (PATROL_INTERVAL_MIN unset or 0)');
    return;
  }
  const ms = minutes * 60 * 1000;
  console.log(`[patrol-cron] starting — every ${minutes}min`);
  timer = setInterval(() => { void startPatrolRun(); }, ms);
}

/** Stop the cron timer. Used by tests; not currently called in production. */
export function stopPatrolCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Query helper for the observability endpoint. Caps limit at [1, 100]. */
export async function getRecentPatrolRuns(limit: number): Promise<{ runs: PatrolRunRow[]; total: number }> {
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 20, 1), 100);
  const runs = await db.select().from(patrolRuns)
    .orderBy(desc(patrolRuns.startedAt))
    .limit(safeLimit);
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)` }).from(patrolRuns);
  return { runs, total: Number(total) };
}
