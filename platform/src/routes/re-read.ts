/**
 * GET /api/re-read/* route handlers (iOS API v1 — ASK-011, read-path v1).
 *
 * Thin HTTP wrappers over the re-read service (src/services/re-read.ts). This
 * file owns ONLY the wire concerns the iOS ReReadLetter / ReReadCurrentResponse /
 * ReReadAllResponse decoders pin:
 *
 *   - GET /api/re-read/current
 *       -> 200 { letter: ReReadLetter | null }   (ENVELOPE — never bare)
 *       -> { letter: null } when nothing is prepared (the no-prepared-letter
 *          SUCCESS-shape — NOT a 404; iOS routes to explore + query).
 *
 *   - GET /api/re-read/?threadEntityId=<uuid>
 *       -> 200 { letter: ReReadLetter | null }   (same envelope, per thread)
 *       -> 400 { error } when threadEntityId is missing.
 *
 *   - GET /api/re-read/all
 *       -> 200 { letters: [ReReadLetter, ...] }  (ENVELOPE — [] for empty, never null)
 *
 *   -> 500 reserved for REAL failures (DB/Qdrant unreachable).
 *
 * null / [] are 200 SUCCESS-shapes (mirrors rise.ts's "source let go" discipline):
 * a missing letter is NOT a 404 — that would surface as a transport error in iOS
 * rather than the intended no-prepared-letter routing. The service owns the
 * mapping; these handlers just pass through and wrap in the envelope.
 *
 * Wiring: src/index.ts mounts these via
 *   app.get('/api/re-read/current', reReadCurrentHandler)
 *   app.get('/api/re-read/all', reReadAllHandler)
 *   app.get('/api/re-read/', reReadThreadHandler)
 * ROUTE ORDER: /current and /all MUST be registered before the bare /api/re-read/
 * so Hono does not shadow them. Do NOT edit index.ts from here.
 */

import type { Context } from 'hono';
import { getCurrentLetter, getAllLetters, getLetterByThread } from '../services/re-read.js';

/**
 * GET /api/re-read/current — the most-resonant current letter. Returns the
 * { letter } envelope (letter: null when none prepared — a 200 success-shape).
 */
export async function reReadCurrentHandler(c: Context): Promise<Response> {
  try {
    const letter = await getCurrentLetter();
    return c.json({ letter });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/**
 * GET /api/re-read/all — the archive list. Returns the { letters } envelope
 * ([] for empty, never null — a 200 success-shape).
 */
export async function reReadAllHandler(c: Context): Promise<Response> {
  try {
    const letters = await getAllLetters();
    return c.json({ letters });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/**
 * GET /api/re-read/?threadEntityId=<uuid> — the current letter for a thread.
 * Returns the { letter } envelope (letter: null when none for that thread). A
 * missing threadEntityId query param is a 400 (the one hard reject — without it
 * there is no thread to resolve).
 */
export async function reReadThreadHandler(c: Context): Promise<Response> {
  const threadEntityId = c.req.query('threadEntityId');
  if (!threadEntityId || threadEntityId.trim().length === 0) {
    return c.json({ error: 'threadEntityId query param is required' }, 400);
  }
  try {
    const letter = await getLetterByThread(threadEntityId);
    return c.json({ letter });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}
