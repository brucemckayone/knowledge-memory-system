import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, sections, courses, notes } from '../db/index.js';
import { explain, type ExplainerAction } from '../agents/explainer.js';

export const explainRoutes = new Hono();

interface ExplainBody {
  selectedText?: unknown;
  action?: unknown;
  sectionId?: unknown;
  // When true and sectionId is present, the explainer's response is also
  // persisted as a Note anchored to the selection. Frontend uses this to
  // make every highlight-action click leave a permanent record on the
  // notes panel — replaces the old transient popover UX.
  saveAsNote?: unknown;
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

  // Persist the explanation as a Note tied to the highlight, when requested.
  // Note creation is best-effort: a save failure must not lose the
  // explanation, so the route still returns the agent result either way.
  let savedNote: { id: string; createdAt: string } | null = null;
  const wantSave =
    body.saveAsNote === true ||
    body.saveAsNote === 'true' ||
    body.saveAsNote === 1 ||
    body.saveAsNote === '1';
  if (wantSave && sectionId && result.ok && result.contentMd) {
    try {
      const noteId = randomUUID();
      const createdAt = new Date().toISOString();
      const headerLabel =
        action === 'explain' ? 'Explain' : action === 'example' ? 'Example' : 'Why';
      const contentMd = `**${headerLabel}** — _"${selectedText.slice(0, 200)}${selectedText.length > 200 ? '…' : ''}"_\n\n${result.contentMd}`;
      await db.insert(notes).values({
        id: noteId,
        learnerId: 'default',
        sectionId,
        anchorText: selectedText,
        contentMd,
        promotedToGraph: 0,
        factId: null,
        createdAt,
      });
      savedNote = { id: noteId, createdAt };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[explain] note save failed: ${msg}`);
    }
  }

  return c.json({ ...result, savedNote });
});
