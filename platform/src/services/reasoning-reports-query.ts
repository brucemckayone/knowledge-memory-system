/**
 * Reasoning reports — read-only query helpers for the viz debug panel
 * (bead nmemo-2yv.81). The reasoning agent (patrol + query) writes
 * `public.reasoning_reports` rows via `save_reasoning_report`
 * (src/services/causal-agent.ts:2234); `computeGraphStats` (bead .49) writes
 * patrol-mode rows summarising graph_stats sweeps; .77 added invocation_id
 * idempotency so a /api/reason call yields at most one row.
 *
 * This module exposes four GET-only views over those rows for the viz panel:
 *
 *   - `listReasoningReports({ limit, mode })` — recent reports header view,
 *     with summary array counts (no full report body) to keep responses light.
 *   - `getReasoningReportById(id)` — full single report including markdown
 *     body + actions_taken for the click-through detail view.
 *   - `listReasoningReportsByEntity(entityId, { limit })` — entity-filtered
 *     for canvas-selection drill-in, leverages the GIN index on entity_ids
 *     (008_reasoning_reports.sql:33). Same lightweight shape as the list.
 *   - `getReasoningReportCadence()` — patrol cadence summary: total count,
 *     per-mode count, time since last patrol, average actions_taken.durationMs
 *     when present. Bounded query — scans the last 100 rows so the snapshot
 *     stays cheap on growing tables.
 *
 * No MCP tool exposure — the viz client hits HTTP GETs only (the MCP
 * `get_reasoning_history` tool stays agent-internal per bead acceptance).
 *
 * Pattern mirrors src/services/cross-cluster-generator.ts:listCrossClusterRuns
 * — raw SQL through drizzle's `db.execute`, snake_case columns, ISO-string
 * timestamps, no joins (reports are self-contained).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

// ============================================
// Shared row shapes
// ============================================

export interface ReasoningReportSummary {
  id: string;
  mode: 'patrol' | 'query';
  question: string | null;
  entityCount: number;
  factCount: number;
  causalEdgeCount: number;
  durationMs: number | null;
  createdAt: string;
  invocationId: string | null;
}

export interface ReasoningReportDetail extends ReasoningReportSummary {
  report: string;
  entityIds: string[];
  factIds: string[];
  causalEdgeIds: string[];
  actionsTaken: Record<string, unknown>;
}

export interface ReasoningReportCadence {
  totalReports: number;
  windowSize: number;
  byMode: { patrol: number; query: number };
  lastPatrolAt: string | null;
  msSinceLastPatrol: number | null;
  lastQueryAt: string | null;
  msSinceLastQuery: number | null;
  // Average actions_taken.durationMs across the recent window when the
  // writer (graph-stats.ts:407 / save_reasoning_report) recorded one.
  // NULL when no row in the window carries a numeric durationMs.
  avgDurationMs: number | null;
  // The single most recent row's timestamp regardless of mode — convenient
  // for the panel's "last report" badge.
  lastReportAt: string | null;
}

// Cadence query bounds the recent window to keep the snapshot O(N) over a
// fixed cap rather than the whole table. Matches the panel's "recent reports"
// expectation (last 20–100 reports is the useful debug surface).
const CADENCE_WINDOW = 100;

// ============================================
// Helpers
// ============================================

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * actions_taken is freeform JSONB (bead .75 confirmed no canonical shape).
 * The /api/reason handler does not currently write durationMs into the JSONB
 * itself — durationMs ships back to the caller in the HTTP response only.
 * graph-stats.ts:writeGraphStatsReport stores graph_stats anomaly metadata
 * but not a duration. The agent's save_reasoning_report tool may pass
 * `actions_taken.duration_ms` when the python prompt asks for it. We probe
 * both `durationMs` and `duration_ms` keys so legacy + future writers both
 * surface. NULL when neither key is present or the value is non-numeric.
 */
