/**
 * POST /api/ask route handler (iOS API v1 — ASK-015).
 *
 * Thin HTTP wrapper over the answerQuery service (src/services/ask.ts). This
 * file owns ONLY the wire concerns the iOS AskRequest/AskResponse contract
 * pins:
 *
 *   - the route shape:    POST /api/ask  body { query, voiceInput }
 *   - status mapping:     empty search => 200 { answer: null };
 *                         any failure => 500
 *   - "answer" is `<obj> | null` (never omitted); "annotations" and
 *     "relevantEntityIds" are ALWAYS arrays inside the obj (never null).
 *
 * The answerQuery service does search + compose + entity join + signal
 * derivation + wire shaping. This handler must NOT be where new data logic
 * lives — it only guarantees the bytes iOS can decode.
 *
 * Wiring: src/index.ts mounts this via
 *   app.post('/api/ask', askHandler)
 */

import type { Context } from 'hono';
import { answerQuery } from '../services/ask.js';

/**
 * Hono handler for POST /api/ask.
 *
 * Body: `{ query: string, voiceInput: boolean }`. A missing/blank query yields
 * the well-formed empty payload `{ answer: null }` (200) — the search simply
 * found nothing, matching the iOS empty-result posture (ask.md §"Empty").
 * `voiceInput` is optional (defaults false) and is a surface hint in v1.
 *
 * Any failure => 500 with an error body; iOS treats 500 as the "still
 * listening" fallback (mirrors routes/recent.ts + routes/holding.ts posture).
 */
export async function askHandler(c: Context): Promise<Response> {
  const body: { query?: string; voiceInput?: boolean } = await c.req
    .json<{ query?: string; voiceInput?: boolean }>()
    .catch(() => ({}));
  const query = typeof body.query === 'string' ? body.query : '';
  const voiceInput = body.voiceInput === true;
  try {
    const result = await answerQuery(query, voiceInput);
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

export default askHandler;
