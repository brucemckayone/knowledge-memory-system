import { Hono } from 'hono';
import { db, insights, quizAttempts, questions, sections } from '../db/index.js';
import { and, eq, desc, avg, count, isNull } from 'drizzle-orm';
import { getLearnerFacts, getContradictions, getActivePatterns, queryReasoning, getEntityById } from '../services/nmemo-client.js';
import { analyzeGapsAndGenerateContent, type GapAnalysisResult } from '../agents/gap-analyzer.js';
import {
  persistGap, getTopGap, isCachedGapFresh, isBelowGapColdStart,
  GAP_COLD_START_FACT_THRESHOLD, GAP_INSIGHT_TYPE, type PersistedGap,
} from '../services/gap-persistence.js';
import { isVisible } from '../services/insight-lifecycle.js';
import { generateLessonAuto, type LessonStage } from '../agents/lesson-generator.js';
import type { PrioritisedGap } from '../agents/learner-lesson-context.js';

export const learnerRoutes = new Hono();

// In-process guard — prevents two concurrent gap-analyzer runs kicked off by
// a flurry of dashboard polls. Resolves on completion (success or failure).
let inFlightGapRun: Promise<void> | null = null;

async function tryResolveRootEntityId(targetConcept: string): Promise<string | null> {
  // Best-effort name lookup against the graph. Used as a FALLBACK only when
  // the gap-analyzer agent failed to emit its structured ROOT_CAUSE: trailer.
  // Brittle on concept-name drift — prefer the structured id.
  try {
    const ent = await getEntityById(targetConcept);
    return ent?.id ?? null;
  } catch {
    return null;
  }
}

async function persistGapResult(result: GapAnalysisResult): Promise<void> {
  // Prefer the structured root-cause id the agent emitted via its
  // `ROOT_CAUSE:` trailer. Fall back to a name lookup only when the agent
  // omitted the trailer or emitted entityId=null. This keeps backward
  // compatibility with older runs while removing the brittle name path
  // from the happy case.
  const rootCauseEntityId = result.rootCauseEntityId
    ?? await tryResolveRootEntityId(result.targetConcept);
  await persistGap({ result, rootCauseEntityId });
}

function kickGapAnalyzerAsync(courseTopic?: string): void {
  if (inFlightGapRun) return; // already running
  inFlightGapRun = (async () => {
    try {
      const result = await analyzeGapsAndGenerateContent({ courseTopic });
      await persistGapResult(result);
    } catch (err) {
      console.warn('[learner] background gap-analyzer failed:', err instanceof Error ? err.message : String(err));
    } finally {
      inFlightGapRun = null;
    }
  })();
}

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

/** THE WOW MOMENT: analyze gaps and generate targeted content (sync — for explicit user-initiated runs). */
learnerRoutes.post('/gap-analysis', async (c) => {
  const body = await c.req.json<{ courseTopic?: string }>().catch(() => ({} as { courseTopic?: string }));

  const result = await analyzeGapsAndGenerateContent({
    courseTopic: body.courseTopic,
  });
  // Best-effort persistence — surface failures in logs but never block the
  // sync path on a DB hiccup.
  try {
    await persistGapResult(result);
  } catch (err) {
    console.warn('[learner] gap-analysis persistence failed:', err instanceof Error ? err.message : String(err));
  }
  return c.json(result);
});

/**
 * GET /gap-analysis/top
 * Cache-aware top gap fetch (nmemo-7b3). Used by the dashboard composite
 * endpoint and the section-page inline card.
 *
 * Behaviour:
 *   - Fewer than 10 learner facts → return { coldStart: true, gap: null }.
 *     Dashboard surfaces the "complete a quiz" affordance instead of a card.
 *   - Cached gap row younger than GAP_CACHE_TTL_MS → return cached.
 *   - Otherwise: kick a fresh analyzer run in the background and return the
 *     stale cached gap (or null) so the UI never blocks.
 */
learnerRoutes.get('/gap-analysis/top', async (c) => {
  let factCount = 0;
  try {
    const facts = await getLearnerFacts();
    factCount = facts.facts.length;
  } catch (err) {
    console.warn('[learner] /gap-analysis/top fact-count fetch failed:', err instanceof Error ? err.message : String(err));
  }

  if (isBelowGapColdStart(factCount)) {
    return c.json({
      coldStart: true,
      threshold: GAP_COLD_START_FACT_THRESHOLD,
      factCount,
      gap: null as PersistedGap | null,
    });
  }

  const gap = await getTopGap();
  const fresh = await isCachedGapFresh();

  if (!fresh) {
    // Stale or missing — kick async, return whatever we have. Dashboard polls
    // pick up the new gap on the next reload.
    kickGapAnalyzerAsync();
  }

  return c.json({
    coldStart: false,
    factCount,
    gap,
    refreshing: !fresh,
  });
});

/**
 * GET /gaps/top?n=3
 * Top-N currently-visible gap insights (nmemo-eh1). Powers the dashboard
 * "See other gaps" modal. Ordering: importance desc, createdAt desc.
 * Visibility filter (TTL + snooze + dismissal) is applied via `isVisible`.
 *
 * Default n=3, clamped to [1, 20]. Each row carries the structured fields
 * the modal needs (title, root-cause concept, why-it-matters, reason,
 * created timestamp) plus the rootCauseEntityId for the fix-this CTA.
 */
