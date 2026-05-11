import { Hono } from 'hono';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, insights } from '../db/index.js';

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
 * Query: limit (default 20, max 100), offset (default 0), type, include_dismissed, include_viewed
 * Defaults: exclude dismissed, include viewed.
 * Order: importance DESC, created_at DESC.
 */
insightRoutes.get('/', async (c) => {
  const limitRaw = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 100);
  const offsetRaw = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);
  const type = c.req.query('type');
  const includeDismissed = c.req.query('include_dismissed') === 'true';
  const includeViewed = c.req.query('include_viewed') !== 'false'; // default true

  const conds = [] as ReturnType<typeof eq>[];
  if (!includeDismissed) conds.push(isNull(insights.dismissedAt));
  if (!includeViewed) conds.push(isNull(insights.viewedAt));
  if (type) conds.push(eq(insights.type, type));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const rows = await db.select().from(insights)
    .where(where)
    .orderBy(desc(insights.importance), desc(insights.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)` })
    .from(insights)
    .where(where);

  return c.json({
    insights: rows.map(shapeInsight),
    total: Number(total),
    limit,
    offset,
  });
});

/** POST /api/insights/:id/dismiss — set dismissed_at = now(). 404 if missing. */
insightRoutes.post('/:id/dismiss', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db.select().from(insights).where(eq(insights.id, id));
  if (!existing) return c.json({ error: 'Insight not found' }, 404);

  const dismissedAt = new Date().toISOString();
  await db.update(insights).set({ dismissedAt }).where(eq(insights.id, id));
  return c.json({ ok: true, id, dismissedAt });
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
