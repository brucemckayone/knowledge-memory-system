/**
 * Pattern Lifecycle Service (Phase 6 — doc 17, nmemo-d9v)
 *
 * `causal_patterns` was created with a full lifecycle schema
 * (staging → candidate → provisional → canonical) in 002_causal_graph.sql but
 * had zero code touching it until this phase. `causal_edges.pattern_id` is
 * wired forward-compat from Phase 4. This service brings patterns alive:
 *
 *   - `detectCausalPatterns` walks active causal chains, normalises each chain
 *     to an abstract template (entity_type + transition_type +
 *     predicate_category), clusters structurally identical templates, and
 *     upserts to staging at a configurable instance threshold (default 3).
 *   - `promotePatterns` drives the lifecycle staging → candidate → provisional
 *     → canonical with status-guarded UPDATE ... WHERE status=$prev RETURNING
 *     (a SQL CAS — no row locks, idempotent across pipeline + manual API
 *     races). Demotes on inactivity. Rejects staging that never activates.
 *   - `nameCandidatePatterns` synchronously calls Haiku for newly-promoted
 *     candidates, with try/catch + name=NULL fallback so naming failures
 *     never block promotion.
 *   - `matchEdgeToPattern` fires fire-and-forget from `createCausalEdge` —
 *     checks if the new edge starts/continues a provisional or canonical
 *     pattern and sets `pattern_id` + `pattern_position`. Never throws back
 *     into edge creation.
 *   - `findCausalGhosts` surfaces expected-but-missing N-1-of-N pattern steps
 *     for an entity (used by the reasoning agent during patrol).
 *   - `activePatterns` filters the catalog by status + entity involvement
 *     for MCP/HTTP/viz consumers.
 *
 * Heuristics implemented in this group (G1 — d9v.1 + d9v.2):
 *   - Migration 012 extends `valid_pattern_status` to include `'rejected'`.
 *   - `collectChains` — recursive CTE walking active causal_edges from events
 *     within `lookbackDays`. Cycle protection via path-array exclusion.
 *     Capped at `maxChains` and `maxChainLength`.
 *
 * Later groups add normalisation/clustering, lifecycle, naming, matching,
 * ghosts, and the active-patterns query.
 */

import { sql } from 'drizzle-orm';
import { rawQuery } from '../db/raw.js';

// ============================================
// Types
// ============================================

export interface DetectOptions {
  /** Minimum chain length to consider for a template. Default 2. */
  minChainLength?: number;
  /** Maximum chain length to walk during collection. Default 6. */
  maxChainLength?: number;
  /** Only include chains whose first cause event occurred within this window. Default 30. */
  lookbackDays?: number;
  /** Cluster size required to upsert into staging. Default 3. */
  instanceThreshold?: number;
  /** Hard cap on the number of chains the CTE returns. Default 1000. */
  maxChains?: number;
}

export interface DetectResult {
  chainsExamined: number;
  templatesFound: number;
  newStaging: number;
  updatedExisting: number;
}

/** A single forward chain through the causal graph (cause → effect → effect → …). */
export interface Chain {
  edgeIds: string[];
  length: number;
}

const DEFAULTS: Required<DetectOptions> = {
  minChainLength: 2,
  maxChainLength: 6,
  lookbackDays: 30,
  instanceThreshold: 3,
  maxChains: 1000,
};

// ============================================
// Detection — chain collection (G1)
// ============================================

/**
 * Walk active `causal_edges` starting from edges whose cause event occurred
 * within `lookbackDays`. Returns linear forward chains of length
 * `[minChainLength, maxChainLength]`. Cycle protection: an edge cannot appear
 * twice in the same chain (path-array exclusion in the recursive term).
 *
 * Output is the raw set of edge-id sequences, capped at `maxChains`. G2 layers
 * normalisation + clustering + upsert on top of these chains.
 */
export async function collectChains(opts: DetectOptions = {}): Promise<Chain[]> {
  const o = { ...DEFAULTS, ...opts };

  type Row = {
    edgePath: string[];
    length: number;
  };

  const rows = await rawQuery<Row>(sql`
    WITH RECURSIVE chain AS (
      SELECT
        ARRAY[e.id]::uuid[] AS edge_path,
        e.cause_event_id     AS first_cause,
        e.effect_event_id    AS current_effect,
        1                    AS length
      FROM public.causal_edges e
      JOIN public.causal_events ce ON ce.id = e.cause_event_id
      WHERE e.expired_at IS NULL
        AND ce.occurred_at >= NOW() - (${o.lookbackDays}::int || ' days')::interval

      UNION ALL

      SELECT
        c.edge_path || n.id,
        c.first_cause,
        n.effect_event_id,
        c.length + 1
      FROM chain c
      JOIN public.causal_edges n
        ON n.cause_event_id = c.current_effect
      WHERE n.expired_at IS NULL
        AND c.length < ${o.maxChainLength}::int
        AND NOT (n.id = ANY(c.edge_path))
    )
    SELECT
      (edge_path)::text[]::uuid[]::text[] AS edge_path,
      length
    FROM chain
    WHERE length >= ${o.minChainLength}::int
    ORDER BY length DESC, first_cause
    LIMIT ${o.maxChains}::int
  `);

  return rows.map((r) => ({
    edgeIds: r.edgePath,
    length: r.length,
  }));
}

/**
 * Phase 6 detection orchestrator. G1 implements only the chain-collection
 * step; later groups layer normalisation, clustering, and upsert.
 */
export async function detectCausalPatterns(
  opts: DetectOptions = {},
): Promise<DetectResult> {
  const chains = await collectChains(opts);
  return {
    chainsExamined: chains.length,
    templatesFound: 0,
    newStaging: 0,
    updatedExisting: 0,
  };
}
