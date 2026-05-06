import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db, sections, questions, quizAttempts, courses } from '../db/index.js';
import { generateLessonAuto } from '../agents/lesson-generator.js';

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
 * POST /api/sections/:id/lesson
 * Generates a lesson for the section via the lesson agent and stores it.
 * Idempotent unless ?regenerate=true — if a lesson already exists and
 * regenerate is not set, returns the stored content unchanged.
 */
sectionRoutes.post('/:id/lesson', async (c) => {
  const id = c.req.param('id');
  const regenerate = c.req.query('regenerate') === 'true';

  const [section] = await db.select().from(sections).where(eq(sections.id, id));
  if (!section) return c.json({ error: 'Section not found' }, 404);

  // Cache hit if either format already exists. Renderer prefers blocks; falls back to content.
  if ((section.lessonBlocks || section.lessonContent) && !regenerate) {
    return c.json({
      content: section.lessonContent,
      blocks: section.lessonBlocks ? (JSON.parse(section.lessonBlocks) as unknown[]) : null,
      estimatedReadMinutes: section.lessonReadMinutes,
      keyTakeaways: section.lessonKeyTakeaways
        ? (JSON.parse(section.lessonKeyTakeaways) as string[])
        : [],
      generatedAt: section.lessonGeneratedAt,
      cached: true,
    });
  }

  let lesson;
  try {
    lesson = await generateLessonAuto(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Lesson generation failed: ${msg}` }, 500);
  }

  const generatedAt = new Date().toISOString();
  // Structured mode writes lesson_blocks and leaves lesson_content untouched
  // (callers can keep an old markdown copy for fallback). Markdown mode writes
  // lesson_content as before.
  if (lesson.format === 'structured') {
    await db.update(sections).set({
      lessonBlocks: JSON.stringify(lesson.blocks),
      lessonGeneratedAt: generatedAt,
      lessonReadMinutes: lesson.estimatedReadMinutes,
      lessonKeyTakeaways: JSON.stringify(lesson.keyTakeaways),
    }).where(eq(sections.id, id));
    return c.json({
      blocks: lesson.blocks,
      estimatedReadMinutes: lesson.estimatedReadMinutes,
      keyTakeaways: lesson.keyTakeaways,
      generatedAt,
      cached: false,
    });
  }

  await db.update(sections).set({
    lessonContent: lesson.content,
    lessonGeneratedAt: generatedAt,
    lessonReadMinutes: lesson.estimatedReadMinutes,
    lessonKeyTakeaways: JSON.stringify(lesson.keyTakeaways),
  }).where(eq(sections.id, id));

  return c.json({
    content: lesson.content,
    estimatedReadMinutes: lesson.estimatedReadMinutes,
    keyTakeaways: lesson.keyTakeaways,
    generatedAt,
    cached: false,
  });
});
