import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { db, courses, sections, questions } from '../db/index.js';
import { eq, desc } from 'drizzle-orm';
import { generateCourse } from '../agents/course-generator.js';
import { relinkCourseConcepts } from '../services/relink-concepts.js';

export const courseRoutes = new Hono();

courseRoutes.get('/', async (c) => {
  const rows = await db.select().from(courses).orderBy(desc(courses.createdAt));
  return c.json(rows);
});

courseRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const [course] = await db.select().from(courses).where(eq(courses.id, id));
  if (!course) return c.json({ error: 'Not found' }, 404);

  const secs = await db.select().from(sections)
    .where(eq(sections.courseId, id))
    .orderBy(sections.orderIndex);

  const result = [];
  for (const sec of secs) {
    const qs = await db.select().from(questions).where(eq(questions.sectionId, sec.id));
    result.push({
      ...sec,
      learningObjectives: JSON.parse(sec.learningObjectives) as string[],
      conceptEntityIds: JSON.parse(sec.conceptEntityIds) as string[],
      questions: qs,
    });
  }

  return c.json({ ...course, sections: result });
});

courseRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    topic: string;
    sourceType?: 'generated' | 'paste';
    sourceText?: string;
    presentationMode?: boolean;
  }>();

  if (!body.topic) return c.json({ error: 'topic is required' }, 400);

  const sourceType = body.sourceType ?? 'generated';
  const presentationMode = Boolean(body.presentationMode);

  // Create a placeholder row immediately so the UI can poll for status
  const courseId = randomUUID();
  await db.insert(courses).values({
    id: courseId,
    title: `${body.topic} — Building...`,
    description: null,
    topic: body.topic,
    sourceType,
    sourceText: body.sourceText ?? null,
    status: 'building',
    presentationMode: presentationMode ? 1 : 0,
  });

  // Run generation asynchronously — client polls /api/courses/:id
  generateCourse({
    courseId,
    topic: body.topic,
    sourceType,
    sourceText: body.sourceText,
    presentationMode,
  }).then(() => {
    console.log(`[course-gen] course ${courseId} ready`);
  }).catch(err => {
    console.error(`[course-gen] course ${courseId} failed:`, err);
    void db.update(courses).set({ status: 'error' }).where(eq(courses.id, courseId));
  });

  return c.json({ courseId, status: 'building' }, 202);
});

courseRoutes.post('/:id/relink-concepts', async (c) => {
  const id = c.req.param('id');
  const [course] = await db.select().from(courses).where(eq(courses.id, id));
  if (!course) return c.json({ error: 'Not found' }, 404);
  try {
    const result = await relinkCourseConcepts(id);
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 502);
  }
});

courseRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete(courses).where(eq(courses.id, id));
  return c.json({ deleted: true });
});
