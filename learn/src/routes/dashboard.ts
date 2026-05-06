import { Hono } from 'hono';
import { desc, eq, isNull, inArray, sql } from 'drizzle-orm';
import {
  db, courses, sections, quizAttempts, questions,
  chatMessages, chatSessions, insights, flashcards,
} from '../db/index.js';
import {
  getDecayCandidates, getSameAsConcepts, getGraphSnapshot, getEntityById,
  type SameAsConceptLink,
} from '../services/nmemo-client.js';
import { pickNextQuestionAnywhere, type NextQuestionResult } from '../services/quiz-picker.js';

export const dashboardRoutes = new Hono();

const LEARNER_ID = 'default';
const INSIGHTS_LIMIT = 5;
const DECAY_THRESHOLD_DAYS = 14;
const FLASHCARD_TARGET_PER_CONCEPT = 3;
const FLASHCARD_DECAY_TOP_N = 5;
const FLASHCARD_TOTAL_LIMIT = 12;
const CCC_TOP_N = 5;
const CHAT_SNIPPET_CHARS = 200;

interface DashboardJumpBackIn {
  quizAttempt?: {
    id: string;
    sectionId: string;
    sectionTitle: string;
    courseId: string;
    courseTitle: string;
    score: number | null;
    completedAt: string;
  };
  chatMessage?: {
    id: string;
    sessionId: string;
    sectionId?: string;
    courseId?: string;
    courseTitle?: string;
    snippet: string;
    createdAt: string;
  };
}

interface DashboardFlashcard {
  id: string;
  conceptEntityId: string;
  conceptName: string;
  courseId?: string;
  courseTitle?: string;
  frontText: string;
  backText: string;
  hintText?: string;
}

interface DashboardInsight {
  id: string;
  type: string;
  title: string;
  contentMd: string;
  importance: number;
  relatedEntityIds: string[];
  relatedCourseIds: string[];
  relatedFactIds: string[];
  relatedSectionIds: string[];
  actionableUrl: string | null;
  createdAt: string;
  viewedAt: string | null;
}

interface CrossCourseConnection {
  conceptEntityId: string;
  conceptName: string;
  courses: Array<{ courseId: string; courseTitle: string }>;
  kind: 'direct' | 'same_as';
}

