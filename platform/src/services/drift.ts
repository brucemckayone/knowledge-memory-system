/**
 * Drift service (bead nmemo-2yv.88).
 *
 * Phase 3 (doc 24.2) drift read functions, extracted from inline route handlers
 * in index.ts so the SELECT/serialisation logic is testable in isolation and so
 * the auto-trigger plumbing from .84 has a natural home.
 *
 * Mirrors the pattern of `cross-cluster-generator.ts` and `derived-freshness.ts`
 * — pure functions over `db.execute(sql\`...\`)`, no Hono types, no req/res
 * shaping beyond the JSON-friendly DTO.
 *
 * Note: triggerReconciliationDriftAfterCompute is intentionally NOT moved here.
 * It lives in index.ts because (a) its lazy-import seam targets services/
 * causal-agent.js (the existing test-injection point) and (b) bead .88
 * acceptance item 4 only requires triggerCrossClusterAfterCompute to leave
 * index.ts; the drift-reconciliation helper is out of scope.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/** ============================================================
 * /api/drift/events — recent drift events (viz.7).
 *
 * `entityId` optional. When absent, returns the global feed newest-first
 * (powers the bottom-of-canvas timeline strip). When present, scopes to
 * that entity (the entity-scoped detail panel).
 *
 * Limit defaults differ: 10 when scoped, 200 when global. Caller (the route
 * handler) parses + clamps the query-string limit and passes the resolved
 * value here; this function does no clamping of its own.
 * ============================================================ */

export interface DriftEventDTO {
  event_id: string;
  entity_id: string;
  detected_at: string;
  drift_magnitude: number;
  cluster_id_at_detection: number | null;
  target_cluster_id: number | null;
  triggered_action: string;
  reconciliation_run_id: string | null;
  error_detail: string | null;
  computation_version: number;
}

export interface DriftEventsResult {
  entity_id: string | null;
  count: number;
  events: DriftEventDTO[];
}

interface DriftEventRow {
  event_id: string;
  entity_id: string;
  detected_at: Date;
  drift_magnitude: number;
  cluster_id_at_detection: number | null;
  target_cluster_id: number | null;
  triggered_action: string;
  reconciliation_run_id: string | null;
  error_detail: string | null;
  computation_version: number;
}

export async function getDriftEvents(opts: {
  entityId?: string | null;
  limit: number;
}): Promise<DriftEventsResult> {
  const entityId = opts.entityId ?? null;
  const rows = (await db.execute(sql`
    SELECT
      id::text                  AS event_id,
      entity_id::text           AS entity_id,
      detected_at,
      drift_magnitude,
      cluster_id_at_detection,
      target_cluster_id,
      triggered_action,
      reconciliation_run_id,
      error_detail,
      computation_version
    FROM public.entity_drift_events
    WHERE (${entityId}::text IS NULL OR entity_id = ${entityId}::uuid)
    ORDER BY detected_at DESC
    LIMIT ${opts.limit}
  `)) as unknown as DriftEventRow[];

  return {
    entity_id: entityId,
    count: rows.length,
    events: rows.map((r) => ({
      ...r,
      detected_at: r.detected_at instanceof Date ? r.detected_at.toISOString() : String(r.detected_at),
    })),
  };
}

/** ============================================================
 * /api/drift/state/:entityId — per-entity drift state (viz.7).
 *
 * observation_count / last_cluster_id / last_updated_at populate the Drift
 * section in the entity detail panel. Returns null when the entity has no
 * observations; the route handler maps null to `{ state: null }`.
 * ============================================================ */

export interface DriftStateDTO {
  observationCount: number;
  lastClusterId: number | null;
  riverVersion: string;
  lastUpdatedAt: string;
}

interface DriftStateRow {
  observation_count: number;
  last_cluster_id: number | null;
  river_version: string;
  last_updated_at: Date;
}

export async function getDriftState(entityId: string): Promise<DriftStateDTO | null> {
  const rows = (await db.execute(sql`
    SELECT
      observation_count,
      last_cluster_id,
      river_version,
      last_updated_at
    FROM public.entity_drift_state
    WHERE entity_id = ${entityId}::uuid
  `)) as unknown as DriftStateRow[];

  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    observationCount: r.observation_count,
    lastClusterId: r.last_cluster_id,
    riverVersion: r.river_version,
    lastUpdatedAt: r.last_updated_at instanceof Date ? r.last_updated_at.toISOString() : String(r.last_updated_at),
  };
}
