/**
 * POST /api/ask route handler (iOS API v1 — ASK-015).
 *
 * Thin HTTP wrapper over the answerQuery service (src/services/ask.ts). This
 * file owns ONLY the wire concerns the iOS AskRequest/AskResponse contract
 * pins:
 *
 *   - the route shape:  POST /api/ask
 *                       { query, voiceInput, turns?, contextEntityIds? }
 *   - status mapping:   nothing to say => 200 { answer: null };
 *                       any failure => 500
 *   - "answer" is `<obj> | null` (never omitted); "annotations" and
 *     "relevantEntityIds" are ALWAYS arrays inside the obj (never null).
 *
 * `turns` (MNEMO-96o8) is the ask conversation: prior (query, answer)
 * exchanges, oldest first, so a follow-up resolves against the thread. Absent
 * or empty means a first turn. `contextEntityIds` (MNEMO-kew8) is the
 * gathered-context scope; absent or empty means a whole-pool ask.
 *
 * Both are read DEFENSIVELY here rather than trusted: a malformed turn (either
 * side blank, or not an object) is dropped rather than 400-ing the ask. Losing
 * one turn of context degrades the answer; rejecting the request loses the
 * question the user just asked.
 *
 * The answerQuery service does search + scope + relevance gate + compose +
 * entity join + wire shaping. This handler must NOT be where new data logic
 * lives — it only guarantees the bytes iOS can decode.
 *
 * Wiring: src/index.ts mounts this via
 *   app.post('/api/ask', askHandler)
 */

import type { Context } from 'hono';
import { answerQuery } from '../services/ask.js';
import type { AskTurn } from '../services/voice-c-ask-llm.js';

/** Cap on how much conversation we carry into a composition prompt. Older
 *  turns are dropped from the FRONT — the recent thread is what a follow-up
 *  refers to, and an unbounded history would grow the prompt without bound. */
const MAX_TURNS = 8;

interface AskBody {
  query?: unknown;
  voiceInput?: unknown;
  turns?: unknown;
  contextEntityIds?: unknown;
}

function readString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Parse `turns` defensively: keep the well-formed exchanges, drop the rest,
 * and hold only the most recent MAX_TURNS.
 */
function readTurns(v: unknown): AskTurn[] {
  if (!Array.isArray(v)) return [];
  const turns: AskTurn[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const t = raw as { query?: unknown; answer?: unknown };
    const query = readString(t.query).trim();
    const answer = readString(t.answer).trim();
    // Both halves are load-bearing: a turn with no question cannot be
    // referred back to, and one with no answer teaches the composer nothing.
    if (query.length === 0 || answer.length === 0) continue;
    turns.push({ query, answer });
  }
  return turns.slice(-MAX_TURNS);
}

/** Parse `contextEntityIds`: non-blank strings only, order preserved. */
function readContextEntityIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const ids: string[] = [];
  for (const raw of v) {
    const id = readString(raw).trim();
    if (id.length > 0) ids.push(id);
  }
  return ids;
}

/**
 * Hono handler for POST /api/ask.
 *
 * A missing / blank query yields `{ answer: null }` (200) — the pool simply has
 * nothing to say, matching the iOS empty-result posture (ask.md §"Empty").
 * `voiceInput` is optional (defaults false) and is a surface hint in v1.
 *
 * Any failure => 500 with an error body; iOS treats 500 as a retryable
 * transport failure, distinct from the quiet `answer: null`.
 */
export async function askHandler(c: Context): Promise<Response> {
  const body: AskBody = await c.req.json<AskBody>().catch(() => ({}));
  const query = readString(body.query);
  const voiceInput = body.voiceInput === true;
  const turns = readTurns(body.turns);
  const contextEntityIds = readContextEntityIds(body.contextEntityIds);
  try {
    const result = await answerQuery(query, voiceInput, { turns, contextEntityIds });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

export default askHandler;