function extractDurationMs(actionsTaken: unknown): number | null {
  if (!actionsTaken || typeof actionsTaken !== 'object') return null;
  const obj = actionsTaken as Record<string, unknown>;
  const candidates = [obj.durationMs, obj.duration_ms];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

/**
 * Shared SELECT clause for the list + by-entity summary endpoints — both
 * return the same row shape. array_length on an empty array yields NULL in
 * Postgres; the row-mapper coerces to 0.
 */
const SUMMARY_SELECT = sql`
  id::text          AS id,
  mode              AS mode,
  question          AS question,
  array_length(entity_ids, 1)      AS entity_count,
  array_length(fact_ids, 1)        AS fact_count,
  array_length(causal_edge_ids, 1) AS causal_edge_count,
  actions_taken     AS actions_taken,
  created_at        AS created_at,
  invocation_id::text AS invocation_id
`;

function rowToSummary(r: Record<string, unknown>): ReasoningReportSummary {
  return {
    id: r.id as string,
    mode: r.mode as 'patrol' | 'query',
    question: (r.question as string | null) ?? null,
    entityCount: (r.entity_count as number | null) ?? 0,
    factCount: (r.fact_count as number | null) ?? 0,
    causalEdgeCount: (r.causal_edge_count as number | null) ?? 0,
    durationMs: extractDurationMs(r.actions_taken),
    createdAt: toIso(r.created_at),
    invocationId: (r.invocation_id as string | null) ?? null,
  };
}

// ============================================
// List endpoint
// ============================================

export async function listReasoningReports(opts: {
  limit?: number;
  mode?: 'patrol' | 'query';
} = {}): Promise<ReasoningReportSummary[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
  // Mode is validated by the HTTP handler before reaching this layer; the
  // SQL guard keeps the path safe even if a future caller skips that.
  const modeFilter = opts.mode === 'patrol' || opts.mode === 'query' ? opts.mode : null;

  const rows = (await db.execute(sql`
    SELECT ${SUMMARY_SELECT}
    FROM public.reasoning_reports
    ${modeFilter ? sql`WHERE mode = ${modeFilter}` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowToSummary);
}

// ============================================
// Single detail endpoint
// ============================================

export async function getReasoningReportById(id: string): Promise<ReasoningReportDetail | null> {
  const rows = (await db.execute(sql`
    SELECT
      id::text          AS id,
      mode              AS mode,
      question          AS question,
      report            AS report,
      entity_ids        AS entity_ids,
      fact_ids          AS fact_ids,
      causal_edge_ids   AS causal_edge_ids,
      actions_taken     AS actions_taken,
      created_at        AS created_at,
      invocation_id::text AS invocation_id
    FROM public.reasoning_reports
    WHERE id = ${id}::uuid
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  const entityIds = Array.isArray(r.entity_ids) ? (r.entity_ids as string[]) : [];
  const factIds = Array.isArray(r.fact_ids) ? (r.fact_ids as string[]) : [];
  const causalEdgeIds = Array.isArray(r.causal_edge_ids) ? (r.causal_edge_ids as string[]) : [];
  return {
    id: r.id as string,
    mode: r.mode as 'patrol' | 'query',
    question: (r.question as string | null) ?? null,
    report: r.report as string,
    entityIds,
    factIds,
    causalEdgeIds,
    actionsTaken: (r.actions_taken ?? {}) as Record<string, unknown>,
    entityCount: entityIds.length,
    factCount: factIds.length,
    causalEdgeCount: causalEdgeIds.length,
    durationMs: extractDurationMs(r.actions_taken),
    createdAt: toIso(r.created_at),
    invocationId: (r.invocation_id as string | null) ?? null,
  };
}

// ============================================
// Entity-filtered list
// ============================================

/**
 * List recent reports whose `entity_ids` contains the given entity. Uses the
 * GIN index `idx_reasoning_reports_entity_ids` (008_reasoning_reports.sql:33)
 * via the `@>` (contains) operator — same access pattern the MCP tool
 * `get_reasoning_history` uses agent-side.
 */
export async function listReasoningReportsByEntity(
  entityId: string,
  opts: { limit?: number } = {},
): Promise<ReasoningReportSummary[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
  const rows = (await db.execute(sql`
    SELECT ${SUMMARY_SELECT}
    FROM public.reasoning_reports
    WHERE entity_ids @> ARRAY[${entityId}::uuid]
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowToSummary);
}

// ============================================
// Cadence summary
// ============================================

/**
 * Cadence over the most recent CADENCE_WINDOW rows. Single-query snapshot so
 * the viz can poll it on the standard 15s cadence without growing cost with
 * the table. Bounded window means avgDurationMs and counts describe "recent
 * behaviour" — exactly the debug signal the panel surfaces.
 */
export async function getReasoningReportCadence(): Promise<ReasoningReportCadence> {
  // One round-trip — pulls the recent window once and aggregates in JS rather
  // than fighting Postgres array_length over the actions_taken JSONB shape.
  const rows = (await db.execute(sql`
    SELECT
      mode          AS mode,
      created_at    AS created_at,
      actions_taken AS actions_taken
    FROM public.reasoning_reports
    ORDER BY created_at DESC
    LIMIT ${CADENCE_WINDOW}
  `)) as unknown as Array<Record<string, unknown>>;

  const now = Date.now();
  let patrolCount = 0;
  let queryCount = 0;
  let lastPatrolAt: Date | null = null;
  let lastQueryAt: Date | null = null;
  let lastReportAt: Date | null = null;
  let durationSum = 0;
  let durationCount = 0;

  for (const r of rows) {
    const mode = r.mode as string;
    const createdAt = r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at));
    if (lastReportAt === null || createdAt > lastReportAt) lastReportAt = createdAt;
    if (mode === 'patrol') {
      patrolCount += 1;
      if (lastPatrolAt === null || createdAt > lastPatrolAt) lastPatrolAt = createdAt;
    } else if (mode === 'query') {
      queryCount += 1;
      if (lastQueryAt === null || createdAt > lastQueryAt) lastQueryAt = createdAt;
    }
    const dur = extractDurationMs(r.actions_taken);
    if (dur !== null) {
      durationSum += dur;
      durationCount += 1;
    }
  }

  return {
    totalReports: rows.length,
    windowSize: CADENCE_WINDOW,
    byMode: { patrol: patrolCount, query: queryCount },
    lastPatrolAt: lastPatrolAt ? lastPatrolAt.toISOString() : null,
    msSinceLastPatrol: lastPatrolAt ? now - lastPatrolAt.getTime() : null,
    lastQueryAt: lastQueryAt ? lastQueryAt.toISOString() : null,
    msSinceLastQuery: lastQueryAt ? now - lastQueryAt.getTime() : null,
    avgDurationMs: durationCount > 0 ? durationSum / durationCount : null,
    lastReportAt: lastReportAt ? lastReportAt.toISOString() : null,
  };
}
