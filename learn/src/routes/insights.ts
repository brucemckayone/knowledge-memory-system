import { Hono } from 'hono';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, insights } from '../db/index.js';
import { isVisible } from '../services/insight-lifecycle.js';

export const insightRoutes = new Hono();

type InsightRow = typeof insights.$inferSelect;

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function shapeInsight(row: InsightRow) {
  return {
    ...row,
    relatedEntityIds: parseJsonArray(row.relatedEntityIds),
    relatedCourseIds: parseJsonArray(row.relatedCourseIds),
    relatedFactIds: parseJsonArray(row.relatedFactIds),
    relatedSectionIds: parseJsonArray(row.relatedSectionIds),
  };
}

/**
 * GET /api/insights
 * Query: limit (default 20, max 100), offset (default 0), type,
 *        include_dismissed, include_viewed, include_expired, include_snoozed
 * Defaults: exclude dismissed, exclude auto-expired, exclude currently snoozed,
 *           include viewed.
 * Order: importance DESC, created_at DESC.
 */
insightRoutes.get('/', async (c) => {
  const limitRaw = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 100);
  const offsetRaw = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);
  const type = c.req.query('type');
  const includeDismissed = c.req.query('include_dismissed') === 'true';
  const includeViewed = c.req.query('include_viewed') !== 'false';      // default true
  const includeExpired = c.req.query('include_expired') === 'true';
  const includeSnoozed = c.req.query('include_snoozed') === 'true';

  // Coarse SQL filters; per-type TTL + snooze-window filters happen in app code
  // (see isVisible) so we never push date-arithmetic across the JS/SQL boundary.
  const conds = [] as ReturnType<typeof eq>[];
  if (!includeDismissed) conds.push(isNull(insights.dismissedAt));
  if (!includeViewed) conds.push(isNull(insights.viewedAt));
  if (type) conds.push(eq(insights.type, type));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const rows = await db.select().from(insights)
    .where(where)
    .orderBy(desc(insights.importance), desc(insights.createdAt));

  const now = new Date();
  const filtered = rows.filter(r => {
    const lc = {
      type: r.type,
      createdAt: r.createdAt,
      dismissalKind: r.dismissalKind,
      snoozedUntil: r.snoozedUntil,
    };
    if (!includeDismissed && (r.dismissalKind === 'dismissed' || r.dismissalKind === 'auto_expired')) {
      return false;
    }
    if (!includeSnoozed && r.dismissalKind === 'snoozed') {
      const until = r.snoozedUntil ? Date.parse(r.snoozedUntil) : NaN;
      if (Number.isFinite(until) && until > now.getTime()) return false;
    }
    if (!includeExpired) {
      // Drop rows past their per-type TTL even if not explicitly dismissed.
      // isVisible would also reject dismissed/snoozed, but we've handled those
      // above with their dedicated flags — short-circuit by checking expiry alone.
      const ttlVisible = isVisible({ ...lc, dismissalKind: null, snoozedUntil: null }, now);
      if (!ttlVisible) return false;
    }
    return true;
  });

  const paged = filtered.slice(offset, offset + limit);
  return c.json({
    insights: paged.map(shapeInsight),
    total: filtered.length,
    limit,
    offset,
  });
});

/**
 * POST /api/insights/:id/dismiss
 * Body (optional): { kind?: 'dismiss_forever' | 'snooze_7d' | 'snooze_30d' }
 * Default kind: 'dismiss_forever' (back-compat).
 * Sets dismissalKind + (for snooze) snoozedUntil.
 */
insightRoutes.post('/:id/dismiss', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db.select().from(insights).where(eq(insights.id, id));
  if (!existing) return c.json({ error: 'Insight not found' }, 404);

  let body: Record<string, unknown> = {};
  try { body = await c.req.json() as Record<string, unknown>; } catch { /* allow empty body */ }
  const queryKind = c.req.query('kind');
  const bodyKind = typeof body.kind === 'string' ? body.kind : undefined;
  const kind = bodyKind ?? queryKind ?? 'dismiss_forever';

  const now = new Date();
  const dismissedAt = now.toISOString();
  if (kind === 'snooze_7d' || kind === 'snooze_30d') {
    const days = kind === 'snooze_7d' ? 7 : 30;
    const snoozedUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    await db.update(insights)
      .set({ dismissalKind: 'snoozed', snoozedUntil, dismissedAt })
      .where(eq(insights.id, id));
    return c.json({ ok: true, id, kind, dismissalKind: 'snoozed', snoozedUntil });
  }

  // dismiss_forever
  await db.update(insights)
    .set({ dismissalKind: 'dismissed', dismissedAt, snoozedUntil: null })
    .where(eq(insights.id, id));
  return c.json({ ok: true, id, kind: 'dismiss_forever', dismissalKind: 'dismissed', dismissedAt });
});

/**
 * POST /api/insights/:id/snooze
 * Body: { days: number } — convenience snooze endpoint. Sets snoozedUntil = now + days.
 */
insightRoutes.post('/:id/snooze', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db.select().from(insights).where(eq(insights.id, id));
  if (!existing) return c.json({ error: 'Insight not found' }, 404);

  let body: Record<string, unknown> = {};
  try { body = await c.req.json() as Record<string, unknown>; } catch { /* */ }
  const days = typeof body.days === 'number' ? body.days : 7;
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    return c.json({ error: 'days must be 1..365' }, 400);
  }
  const now = new Date();
  const snoozedUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  await db.update(insights)
    .set({ dismissalKind: 'snoozed', snoozedUntil, dismissedAt: now.toISOString() })
    .where(eq(insights.id, id));
  return c.json({ ok: true, id, dismissalKind: 'snoozed', snoozedUntil });
});

/** POST /api/insights/:id/viewed — set viewed_at = now() only if currently null (idempotent). */
insightRoutes.post('/:id/viewed', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db.select().from(insights).where(eq(insights.id, id));
  if (!existing) return c.json({ error: 'Insight not found' }, 404);

  if (existing.viewedAt) {
    return c.json({ ok: true, id, viewedAt: existing.viewedAt });
  }

  const viewedAt = new Date().toISOString();
  await db.update(insights)
    .set({ viewedAt })
    .where(and(eq(insights.id, id), isNull(insights.viewedAt)));

  // Re-read in case a concurrent call beat us — return the persisted value.
  const [after] = await db.select({ viewedAt: insights.viewedAt }).from(insights).where(eq(insights.id, id));
  return c.json({ ok: true, id, viewedAt: after?.viewedAt ?? viewedAt });
});
