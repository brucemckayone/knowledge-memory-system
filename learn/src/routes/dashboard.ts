import { Hono } from 'hono';
import { and, desc, eq, isNull, inArray, sql } from 'drizzle-orm';
import {
  db, courses, sections, quizAttempts, questions,
  chatMessages, chatSessions, insights, flashcards,
} from '../db/index.js';
import {
  getDecayCandidates, getSameAsConcepts, getGraphSnapshot, getEntityById,
  getLearnerFacts,
  type SameAsConceptLink,
} from '../services/nmemo-client.js';
import { pickNextQuestionAnywhere, type NextQuestionResult } from '../services/quiz-picker.js';
import { isVisible } from '../services/insight-lifecycle.js';
import {
  getTopGap, isCachedGapFresh, isBelowGapColdStart,
  GAP_COLD_START_FACT_THRESHOLD, type PersistedGap,
} from '../services/gap-persistence.js';

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

interface CrossCourseConnectionCourse {
  courseId: string;
  courseTitle: string;
  sectionId?: string;
  sectionTitle?: string;
  snippet?: string;
}

interface CrossCourseConnection {
  conceptEntityId: string;
  conceptName: string;
  courses: CrossCourseConnectionCourse[];
  kind: 'direct' | 'same_as';
}

interface CrossCourseLinkInsight {
  id: string;
  title: string;
  contentMd: string;
  relatedEntityIds: string[];
  relatedCourseIds: string[];
  importance: number;
  createdAt: string;
}

interface DashboardTopGap {
  coldStart: boolean;
  threshold: number;
  factCount: number;
  refreshing: boolean;
  gap: PersistedGap | null;
  /** When the top gap maps to a section (a section whose conceptEntityIds
   *  includes the root-cause concept), the dashboard card's CTA links there.
   *  Null when no section currently teaches the concept. */
  candidateSectionId: string | null;
  candidateSectionTitle: string | null;
  candidateCourseId: string | null;
}

interface DashboardResponse {
  jumpBackIn: DashboardJumpBackIn | null;
  dailyQuiz: NextQuestionResult;
  dailyFlashcards: { cards: DashboardFlashcard[]; generatedNew: number };
  insights: { items: DashboardInsight[]; total: number };
  crossCourseConnections: {
    concepts: CrossCourseConnection[];
    linkInsights: CrossCourseLinkInsight[];
  };
  graphSnapshot: { conceptCount: number; growthThisWeek: number; factCount?: number };
  topGap: DashboardTopGap;
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

// Concepts the learner has scored poorly on recently — fallback candidates
// when nothing has decayed yet. Caps at FLASHCARD_DECAY_TOP_N, lowest avg
// score first. Names are looked up via Nmemo entity-by-id; on lookup failure
// we still surface the candidate with a truncated id so the row isn't lost.
async function getStruggleConcepts(): Promise<Array<{ entity_id: string; canonical_name: string; avgScore: number }>> {
  const rows = await db
    .select({
      conceptEntityId: questions.conceptEntityId,
      score: quizAttempts.score,
    })
    .from(quizAttempts)
    .innerJoin(questions, eq(questions.id, quizAttempts.questionId))
    .where(eq(quizAttempts.learnerId, LEARNER_ID));

  const agg = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (!r.conceptEntityId || r.score == null) continue;
    const v = agg.get(r.conceptEntityId) ?? { sum: 0, n: 0 };
    v.sum += r.score;
    v.n += 1;
    agg.set(r.conceptEntityId, v);
  }

  const struggling = [...agg.entries()]
    .map(([eid, v]) => ({ entity_id: eid, avgScore: v.sum / v.n, n: v.n }))
    .filter(c => c.avgScore < 0.6 && c.n >= 1)
    .sort((a, b) => a.avgScore - b.avgScore)
    .slice(0, FLASHCARD_DECAY_TOP_N);

  return Promise.all(struggling.map(async (c) => {
    let canonical_name = c.entity_id.slice(0, 8);
    try {
      const ent = await getEntityById(c.entity_id);
      if (ent?.canonicalName) canonical_name = ent.canonicalName;
    } catch { /* best effort */ }
    return { entity_id: c.entity_id, canonical_name, avgScore: c.avgScore };
  }));
}

