/**
 * Lesson Overlay HTTP routes.
 *
 * Mounted under /api/sections/:id/overlay — keeps the overlay endpoints
 * grouped with the section they belong to without bloating sections.ts.
 *
 *   GET    /api/sections/:id/overlay              → latest overlay or { overlay: null }
 *   GET    /api/sections/:id/overlay/history      → all versions (newest first)
 *   POST   /api/sections/:id/overlay/edit         → applyEditOp; returns new row
 *   POST   /api/sections/:id/overlay/revert       → revert to version N (?to_version=N)
 *
 * `learner_id` defaults to "default" (matching the schema default and the
 * single-learner POC stance). When multi-learner support lands the body /
 * query string can carry an explicit learnerId without breaking the URL.
 */
import { Hono } from 'hono';
import {
  getLatestOverlay,
  getOverlayHistory,
  applyEditOp,
  revertToVersion,
  buildEditOp,
  OverlayError,
} from '../services/lesson-overlay.js';

export const lessonOverlayRoutes = new Hono();

function asLearnerId(v: unknown, fallback = 'default'): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function errorStatus(err: unknown): { status: number; message: string } {
  if (err instanceof OverlayError) {
    return { status: err.status, message: err.message };
  }
  return {
    status: 500,
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * GET /api/sections/:id/overlay
 * Returns { overlay: OverlayRow | null }. We use a 200 + null shape rather
 * than 404 so clients can call this on every section view without branching
 * on HTTP status — "no overlay yet" is an expected, common state.
 */
lessonOverlayRoutes.get('/:id/overlay', async (c) => {
  const sectionId = c.req.param('id');
  const learnerId = asLearnerId(c.req.query('learner_id'));
  try {
    const overlay = await getLatestOverlay(sectionId, learnerId);
    return c.json({ overlay });
  } catch (err) {
    const { status, message } = errorStatus(err);
    return c.json({ error: message }, status as 400 | 404 | 409 | 500);
  }
});

/**
 * GET /api/sections/:id/overlay/history
 * Returns { versions: OverlayRow[] } ordered newest-first. Empty array when
 * no overlays exist yet.
 */
lessonOverlayRoutes.get('/:id/overlay/history', async (c) => {
  const sectionId = c.req.param('id');
  const learnerId = asLearnerId(c.req.query('learner_id'));
  try {
    const versions = await getOverlayHistory(sectionId, learnerId);
    return c.json({ versions });
  } catch (err) {
    const { status, message } = errorStatus(err);
    return c.json({ error: message }, status as 400 | 404 | 409 | 500);
  }
});

/**
 * POST /api/sections/:id/overlay/edit
 * Body: { op_kind, after_index?, index?, block?, markdown?, learner_id? }
 * Returns the new overlay row.
 */
lessonOverlayRoutes.post('/:id/overlay/edit', async (c) => {
  const sectionId = c.req.param('id');
  let body: Record<string, unknown> = {};
  try {
    const parsed = await c.req.json<Record<string, unknown>>();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }

  const learnerId = asLearnerId(body.learner_id);

  let op;
  try {
    op = buildEditOp(body);
  } catch (err) {
    const { status, message } = errorStatus(err);
    return c.json({ error: message }, status as 400 | 404 | 409 | 500);
  }

  try {
    const overlay = await applyEditOp(sectionId, op, learnerId);
    return c.json({ overlay }, 201);
  } catch (err) {
    const { status, message } = errorStatus(err);
    return c.json({ error: message }, status as 400 | 404 | 409 | 500);
  }
});

/**
 * POST /api/sections/:id/overlay/revert?to_version=N
 * Inserts a new latest version whose blocks match version N's blocks.
 */
lessonOverlayRoutes.post('/:id/overlay/revert', async (c) => {
  const sectionId = c.req.param('id');
  const toVersionRaw = c.req.query('to_version');
  // Allow body override for non-query callers.
  let bodyLearner: string | undefined;
  let bodyVersion: number | undefined;
  try {
    const parsed = await c.req.json<Record<string, unknown>>();
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.learner_id === 'string') bodyLearner = parsed.learner_id;
      if (typeof parsed.to_version === 'number') bodyVersion = parsed.to_version;
    }
  } catch { /* body is optional */ }

  const learnerId = asLearnerId(bodyLearner);
  const toVersion = bodyVersion ?? (toVersionRaw ? parseInt(toVersionRaw, 10) : NaN);
  if (!Number.isInteger(toVersion)) {
    return c.json({ error: 'to_version is required (query string or body)' }, 400);
  }

  try {
    const overlay = await revertToVersion(sectionId, toVersion, learnerId);
    return c.json({ overlay }, 201);
  } catch (err) {
    const { status, message } = errorStatus(err);
    return c.json({ error: message }, status as 400 | 404 | 409 | 500);
  }
});
