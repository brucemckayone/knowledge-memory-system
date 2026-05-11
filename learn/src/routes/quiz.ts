import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { db, questions, quizAttempts, sections, courses } from '../db/index.js';
import { eq, desc } from 'drizzle-orm';
import { evaluateAnswer } from '../agents/answer-evaluator.js';
import { generateQuestion } from '../agents/quiz-generator.js';
import { pickNextQuestionAnywhere } from '../services/quiz-picker.js';

export const quizRoutes = new Hono();

/** Get questions for a section, optionally with attempt stats */
quizRoutes.get('/sections/:sectionId/questions', async (c) => {
  const sectionId = c.req.param('sectionId');
  const qs = await db.select().from(questions)
    .where(eq(questions.sectionId, sectionId))
    .orderBy(questions.createdAt);

  // Attach best score for each question
  const withScores = await Promise.all(qs.map(async q => {
    const attempts = await db.select({ score: quizAttempts.score })
      .from(quizAttempts)
      .where(eq(quizAttempts.questionId, q.id))
      .orderBy(desc(quizAttempts.createdAt))
      .limit(5);
    const bestScore = attempts.reduce((best, a) => Math.max(best, a.score ?? 0), 0);
    return { ...q, bestScore, attemptCount: attempts.length };
  }));

  return c.json(withScores);
});

/** Get next unanswered / weakest question for a section (adaptive selection) */
quizRoutes.get('/sections/:sectionId/next-question', async (c) => {
  const sectionId = c.req.param('sectionId');
  const qs = await db.select().from(questions).where(eq(questions.sectionId, sectionId));

  if (qs.length === 0) return c.json({ question: null, message: 'No questions in this section yet' });

  // Score each question: not attempted = high priority, low score = high priority
  const scored = await Promise.all(qs.map(async q => {
    const attempts = await db.select({ score: quizAttempts.score })
      .from(quizAttempts).where(eq(quizAttempts.questionId, q.id));
    const bestScore = attempts.length === 0 ? null : Math.max(...attempts.map(a => a.score ?? 0));
    return { question: q, bestScore, attempted: attempts.length > 0 };
  }));

  // Priority: unattempted first, then lowest score
  const unattempted = scored.filter(s => !s.attempted);
  if (unattempted.length > 0) {
    return c.json({ question: unattempted[0]!.question });
  }
  const weakest = scored.sort((a, b) => (a.bestScore ?? 0) - (b.bestScore ?? 0))[0]!;
  return c.json({ question: weakest.question });
});

/** Submit an answer for evaluation */
quizRoutes.post('/questions/:questionId/attempt', async (c) => {
  const questionId = c.req.param('questionId');
  const body = await c.req.json<{ answerText: string }>();
  if (!body.answerText?.trim()) return c.json({ error: 'answerText is required' }, 400);

  const [q] = await db.select().from(questions).where(eq(questions.id, questionId));
  if (!q) return c.json({ error: 'Question not found' }, 404);

  // Get the section to find the concept name
  const [sec] = await db.select().from(sections).where(eq(sections.id, q.sectionId));
  const conceptName = q.conceptEntityId
    ? (sec?.title ?? 'this concept')
    : (sec?.title ?? 'this concept');

  // Resolve presentation_mode via the section → course chain so the evaluator
  // adopts the demo register when the parent course is part of a live demo.
  let presentationMode = false;
  if (sec?.courseId) {
    const [course] = await db.select({ presentationMode: courses.presentationMode })
      .from(courses).where(eq(courses.id, sec.courseId));
    presentationMode = Boolean(course?.presentationMode);
  }

  // Run evaluator agent
  const evaluation = await evaluateAnswer({
    questionText: q.questionText,
    expectedAnswer: q.expectedAnswer ?? '',
    explanation: q.explanation ?? '',
    conceptName,
    answerText: body.answerText,
    presentationMode,
  });

  // Store attempt.
  // nmemo-15o: `nmemoUpdates` column is deprecated (zero readers across
  // learn/). The DEFAULT '[]' on the column keeps it populated for any
  // legacy clients still inspecting it; we no longer write to it from
  // the quiz path. Physical column drop is deferred to a later release.
  const attemptId = randomUUID();
  await db.insert(quizAttempts).values({
    id: attemptId,
    questionId,
    learnerId: 'default',
    answerText: body.answerText,
    score: evaluation.score,
    feedback: evaluation.feedback,
    agentReasoning: evaluation.internalNotes,
  });

  return c.json({
    attemptId,
    score: evaluation.score,
    scoreLabel: evaluation.scoreLabel,
    feedback: evaluation.feedback,
    explanation: q.explanation,
  });
});

/** Generate a new question for a concept */
quizRoutes.post('/generate', async (c) => {
  const body = await c.req.json<{ concept: string; sectionId: string; conceptEntityId?: string }>();
  if (!body.concept || !body.sectionId) return c.json({ error: 'concept and sectionId are required' }, 400);

  const questionId = await generateQuestion({
    concept: body.concept,
    sectionId: body.sectionId,
    conceptEntityId: body.conceptEntityId,
  });

  const [q] = await db.select().from(questions).where(eq(questions.id, questionId));
  return c.json(q, 201);
});

// Daily quiz: most-impactful next question across all touched courses.
// Logic lives in services/quiz-picker.ts and is shared with /api/dashboard.
quizRoutes.get('/next-anywhere', async (c) => {
  const result = await pickNextQuestionAnywhere();
  return c.json(result);
});

/** Get attempt history for the learner */
quizRoutes.get('/history', async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '20', 10);
  const attempts = await db.select({
    id: quizAttempts.id,
    questionId: quizAttempts.questionId,
    score: quizAttempts.score,
    feedback: quizAttempts.feedback,
    createdAt: quizAttempts.createdAt,
    questionText: questions.questionText,
  })
  .from(quizAttempts)
  .innerJoin(questions, eq(quizAttempts.questionId, questions.id))
  .where(eq(quizAttempts.learnerId, 'default'))
  .orderBy(desc(quizAttempts.createdAt))
  .limit(limit);

  return c.json(attempts);
});
