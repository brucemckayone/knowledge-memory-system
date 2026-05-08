/**
 * Gap persistence (nmemo-7b3)
 *
 * Persists gap-analyzer results into the existing `insights` table with
 * `type='gap_analysis'`. Reuses the patrol+insights idempotency machinery
 * (nmemo-fv9) — the idempotency key is sha256("gap_analysis|<rootEntityId>")
 * so re-running the analyzer for the same root cause does NOT create a
 * duplicate row when a non-dismissed, non-expired record already exists.
 *
 * Read path: `getTopGap()` returns the highest-importance, currently
 * visible gap insight (lifecycle filter applied). Used by the dashboard
 * composite endpoint and the section-page inline card.
 *
 * Cache: callers decide whether to trigger a fresh analyzer run; this
 * module only persists and reads. Soft-cache TTL is enforced at the
 * route layer.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, insights } from '../db/index.js';
import { decideInsert, isVisible, hybridImportance } from './insight-lifecycle.js';
import type { GapAnalysisResult } from '../agents/gap-analyzer.js';

export const GAP_INSIGHT_TYPE = 'gap_analysis';

/** Soft-cache TTL for gap-analyzer reruns. The patrol-insight TTL governs
 *  visibility (default 14d for unknown types); this cache is a much shorter
 *  window that decides whether the dashboard should kick a fresh run. */
export const GAP_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Minimum learner-fact count before the gap-analyzer is meaningful. Below
 *  this threshold the dashboard surfaces the "complete a quiz" affordance
 *  instead of running the analyzer. */
export const GAP_COLD_START_FACT_THRESHOLD = 10;

/** A gap insight as exposed to the dashboard / section page. Same shape as
 *  DashboardInsight but typed for the gap-specific consumers. */
export interface PersistedGap {
  id: string;
  title: string;
  contentMd: string;
  importance: number;
  rootCauseEntityId: string | null;
  rootCauseConceptName: string;
  whyItMatters: string;
  rootCauseReason: string;
  createdAt: string;
}

export interface PersistGapInput {
  result: GapAnalysisResult;
  /** The Nmemo entity id of the root-cause concept, when known. Used as the
   *  idempotency key — when the analyzer can't resolve a concrete entity id
   *  we fall back to a hash of the target concept name. */
  rootCauseEntityId?: string | null;
}

export interface PersistGapOutput {
  inserted: boolean;
  id: string;
  reason?: 'duplicate' | 'snoozed' | 'dismissed_forever' | 'race';
}

/** Build the idempotency key for a gap insight. Prefers the entity id;
 *  falls back to a hash of the target concept name when no id is known. */
export function gapIdempotencyKey(rootCauseEntityId: string | null | undefined, fallbackTargetConcept: string): string {
  const id = rootCauseEntityId && rootCauseEntityId.length > 0
    ? rootCauseEntityId
    : `name:${fallbackTargetConcept.trim().toLowerCase()}`;
  return createHash('sha256').update(`${GAP_INSIGHT_TYPE}|${id}`).digest('hex');
}

/** Compose the markdown body the dashboard / section card renders. */
export function renderGapContentMd(result: GapAnalysisResult): string {
  const lines = [
    `**Root cause:** ${result.rootCause}`,
    '',
    `**Why this matters:** ${result.whyItMatters}`,
    '',
    `**Next steps:** ${result.nextSteps}`,
  ];
  return lines.join('\n');
}

/**
 * Persist a gap-analyzer result. Returns `{ inserted: false, reason }` when
 * the existing row blocks reinsertion (active duplicate / snoozed / dismissed).
 */
