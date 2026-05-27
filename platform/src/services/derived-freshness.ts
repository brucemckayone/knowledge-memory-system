/**
 * Derived-state freshness helpers (bead nmemo-2yv.84).
 *
 * Three auto-trigger anchors for the derived-state computes:
 *
 *  1. Post-merge — an entity merge invalidates topology + clustering
 *     (the merge re-points edges and merges clusters). triggerTopologyAndClusteringAfterMerge()
 *     fires both computes fire-and-forget on every successful merge.
 *
 *  2. Post-ingest counter — every fact insert bumps facts_since_compute via
 *     the DB trigger added in 024_derived_freshness.sql. Platform callers
 *     (createFact) invoke maybeFireFactThresholdCompute() AFTER the insert
 *     commits; if facts_since_compute >= TOPOLOGY_CLUSTERING_FACT_THRESHOLD,
 *     both computes fire and both rows reset.
 *
 *  3. (handled in scheduler.ts) Time-driven drift patrol.
 *
 * All three anchors go through the existing /api/{topology,clustering,drift}
 * /compute HTTP routes. The advisory-lock concurrency guard from bead .87
 * fires inside those routes; no code path here bypasses it.
 *
 * Every trigger here is fire-and-forget with try/catch + structured logging.
 * A failure is logged and swallowed — never thrown — so a transient ml-services
 * blip cannot kill the inserting transaction or the merge that triggered it.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { config } from '../config.js';

/**
 * Test-injection seam for the localhost compute URL base. Production passes
 * through to config.PLATFORM_PORT. Tests stub a localhost server and set
 * this to its bound port so the fire-and-forget helpers hit the stub.
 *
 * Underscore prefix marks it test-only; production callers must NEVER set it.
 */
let _testPortOverride: number | null = null;
export function _setComputeUrlPortForTesting(port: number | null): void {
  _testPortOverride = port;
}

function resolveComputePort(): number {
  return _testPortOverride ?? config.PLATFORM_PORT;
}

/** ============================================================
 * Internal: POST to the platform's own compute endpoint.
 * Uses the in-process port so we share the route's auth, logging,
 * proxy-to-ml-services translation, and post-success Phase-4
 * cross-cluster trigger logic.
 * ============================================================ */
async function fireComputeEndpoint(
  kind: 'topology' | 'clustering' | 'drift',
  source: string,
): Promise<void> {
  const port = resolveComputePort();
  const url = `http://127.0.0.1:${port}/api/${kind}/compute`;
  try {
    const response = await fetch(url, { method: 'POST' });
    const ok = response.ok;
    let body: unknown = null;
    try { body = await response.json(); } catch { /* ignore non-json error bodies */ }
    if (ok) {
      console.log(`[derived-freshness] auto-trigger ${kind} (${source}): ok`);
    } else {
      const status = response.status;
      // 409 is the existing in-progress signal; the advisory lock has dropped
      // our caller and the running compute will finish. Not an error.
      const level = status === 409 ? 'info' : 'warn';
      if (level === 'info') {
        console.log(`[derived-freshness] auto-trigger ${kind} (${source}): in-progress (409) — concurrent compute already running`);
      } else {
        console.warn(`[derived-freshness] auto-trigger ${kind} (${source}): http ${status}`, body);
      }
    }
  } catch (err) {
    console.warn(
      `[derived-freshness] auto-trigger ${kind} (${source}) failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Reset facts_since_compute and stamp last_computed_at for a single derived_kind.
 * Called by the success branches of the /api/{topology,clustering}/compute
 * routes (the only places that know the compute actually finished).
 *
 * Bead nmemo-2yv.72 extends this to the two new in-process compute kinds —
 * pattern_detection and graph_stats — so the per-kind threshold helpers below
 * can stamp last_computed_at after their fire-and-forget compute settles.
 */
export async function markDerivedComputed(kind: 'topology' | 'clustering' | 'pattern_detection' | 'graph_stats'): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE public.derived_freshness
         SET facts_since_compute = 0,
             last_computed_at    = NOW(),
             updated_at          = NOW()
       WHERE derived_kind = ${kind}
    `);
  } catch (err) {
    // The freshness table is purely advisory — a write failure must not
    // wedge the compute route's success path.
    console.warn(`[derived-freshness] markDerivedComputed(${kind}) failed:`, err instanceof Error ? err.message : err);
  }
}

