/**
 * Platform scheduler (bead nmemo-2yv.84, extended .71).
 *
 * Single home for all time-driven cadences. Today registers two jobs:
 *   - drift patrol      (DRIFT_PATROL_CRON / DRIFT_PATROL_INTERVAL_MIN)
 *   - reasoning patrol  (REASONING_PATROL_CRON / REASONING_PATROL_INTERVAL_MIN)
 *
 * All jobs are fire-and-forget with try/catch + structured logging. Every
 * `await` lives inside the job's try block; an awaiting failure becomes a
 * caught warn-log, never an unhandled promise rejection that crashes Node.
 *
 * Future time-driven cadences register here. Add the env-var to config.ts,
 * drop a new registerXxxJob() call in startScheduler(), and the stop/start
 * lifecycle handles the rest.
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
import { sql } from 'drizzle-orm';
import { config } from './config.js';
import { db } from './db/index.js';

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
 * Resolve a cron expression from a raw-cron override plus a minutes-interval
 * fallback. Same precedence and shape rules used by every scheduled job:
 *   1) explicit raw cron string (full 5-field form)
 *   2) minutes-interval convenience knob
 *
 * Originally extracted from resolveDriftCron() (bead nmemo-2yv.84). The
 * reasoning patrol (nmemo-2yv.71) reuses the same shape; centralising here
 * keeps the cron-resolution rules in one place.
 */
function resolveCron(rawCron: string | undefined, intervalMin: number): string {
  if (rawCron && rawCron.trim().length > 0) {
    return rawCron.trim();
  }
  // node-cron uses 5-field unix-cron format ("m h dom mon dow"). For "every
  // N minutes" the canonical shape is "*/N * * * *". N must be <= 59 for the
  // minutes field to parse cleanly; for hourly cadences (>=60) we step the
  // hour field and pin the minute at 0.
  if (intervalMin < 60) return `*/${intervalMin} * * * *`;
  const hours = Math.floor(intervalMin / 60);
  return `0 */${hours} * * *`;
}

function resolveDriftCron(): string {
  return resolveCron(config.DRIFT_PATROL_CRON, config.DRIFT_PATROL_INTERVAL_MIN);
}

function resolveReasoningCron(): string {
  return resolveCron(config.REASONING_PATROL_CRON, config.REASONING_PATROL_INTERVAL_MIN);
}

/**
 * Source-refs drift patrol (bead nmemo-d1r.7). Default cadence is monthly —
 * "0 3 1 * *" = 03:00 on day-1 of every month. Drift accumulates slowly and
 * the patrol is a watchdog, not a hot-path check, so a coarse cadence is
 * appropriate. The raw cron knob lets ops change the cadence (e.g. weekly
 * during a feature rollout); the minutes-interval knob exists for
 * integration tests + ad-hoc shorter cadences. resolveCron caps minutes
 * intervals at the hourly form ("0 step-N hours" syntax), so anything >= 60
 * minutes lands on an hour boundary — sub-daily cadences work fine,
 * sub-monthly is the natural reach of the convenience knob.
 */