learnerRoutes.get('/gaps/top', async (c) => {
  const nRaw = c.req.query('n');
  const n = Math.max(1, Math.min(20, Number.parseInt(nRaw ?? '3', 10) || 3));

  // Pull a wider window than n so the visibility filter can drop hidden rows
  // without starving the response.
  const rows = await db.select().from(insights)
    .where(and(
      eq(insights.type, GAP_INSIGHT_TYPE),
      isNull(insights.dismissedAt),
    ))
    .orderBy(desc(insights.importance), desc(insights.createdAt))
    .limit(n * 4);

  const now = new Date();
  const visible = rows.filter(r => isVisible({
    type: r.type,
    createdAt: r.createdAt,
    dismissalKind: r.dismissalKind,
    snoozedUntil: r.snoozedUntil,
  }, now)).slice(0, n);

  const projected = visible.map(r => {
    let rootCauseEntityId: string | null = null;
    try {
      const parsed = JSON.parse(r.relatedEntityIds);
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') rootCauseEntityId = parsed[0];
    } catch { /* defensive */ }

    const md = r.contentMd;
    const matchAfter = (s: string, marker: string): string => {
      const idx = s.indexOf(marker);
      if (idx < 0) return '';
      const rest = s.slice(idx + marker.length);
      const lineEnd = rest.indexOf('\n');
      return (lineEnd >= 0 ? rest.slice(0, lineEnd) : rest).trim();
    };
    return {
      id: r.id,
      title: r.title,
      rootCauseConceptName: r.title.replace(/^Gap:\s*/, '').trim(),
      rootCauseReason: matchAfter(md, '**Root cause:**'),
      whyItMatters: matchAfter(md, '**Why this matters:**'),
      importance: r.importance,
      createdAt: r.createdAt,
      rootCauseEntityId,
    };
  });

  return c.json({ gaps: projected, requestedN: n });
});

/**
 * POST /fix-gap
 * Body: { gapEntityId, sectionId }
 * Triggers a regeneration of the section's lesson with gap-bias context so
 * the outline tilts toward the gap's root-cause concept. Returns 202 with
 * the section id (caller polls /api/sections/:id/lesson/status to track).
 */
learnerRoutes.post('/fix-gap', async (c) => {
  const body = await c.req.json<{ gapEntityId?: string; sectionId?: string }>()
    .catch(() => ({} as { gapEntityId?: string; sectionId?: string }));
  const sectionId = body.sectionId?.trim();
  if (!sectionId) return c.json({ error: 'sectionId is required' }, 400);

  const [section] = await db.select().from(sections).where(eq(sections.id, sectionId));
  if (!section) return c.json({ error: 'Section not found' }, 404);

  // Look up the cached gap so we can build the prioritisedGap hint. If the
  // caller passed an explicit gapEntityId we prefer it; otherwise fall back
  // to the top gap.
  const top = await getTopGap();
  if (!top) {
    return c.json({ error: 'No gap to fix — run gap-analysis first' }, 409);
  }
  // Caller-supplied entity id wins for routing; the cached gap supplies the
  // human-readable bias text.
  const rootCauseEntityId = body.gapEntityId?.trim() || top.rootCauseEntityId || '';
  const prioritisedGap: PrioritisedGap = {
    rootCauseEntityId,
    rootCauseConceptName: top.rootCauseConceptName,
    rootCauseReason: top.rootCauseReason,
    whyItMatters: top.whyItMatters,
  };

  const startedAt = new Date().toISOString();
  await db.update(sections).set({
    lessonStatus: 'building',
    lessonStage: 'outlining',
    lessonStartedAt: startedAt,
    lessonError: null,
  }).where(eq(sections.id, sectionId));

  const onStage = async (stage: LessonStage): Promise<void> => {
    try {
      await db.update(sections).set({ lessonStage: stage }).where(eq(sections.id, sectionId));
    } catch (err) {
      console.warn(`[fix-gap] stage update for ${sectionId} (${stage}) failed:`, err);
    }
  };

  // Fire-and-forget — same pattern as POST /api/sections/:id/lesson.
  void (async () => {
    try {
      const lesson = await generateLessonAuto(sectionId, { onStage, prioritisedGap });
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
        }).where(eq(sections.id, sectionId));
      } else {
        await db.update(sections).set({
          lessonContent: lesson.content,
          lessonGeneratedAt: generatedAt,
          lessonReadMinutes: lesson.estimatedReadMinutes,
          lessonKeyTakeaways: JSON.stringify(lesson.keyTakeaways),
          lessonStatus: 'ready',
          lessonStage: null,
          lessonError: null,
        }).where(eq(sections.id, sectionId));
      }
      console.log(`[fix-gap] section ${sectionId} regenerated with gap-bias`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[fix-gap] section ${sectionId} failed:`, msg);
      await db.update(sections).set({
        lessonStatus: 'error',
        lessonStage: null,
        lessonError: msg.slice(0, 4000),
      }).where(eq(sections.id, sectionId));
    }
  })();

  return c.json({
    accepted: true,
    sectionId,
    statusUrl: `/api/sections/${sectionId}/lesson/status`,
    prioritisedGap,
    startedAt,
  }, 202);
});

// Test-only hooks — exported for unit tests that inject mocks for the
// analyzer / lesson-generator. Production code never imports __test.
export const __test = {
  /** Reset the in-process inFlightGapRun guard. Tests rely on this to ensure
   *  successive `kickGapAnalyzerAsync` calls in different test cases do not
   *  collide via the singleton promise. */
  resetInFlightGapRun(): void {
    inFlightGapRun = null;
  },
};

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
