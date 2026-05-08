import { Hono } from 'hono';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, articles, sections, courses } from '../db/index.js';
import { generateArticle, type ArticleGenConcept } from '../agents/article-generator.js';
import { persistArticle } from '../services/article-store.js';
import { getEntityById } from '../services/nmemo-client.js';

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
 * GET /api/articles/by-section/:sectionId
 * Returns articles whose relatedEntityIds intersect the section's
 * conceptEntityIds. Empty array if section not found, has no concepts, or
 * has no overlapping articles. Used by the section page "Synthesis available"
 * affordance (nmemo-3va).
 *
 * NOTE: Mounted BEFORE GET /:id so the literal "by-section" segment doesn't
 * get matched as an article id.
 */
articleRoutes.get('/by-section/:sectionId', async (c) => {
  const sectionId = c.req.param('sectionId');
  const [section] = await db.select().from(sections).where(eq(sections.id, sectionId));
  if (!section) return c.json({ articles: [] });

  let conceptIds: string[] = [];
  try {
    const parsed = JSON.parse(section.conceptEntityIds);
    if (Array.isArray(parsed)) conceptIds = parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* fall through to empty */ }
  if (conceptIds.length === 0) return c.json({ articles: [] });

  // SQLite has no JSON intersect operator at the column level — pull recent
  // articles and filter in JS. Capped at 200 to bound memory; synthesis
  // articles are produced sparingly and 200 covers a long horizon.
  const rows = await db.select().from(articles)
    .orderBy(desc(articles.generatedAt))
    .limit(200);

  const conceptSet = new Set(conceptIds);
  const matching = rows
    .map(shapeArticle)
    .filter(a => a.relatedEntityIds.some(eid => conceptSet.has(eid)));

  return c.json({ articles: matching, sectionId, conceptCount: conceptIds.length });
});

/**
 * POST /api/articles/generate
 * Body: { conceptEntityIds: string[], sectionId?: string, hint?: string }
 *
 * Generates a synthesis article on-demand for the given concept ids and
 * persists it. Used by the "Generate new" button on the section-page
 * synthesis card (nmemo-3va). Concept names are resolved by hitting
 * /api/learn/entity/:id (best-effort — falls back to truncated id).
 *
 * Returns the persisted article on success or { error } on failure.
 * Bounded by article-generator agent's own 90s timeout.
 */
articleRoutes.post('/generate', async (c) => {
  let body: { conceptEntityIds?: unknown; sectionId?: unknown; hint?: unknown } = {};
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === 'object') body = parsed as typeof body;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const ids = Array.isArray(body.conceptEntityIds)
    ? body.conceptEntityIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  if (ids.length === 0) {
    return c.json({ error: 'conceptEntityIds (non-empty string[]) required' }, 400);
  }

  const sectionId = typeof body.sectionId === 'string' ? body.sectionId : null;
  const hint = typeof body.hint === 'string' && body.hint.trim() ? body.hint.trim() : undefined;

  // Hydrate the section's course title so the article's "courseTitle" hint
  // and relatedCourseIds carry it. Also pull all sections that share any
  // concept id so we can record cross-course coverage.
  let primaryCourseId: string | null = null;
  if (sectionId) {
    const [s] = await db.select().from(sections).where(eq(sections.id, sectionId));
    if (s) primaryCourseId = s.courseId;
  }

  // Look up the courses that touch any of these concepts so the relatedCourseIds
  // array is meaningful. Pulls all sections — fine at our scale (<10k rows).
  const allSections = await db.select({
    courseId: sections.courseId,
    conceptEntityIds: sections.conceptEntityIds,
  }).from(sections);
  const idSet = new Set(ids);
  const courseIdSet = new Set<string>();
  for (const s of allSections) {
    let parsed: string[] = [];
    try {
      const v = JSON.parse(s.conceptEntityIds);
      if (Array.isArray(v)) parsed = v.filter((x): x is string => typeof x === 'string');
    } catch { /* skip */ }
    if (parsed.some(eid => idSet.has(eid))) courseIdSet.add(s.courseId);
  }
  if (primaryCourseId) courseIdSet.add(primaryCourseId);

  const courseRows = courseIdSet.size > 0
    ? await db.select().from(courses)
    : [];
  const courseTitleById = new Map(courseRows.map(r => [r.id, r.title] as const));

  // Build concept→course map so each concept can carry its course title
  // through to the article-generator prompt.
  const conceptToCourseId = new Map<string, string>();
  for (const s of allSections) {
    let parsed: string[] = [];
    try {
      const v = JSON.parse(s.conceptEntityIds);
      if (Array.isArray(v)) parsed = v.filter((x): x is string => typeof x === 'string');
    } catch { /* skip */ }
    for (const eid of parsed) {
      if (idSet.has(eid) && !conceptToCourseId.has(eid)) {
        conceptToCourseId.set(eid, s.courseId);
      }
    }
  }

  // Resolve concept names from the platform — best-effort.
  const concepts: ArticleGenConcept[] = await Promise.all(ids.slice(0, 12).map(async (eid) => {
    let name = eid.slice(0, 8);
    try {
      const ent = await getEntityById(eid);
      if (ent?.canonicalName) name = ent.canonicalName;
    } catch { /* fall through */ }
    const courseId = conceptToCourseId.get(eid);
    const courseTitle = courseId ? courseTitleById.get(courseId) : undefined;
    return { entityId: eid, name, courseId, courseTitle } as ArticleGenConcept;
  }));

  const result = await generateArticle({ concepts, hint });
  if (!result.ok) {
    return c.json({ error: result.errorText ?? 'article generation failed' }, 502);
  }

  const persisted = await persistArticle({
    type: 'synthesis',
    title: result.title,
    contentMd: result.contentMd,
    relatedEntityIds: result.conceptEntityIds,
    relatedCourseIds: [...courseIdSet],
  });

  // Round-trip the persisted row so the client gets the canonical shape.
  const [row] = await db.select().from(articles).where(eq(articles.id, persisted.id));
  if (!row) {
    return c.json({ error: 'persistence round-trip failed' }, 500);
  }
  return c.json(shapeArticle(row), 201);
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