export async function persistGap(input: PersistGapInput): Promise<PersistGapOutput> {
  const { result, rootCauseEntityId } = input;
  const idempotencyKey = gapIdempotencyKey(rootCauseEntityId ?? null, result.targetConcept);

  const sortedIds: string[] = rootCauseEntityId ? [rootCauseEntityId] : [];

  // Reuse the same lifecycle decision tree the MCP write_insight tool uses.
  const existingRows = await db.select()
    .from(insights)
    .where(eq(insights.idempotencyKey, idempotencyKey));

  const now = new Date();
  const existing = existingRows.length > 0
    ? [...existingRows].sort((a, b) =>
        (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]!
    : null;
  const decision = decideInsert(existing, now);

  if (decision === 'block_dismissed') {
    return { inserted: false, id: existing!.id, reason: 'dismissed_forever' };
  }
  if (decision === 'block_snoozed') {
    return { inserted: false, id: existing!.id, reason: 'snoozed' };
  }
  if (decision === 'block_duplicate') {
    return { inserted: false, id: existing!.id, reason: 'duplicate' };
  }
  // Reinsert paths: free up the unique index by moving the old row's
  // idempotency_key aside.
  if (existing && decision !== 'insert') {
    const newKindForOld = decision === 'reinsert_after_ttl'
      ? 'auto_expired'
      : existing.dismissalKind;
    await db.update(insights)
      .set({
        idempotencyKey: `${idempotencyKey}#superseded-${existing.id}`,
        dismissalKind: newKindForOld,
      })
      .where(eq(insights.id, existing.id));
  }

  const id = randomUUID();
  const deterministicImportance = 0.7;          // gap insights are high-signal by construction
  const importance = hybridImportance(deterministicImportance, 1.0);
  const title = `Gap: ${result.targetConcept}`;
  const contentMd = renderGapContentMd(result);

  try {
    await db.insert(insights).values({
      id,
      type: GAP_INSIGHT_TYPE,
      title,
      contentMd,
      importance,
      deterministicImportance,
      relatedEntityIds: JSON.stringify(sortedIds),
      relatedCourseIds: JSON.stringify([]),
      relatedFactIds: JSON.stringify([]),
      relatedSectionIds: JSON.stringify([]),
      actionableUrl: null,
      idempotencyKey,
    });
    return { inserted: true, id };
  } catch (err) {
    // Race: another writer beat us between SELECT and INSERT. Re-read.
    const row = await db.select({ id: insights.id })
      .from(insights)
      .where(eq(insights.idempotencyKey, idempotencyKey))
      .limit(1);
    if (row[0]) return { inserted: false, id: row[0].id, reason: 'race' };
    throw err;
  }
}

/**
 * Read the highest-importance currently-visible gap insight. Returns null
 * when no visible gap exists. Lifecycle filter (TTL + snooze + dismissal)
 * is applied in app code via `isVisible`.
 */
export async function getTopGap(): Promise<PersistedGap | null> {
  const rows = await db.select().from(insights)
    .where(and(
      eq(insights.type, GAP_INSIGHT_TYPE),
      isNull(insights.dismissedAt),
    ))
    .orderBy(desc(insights.importance), desc(insights.createdAt))
    .limit(20);

  const now = new Date();
  const visible = rows.filter(r => isVisible({
    type: r.type,
    createdAt: r.createdAt,
    dismissalKind: r.dismissalKind,
    snoozedUntil: r.snoozedUntil,
  }, now));
  if (visible.length === 0) return null;

  const top = visible[0]!;
  return projectGap(top);
}

/** Project a gap insight row to a `PersistedGap`. Exported for the
 *  section-page card path (which needs to look up gaps by entity id). */
function projectGap(row: typeof insights.$inferSelect): PersistedGap {
  let rootCauseEntityId: string | null = null;
  try {
    const parsed = JSON.parse(row.relatedEntityIds);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') rootCauseEntityId = parsed[0];
  } catch { /* defensive */ }

  // Best-effort: parse the markdown body back into structured fields. The
  // markdown shape is fixed by `renderGapContentMd` so a regex pull is safe.
  const contentMd = row.contentMd;
  const rootCauseReason = matchAfter(contentMd, '**Root cause:**') ?? '';
  const whyItMatters = matchAfter(contentMd, '**Why this matters:**') ?? '';
  const rootCauseConceptName = row.title.replace(/^Gap:\s*/, '').trim();

  return {
    id: row.id,
    title: row.title,
    contentMd: row.contentMd,
    importance: row.importance,
    rootCauseEntityId,
    rootCauseConceptName,
    whyItMatters,
    rootCauseReason,
    createdAt: row.createdAt,
  };
}

function matchAfter(s: string, marker: string): string | null {
  const idx = s.indexOf(marker);
  if (idx < 0) return null;
  const rest = s.slice(idx + marker.length);
  const lineEnd = rest.indexOf('\n');
  const slice = lineEnd >= 0 ? rest.slice(0, lineEnd) : rest;
  return slice.trim() || null;
}

/**
 * True when the most-recent `gap_analysis` insight (visible or otherwise)
 * is younger than `GAP_CACHE_TTL_MS`. Callers use this to decide whether
 * a fresh analyzer run is warranted on the dashboard fetch path.
 */
export async function isCachedGapFresh(now: Date = new Date()): Promise<boolean> {
  const [row] = await db.select({ createdAt: insights.createdAt })
    .from(insights)
    .where(eq(insights.type, GAP_INSIGHT_TYPE))
    .orderBy(desc(insights.createdAt))
    .limit(1);
  if (!row) return false;
  const created = Date.parse(row.createdAt);
  if (!Number.isFinite(created)) return false;
  return (now.getTime() - created) < GAP_CACHE_TTL_MS;
}

/** Pure helper used in tests + routes — checks fact count against the
 *  cold-start threshold. Caller passes the count. */
export function isBelowGapColdStart(factCount: number): boolean {
  return factCount < GAP_COLD_START_FACT_THRESHOLD;
}

// Internal helpers exposed for unit-style testing.
export const __test = { gapIdempotencyKey, renderGapContentMd, projectGap, matchAfter };

// Touch the noop import so tsc keeps the sql tag for future migrations.
void sql;