interface DashboardResponse {
  jumpBackIn: DashboardJumpBackIn | null;
  dailyQuiz: NextQuestionResult;
  dailyFlashcards: { cards: DashboardFlashcard[]; generatedNew: number };
  insights: { items: DashboardInsight[]; total: number };
  crossCourseConnections: { concepts: CrossCourseConnection[] };
  graphSnapshot: { conceptCount: number; growthThisWeek: number; factCount?: number };
  timing?: Record<string, number>;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function buildJumpBackIn(): Promise<DashboardJumpBackIn | null> {
  try {
    const [latestAttemptRow] = await db
      .select({
        attemptId: quizAttempts.id,
        score: quizAttempts.score,
        createdAt: quizAttempts.createdAt,
        sectionId: questions.sectionId,
        sectionTitle: sections.title,
        courseId: courses.id,
        courseTitle: courses.title,
      })
      .from(quizAttempts)
      .innerJoin(questions, eq(quizAttempts.questionId, questions.id))
      .innerJoin(sections, eq(questions.sectionId, sections.id))
      .innerJoin(courses, eq(sections.courseId, courses.id))
      .where(eq(quizAttempts.learnerId, LEARNER_ID))
      .orderBy(desc(quizAttempts.createdAt))
      .limit(1);

    const [latestMessageRow] = await db
      .select({
        id: chatMessages.id,
        sessionId: chatMessages.sessionId,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
        courseId: chatSessions.courseId,
        courseTitle: courses.title,
      })
      .from(chatMessages)
      .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
      .leftJoin(courses, eq(chatSessions.courseId, courses.id))
      .where(eq(chatSessions.learnerId, LEARNER_ID))
      .orderBy(desc(chatMessages.createdAt))
      .limit(1);

    const out: DashboardJumpBackIn = {};
    if (latestAttemptRow) {
      out.quizAttempt = {
        id: latestAttemptRow.attemptId,
        sectionId: latestAttemptRow.sectionId,
        sectionTitle: latestAttemptRow.sectionTitle,
        courseId: latestAttemptRow.courseId,
        courseTitle: latestAttemptRow.courseTitle,
        score: latestAttemptRow.score,
        completedAt: latestAttemptRow.createdAt,
      };
    }
    if (latestMessageRow) {
      const snippet = latestMessageRow.content.slice(0, CHAT_SNIPPET_CHARS);
      out.chatMessage = {
        id: latestMessageRow.id,
        sessionId: latestMessageRow.sessionId,
        courseId: latestMessageRow.courseId ?? undefined,
        courseTitle: latestMessageRow.courseTitle ?? undefined,
        snippet,
        createdAt: latestMessageRow.createdAt,
      };
    }
    if (!out.quizAttempt && !out.chatMessage) return null;
    return out;
  } catch (err) {
    console.error('[dashboard] buildJumpBackIn failed', err);
    return null;
  }
}

async function buildDailyQuiz(): Promise<NextQuestionResult> {
  try {
    return await pickNextQuestionAnywhere();
  } catch (err) {
    return {
      question: null,
      rationale: { reason: `Daily quiz unavailable: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}

async function buildDailyFlashcards(regenerate: boolean): Promise<{ cards: DashboardFlashcard[]; generatedNew: number }> {
  try {
    const decay = await getDecayCandidates(DECAY_THRESHOLD_DAYS);
    const topConcepts = decay.candidates.slice(0, FLASHCARD_DECAY_TOP_N);
    if (topConcepts.length === 0) return { cards: [], generatedNew: 0 };

    const conceptIds = topConcepts.map(c => c.entity_id);
    const cardRows = await db.select()
      .from(flashcards)
      .where(inArray(flashcards.conceptEntityId, conceptIds))
      .orderBy(desc(flashcards.generatedAt));

    const byConcept = new Map<string, typeof cardRows>();
    for (const row of cardRows) {
      const list = byConcept.get(row.conceptEntityId);
      if (list) list.push(row);
      else byConcept.set(row.conceptEntityId, [row]);
    }

    let generatedNew = 0;
    if (regenerate) {
      const { generateFlashcards } = await import('../agents/flashcard-generator.js');
      const conceptsNeedingGen = topConcepts
        .filter(c => (byConcept.get(c.entity_id)?.length ?? 0) < FLASHCARD_TARGET_PER_CONCEPT)
        .slice(0, 2);
      for (const cand of conceptsNeedingGen) {
        try {
          const rows = await generateFlashcards({
            conceptEntityId: cand.entity_id,
            conceptName: cand.canonical_name,
          });
          generatedNew += rows.length;
          const merged = byConcept.get(cand.entity_id) ?? [];
          for (const r of rows) {
            merged.unshift({
              id: r.id,
              conceptEntityId: r.conceptEntityId,
              courseId: r.courseId,
              frontText: r.frontText,
              backText: r.backText,
              hintText: r.hintText,
              generatedAt: r.generatedAt,
              generationSource: r.generationSource,
            });
          }
          byConcept.set(cand.entity_id, merged);
        } catch (err) {
          console.error(`[dashboard] flashcard regen failed for ${cand.canonical_name}`, err);
        }
      }
    }

    const conceptNames = new Map(topConcepts.map(c => [c.entity_id, c.canonical_name]));
    const courseIds = new Set<string>();
    for (const list of byConcept.values()) for (const r of list) if (r.courseId) courseIds.add(r.courseId);
    const courseRows = courseIds.size === 0 ? [] : await db
      .select({ id: courses.id, title: courses.title })
      .from(courses)
      .where(inArray(courses.id, [...courseIds]));
    const courseTitles = new Map(courseRows.map(c => [c.id, c.title]));

    const cards: DashboardFlashcard[] = [];
    for (const cand of topConcepts) {
      const list = (byConcept.get(cand.entity_id) ?? []).slice(0, FLASHCARD_TARGET_PER_CONCEPT);
      const conceptName = conceptNames.get(cand.entity_id) ?? cand.entity_id.slice(0, 8);
      for (const row of list) {
        cards.push({
          id: row.id,
          conceptEntityId: row.conceptEntityId,
          conceptName,
          courseId: row.courseId ?? undefined,
          courseTitle: row.courseId ? courseTitles.get(row.courseId) : undefined,
          frontText: row.frontText,
          backText: row.backText,
          hintText: row.hintText ?? undefined,
        });
        if (cards.length >= FLASHCARD_TOTAL_LIMIT) break;
      }
      if (cards.length >= FLASHCARD_TOTAL_LIMIT) break;
    }

    return { cards, generatedNew };
  } catch (err) {
    console.error('[dashboard] buildDailyFlashcards failed', err);
    return { cards: [], generatedNew: 0 };
  }
}

async function buildInsights(): Promise<{ items: DashboardInsight[]; total: number }> {
  try {
    const where = isNull(insights.dismissedAt);
    const rows = await db.select().from(insights)
      .where(where)
      .orderBy(desc(insights.importance), desc(insights.createdAt))
      .limit(INSIGHTS_LIMIT);
    const [{ total } = { total: 0 }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(insights)
      .where(where);
    const items: DashboardInsight[] = rows.map(r => ({
      id: r.id,
      type: r.type,
      title: r.title,
      contentMd: r.contentMd,
      importance: r.importance,
      relatedEntityIds: parseJsonArray(r.relatedEntityIds),
      relatedCourseIds: parseJsonArray(r.relatedCourseIds),
      relatedFactIds: parseJsonArray(r.relatedFactIds),
      relatedSectionIds: parseJsonArray(r.relatedSectionIds),
      actionableUrl: r.actionableUrl,
      createdAt: r.createdAt,
      viewedAt: r.viewedAt,
    }));
    return { items, total: Number(total) };
  } catch (err) {
    console.error('[dashboard] buildInsights failed', err);
    return { items: [], total: 0 };
  }
}

async function buildCrossCourseConnections(): Promise<{ concepts: CrossCourseConnection[] }> {
  try {
    const [secs, sameAsRes, courseRows] = await Promise.all([
      db.select({
        courseId: sections.courseId,
        conceptEntityIds: sections.conceptEntityIds,
      }).from(sections),
      getSameAsConcepts().catch(() => ({ links: [] as SameAsConceptLink[] })),
      db.select({ id: courses.id, title: courses.title }).from(courses),
    ]);

    const courseTitles = new Map(courseRows.map(c => [c.id, c.title]));
    const entityToCourses = new Map<string, Set<string>>();
    for (const s of secs) {
      const ids = parseJsonArray(s.conceptEntityIds);
      for (const eid of ids) {
        let set = entityToCourses.get(eid);
        if (!set) { set = new Set(); entityToCourses.set(eid, set); }
        set.add(s.courseId);
      }
    }

    const directIds = [...entityToCourses.entries()]
      .filter(([, courseSet]) => courseSet.size >= 2)
      .map(([eid]) => eid);

    // Names: same_as links already carry a_name/b_name. For direct overlaps
    // we hit /api/learn/entity/:id (capped at top N) — failures fall back to
    // the truncated id.
    const idToName = new Map<string, string>();
    for (const link of sameAsRes.links) {
      if (link.entity_a_id && link.a_name) idToName.set(link.entity_a_id, link.a_name);
      if (link.entity_b_id && link.b_name) idToName.set(link.entity_b_id, link.b_name);
    }
    const needsLookup = directIds
      .filter(eid => !idToName.has(eid))
      .slice(0, CCC_TOP_N * 2);
    await Promise.all(needsLookup.map(async (eid) => {
      try {
        const ent = await getEntityById(eid);
        if (ent?.canonicalName) idToName.set(eid, ent.canonicalName);
      } catch { /* best effort */ }
    }));

    const directConnections: CrossCourseConnection[] = directIds.map(eid => {
      const ids = [...(entityToCourses.get(eid) ?? [])];
      return {
        conceptEntityId: eid,
        conceptName: idToName.get(eid) ?? eid.slice(0, 8),
        courses: ids.map(cid => ({ courseId: cid, courseTitle: courseTitles.get(cid) ?? cid })),
        kind: 'direct' as const,
      };
    }).sort((a, b) => b.courses.length - a.courses.length);

    const sameAsConnections: CrossCourseConnection[] = [];
    for (const link of sameAsRes.links) {
      const aCourses = [...(entityToCourses.get(link.entity_a_id) ?? [])];
      const bCourses = [...(entityToCourses.get(link.entity_b_id) ?? [])];
      const merged = new Map<string, { courseId: string; courseTitle: string }>();
      for (const cid of [...aCourses, ...bCourses]) {
        if (!merged.has(cid)) merged.set(cid, { courseId: cid, courseTitle: courseTitles.get(cid) ?? cid });
      }
      if (merged.size === 0) continue;
      sameAsConnections.push({
        conceptEntityId: link.entity_a_id,
        conceptName: link.a_name || link.b_name || link.entity_a_id.slice(0, 8),
        courses: [...merged.values()],
        kind: 'same_as',
      });
    }

    const seen = new Set<string>();
    const concepts: CrossCourseConnection[] = [];
    for (const c of [...directConnections, ...sameAsConnections]) {
      if (seen.has(c.conceptEntityId)) continue;
      seen.add(c.conceptEntityId);
      concepts.push(c);
      if (concepts.length >= CCC_TOP_N) break;
    }

    return { concepts };
  } catch (err) {
    console.error('[dashboard] buildCrossCourseConnections failed', err);
    return { concepts: [] };
  }
}

async function buildGraphSnapshot(): Promise<{ conceptCount: number; growthThisWeek: number; factCount?: number }> {
  try {
    const snap = await getGraphSnapshot();
    return {
      conceptCount: snap.conceptCount,
      growthThisWeek: snap.growthThisWeek,
      factCount: snap.factCount,
    };
  } catch (err) {
    console.error('[dashboard] buildGraphSnapshot failed', err);
    return { conceptCount: 0, growthThisWeek: 0 };
  }
}

dashboardRoutes.get('/', async (c) => {
  const regenerate = c.req.query('regenerate') === 'true';
  const debug = c.req.query('debug') === 'true';
  const t0 = Date.now();

  // Run all six sub-builders in parallel. Each handles its own try/catch and
  // returns an empty/null state on failure — allSettled is belt-and-braces.
  const tStart: Record<string, number> = {};
  function timed<T>(name: string, p: Promise<T>): Promise<T> {
    tStart[name] = Date.now();
    return p.then(v => { tStart[name] = Date.now() - tStart[name]; return v; });
  }

  const [jbi, dq, df, ins, ccc, gs] = await Promise.allSettled([
    timed('jumpBackIn', buildJumpBackIn()),
    timed('dailyQuiz', buildDailyQuiz()),
    timed('dailyFlashcards', buildDailyFlashcards(regenerate)),
    timed('insights', buildInsights()),
    timed('crossCourseConnections', buildCrossCourseConnections()),
    timed('graphSnapshot', buildGraphSnapshot()),
  ]);

  const totalMs = Date.now() - t0;

  const response: DashboardResponse = {
    jumpBackIn: jbi.status === 'fulfilled' ? jbi.value : null,
    dailyQuiz: dq.status === 'fulfilled' ? dq.value : { question: null, rationale: { reason: 'Daily quiz unavailable' } },
    dailyFlashcards: df.status === 'fulfilled' ? df.value : { cards: [], generatedNew: 0 },
    insights: ins.status === 'fulfilled' ? ins.value : { items: [], total: 0 },
    crossCourseConnections: ccc.status === 'fulfilled' ? ccc.value : { concepts: [] },
    graphSnapshot: gs.status === 'fulfilled' ? gs.value : { conceptCount: 0, growthThisWeek: 0 },
  };

  if (debug) response.timing = { ...tStart, total: totalMs };

  return c.json(response);
});