/** ============================================================
 * Post-merge trigger (bead nmemo-2yv.84 acceptance bullet 5).
 * An entity merge re-points facts + edges and merges clusters; topology
 * and clustering both need to recompute. Mirrors triggerCrossClusterAfterCompute
 * in index.ts: fire-and-forget, never throws out.
 * ============================================================ */
export async function triggerTopologyAndClusteringAfterMerge(reason: string): Promise<void> {
  try {
    // Sequential rather than Promise.all: the two computes share the same
    // ml-services worker pool and serialising them produces clearer logs
    // and bounded LLM/CPU contention. The advisory locks at .87 already
    // serialise concurrent same-kind callers; this is just being polite.
    await fireComputeEndpoint('topology', `post-merge:${reason}`);
    await fireComputeEndpoint('clustering', `post-merge:${reason}`);
  } catch (err) {
    // Defensive — fireComputeEndpoint already swallows; this catch covers a
    // hypothetical future refactor that lets a throw escape.
    console.warn(
      '[derived-freshness] triggerTopologyAndClusteringAfterMerge failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** ============================================================
 * Post-ingest counter trigger (bead nmemo-2yv.84 acceptance bullet 6).
 *
 * Called from createFact (and any future fact-insert path) AFTER the fact
 * has committed. Reads the post-increment facts_since_compute value (the
 * 024 migration's AFTER-INSERT trigger has already bumped it inside the
 * same transaction). When either kind's counter crosses the threshold:
 *   - fire topology + clustering compute fire-and-forget
 *   - reset both rows pre-emptively (so two parallel inserts crossing the
 *     threshold simultaneously don't fire the compute twice — the second
 *     reads facts_since_compute=0 and short-circuits)
 *
 * NB the bead-spec phrasing is "both rows" — same threshold on both — so we
 * only need to consult one row's counter; either side crossing is sufficient
 * because they advance in lockstep. We pick 'topology' as the arbitrary
 * source of truth.
 * ============================================================ */
export async function maybeFireFactThresholdCompute(): Promise<void> {
  const threshold = config.TOPOLOGY_CLUSTERING_FACT_THRESHOLD;
  try {
    // Atomic compare-and-reset. If we are the inserter that crossed the
    // threshold (RETURNING returns rows only when the WHERE matched), we
    // own the fire-and-forget. Concurrent inserters see facts_since_compute
    // < threshold on their post-reset read and skip.
    //
    // We reset BOTH rows in one statement so a future kind-specific reset
    // can't leak. updated_at stamps NOW() for ops visibility; last_computed_at
    // stays untouched (the compute hasn't finished yet — the route's success
    // branch will stamp it via markDerivedComputed).
    const reset = (await db.execute(sql`
      UPDATE public.derived_freshness
         SET facts_since_compute = 0,
             updated_at          = NOW()
       WHERE derived_kind = 'topology'
         AND facts_since_compute >= ${threshold}
       RETURNING derived_kind
    `)) as unknown as Array<{ derived_kind: string }>;
    if (reset.length === 0) return; // threshold not crossed (or another inserter won the race)

    // Reset the sibling row too so the counters stay in lockstep.
    await db.execute(sql`
      UPDATE public.derived_freshness
         SET facts_since_compute = 0,
             updated_at          = NOW()
       WHERE derived_kind = 'clustering'
    `);

    void triggerTopologyAndClusteringAfterMerge(`post-ingest-counter:>=${threshold}`);
  } catch (err) {
    console.warn(
      '[derived-freshness] maybeFireFactThresholdCompute failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** ============================================================
 * Per-kind threshold helpers — pattern_detection + graph_stats
 * (bead nmemo-2yv.72).
 *
 * Both kinds were previously gated by counters in pipeline.ts ticked on
 * reasoning-patrol success (Rule 2 violation per doc 34 §3.4). They now
 * follow the same DB-reactive shape as topology + clustering: the AFTER-
 * INSERT trigger on public.facts (migration 024) bumps facts_since_compute
 * for every row in derived_freshness; the helper here reads-and-resets when
 * its row crosses the configured threshold and fires the compute in-process.
 *
 * Unlike topology + clustering — which proxy through HTTP into ml-services —
 * pattern detection and graph_stats are platform-side TS functions. We call
 * them directly here (no /api/{...}/compute hop) so the auto-trigger path
 * has no HTTP self-call. The manual viz endpoints (POST /api/patterns/detect,
 * POST /api/patterns/promote, POST /api/graph-stats/compute) remain as Rule-3
 * debug surfaces.
 *
 * Each helper:
 *   1. Atomically compare-and-reset on its row (UPDATE ... RETURNING with
 *      WHERE facts_since_compute >= threshold). If zero rows return, another
 *      parallel inserter already crossed the threshold and reset — skip.
 *   2. Fire the in-process compute fire-and-forget (void async IIFE so a
 *      throw in the compute body becomes a logged warn, never an unhandled
 *      rejection).
 *   3. On compute success, stamp last_computed_at via markDerivedComputed().
 *
 * The dedicated kind-specific helpers (vs a single generic dispatcher) keep
 * the compute-side type signatures explicit and let each helper log a kind-
 * tagged line for ops triage.
 * ============================================================ */

/**
 * Internal: atomic compare-and-reset for a single derived_kind row. Returns
 * true if THIS caller crossed the threshold (owns the fire) and false
 * otherwise (another caller won the race, or the threshold is not yet
 * crossed). updated_at stamps NOW() for ops visibility; last_computed_at
 * stays untouched until the compute itself finishes (markDerivedComputed).
 */
async function tryClaimThresholdReset(
  kind: 'pattern_detection' | 'graph_stats',
  threshold: number,
): Promise<boolean> {
  const reset = (await db.execute(sql`
    UPDATE public.derived_freshness
       SET facts_since_compute = 0,
           updated_at          = NOW()
     WHERE derived_kind = ${kind}
       AND facts_since_compute >= ${threshold}
    RETURNING derived_kind
  `)) as unknown as Array<{ derived_kind: string }>;
  return reset.length > 0;
}

/**
 * Post-ingest counter trigger for pattern detection. When the threshold is
 * crossed, runs detectCausalPatterns() + promotePatterns() sequentially. The
 * two are paired because every staging row written by detect needs a promote
 * pass to advance through the lifecycle on the same cadence — splitting them
 * would let staging rows accumulate while promotion runs less often.
 */
export async function maybeFirePatternDetection(): Promise<void> {
  const threshold = config.PATTERN_DETECTION_FACT_THRESHOLD;
  try {
    const claimed = await tryClaimThresholdReset('pattern_detection', threshold);
    if (!claimed) return;

    void (async () => {
      try {
        const { detectCausalPatterns, promotePatterns } = await import('./causal-patterns.js');
        const detection = await detectCausalPatterns();
        const promotion = await promotePatterns();
        console.log(
          `[derived-freshness] auto-trigger pattern_detection (>=${threshold}): ${detection.newStaging} new staging, ${promotion.promoted.length} promoted, ${promotion.demoted.length} demoted, ${promotion.rejected.length} rejected`,
        );
        await markDerivedComputed('pattern_detection');
      } catch (err) {
        console.warn(
          '[derived-freshness] auto-trigger pattern_detection failed:',
          err instanceof Error ? err.message : err,
        );
      }
    })();
  } catch (err) {
    console.warn(
      '[derived-freshness] maybeFirePatternDetection failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Post-ingest counter trigger for graph_stats. When the threshold is
 * crossed, runs computeGraphStats() once. Cheap pure-SQL aggregate; the
 * threshold is tuned low (default 20) so the viz `graph_stats` row stays
 * close to live without ingest-path latency cost.
 */
export async function maybeFireGraphStats(): Promise<void> {
  const threshold = config.GRAPH_STATS_FACT_THRESHOLD;
  try {
    const claimed = await tryClaimThresholdReset('graph_stats', threshold);
    if (!claimed) return;

    void (async () => {
      try {
        const { computeGraphStats } = await import('./graph-stats.js');
        const stats = await computeGraphStats();
        console.log(
          `[derived-freshness] auto-trigger graph_stats (>=${threshold}): total_entities=${stats.totalEntities} active_facts=${stats.totalActiveFacts} duration=${stats.computedDurationMs}ms`,
        );
        await markDerivedComputed('graph_stats');
      } catch (err) {
        console.warn(
          '[derived-freshness] auto-trigger graph_stats failed:',
          err instanceof Error ? err.message : err,
        );
      }
    })();
  } catch (err) {
    console.warn(
      '[derived-freshness] maybeFireGraphStats failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
