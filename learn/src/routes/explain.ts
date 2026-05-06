import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, sections, courses } from '../db/index.js';
import { explain, type ExplainerAction } from '../agents/explainer.js';

export const explainRoutes = new Hono();

interface ExplainBody {
  selectedText?: unknown;
  action?: unknown;
  sectionId?: unknown;
}

const VALID_ACTIONS: ReadonlySet<ExplainerAction> = new Set([
  'explain',
  'example',
  'why',
]);

function isValidAction(v: unknown): v is ExplainerAction {
  return typeof v === 'string' && (VALID_ACTIONS as Set<string>).has(v);
}

/**
 * POST /api/explain
 * Body: { selectedText: string, action: 'explain' | 'example' | 'why', sectionId?: string }
 *
 * Calls the popover-sized explainer agent. If sectionId is provided, hydrates
 * sectionContext (section title) and courseContext (course title) from the DB
 * so the answer stays grounded in what the learner is reading.
 *
 * Always 200 with { ok, contentMd, errorText? } — frontend popover shows
 * `contentMd` regardless. Only obvious validation errors return 400.
 */
explainRoutes.post('/', async (c) => {
  let body: ExplainBody = {};
  try {
    const parsed = await c.req.json<ExplainBody>();
    if (parsed && typeof parsed === 'object') body = parsed;
  } catch {
    return c.json({ ok: false, contentMd: '', errorText: 'invalid JSON body' }, 400);
  }

  const selectedText =
    typeof body.selectedText === 'string' ? body.selectedText.trim() : '';
  if (!selectedText) {
    return c.json(
      { ok: false, contentMd: '', errorText: 'selectedText required' },
      400,
    );
  }
  if (selectedText.length > 2000) {
    return c.json(
      { ok: false, contentMd: '', errorText: 'selectedText too long (max 2000 chars)' },
      400,
    );
  }

  if (!isValidAction(body.action)) {
    return c.json(
      {
        ok: false,
        contentMd: '',
        errorText: 'action must be explain | example | why',
      },
      400,
    );
  }
  const action = body.action;

  let sectionContext: string | undefined;
  let courseContext: string | undefined;
  const sectionId = typeof body.sectionId === 'string' ? body.sectionId : null;
  if (sectionId) {
    try {
      const [section] = await db
        .select({
          title: sections.title,
          courseId: sections.courseId,
        })
        .from(sections)
        .where(eq(sections.id, sectionId));
      if (section) {
        sectionContext = section.title;
        if (section.courseId) {
          const [course] = await db
            .select({ title: courses.title })
            .from(courses)
            .where(eq(courses.id, section.courseId));
          if (course) courseContext = course.title;
        }
      }
    } catch (err) {
      // Context hydration is opportunistic — never fail the request because of it.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[explain] section context hydration failed: ${msg}`);
    }
  }

  const result = await explain({
    selectedText,
    action,
    sectionContext,
    courseContext,
  });

  return c.json(result);
});
