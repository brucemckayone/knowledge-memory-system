import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db, sections, questions, quizAttempts, courses } from '../db/index.js';
import { generateLessonAuto, type LessonStage } from '../agents/lesson-generator.js';

export const sectionRoutes = new Hono();

/**
 * GET /api/sections/:id
 * Returns section detail including parsed learningObjectives, lesson fields,
 * and questions with attempt stats (best score + count).
 */
sectionRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const [section] = await db.select().from(sections).where(eq(sections.id, id));
  if (!section) return c.json({ error: 'Section not found' }, 404);

  const [course] = await db.select().from(courses).where(eq(courses.id, section.courseId));

  const qs = await db.select().from(questions)
    .where(eq(questions.sectionId, id))
    .orderBy(questions.createdAt);

  // For each question, fetch attempts and compute best score + attempt count
  const questionsWithStats = await Promise.all(qs.map(async q => {
    const attempts = await db.select({ score: quizAttempts.score })
      .from(quizAttempts)
      .where(eq(quizAttempts.questionId, q.id))
      .orderBy(desc(quizAttempts.createdAt));
    const bestScore = attempts.length === 0
      ? null
      : attempts.reduce((best, a) => Math.max(best, a.score ?? 0), 0);
    return { ...q, bestScore, attemptCount: attempts.length };
  }));

  return c.json({
    ...section,
    learningObjectives: JSON.parse(section.learningObjectives) as string[],
    conceptEntityIds: JSON.parse(section.conceptEntityIds) as string[],
    lessonKeyTakeaways: section.lessonKeyTakeaways
      ? (JSON.parse(section.lessonKeyTakeaways) as string[])
      : null,
    // lessonBlocks is the raw JSON string; the renderer parses it. Keep as-is for backwards-compat with v0.1 clients.
    courseTitle: course?.title ?? null,
    questions: questionsWithStats,
  });
});

/**
 * Build the JSON status payload polled by the UI. Centralised here so the
 * POST and GET endpoints emit the exact same shape.
 */
interface LessonStatusPayload {
  status: 'idle' | 'building' | 'ready' | 'error';
  stage: LessonStage | null;
  startedAt: string | null;
  elapsedMs: number | null;
  error: string | null;
  hasBody: boolean;
  generatedAt: string | null;
}

function buildLessonStatusPayload(section: typeof sections.$inferSelect): LessonStatusPayload {
  const hasBody = Boolean(section.lessonBlocks || section.lessonContent);
  let status: LessonStatusPayload['status'];
  if (section.lessonStatus === 'building') status = 'building';
  else if (section.lessonStatus === 'error') status = 'error';
  else if (hasBody) status = 'ready';
  else status = 'idle';
  const startedAt = section.lessonStartedAt;
  const elapsedMs = startedAt ? Date.now() - new Date(startedAt).getTime() : null;
  return {
    status,
    stage: (section.lessonStage as LessonStage | null) ?? null,
    startedAt,
    elapsedMs,
    error: section.lessonError,
    hasBody,
    generatedAt: section.lessonGeneratedAt,
  };
}

/**
 * GET /api/sections/:id/lesson/status
 * Cheap status read for client-side polling during async generation.
 * Returns { status, stage, startedAt, elapsedMs, error, hasBody, generatedAt }.
 */
sectionRoutes.get('/:id/lesson/status', async (c) => {
  const id = c.req.param('id');
  const [section] = await db.select().from(sections).where(eq(sections.id, id));
  if (!section) return c.json({ error: 'Section not found' }, 404);
  return c.json(buildLessonStatusPayload(section));
});

/**
 * POST /api/sections/:id/lesson
 *
 * Asynchronous: kicks off generation if needed, returns immediately.
 *
 *  - If a generation is already in flight (lesson_status='building'), returns
 *    202 with the current status payload. No double-kick.
 *  - If a lesson body already exists and ?regenerate is not set, returns 200
 *    with status='ready' (cached path, no agent invocation).
 *  - Otherwise: clears prior status, sets lesson_status='building', spawns
 *    generateLessonAuto in the background with stage callbacks, returns 202
 *    with the freshly initialised status payload.
 *
 * The actual lesson body is written by the background task on completion.
 * Clients poll GET /api/sections/:id/lesson/status to track progress, then
 * GET /api/sections/:id when status='ready' to fetch the rendered lesson.
 */
sectionRoutes.post('/:id/lesson', async (c) => {
  const id = c.req.param('id');
  const regenerate = c.req.query('regenerate') === 'true';

  const [section] = await db.select().from(sections).where(eq(sections.id, id));
  if (!section) return c.json({ error: 'Section not found' }, 404);

  // Already generating — never kick a second pipeline. Return current status.
  if (section.lessonStatus === 'building') {
    return c.json(buildLessonStatusPayload(section), 202);
  }

  // Cache hit — lesson body present and caller didn't ask for regen.
  const hasBody = Boolean(section.lessonBlocks || section.lessonContent);
  if (hasBody && !regenerate) {
    return c.json({
      ...buildLessonStatusPayload(section),
      cached: true,
    });
  }

  // Kick off a fresh generation. Mark the row 'building' synchronously so a
  // duplicate POST that races us is short-circuited above.
  const startedAt = new Date().toISOString();
  await db.update(sections).set({
    lessonStatus: 'building',
    lessonStage: 'outlining',
    lessonStartedAt: startedAt,
    lessonError: null,
  }).where(eq(sections.id, id));

  // Stage callback — best-effort DB write at each phase transition. Failures
  // here are logged but never abort the generator.
  const onStage = async (stage: LessonStage): Promise<void> => {
    try {
      await db.update(sections).set({ lessonStage: stage }).where(eq(sections.id, id));
    } catch (err) {
      console.warn(`[lesson] stage update for ${id} (${stage}) failed:`, err);
    }
  };

  // Fire-and-forget. Errors land in the catch which writes 'error' status.
  void (async () => {
    try {
      const lesson = await generateLessonAuto(id, { onStage });
      const generatedAt = new Date().toISOString();
      if (lesson.format === 'structured') {
        await db.update(sections).set({
          lessonBlocks: JSON.stringify(lesson.blocks),
          lessonGeneratedAt: generatedAt,
          lessonReadMinutes: lesson.estimatedReadMinutes,
          lessonKeyTakeaways: JSON.stringify(lesson.keyTakeaways),
          lessonStatus: 'ready',
          lessonStage: null,
          lessonError: null,
        }).where(eq(sections.id, id));
      } else {
        await db.update(sections).set({
          lessonContent: lesson.content,
          lessonGeneratedAt: generatedAt,
          lessonReadMinutes: lesson.estimatedReadMinutes,
          lessonKeyTakeaways: JSON.stringify(lesson.keyTakeaways),
          lessonStatus: 'ready',
          lessonStage: null,
          lessonError: null,
        }).where(eq(sections.id, id));
      }
      console.log(`[lesson] section ${id} ready`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[lesson] section ${id} failed:`, msg);
      await db.update(sections).set({
        lessonStatus: 'error',
        lessonStage: null,
        lessonError: msg.slice(0, 4000),
      }).where(eq(sections.id, id));
    }
  })();

  // Re-read so the response reflects the row we just wrote (cheap — same row).
  const [fresh] = await db.select().from(sections).where(eq(sections.id, id));
  return c.json(buildLessonStatusPayload(fresh!), 202);
});
