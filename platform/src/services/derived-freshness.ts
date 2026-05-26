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
 */
export async function markDerivedComputed(kind: 'topology' | 'clustering'): Promise<void> {
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
