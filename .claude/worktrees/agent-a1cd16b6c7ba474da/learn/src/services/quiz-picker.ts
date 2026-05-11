/**
 * Adaptive question selection across all touched courses.
 *
 * Shared between `GET /api/quiz/next-anywhere` and `GET /api/dashboard`.
 * Returns the next-best quiz question for the learner, or null with a reason.
 */

import { eq, inArray } from 'drizzle-orm';
import {
  db, courses, questions, quizAttempts, sections, chatSessions, chatMessages,
} from '../db/index.js';
import {
  getDecayCandidates, getStruggleAreas, getBlastRadius,
  type DecayCandidate,
} from './nmemo-client.js';

export interface NextQuestion {
  id: string;
  sectionId: string;
  courseId: string;
  courseTitle: string;
  sectionTitle: string;
  questionText: string;
  questionType: string;
  conceptEntityId?: string;
}

export interface NextQuestionRationale {
  reason: string;
  blastRadius?: number;
  decayDays?: number;
  priorBestScore?: number;
}

export interface NextQuestionResult {
  question: NextQuestion | null;
  rationale: NextQuestionRationale;
}

interface ScoredCandidate {
  entityId: string;
  conceptName: string;
  decayDays: number;
  blastRadius: number;
  blastRadiusNorm: number;
  priorBestScore: number;
  composite: number;
  reason: string;
}

const LEARNER_ID = 'default';
const DECAY_THRESHOLD_DAYS = 14;
const TOP_N_FOR_BLAST = 10;
const W_BLAST = 0.5;
const W_DECAY = 0.3;
const W_PRIOR = 0.2;

function decayFactor(days: number): number {
  return 1 - Math.exp(-days / 30);
}

function daysSince(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 86_400_000);
}

export async function pickNextQuestionAnywhere(): Promise<NextQuestionResult> {
  try {
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
      return { question: null, rationale: { reason: 'No courses touched yet — start a course to begin' } };
    }

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
      return { question: null, rationale: { reason: 'Touched courses have no concept entities yet' } };
    }

    let decay: DecayCandidate[] = [];
    try {
      const r = await getDecayCandidates(DECAY_THRESHOLD_DAYS);
      decay = r.candidates.filter(d => touchedConcepts.has(d.entity_id));
    } catch { /* upstream offline */ }

    const struggle: { entityId: string; confidence: number }[] = [];
    try {
      const r = await getStruggleAreas();
      const all = [...r.weakAreas, ...r.confusions];
      const seen = new Set<string>();
      for (const s of all) {
        if (!s.entityId || !touchedConcepts.has(s.entityId) || seen.has(s.entityId)) continue;
        seen.add(s.entityId);
        struggle.push({ entityId: s.entityId, confidence: s.confidence });
      }
    } catch { /* upstream offline */ }

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
      return { question: null, rationale: { reason: 'No decay or struggle signals across your touched courses' } };
    }

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

    for (const cand of scored) {
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

      return {
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
      };
    }

    return {
      question: null,
      rationale: { reason: 'Ranked candidates have no questions yet — try the top-ranked section' },
    };
  } catch (err) {
    return {
      question: null,
      rationale: { reason: `Unable to compute next question: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}
