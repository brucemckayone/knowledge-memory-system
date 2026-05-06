import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { db, courses, questions, quizAttempts, sections, chatSessions, chatMessages } from '../db/index.js';
import { eq, desc, sql, inArray } from 'drizzle-orm';
import { evaluateAnswer } from '../agents/answer-evaluator.js';
import { generateQuestion } from '../agents/quiz-generator.js';
import {
  getDecayCandidates,
  getStruggleAreas,
  getBlastRadius,
  type DecayCandidate,
} from '../services/nmemo-client.js';

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

  // Run evaluator agent
  const evaluation = await evaluateAnswer({
    questionText: q.questionText,
    expectedAnswer: q.expectedAnswer ?? '',
    explanation: q.explanation ?? '',
    conceptName,
    answerText: body.answerText,
  });

  // Store attempt
  const attemptId = randomUUID();
  await db.insert(quizAttempts).values({
    id: attemptId,
    questionId,
    learnerId: 'default',
    answerText: body.answerText,
    score: evaluation.score,
    feedback: evaluation.feedback,
    agentReasoning: evaluation.internalNotes,
    nmemoUpdates: '[]',
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

// ─── Daily quiz: most-impactful next question across all touched courses ───

interface ScoredCandidate {
  entityId: string;
  conceptName: string;
  decayDays: number;
  blastRadius: number;       // totalAffected from /api/impact (clamped 0..max)
  blastRadiusNorm: number;   // 0..1
  priorBestScore: number;    // 0..1, default 0
  composite: number;         // final score
  reason: string;
}

const LEARNER_ID = 'default';
const DECAY_THRESHOLD_DAYS = 14;
const TOP_N_FOR_BLAST = 10;
const W_BLAST = 0.5;
const W_DECAY = 0.3;
const W_PRIOR = 0.2;

function decayFactor(days: number): number {
  // 1 - exp(-d/30): 0 at d=0, ~0.5 at d=21, ~0.7 at d=36, asymptotic to 1.
  return 1 - Math.exp(-days / 30);
}

function daysSince(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 86_400_000);
}

quizRoutes.get('/next-anywhere', async (c) => {
  try {
    // 1. Find courses the learner has touched (any quiz attempt OR chat session).
    const attemptCourseRows = await db
      .select({ courseId: sections.courseId })
      .from(quizAttempts)
      .innerJoin(questions, eq(quizAttempts.questionId, questions.id))
      .innerJoin(sections, eq(questions.sectionId, sections.id))
      .where(eq(quizAttempts.learnerId, LEARNER_ID));
    const chatCourseRows = await db
      .select({ courseId: chatSessions.courseId })
      .from(chatSessions)
      .innerJoin(chatMessages, eq(chatMessages.sessionId, chatSessions.id))
      .where(eq(chatSessions.learnerId, LEARNER_ID));

    const touchedCourseIds = new Set<string>();
    for (const r of attemptCourseRows) if (r.courseId) touchedCourseIds.add(r.courseId);
    for (const r of chatCourseRows) if (r.courseId) touchedCourseIds.add(r.courseId);

    if (touchedCourseIds.size === 0) {
      return c.json({ question: null, rationale: { reason: 'No courses touched yet — start a course to begin' } });
    }

    // 2. Pull all sections in those courses to build the touched-concept set.
    const touchedSections = await db
      .select({
        id: sections.id,
        courseId: sections.courseId,
        title: sections.title,
        conceptEntityIds: sections.conceptEntityIds,
      })
      .from(sections)
      .where(inArray(sections.courseId, [...touchedCourseIds]));

    const touchedConcepts = new Set<string>();
    const conceptToSection = new Map<string, { sectionId: string; sectionTitle: string; courseId: string }>();
    for (const s of touchedSections) {
      let ids: string[] = [];
      try { ids = JSON.parse(s.conceptEntityIds) as string[]; } catch { /* skip */ }
      for (const eid of ids) {
        touchedConcepts.add(eid);
        if (!conceptToSection.has(eid)) {
          conceptToSection.set(eid, { sectionId: s.id, sectionTitle: s.title, courseId: s.courseId });
        }
      }
    }

    if (touchedConcepts.size === 0) {
      return c.json({ question: null, rationale: { reason: 'Touched courses have no concept entities yet' } });
    }

    // 3. Gather decay + struggle candidates restricted to touched concepts.
    let decay: DecayCandidate[] = [];
    try {
      const r = await getDecayCandidates(DECAY_THRESHOLD_DAYS);
      decay = r.candidates.filter(d => touchedConcepts.has(d.entity_id));
    } catch { /* upstream offline — degrade */ }

    let struggle: { entityId: string; confidence: number }[] = [];
    try {
      const r = await getStruggleAreas();
      const all = [...r.weakAreas, ...r.confusions];
      const seen = new Set<string>();
      for (const s of all) {
        if (!s.entityId || !touchedConcepts.has(s.entityId) || seen.has(s.entityId)) continue;
        seen.add(s.entityId);
        struggle.push({ entityId: s.entityId, confidence: s.confidence });
      }
    } catch { /* upstream offline — degrade */ }

    // Merge into a candidate pool keyed by entityId.
    const pool = new Map<string, { entityId: string; decayDays: number; struggleConfidence?: number }>();
    for (const d of decay) {
      pool.set(d.entity_id, { entityId: d.entity_id, decayDays: daysSince(d.last_fact_at) });
    }
    for (const s of struggle) {
      const existing = pool.get(s.entityId);
      if (existing) existing.struggleConfidence = s.confidence;
      else pool.set(s.entityId, { entityId: s.entityId, decayDays: 0, struggleConfidence: s.confidence });
    }

    if (pool.size === 0) {
      return c.json({ question: null, rationale: { reason: 'No decay or struggle signals across your touched courses' } });
    }

    // 4. Cap blast-radius lookups: pick top TOP_N by initial heuristic
    // (decay days + struggle bonus). One HTTP call per remaining entity.
    const initial = [...pool.values()].sort((a, b) => {
      const aS = a.decayDays + (a.struggleConfidence !== undefined ? 30 * (1 - a.struggleConfidence) : 0);
      const bS = b.decayDays + (b.struggleConfidence !== undefined ? 30 * (1 - b.struggleConfidence) : 0);
      return bS - aS;
    }).slice(0, TOP_N_FOR_BLAST);

    const blastReports = await Promise.all(initial.map(async (cand) => {
      try {
        const r = await getBlastRadius('entity', cand.entityId, 2);
        return { entityId: cand.entityId, totalAffected: r.totalAffected, summary: r.root.summary };
      } catch {
        return { entityId: cand.entityId, totalAffected: 0, summary: '' };
      }
    }));
    const maxBlast = Math.max(1, ...blastReports.map(r => r.totalAffected));

    // 5. Look up prior best score per concept (best score on any question
    // tagged with that concept_entity_id).
    const entityIds = initial.map(i => i.entityId);
    const priorRows = entityIds.length === 0 ? [] : await db
      .select({
        conceptEntityId: questions.conceptEntityId,
        score: quizAttempts.score,
      })
      .from(quizAttempts)
      .innerJoin(questions, eq(quizAttempts.questionId, questions.id))
      .where(inArray(questions.conceptEntityId, entityIds));
    const priorBest = new Map<string, number>();
    for (const r of priorRows) {
      if (!r.conceptEntityId) continue;
      const cur = priorBest.get(r.conceptEntityId) ?? 0;
      const s = r.score ?? 0;
      if (s > cur) priorBest.set(r.conceptEntityId, s);
    }

    // 6. Score and rank.
    const scored: ScoredCandidate[] = initial.map((cand) => {
      const blast = blastReports.find(b => b.entityId === cand.entityId);
      const blastRadius = blast?.totalAffected ?? 0;
      const blastRadiusNorm = blastRadius / maxBlast;
      const dF = decayFactor(cand.decayDays);
      const prior = priorBest.get(cand.entityId) ?? 0;
      const composite = (blastRadiusNorm * W_BLAST) + (dF * W_DECAY) + ((1 - prior) * W_PRIOR);
      const conceptName = blast?.summary?.replace(/\s*\(.*?\)\s*$/, '').trim() || cand.entityId.slice(0, 8);
      let reason: string;
      if (cand.decayDays >= DECAY_THRESHOLD_DAYS && blastRadius > 0) {
        reason = `Decay candidate — last touched ${Math.round(cand.decayDays)} days ago, blocks ${blastRadius} downstream concept${blastRadius === 1 ? '' : 's'}`;
      } else if (cand.decayDays >= DECAY_THRESHOLD_DAYS) {
        reason = `Decay candidate — last touched ${Math.round(cand.decayDays)} days ago`;
      } else if (cand.struggleConfidence !== undefined) {
        reason = `Struggle area — current confidence ${cand.struggleConfidence.toFixed(2)}, blocks ${blastRadius} downstream concept${blastRadius === 1 ? '' : 's'}`;
      } else {
        reason = `High-impact concept — blocks ${blastRadius} downstream`;
      }
      return {
        entityId: cand.entityId,
        conceptName,
        decayDays: cand.decayDays,
        blastRadius,
        blastRadiusNorm,
        priorBestScore: prior,
        composite,
        reason,
      };
    }).sort((a, b) => b.composite - a.composite);

    // 7. Pick top candidate that has a question we can ask.
    for (const cand of scored) {
      // Try direct match: question.concept_entity_id == cand.entityId
      let qRows = await db
        .select({
          id: questions.id,
          sectionId: questions.sectionId,
          questionText: questions.questionText,
          questionType: questions.questionType,
          conceptEntityId: questions.conceptEntityId,
        })
        .from(questions)
        .where(eq(questions.conceptEntityId, cand.entityId))
        .limit(1);

      // Fallback: any question in the section whose conceptEntityIds includes the entity
      if (qRows.length === 0) {
        const sectionInfo = conceptToSection.get(cand.entityId);
        if (sectionInfo) {
          qRows = await db
            .select({
              id: questions.id,
              sectionId: questions.sectionId,
              questionText: questions.questionText,
              questionType: questions.questionType,
              conceptEntityId: questions.conceptEntityId,
            })
            .from(questions)
            .where(eq(questions.sectionId, sectionInfo.sectionId))
            .orderBy(questions.createdAt)
            .limit(1);
        }
      }

      if (qRows.length === 0) continue;

      const q = qRows[0]!;
      const [sec] = await db.select().from(sections).where(eq(sections.id, q.sectionId));
      if (!sec) continue;
      const [course] = await db.select().from(courses).where(eq(courses.id, sec.courseId));
      if (!course) continue;

      return c.json({
        question: {
          id: q.id,
          sectionId: q.sectionId,
          courseId: course.id,
          courseTitle: course.title,
          sectionTitle: sec.title,
          questionText: q.questionText,
          questionType: q.questionType,
          conceptEntityId: q.conceptEntityId ?? undefined,
        },
        rationale: {
          reason: cand.reason,
          blastRadius: cand.blastRadius,
          decayDays: Math.round(cand.decayDays),
          priorBestScore: cand.priorBestScore,
        },
      });
    }

    return c.json({
      question: null,
      rationale: { reason: 'Ranked candidates have no questions yet — try the top-ranked section' },
    });
  } catch (err) {
    return c.json({
      question: null,
      rationale: { reason: `Unable to compute next question: ${err instanceof Error ? err.message : String(err)}` },
    });
  }
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
