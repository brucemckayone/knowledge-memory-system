/**
 * Platform scheduler (bead nmemo-2yv.84).
 *
 * Single home for all time-driven cadences. Today registers exactly one job:
 * the drift patrol, on DRIFT_PATROL_CRON / DRIFT_PATROL_INTERVAL_MIN cadence.
 *
 * All jobs are fire-and-forget with try/catch + structured logging. Every
 * `await` lives inside the job's try block; an awaiting failure becomes a
 * caught warn-log, never an unhandled promise rejection that crashes Node.
 *
 * Future time-driven cadences (e.g. .71 reasoning patrol if it lands
 * time-driven) register here next to driftPatrol. Add the env-var to
 * config.ts, drop a new registerXxxJob() call in startScheduler(), and the
 * stop/start lifecycle handles the rest.
 *
 * Lifecycle:
 *   - startScheduler() called from src/index.ts at startup (skipped under
 *     VITEST and when DISABLE_SCHEDULER=1).
 *   - stopScheduler() (exported for tests + SIGTERM hook).
 *
 * The scheduler is a no-op when imported under Vitest unless explicitly
 * started, so test files can register a faster cadence (overrideInterval) for
 * integration coverage without colliding with the production cron string.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { config } from './config.js';

interface RegisteredJob {
  name: string;
  task: ScheduledTask;
}

const jobs: RegisteredJob[] = [];

/**
 * Test-injection seam for the localhost compute URL base. Production reads
 * config.PLATFORM_PORT; tests override to point at a stub server.
 */
let _testPortOverride: number | null = null;
export function _setSchedulerPortForTesting(port: number | null): void {
  _testPortOverride = port;
}

function resolveComputePort(): number {
  return _testPortOverride ?? config.PLATFORM_PORT;
}

/**
 * Resolve the drift cadence into a cron expression. Order of precedence:
 *   1) explicit DRIFT_PATROL_CRON (raw cron string, full 5-field form)
 *   2) DRIFT_PATROL_INTERVAL_MIN (minutes-interval convenience)
 */
function resolveDriftCron(): string {
  if (config.DRIFT_PATROL_CRON && config.DRIFT_PATROL_CRON.trim().length > 0) {
    return config.DRIFT_PATROL_CRON.trim();
  }
  const min = config.DRIFT_PATROL_INTERVAL_MIN;
  // node-cron uses 5-field unix-cron format ("m h dom mon dow"). For "every
  // N minutes" the canonical shape is "*/N * * * *". N must be <= 59 for the
  // minutes field to parse cleanly; for hourly cadences (>=60) we step the
  // hour field and pin the minute at 0.
  if (min < 60) return `*/${min} * * * *`;
  const hours = Math.floor(min / 60);
  return `0 */${hours} * * *`;
}

/**
 * The drift patrol job. Fires POST /api/drift/compute against the in-process
 * platform port. Fire-and-forget; never throws out. A failure on a single
 * tick lands as a console.warn and the next tick proceeds normally.
 */
async function runDriftPatrol(): Promise<void> {
  const url = `http://127.0.0.1:${resolveComputePort()}/api/drift/compute`;
  try {
    const start = Date.now();
    const response = await fetch(url, { method: 'POST' });
    const ok = response.ok;
    let body: unknown = null;
    try { body = await response.json(); } catch { /* ignore non-json error bodies */ }
    const durationMs = Date.now() - start;
    if (ok) {
      console.log(`[scheduler] drift-patrol: ok (${durationMs}ms)`);
    } else if (response.status === 409) {
      console.log(`[scheduler] drift-patrol: in-progress (409) — concurrent compute already running`);
    } else {
      console.warn(`[scheduler] drift-patrol: http ${response.status} (${durationMs}ms)`, body);
    }
  } catch (err) {
    console.warn('[scheduler] drift-patrol failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Register a job by name. Idempotent: a second call with the same name
 * replaces the previous task (stop + re-register). Exposed so tests can
 * override a cadence for fast verification.
 */
export function registerJob(name: string, cronExpression: string, runner: () => Promise<void> | void): void {
  // Validate the cron expression up-front so a typo at boot lands as a
  // startup error rather than a silent no-op.
  if (!cron.validate(cronExpression)) {
    throw new Error(`[scheduler] invalid cron expression for job "${name}": ${cronExpression}`);
  }
  const existingIdx = jobs.findIndex((j) => j.name === name);
  if (existingIdx >= 0) {
    const prev = jobs[existingIdx];
    if (prev) {
      prev.task.stop();
      jobs.splice(existingIdx, 1);
    }
  }
  const task = cron.schedule(
    cronExpression,
    () => {
      // node-cron's tick handler is synchronous; wrap the async runner so
      // exceptions land as warns rather than process-killing rejections.
      void (async () => {
        try {
          await runner();
        } catch (err) {
          console.warn(`[scheduler] job "${name}" threw:`, err instanceof Error ? err.message : err);
        }
      })();
    },
    { scheduled: false },
  );
  task.start();
  jobs.push({ name, task });
  console.log(`[scheduler] registered job "${name}" with cron "${cronExpression}"`);
}

/**
 * Start the scheduler. Registers the production job set. Idempotent —
 * subsequent calls re-register jobs (used by tests that override cadence).
 *
 * Honours DISABLE_SCHEDULER=1 (skips registration entirely) so test harnesses
 * and one-off CLI scripts can import platform modules without spawning a
 * background patrol.
 */
export function startScheduler(): void {
  if (config.DISABLE_SCHEDULER) {
    console.log('[scheduler] disabled via DISABLE_SCHEDULER=1');
    return;
  }
  const driftCron = resolveDriftCron();
  registerJob('drift-patrol', driftCron, runDriftPatrol);
}

/**
 * Stop and clear all registered jobs. Test-facing; production calls this
 * from the SIGTERM/SIGINT shutdown path so node-cron's interval doesn't
 * keep the event loop alive after the HTTP server closes.
 */
export function stopScheduler(): void {
  for (const job of jobs) {
    try {
      job.task.stop();
    } catch (err) {
      console.warn(`[scheduler] stop job "${job.name}" failed:`, err instanceof Error ? err.message : err);
    }
  }
  jobs.length = 0;
}

/**
 * Test-facing introspection. Returns the names of currently-registered jobs.
 */
export function getRegisteredJobs(): string[] {
  return jobs.map((j) => j.name);
}
