import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db, sections, questions, quizAttempts, courses } from '../db/index.js';
import { generateLessonAuto, type LessonStage } from '../agents/lesson-generator.js';
import { getSameAsConcepts, getEntityById, type SameAsConceptLink } from '../services/nmemo-client.js';

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

// ── Bridge data (nmemo-3va) ────────────────────────────────────────────────

interface BridgeOverlap {
  kind: 'direct' | 'same_as';
  // The concept side as it appears in the CURRENT section.
  thisConceptId: string;
  thisConceptName: string;
  // The concept side as it appeared in a PRIOR/OTHER course. For 'direct'
  // this is the same id as thisConceptId (the same entity, surfaced by
  // a different course); for 'same_as' it is the other entity in the link.
  priorConceptId: string;
  priorConceptName: string;
  priorCourseId: string;
  priorCourseTitle: string;
  // For same_as overlaps; null for direct.
  confidence: number | null;
  // For same_as overlaps; null for direct.
  reasoning: string | null;
}

/**
 * GET /api/sections/:id/bridge
 *
 * Returns the cross-course overlaps for this section's concepts:
 *  - direct: same entity id appears in another course's section
 *  - same_as: a same_as link relates this section's concept to a concept
 *    in another course (confidence ≥ 0.7)
 *
 * Each overlap carries enough context to render the bridge card without
 * additional client roundtrips: prior course title, both concept names,
 * confidence, and reasoning (for same_as). Lazy-loaded per section — the
 * dashboard composite does not pre-fetch this.
 */
sectionRoutes.get('/:id/bridge', async (c) => {
  const id = c.req.param('id');
  const [section] = await db.select().from(sections).where(eq(sections.id, id));
  if (!section) return c.json({ error: 'Section not found' }, 404);

  let conceptIds: string[] = [];
  try {
    const parsed = JSON.parse(section.conceptEntityIds);
    if (Array.isArray(parsed)) conceptIds = parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* fall through */ }

  if (conceptIds.length === 0) {
    return c.json({ overlaps: [], conceptCount: 0 });
  }

  const conceptSet = new Set(conceptIds);
  const currentCourseId = section.courseId;

  // Pull every section + course title + same_as links concurrently.
  // (Same-as is a platform call; tolerate failure and degrade to direct-only.)
  const [allSections, courseRows, sameAsRes] = await Promise.all([
    db.select({
      courseId: sections.courseId,
      conceptEntityIds: sections.conceptEntityIds,
    }).from(sections),
    db.select({ id: courses.id, title: courses.title }).from(courses),
    getSameAsConcepts().catch((err) => {
      console.warn(`[sections.bridge] same-as fetch failed: ${err}`);
      return { links: [] as SameAsConceptLink[] };
    }),
  ]);

  const courseTitleById = new Map(courseRows.map(r => [r.id, r.title] as const));

  // Direct: which OTHER courses contain any of this section's concepts?
  // Build entityId -> Set<courseId>.
  const entityToCourses = new Map<string, Set<string>>();
  for (const s of allSections) {
    let parsed: string[] = [];
    try {
      const v = JSON.parse(s.conceptEntityIds);
      if (Array.isArray(v)) parsed = v.filter((x): x is string => typeof x === 'string');
    } catch { /* skip */ }
    for (const eid of parsed) {
      if (!conceptSet.has(eid)) continue;
      let set = entityToCourses.get(eid);
      if (!set) { set = new Set(); entityToCourses.set(eid, set); }
      set.add(s.courseId);
    }
  }

  // Resolve concept names — best-effort. Build a name map for every concept
  // that appears in either side of any overlap, so the response is rendered
  // ready without secondary lookups.
  const nameLookups = new Set<string>();
  for (const eid of conceptIds) nameLookups.add(eid);
  for (const link of sameAsRes.links) {
    if (link.entity_a_id) nameLookups.add(link.entity_a_id);
    if (link.entity_b_id) nameLookups.add(link.entity_b_id);
  }
  const idToName = new Map<string, string>();
  // Same-as already carries names — use them first to skip platform calls.
  for (const link of sameAsRes.links) {
    if (link.entity_a_id && link.a_name) idToName.set(link.entity_a_id, link.a_name);
    if (link.entity_b_id && link.b_name) idToName.set(link.entity_b_id, link.b_name);
  }
  // Look up only the section concepts that still need names.
  await Promise.all(conceptIds
    .filter(eid => !idToName.has(eid))
    .slice(0, 20) // cap to bound platform calls
    .map(async (eid) => {
      try {
        const ent = await getEntityById(eid);
        if (ent?.canonicalName) idToName.set(eid, ent.canonicalName);
      } catch { /* fall through to truncated id */ }
    })
  );
  const nameOf = (eid: string) => idToName.get(eid) ?? eid.slice(0, 8);

  const overlaps: BridgeOverlap[] = [];

  // Direct overlaps — one per (concept, otherCourse) pair.
  for (const eid of conceptIds) {
    const courseSet = entityToCourses.get(eid);
    if (!courseSet) continue;
    for (const cid of courseSet) {
      if (cid === currentCourseId) continue;
      overlaps.push({
        kind: 'direct',
        thisConceptId: eid,
        thisConceptName: nameOf(eid),
        priorConceptId: eid,
        priorConceptName: nameOf(eid),
        priorCourseId: cid,
        priorCourseTitle: courseTitleById.get(cid) ?? cid,
        confidence: null,
        reasoning: null,
      });
    }
  }

  // Same-as overlaps — confidence ≥ 0.7 only (per AC3). One side of the
  // link must be a section concept; the other side must touch a different
  // course (so the bridge actually points elsewhere).
  for (const link of sameAsRes.links) {
    if ((link.confidence ?? 0) < 0.7) continue;
    let thisId: string | null = null;
    let priorId: string | null = null;
    if (conceptSet.has(link.entity_a_id)) {
      thisId = link.entity_a_id;
      priorId = link.entity_b_id;
    } else if (conceptSet.has(link.entity_b_id)) {
      thisId = link.entity_b_id;
      priorId = link.entity_a_id;
    } else {
      continue;
    }
    const priorCourseSet = entityToCourses.get(priorId);
    if (!priorCourseSet || priorCourseSet.size === 0) continue;
    for (const cid of priorCourseSet) {
      if (cid === currentCourseId) continue;
      overlaps.push({
        kind: 'same_as',
        thisConceptId: thisId,
        thisConceptName: nameOf(thisId),
        priorConceptId: priorId,
        priorConceptName: nameOf(priorId),
        priorCourseId: cid,
        priorCourseTitle: courseTitleById.get(cid) ?? cid,
        confidence: link.confidence ?? null,
        reasoning: link.reasoning ?? null,
      });
    }
  }

  // De-dup: same (kind, thisConceptId, priorConceptId, priorCourseId).
  const seen = new Set<string>();
  const dedup = overlaps.filter(o => {
    const k = `${o.kind}|${o.thisConceptId}|${o.priorConceptId}|${o.priorCourseId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Sort: same_as with highest confidence first, then direct.
  dedup.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'same_as' ? -1 : 1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  return c.json({
    overlaps: dedup,
    conceptCount: conceptIds.length,
    currentCourseId,
    currentCourseTitle: courseTitleById.get(currentCourseId) ?? currentCourseId,
  });
});
