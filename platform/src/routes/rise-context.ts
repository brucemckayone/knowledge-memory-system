/**
 * GET /api/memories/:id/context route handler (iOS API v1 — ASK-009).
 *
 * Thin HTTP wrapper over the composeRiseContext service
 * (src/services/rise-context.ts). This file owns ONLY the wire concerns the
 * iOS RiseContextResponse contract pins:
 *
 *   - the route shape:    GET /api/memories/:id/context
 *   - status mapping:     unknown memory id => 404;
 *                         any other failure => 500
 *   - the response body   { text, annotations: [...] } (bare array, never null)
 *
 * The composeRiseContext service does the Qdrant body fetch + connected-
 * entities/pattern-partner sourcing + the LLM Voice-C compose (with the
 * deterministic floor as the always-safe degradation). This handler must NOT
 * be where new data or compose logic lives — it only guarantees the bytes iOS
 * can decode.
 *
 * Wiring: src/index.ts mounts this in a LATER phase via
 *   app.get('/api/memories/:id/context', riseContextHandler)
 * Do NOT edit index.ts from here.
 */

import type { Context } from 'hono';
import {
  composeRiseContext,
  RiseContextNotFoundError,
} from '../services/rise-context.js';

/**
 * Hono handler for GET /api/memories/:id/context.
 *
 * `:id` is the memory UUID. An unknown id yields 404 (the memory was let go, or
 * never existed); iOS surfaces the "this is gone" affordance rather than a
 * decode error. Any other failure yields 500 with an error body; iOS treats 500
 * as the "still listening" fallback.
 */
export async function riseContextHandler(c: Context): Promise<Response> {
  const id = c.req.param('id');
  try {
    const result = await composeRiseContext(id);
    return c.json(result);
  } catch (err) {
    if (err instanceof RiseContextNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export default riseContextHandler;
