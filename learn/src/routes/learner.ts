import { Hono } from 'hono';
import { db, quizAttempts, questions } from '../db/index.js';
import { eq, desc, avg, count } from 'drizzle-orm';
import { getLearnerFacts, getContradictions, getActivePatterns, queryReasoning } from '../services/nmemo-client.js';
import { analyzeGapsAndGenerateContent } from '../agents/gap-analyzer.js';

export const learnerRoutes = new Hono();

/** Overall learner stats */
learnerRoutes.get('/stats', async (c) => {
  const [attempts] = await db.select({
    total: count(),
    avgScore: avg(quizAttempts.score),
  }).from(quizAttempts).where(eq(quizAttempts.learnerId, 'default'));

  const learnerFacts = await getLearnerFacts();
  const understandingFacts = learnerFacts.facts.filter(f => f.predicate === 'understands');
  const confusionFacts = learnerFacts.facts.filter(f => f.predicate === 'confused_by');
  const gapFacts = learnerFacts.facts.filter(f => f.predicate === 'lacks_prerequisite');

  const avgConfidence = understandingFacts.length > 0
    ? understandingFacts.reduce((s, f) => s + (f.confidence ?? 0), 0) / understandingFacts.length
    : 0;

  return c.json({
    quizAttempts: attempts?.total ?? 0,
    avgQuizScore: attempts?.avgScore ?? 0,
    conceptsEncountered: understandingFacts.length,
    avgUnderstandingConfidence: Math.round(avgConfidence * 100) / 100,
    activeConfusions: confusionFacts.length,
    knownGaps: gapFacts.length,
  });
});

/** The learner's current knowledge state from the graph */
learnerRoutes.get('/knowledge', async (c) => {
  const learnerFacts = await getLearnerFacts();

  const byPredicate: Record<string, typeof learnerFacts.facts> = {};
  for (const f of learnerFacts.facts) {
    if (!byPredicate[f.predicate]) byPredicate[f.predicate] = [];
    byPredicate[f.predicate]!.push(f);
  }

  return c.json({
    total: learnerFacts.facts.length,
    byPredicate,
  });
});

/** Active contradictions in learner understanding */
learnerRoutes.get('/contradictions', async (c) => {
  const contradictions = await getContradictions();
  return c.json(contradictions);
});

/** Active learning patterns */
learnerRoutes.get('/patterns', async (c) => {
  const patterns = await getActivePatterns();
  return c.json(patterns);
});

/** THE WOW MOMENT: analyze gaps and generate targeted content */
learnerRoutes.post('/gap-analysis', async (c) => {
  const body = await c.req.json<{ courseTopic?: string }>().catch(() => ({} as { courseTopic?: string }));

  const result = await analyzeGapsAndGenerateContent({
    courseTopic: body.courseTopic,
  });

  return c.json(result);
});

/** Ask a question about the learner's progress in natural language */
learnerRoutes.post('/ask', async (c) => {
  const body = await c.req.json<{ question: string }>();
  if (!body.question) return c.json({ error: 'question is required' }, 400);

  const result = await queryReasoning(body.question);
  return c.json({ answer: result.result, durationMs: result.durationMs });
});

/** Recent quiz performance */
learnerRoutes.get('/recent-activity', async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '10', 10);
  const activity = await db.select({
    id: quizAttempts.id,
    score: quizAttempts.score,
    createdAt: quizAttempts.createdAt,
    questionText: questions.questionText,
  })
  .from(quizAttempts)
  .innerJoin(questions, eq(quizAttempts.questionId, questions.id))
  .where(eq(quizAttempts.learnerId, 'default'))
  .orderBy(desc(quizAttempts.createdAt))
  .limit(limit);

  return c.json(activity);
});
