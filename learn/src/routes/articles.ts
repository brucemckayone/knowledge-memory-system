import { Hono } from 'hono';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, articles } from '../db/index.js';

export const articleRoutes = new Hono();

type ArticleRow = typeof articles.$inferSelect;

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function shapeArticle(row: ArticleRow) {
  return {
    ...row,
    relatedEntityIds: parseJsonArray(row.relatedEntityIds),
    relatedCourseIds: parseJsonArray(row.relatedCourseIds),
  };
}

/**
 * GET /api/articles
 * Query: type ('synthesis' | 'cross_course_summary'; optional), limit (default 20, max 100), offset (default 0)
 * Order: generated_at DESC.
 */
articleRoutes.get('/', async (c) => {
  const limitRaw = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 100);
  const offsetRaw = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);
  const type = c.req.query('type');

  const where = type ? eq(articles.type, type) : undefined;

  const rows = await db.select().from(articles)
    .where(where)
    .orderBy(desc(articles.generatedAt))
    .limit(limit)
    .offset(offset);

  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)` })
    .from(articles)
    .where(where);

  return c.json({
    articles: rows.map(shapeArticle),
    total: Number(total),
    limit,
    offset,
  });
});

/**
 * GET /api/articles/:id — single fetch.
 * Sets viewed_at = now() if currently null (idempotent — same pattern as insights).
 * 404 if not found.
 */
articleRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db.select().from(articles).where(eq(articles.id, id));
  if (!existing) return c.json({ error: 'Article not found' }, 404);

  if (existing.viewedAt) {
    return c.json(shapeArticle(existing));
  }

  const viewedAt = new Date().toISOString();
  await db.update(articles)
    .set({ viewedAt })
    .where(and(eq(articles.id, id), isNull(articles.viewedAt)));

  // Re-read so we return the persisted value (handles concurrent calls).
  const [after] = await db.select().from(articles).where(eq(articles.id, id));
  return c.json(shapeArticle(after ?? { ...existing, viewedAt }));
});