const SOURCE_REFS_DRIFT_DEFAULT_CRON = '0 3 1 * *';
function resolveSourceRefsDriftCron(): string {
  if (config.SOURCE_REFS_DRIFT_PATROL_CRON && config.SOURCE_REFS_DRIFT_PATROL_CRON.trim().length > 0) {
    return config.SOURCE_REFS_DRIFT_PATROL_CRON.trim();
  }
  if (config.SOURCE_REFS_DRIFT_PATROL_INTERVAL_MIN !== undefined) {
    return resolveCron(undefined, config.SOURCE_REFS_DRIFT_PATROL_INTERVAL_MIN);
  }
  return SOURCE_REFS_DRIFT_DEFAULT_CRON;
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
 * Source-refs drift detector (bead nmemo-d1r.7).
 *
 * Phase 3 (doc 14) introduced edge_source_refs as a reverse-lookup index
 * over causal_edges.source_references (JSONB authoritative). All wired
 * mutation paths keep them in step today; the index is the only thing
 * findEdgesCitingReference() reads. The failure mode the patrol exists
 * to surface: a future un-instrumented edge-mutation path could write
 * JSONB without writing the index row, and findEdgesCitingReference would
 * silently return [] for the drifted ref (see the adversarial fixture
 * src/test/data/phase3-source-refs/fixtures/drift-detected.sql, which
 * encodes exactly this shape — JSONB cites a ref the index doesn't carry).
 *
 * The query mirrors the canonical drift expression in
 * src/test/harness/source-refs-index.test.ts driftCount(): for every
 * JSONB-side ref of every edge, assert a matching edge_source_refs row
 * exists. Normalises legacy string-encoded JSONB the same way to avoid
 * false positives on rows written before the array-shape contract landed.
 *
 * The returned `driftCount` is the number of JSONB refs without a
 * corresponding index row — drift > 0 is an alert condition.
 */
export interface SourceRefsDriftSignal {
  driftCount: number;
  durationMs: number;
}

export async function checkSourceRefsDrift(): Promise<SourceRefsDriftSignal> {
  const start = Date.now();
  const rows = (await db.execute(sql`
    WITH normalized AS (
      SELECT
        e.id AS edge_id,
        CASE
          WHEN jsonb_typeof(e.source_references) = 'array'  THEN e.source_references
          WHEN jsonb_typeof(e.source_references) = 'string' THEN (e.source_references #>> '{}')::jsonb
          ELSE '[]'::jsonb
        END AS refs
      FROM public.causal_edges e
    )
    SELECT COUNT(*)::int AS drift
    FROM normalized n
    CROSS JOIN LATERAL jsonb_array_elements(n.refs) ref
    WHERE ref->>'type' IN ('memory','fact','entity')
      AND ref->>'id' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.edge_source_refs r
        WHERE r.edge_id = n.edge_id
          AND r.ref_type = (ref->>'type')
          AND r.ref_id   = (ref->>'id')::uuid
      )
  `)) as unknown as Array<{ drift: number }>;
  const driftCount = rows[0]?.drift ?? 0;
  return { driftCount, durationMs: Date.now() - start };
}

/**
 * The source-refs drift patrol job (bead nmemo-d1r.7).
 *
 * DB-only — no HTTP fire. Counts JSONB refs without a matching
 * edge_source_refs row and surfaces drift via a structured warn log.
 * drift=0 lands as a quiet info log on the same prefix so ops can confirm
 * the patrol is actually ticking.
 *
 * Fire-and-forget; never throws out. A DB failure on a single tick lands
 * as a console.warn and the next tick proceeds normally.
 */
export async function runSourceRefsDriftPatrol(): Promise<void> {
  try {
    const signal = await checkSourceRefsDrift();
    if (signal.driftCount > 0) {
      console.warn(
        `[scheduler] source-refs-drift-patrol: DRIFT DETECTED — ${signal.driftCount} JSONB ref(s) without a matching edge_source_refs row (${signal.durationMs}ms). findEdgesCitingReference will silently miss these refs; investigate which mutation path is writing JSONB without the index.`,
      );
    } else {
      console.log(`[scheduler] source-refs-drift-patrol: ok (drift=0, ${signal.durationMs}ms)`);
    }
  } catch (err) {
    console.warn('[scheduler] source-refs-drift-patrol failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Reasoning-patrol freshness gate (bead nmemo-2yv.71).
 *
 * The patrol shells out to ml-services which spawns a Claude Code subprocess —
 * expensive (40-70 MCP tool calls per pass, ~minutes wall-clock). Firing on a
 * blind cadence wastes capacity when nothing in the graph has moved. Cheap
 * fix: gate the fire on the freshness signals already maintained by
 * extraction and save_reasoning_report:
 *
 *   - entity_meta.last_mentioned_at  — bumped when extraction touches an entity
 *   - entity_meta.last_reasoned_at   — bumped when save_reasoning_report names
 *                                      the entity in entity_ids
 *   - reasoning_reports.created_at   — wall-clock anchor for the patrol itself
 *
 * Fire iff ANY entity has been mentioned more recently than the last patrol
 * pass touched any entity. Specifically: fire if max(last_mentioned_at) >
 * max(last_reasoned_at, latest reasoning_reports.created_at). The two
 * reasoned-side signals are MAX'd because:
 *
 *   - last_reasoned_at lags reality when the agent runs but doesn't claim
 *     the entity in entity_ids (e.g. patrol explored, found nothing
 *     interesting on this subject) — created_at still moves
 *   - reasoning_reports.created_at lags reality when the patrol is
 *     contradiction-resolution only (no report row written) — last_reasoned_at
 *     still moves
 *
 * Edge cases:
 *   - empty entity_meta            → no mentions, skip (cold start)
 *   - all last_mentioned_at NULL   → ditto
 *   - reasoned-side both NULL      → graph has mentions but has never been
 *                                    patrolled → fire (first-ever patrol case)
 *
 * Returns `{ fresh: boolean, reason: string }` for the runner to log + the
 * test to assert. `reason` is human-readable scaffolding only — do not
 * pattern-match on its content from production code.
 */
export interface ReasoningFreshnessSignal {
  fresh: boolean;
  reason: string;
}

export async function checkReasoningFreshness(): Promise<ReasoningFreshnessSignal> {
  // GREATEST treats NULL as NULL in postgres, which is what we want: a NULL
  // reasoned-side anchor with a non-NULL mentioned-side anchor evaluates the
  // overall comparison to NULL (i.e. "unknown") — we treat that as "fire"
  // via the explicit branch below.
  const rows = (await db.execute(sql`
    SELECT
      (SELECT MAX(last_mentioned_at) FROM public.entity_meta)                                 AS max_mentioned,
      (SELECT MAX(last_reasoned_at)  FROM public.entity_meta)                                 AS max_reasoned,
      (SELECT MAX(created_at)        FROM public.reasoning_reports)                           AS last_report_at
  `)) as unknown as Array<{ max_mentioned: Date | null; max_reasoned: Date | null; last_report_at: Date | null }>;
  const row = rows[0];
  if (!row || !row.max_mentioned) {
    return { fresh: false, reason: 'no mentions in entity_meta yet' };
  }
  // Both anchors NULL → graph has activity but no patrol has ever run.
  if (!row.max_reasoned && !row.last_report_at) {
    return { fresh: true, reason: 'first-ever patrol (no prior reasoning anchor)' };
  }
  const reasonedAnchor = new Date(
    Math.max(
      row.max_reasoned ? new Date(row.max_reasoned).getTime() : 0,
      row.last_report_at ? new Date(row.last_report_at).getTime() : 0,
    ),
  );
  const mentioned = new Date(row.max_mentioned);
  if (mentioned.getTime() > reasonedAnchor.getTime()) {
    return {
      fresh: true,
      reason: `mentions newer than last patrol (mentioned=${mentioned.toISOString()} reasoned=${reasonedAnchor.toISOString()})`,
    };
  }
  return {
    fresh: false,
    reason: `no new mentions since last patrol (mentioned=${mentioned.toISOString()} reasoned=${reasonedAnchor.toISOString()})`,
  };
}

/**
 * The reasoning patrol job (bead nmemo-2yv.71). Fires POST /api/reason
 * against the in-process platform port, but only when the freshness gate
 * says the graph has moved since the last patrol.
 *
 * The HTTP path (vs an in-process invokeReasoningAgent() call) mirrors
 * drift-patrol: the platform endpoint owns request logging, invocation_id
 * minting, and the timeout-to-504 mapping, all of which we want for free.
 *
 * Fire-and-forget; never throws out. A freshness-skip lands as a console.log
 * (silent under normal conditions, surfaces under DEBUG via the scheduler
 * prefix). A timeout (504 from the platform) lands as warn but the next tick
 * proceeds normally — the natural "minimum interval" then becomes
 * REASONING_PATROL_INTERVAL_MIN, which is the spawn-storm guard.
 */
export async function runReasoningPatrol(): Promise<void> {
  // Gate first — cheap SQL query (3 indexed aggregates) cuts the spawn-storm
  // surface area down to "graph has actually moved" before we incur the
  // Claude Code subprocess cost.
  let signal: ReasoningFreshnessSignal;
  try {
    signal = await checkReasoningFreshness();
  } catch (err) {
    // A DB failure on the gate itself is not fatal — fall back to firing.
    // Better to over-spend on patrol than to silently stop running it.
    console.warn('[scheduler] reasoning-patrol freshness check failed, firing anyway:', err instanceof Error ? err.message : err);
    signal = { fresh: true, reason: 'freshness-check error (fail-open)' };
  }
  if (!signal.fresh) {
    console.log(`[scheduler] reasoning-patrol: skipped (${signal.reason})`);
    return;
  }
  const url = `http://127.0.0.1:${resolveComputePort()}/api/reason`;
  try {
    const start = Date.now();
    const response = await fetch(url, { method: 'POST' });
    const ok = response.ok;
    let body: unknown = null;
    try { body = await response.json(); } catch { /* ignore non-json error bodies */ }
    const durationMs = Date.now() - start;
    if (ok) {
      console.log(`[scheduler] reasoning-patrol: ok (${durationMs}ms) — ${signal.reason}`);
    } else if (response.status === 504) {
      console.warn(`[scheduler] reasoning-patrol: timeout (504, ${durationMs}ms)`);
    } else {
      console.warn(`[scheduler] reasoning-patrol: http ${response.status} (${durationMs}ms)`, body);
    }
  } catch (err) {
    console.warn('[scheduler] reasoning-patrol failed:', err instanceof Error ? err.message : err);
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
  // Bead nmemo-2yv.71 — time-driven reasoning patrol, gated on entity_meta
  // freshness so we only spawn the Claude Code subprocess when the graph has
  // actually moved since the last pass.
  const reasoningCron = resolveReasoningCron();
  registerJob('reasoning-patrol', reasoningCron, runReasoningPatrol);
  // Bead nmemo-d1r.7 — monthly source-refs drift patrol. Watchdog that
  // surfaces JSONB-vs-index drift on causal_edges.source_references so the
  // silent false-negative mode of findEdgesCitingReference does not go
  // unnoticed.
  const sourceRefsDriftCron = resolveSourceRefsDriftCron();
  registerJob('source-refs-drift-patrol', sourceRefsDriftCron, runSourceRefsDriftPatrol);
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
