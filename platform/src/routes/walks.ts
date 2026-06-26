/**
 * POST/GET /api/walks/* route handlers (iOS API v1 — ASK-007 walk lifecycle).
 *
 * Thin HTTP wrappers over the walk-session service (services/walk-sessions.ts).
 * This file owns ONLY the wire concerns iOS pins:
 *
 *   - POST /api/walks
 *       body { thread_entity_id?, source:"radial"|"notification"|"bridge" }
 *       -> 200 { session_id, initial_question_queue: [WalkQuestion, ...] }
 *       -> 400 when source is missing / not in the closed set.
 *
 *   - POST /api/walks/:id/answer
 *       body { question_id, transcript, captured_at }
 *       -> 200 { next_question?, new_node_id, new_edge_ids }
 *       -> 400 when question_id / transcript is missing.
 *       -> 404 when the session is missing / expired / terminal.
 *
 *   - POST /api/walks/:id/skip
 *       body { question_id }
 *       -> 200 { next_question? }
 *       -> 400 when question_id is missing; 404 when the session is gone.
 *
 *   - POST /api/walks/:id/end
 *       -> 200 { summary_letter: ReReadLetter | null }   (null until 478.3 pregen)
 *       -> 404 when the session is missing.
 *
 *   - GET /api/walks/:id/state
 *       -> 200 { session_id, status, queue, answered, current_question_position }
 *       -> 404 when the session is missing.
 *
 *   -> 500 reserved for REAL failures (DB/Qdrant unreachable, compose floor failure).
 *
 * The service owns the lifecycle + persistence; these handlers validate genuinely-
 * required input (400), map a missing/expired session (WalkSessionNotFoundError) to
 * 404, and reserve 500 for real failures. Mirrors re-read.ts's envelope discipline.
 *
 * Wiring: src/index.ts mounts these. ROUTE ORDER: the static-suffix routes
 * (/:id/answer, /:id/skip, /:id/end, /:id/state) carry a distinct trailing segment,
 * so they do not collide with the bare collection POST /api/walks. They are
 * registered together near the re-read block. Do NOT edit index.ts from here.
 */

import type { Context } from 'hono';
import {
  startWalk,
  answerWalk,
  skipWalk,
  endWalk,
  getWalkState,
  isValidWalkSource,
  WalkSessionNotFoundError,
} from '../services/walk-sessions.js';

/** Map a service error to the right status: WalkSessionNotFoundError → 404, else 500. */
function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof WalkSessionNotFoundError) {
    return c.json({ error: err.message }, 404);
  }
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
}

/**
 * POST /api/walks — start a walk session. source is the one hard reject (it must be
 * in the closed "radial"|"notification"|"bridge" set). thread_entity_id is optional.
 */
export async function startWalkHandler(c: Context): Promise<Response> {
  let body: { thread_entity_id?: unknown; source?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (!isValidWalkSource(body.source)) {
    return c.json({ error: 'source must be one of "radial" | "notification" | "bridge"' }, 400);
  }
  const threadEntityId =
    typeof body.thread_entity_id === 'string' && body.thread_entity_id.trim().length > 0
      ? body.thread_entity_id.trim()
      : undefined;
  try {
    const result = await startWalk({ threadEntityId, source: (body.source as string).trim() });
    return c.json(result);
  } catch (err) {
    return errorResponse(c, err);
  }
}

/**
 * POST /api/walks/:id/answer — submit an answer segment. question_id + transcript
 * are required (400). A missing/expired session → 404. Returns the next question (if
 * any), the new node id, and new_edge_ids ([] — extraction is async, degraded-v1).
 */
export async function answerWalkHandler(c: Context): Promise<Response> {
  const sessionId = c.req.param('id');
  let body: { question_id?: unknown; transcript?: unknown; captured_at?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const questionId = typeof body.question_id === 'string' ? body.question_id.trim() : '';
  if (questionId.length === 0) {
    return c.json({ error: 'question_id is required' }, 400);
  }
  if (typeof body.transcript !== 'string' || body.transcript.trim().length === 0) {
    return c.json({ error: 'transcript is required' }, 400);
  }
  try {
    const result = await answerWalk({
      sessionId,
      questionId,
      transcript: body.transcript,
      capturedAt: typeof body.captured_at === 'string' ? body.captured_at : undefined,
    });
    return c.json(result);
  } catch (err) {
    return errorResponse(c, err);
  }
}

/**
 * POST /api/walks/:id/skip — skip the current question. question_id is required
 * (400). A missing/expired session → 404. Returns the next question (if any).
 */
export async function skipWalkHandler(c: Context): Promise<Response> {
  const sessionId = c.req.param('id');
  let body: { question_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const questionId = typeof body.question_id === 'string' ? body.question_id.trim() : '';
  if (questionId.length === 0) {
    return c.json({ error: 'question_id is required' }, 400);
  }
  try {
    const result = await skipWalk({ sessionId, questionId });
    return c.json(result);
  } catch (err) {
    return errorResponse(c, err);
  }
}

/**
 * POST /api/walks/:id/end — end the session. Returns the pregenerated summary letter
 * when one exists (478.3 wires the pregen), else { summary_letter: null }. A missing
 * session → 404.
 */
export async function endWalkHandler(c: Context): Promise<Response> {
  const sessionId = c.req.param('id');
  try {
    const result = await endWalk({ sessionId });
    return c.json(result);
  } catch (err) {
    return errorResponse(c, err);
  }
}

/**
 * GET /api/walks/:id/state — the resume payload. A missing session → 404 (iOS has no
 * let-go shape for a non-existent session). A terminal session returns its status.
 */
export async function walkStateHandler(c: Context): Promise<Response> {
  const sessionId = c.req.param('id');
  try {
    const result = await getWalkState({ sessionId });
    return c.json(result);
  } catch (err) {
    return errorResponse(c, err);
  }
}
