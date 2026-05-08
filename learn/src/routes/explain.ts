import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, sections, courses, notes } from '../db/index.js';
import { explain, type ExplainerAction } from '../agents/explainer.js';
import { runAgent } from '../services/agent.js';

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

// ── Cross-course bridge explainer (nmemo-3va) ──────────────────────────────
// In-memory cache keyed by sorted (aId, bId). 72h TTL. Bridges are stable
// pairings — same concept→concept mapping yields the same explanation.
interface BridgeCacheEntry {
  contentMd: string;
  storedAt: number;
}
const BRIDGE_CACHE = new Map<string, BridgeCacheEntry>();
const BRIDGE_TTL_MS = 72 * 60 * 60 * 1000;

function bridgeCacheKey(aId: string, bId: string): string {
  return [aId, bId].sort().join('|');
}

interface BridgeExplainerBody {
  aEntityId?: unknown;
  bEntityId?: unknown;
  aName?: unknown;
  bName?: unknown;
  aCourseTitle?: unknown;
  bCourseTitle?: unknown;
  kind?: unknown; // 'direct' | 'same_as'
}

const BRIDGE_SYSTEM = `You are an educator explaining how a concept the learner already knows from one course relates to a concept they're now seeing in another. Output 1-2 short paragraphs of plain markdown.

Hard rules:
- Plain markdown only — no JSON, no code fences, no preamble.
- 1-2 short paragraphs. Specific to the two named concepts and courses.
- For semantically equivalent concepts (different names): say plainly that the two names refer to the same idea, then call out the one or two facets that justify the mapping.
- For identical concepts (same name across courses): note what stays the same and what shifts in emphasis between the two course contexts.
- Do not lecture; do not pad. No "Hope that helps".`;

/**
 * POST /api/explain/bridge
 * Body: { aEntityId, bEntityId, aName, bName, aCourseTitle, bCourseTitle, kind? }
 *
 * Returns a 1-2 paragraph cross-course bridge explainer mapping concept A
 * (prior course) to concept B (current course). Cached by sorted (aId, bId)
 * for 72h. Used by the section-page bridge card "Show me the bridge" CTA.
 *
 * Always 200 with { ok, contentMd, errorText?, cached } so the UI never
 * shows nothing — only validation errors return 400.
 */
explainRoutes.post('/bridge', async (c) => {
  let body: BridgeExplainerBody = {};
  try {
    const parsed = await c.req.json<BridgeExplainerBody>();
    if (parsed && typeof parsed === 'object') body = parsed;
  } catch {
    return c.json({ ok: false, contentMd: '', errorText: 'invalid JSON body' }, 400);
  }

  const aEntityId = typeof body.aEntityId === 'string' ? body.aEntityId.trim() : '';
  const bEntityId = typeof body.bEntityId === 'string' ? body.bEntityId.trim() : '';
  if (!aEntityId || !bEntityId) {
    return c.json(
      { ok: false, contentMd: '', errorText: 'aEntityId and bEntityId required' },
      400,
    );
  }
  const aName = typeof body.aName === 'string' ? body.aName.trim() : '';
  const bName = typeof body.bName === 'string' ? body.bName.trim() : '';
  if (!aName || !bName) {
    return c.json(
      { ok: false, contentMd: '', errorText: 'aName and bName required' },
      400,
    );
  }
  const aCourseTitle = typeof body.aCourseTitle === 'string' ? body.aCourseTitle.trim() : '';
  const bCourseTitle = typeof body.bCourseTitle === 'string' ? body.bCourseTitle.trim() : '';
  const kind = body.kind === 'direct' || body.kind === 'same_as' ? body.kind : 'same_as';

  const cacheKey = bridgeCacheKey(aEntityId, bEntityId);
  const cached = BRIDGE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < BRIDGE_TTL_MS) {
    return c.json({ ok: true, contentMd: cached.contentMd, cached: true });
  }

  const userPrompt = [
    `Concept A — in course "${aCourseTitle || 'a prior course'}": "${aName}"`,
    `Concept B — in this course "${bCourseTitle || 'the current course'}": "${bName}"`,
    `Overlap kind: ${kind === 'direct' ? 'identical concept across courses' : 'semantically equivalent (different names)'}`,
    '',
    `Write the bridge explainer in 1-2 short paragraphs of markdown only.`,
  ].join('\n');

  let raw = '';
  try {
    const result = await runAgent(userPrompt, {
      model: 'haiku',
      effort: 'low',
      systemPrompt: BRIDGE_SYSTEM,
      tools: 'none',
      maxTurns: 1,
      timeoutMs: 30_000,
    });
    raw = (result.result ?? '').trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bridge-explainer] runAgent failed: ${msg}`);
    return c.json({
      ok: false,
      contentMd: `_Couldn't generate the bridge explainer right now. (${msg.slice(0, 120)})_`,
      errorText: msg,
      cached: false,
    });
  }

  if (!raw) {
    return c.json({
      ok: false,
      contentMd: '_Empty response from bridge explainer._',
      errorText: 'empty agent output',
      cached: false,
    });
  }

  // Strip any wrapping triple-fence the model may have added.
  const fence = raw.match(/^```(?:markdown|md)?\s*([\s\S]*?)```\s*$/);
  const cleaned = fence?.[1] ? fence[1].trim() : raw;

  BRIDGE_CACHE.set(cacheKey, { contentMd: cleaned, storedAt: Date.now() });
  return c.json({ ok: true, contentMd: cleaned, cached: false });
});
