/**
 * Insight lifecycle (nmemo-fv9)
 *
 * Per-type TTL + helpers shared between routes, dashboard, and the
 * write_insight MCP tool. Pure functions — no DB access.
 */

export const INSIGHT_TTL_DAYS: Record<string, number> = {
  decay_warning: 14,
  cross_course_link: 21,
  synthesis_candidate: 21,
  prerequisite_gap: 14,
  contradiction_detected: 14,
  pattern_emerging: 21,
};

/** Default TTL for insight types not in the table above. */
export const DEFAULT_INSIGHT_TTL_DAYS = 14;

export type DismissalKind = 'dismissed' | 'snoozed' | 'auto_expired';

export interface InsightLifecycleRow {
  type: string;
  createdAt: string;
  dismissalKind: string | null;
  snoozedUntil: string | null;
}

export function ttlForType(type: string): number {
  return INSIGHT_TTL_DAYS[type] ?? DEFAULT_INSIGHT_TTL_DAYS;
}

/**
 * True iff the insight is past its per-type TTL relative to `now`.
 * Auto-expiry is independent of dismissal — even an active insight is
 * "expired" once createdAt + TTL < now.
 */
export function isExpired(row: InsightLifecycleRow, now: Date = new Date()): boolean {
  const created = Date.parse(row.createdAt);
  if (!Number.isFinite(created)) return false;
  const ttlMs = ttlForType(row.type) * 24 * 60 * 60 * 1000;
  return created + ttlMs < now.getTime();
}

/**
 * True iff the insight is currently snoozed (snoozedUntil > now and kind matches).
 * Returns false for expired snoozes — those are eligible for re-emit.
 */
export function isCurrentlySnoozed(row: InsightLifecycleRow, now: Date = new Date()): boolean {
  if (row.dismissalKind !== 'snoozed') return false;
  if (!row.snoozedUntil) return false;
  const until = Date.parse(row.snoozedUntil);
  if (!Number.isFinite(until)) return false;
  return until > now.getTime();
}

/**
 * Return whether a row should be visible on the dashboard / insights list.
 * Hidden when:
 *   - dismissalKind = 'dismissed' (forever)
 *   - dismissalKind = 'auto_expired' (legacy or pre-marked)
 *   - dismissalKind = 'snoozed' AND snoozedUntil > now
 *   - createdAt + TTL[type] < now (auto-expired)
 */
export function isVisible(row: InsightLifecycleRow, now: Date = new Date()): boolean {
  if (row.dismissalKind === 'dismissed') return false;
  if (row.dismissalKind === 'auto_expired') return false;
  if (isCurrentlySnoozed(row, now)) return false;
  if (isExpired(row, now)) return false;
  return true;
}

/** Clamp a number into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export const JUDGEMENT_MIN = 0.5;
export const JUDGEMENT_MAX = 1.5;

/**
 * Hybrid importance: deterministic baseline scaled by agent judgment.
 * Multiplier is clamped to [0.5, 1.5]; result is clamped to [0, 1].
 */
export function hybridImportance(deterministic: number, judgement: number = 1.0): number {
  const det = clamp(deterministic, 0, 1);
  const judged = clamp(judgement, JUDGEMENT_MIN, JUDGEMENT_MAX);
  return clamp(det * judged, 0, 1);
}

/**
 * Decide whether to insert a fresh insight row given the most-recent existing
 * row (if any) with the same idempotency_key. Pure function so the policy is
 * unit-testable without a database.
 *
 * Outcome semantics:
 *   - 'insert' — no existing row; insert a fresh one.
 *   - 'block_dismissed' — existing dismissed-forever row; do not insert.
 *   - 'block_snoozed' — existing snoozed row, snooze still active; do not insert.
 *   - 'block_duplicate' — existing active row (no dismissal, no expiry); dedup.
 *   - 'reinsert_after_snooze' — existing snoozed row, snooze expired; insert fresh.
 *   - 'reinsert_after_expired' — existing auto_expired row; insert fresh.
 *   - 'reinsert_after_ttl' — no dismissal but past per-type TTL; insert fresh.
 */
export type InsertDecision =
  | 'insert'
  | 'block_dismissed'
  | 'block_snoozed'
  | 'block_duplicate'
  | 'reinsert_after_snooze'
  | 'reinsert_after_expired'
  | 'reinsert_after_ttl';

export function decideInsert(
  existing: InsightLifecycleRow | null | undefined,
  now: Date = new Date(),
): InsertDecision {
  if (!existing) return 'insert';
  if (existing.dismissalKind === 'dismissed') return 'block_dismissed';
  if (existing.dismissalKind === 'auto_expired') return 'reinsert_after_expired';
  if (existing.dismissalKind === 'snoozed') {
    return isCurrentlySnoozed(existing, now) ? 'block_snoozed' : 'reinsert_after_snooze';
  }
  // No dismissalKind — check expiry.
  if (isExpired(existing, now)) return 'reinsert_after_ttl';
  return 'block_duplicate';
}