async function buildDailyFlashcards(regenerate: boolean): Promise<{ cards: DashboardFlashcard[]; generatedNew: number }> {
  try {
    const decay = await getDecayCandidates(DECAY_THRESHOLD_DAYS).catch(() => ({ candidates: [] as Array<{ entity_id: string; canonical_name: string }> }));
    let topConcepts: Array<{ entity_id: string; canonical_name: string }> = decay.candidates.slice(0, FLASHCARD_DECAY_TOP_N);
    // Fallback: if nothing has decayed, surface concepts the learner is
    // currently struggling with. Keeps the card useful for fresh learners.
    if (topConcepts.length === 0) {
      const struggle = await getStruggleConcepts();
      topConcepts = struggle.map(s => ({ entity_id: s.entity_id, canonical_name: s.canonical_name }));
    }
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
    // Pull a wider page than INSIGHTS_LIMIT so the lifecycle filter (TTL +
    // snooze) can drop hidden rows in app code without starving the dashboard.
    const rows = await db.select().from(insights)
      .where(isNull(insights.dismissedAt))
      .orderBy(desc(insights.importance), desc(insights.createdAt))
      .limit(INSIGHTS_LIMIT * 5);

    const now = new Date();
    const visible = rows.filter(r => isVisible({
      type: r.type,
      createdAt: r.createdAt,
      dismissalKind: r.dismissalKind,
      snoozedUntil: r.snoozedUntil,
    }, now));

    const items: DashboardInsight[] = visible.slice(0, INSIGHTS_LIMIT).map(r => ({
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
    return { items, total: visible.length };
  } catch (err) {
    console.error('[dashboard] buildInsights failed', err);
    return { items: [], total: 0 };
  }
}

async function buildCrossCourseConnections(): Promise<{
  concepts: CrossCourseConnection[];
  linkInsights: CrossCourseLinkInsight[];
}> {
  try {
    const linkInsightsWhere = and(
      isNull(insights.dismissedAt),
      eq(insights.type, 'cross_course_link'),
    );
    const [secs, sameAsRes, courseRows, linkInsightRows] = await Promise.all([
      db.select({
        id: sections.id,
        title: sections.title,
        description: sections.description,
        lessonKeyTakeaways: sections.lessonKeyTakeaways,
        courseId: sections.courseId,
        orderIndex: sections.orderIndex,
        conceptEntityIds: sections.conceptEntityIds,
      }).from(sections),
      getSameAsConcepts().catch(() => ({ links: [] as SameAsConceptLink[] })),
      db.select({ id: courses.id, title: courses.title }).from(courses),
      db.select().from(insights)
        .where(linkInsightsWhere)
        .orderBy(desc(insights.importance), desc(insights.createdAt))
        .limit(INSIGHTS_LIMIT * 5),
    ]);

    const now = new Date();
    const visibleLinkInsightRows = linkInsightRows.filter(r => isVisible({
      type: r.type,
      createdAt: r.createdAt,
      dismissalKind: r.dismissalKind,
      snoozedUntil: r.snoozedUntil,
    }, now));

    const linkInsights: CrossCourseLinkInsight[] = visibleLinkInsightRows.slice(0, INSIGHTS_LIMIT).map(r => ({
      id: r.id,
      title: r.title,
      contentMd: r.contentMd,
      relatedEntityIds: parseJsonArray(r.relatedEntityIds),
      relatedCourseIds: parseJsonArray(r.relatedCourseIds),
      importance: r.importance,
      createdAt: r.createdAt,
    }));

    const courseTitles = new Map(courseRows.map(c => [c.id, c.title]));

    // For each entity, the courses it appears in and — per course — the first
    // section (by orderIndex) that mentions it plus a short snippet. The
    // snippet is the first key-takeaway when one exists, falling back to the
    // first sentence of the section description. Empty when neither is set.
    const entityToCourseContext = new Map<string, Map<string, CrossCourseConnectionCourse>>();
    const orderedSecs = [...secs].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
    for (const s of orderedSecs) {
      const ids = parseJsonArray(s.conceptEntityIds);
      if (ids.length === 0) continue;
      let snippet = '';
      try {
        const k = parseJsonArray(s.lessonKeyTakeaways ?? '[]');
        if (k.length > 0 && typeof k[0] === 'string') snippet = k[0];
      } catch { /* ignore */ }
      if (!snippet && s.description) {
        const m = s.description.match(/[^.!?]+[.!?]/);
        snippet = (m ? m[0] : s.description).trim();
      }
      if (snippet.length > 220) snippet = snippet.slice(0, 217).trimEnd() + '…';

      for (const eid of ids) {
        let perCourse = entityToCourseContext.get(eid);
        if (!perCourse) { perCourse = new Map(); entityToCourseContext.set(eid, perCourse); }
        if (!perCourse.has(s.courseId)) {
          perCourse.set(s.courseId, {
            courseId: s.courseId,
            courseTitle: courseTitles.get(s.courseId) ?? s.courseId,
            sectionId: s.id,
            sectionTitle: s.title,
            snippet,
          });
        }
      }
    }

    const directIds = [...entityToCourseContext.entries()]
      .filter(([, m]) => m.size >= 2)
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
      const perCourse = entityToCourseContext.get(eid)!;
      return {
        conceptEntityId: eid,
        conceptName: idToName.get(eid) ?? eid.slice(0, 8),
        courses: [...perCourse.values()],
        kind: 'direct' as const,
      };
    }).sort((a, b) => b.courses.length - a.courses.length);

    const sameAsConnections: CrossCourseConnection[] = [];
    for (const link of sameAsRes.links) {
      const aMap = entityToCourseContext.get(link.entity_a_id);
      const bMap = entityToCourseContext.get(link.entity_b_id);
      const merged = new Map<string, CrossCourseConnectionCourse>();
      for (const m of [aMap, bMap]) {
        if (!m) continue;
        for (const [cid, ctx] of m.entries()) {
          if (!merged.has(cid)) merged.set(cid, ctx);
        }
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

    return { concepts, linkInsights };
  } catch (err) {
    console.error('[dashboard] buildCrossCourseConnections failed', err);
    return { concepts: [], linkInsights: [] };
  }
}

/**
 * Build the dashboard "Top gap" payload (nmemo-7b3). Read-only — never kicks
 * the gap-analyzer agent itself. Soft-cache freshness is reported via
 * `refreshing` so the client can show a subtle pending indicator; the
 * dedicated GET /api/learner/gap-analysis/top route handles actual reruns.
 */
async function buildTopGap(): Promise<DashboardTopGap> {
  // Fact count gates the cold-start affordance.
  let factCount = 0;
  try {
    const facts = await getLearnerFacts();
    factCount = facts.facts.length;
  } catch (err) {
    console.warn('[dashboard] buildTopGap fact-count fetch failed:', err);
  }

  if (isBelowGapColdStart(factCount)) {
    return {
      coldStart: true,
      threshold: GAP_COLD_START_FACT_THRESHOLD,
      factCount,
      refreshing: false,
      gap: null,
      candidateSectionId: null,
      candidateSectionTitle: null,
      candidateCourseId: null,
    };
  }

  const [gap, fresh] = await Promise.all([getTopGap(), isCachedGapFresh()]);
  let candidateSectionId: string | null = null;
  let candidateSectionTitle: string | null = null;
  let candidateCourseId: string | null = null;

  if (gap?.rootCauseEntityId) {
    // First section whose conceptEntityIds includes the root-cause concept.
    // Earliest by orderIndex wins, mirroring the design doc's "earliest is
    // selected" rule for cross-section gaps.
    try {
      const rootId = gap.rootCauseEntityId;
      const rows = await db.select({
        id: sections.id,
        title: sections.title,
        courseId: sections.courseId,
        orderIndex: sections.orderIndex,
        conceptEntityIds: sections.conceptEntityIds,
      }).from(sections);
      const candidates = rows
        .filter(r => parseJsonArray(r.conceptEntityIds).includes(rootId))
        .sort((a, b) => a.orderIndex - b.orderIndex);
      if (candidates.length > 0) {
        candidateSectionId = candidates[0]!.id;
        candidateSectionTitle = candidates[0]!.title;
        candidateCourseId = candidates[0]!.courseId;
      }
    } catch (err) {
      console.warn('[dashboard] buildTopGap section lookup failed:', err);
    }
  }

  return {
    coldStart: false,
    threshold: GAP_COLD_START_FACT_THRESHOLD,
    factCount,
    refreshing: !fresh,
    gap,
    candidateSectionId,
    candidateSectionTitle,
    candidateCourseId,
  };
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

  const [jbi, dq, df, ins, ccc, gs, tg] = await Promise.allSettled([
    timed('jumpBackIn', buildJumpBackIn()),
    timed('dailyQuiz', buildDailyQuiz()),
    timed('dailyFlashcards', buildDailyFlashcards(regenerate)),
    timed('insights', buildInsights()),
    timed('crossCourseConnections', buildCrossCourseConnections()),
    timed('graphSnapshot', buildGraphSnapshot()),
    timed('topGap', buildTopGap()),
  ]);

  const totalMs = Date.now() - t0;

  const response: DashboardResponse = {
    jumpBackIn: jbi.status === 'fulfilled' ? jbi.value : null,
    dailyQuiz: dq.status === 'fulfilled' ? dq.value : { question: null, rationale: { reason: 'Daily quiz unavailable' } },
    dailyFlashcards: df.status === 'fulfilled' ? df.value : { cards: [], generatedNew: 0 },
    insights: ins.status === 'fulfilled' ? ins.value : { items: [], total: 0 },
    crossCourseConnections: ccc.status === 'fulfilled' ? ccc.value : { concepts: [], linkInsights: [] },
    graphSnapshot: gs.status === 'fulfilled' ? gs.value : { conceptCount: 0, growthThisWeek: 0 },
    topGap: tg.status === 'fulfilled' ? tg.value : {
      coldStart: false,
      threshold: GAP_COLD_START_FACT_THRESHOLD,
      factCount: 0,
      refreshing: false,
      gap: null,
      candidateSectionId: null,
      candidateSectionTitle: null,
      candidateCourseId: null,
    },
  };

  if (debug) response.timing = { ...tStart, total: totalMs };

  return c.json(response);
});
