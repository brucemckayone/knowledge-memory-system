/**
 * GET /api/promises/* route handlers (iOS API v1 — ASK-016 slice 2, READ).
 *
 * Thin HTTP wrappers over the promises service (src/services/promises.ts).
 * This file owns ONLY the wire concerns the iOS `Promise` / `OpenPromisesResponse`
 * decoders pin:
 *
 *   - GET /api/promises/open?limit=N
 *       -> 200 { promises: [Promise, ...] }   (BARE array; never null)
 *       -> sparse / no self entity / no commitment predicates => { promises: [] }
 *       -> any failure => 500 (iOS treats 500 as the "still listening" fallback)
 *
 *   - GET /api/promises/:factId
 *       -> 200 <bare Promise object>          (NO wrapper — iOS decodes Response = Promise)
 *       -> 404 { error } when the fact is missing, not a commitment predicate,
 *          or invalidated/expired.
 *       -> any other failure => 500.
 *
 * `?limit` is OPTIONAL (widget sizes). Default = all active. A non-positive or
 * non-integer limit is ignored (falls back to all) rather than 400'd — the
 * capture-works-offline posture favours a well-formed payload over a hard
 * reject on a soft param, mirroring /api/holding's clamp.
 *
 * The service does the state derivation (backend-authoritative) + Qdrant
 * source-quote lift + fail-loud row dropping. This handler must NOT be where
 * new data logic lives — it only guarantees the bytes iOS can decode.
 *
 * Wiring: src/index.ts mounts this via
 *   app.get('/api/promises/open', openPromisesHandler)
 *   app.get('/api/promises/:fact_id', promiseDetailHandler)
 * Do NOT edit index.ts from here.
 */

import type { Context } from 'hono';
import { getOpenPromises, getPromiseByFactId } from '../services/promises.js';

/**
 * Hono handler for GET /api/promises/open. Optional ?limit caps the active
 * set. Sparse / fresh DB yields the well-formed `{ promises: [] }` (never
 * null) so iOS renders the empty widget state. Any failure => 500.
 */
export async function openPromisesHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  let limit: number | undefined;
  if (limitRaw != null && limitRaw !== '') {
    const parsed = Number.parseInt(limitRaw, 10);
    // Honour a positive integer; ignore anything else (no 400 — soft param).
    if (Number.isInteger(parsed) && parsed > 0) limit = parsed;
  }
  try {
    const result = await getOpenPromises(limit);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/**
 * Hono handler for GET /api/promises/:fact_id. Returns a BARE Promise object
 * (no wrapper — iOS decodes Response = Promise directly). 404 when the fact
 * is missing, not a commitment predicate, or invalidated/expired. 500 on any
 * other failure.
 */
export async function promiseDetailHandler(c: Context): Promise<Response> {
  const factId = c.req.param('fact_id');
  if (!factId) return c.json({ error: 'fact_id is required' }, 400);
  try {
    const promise = await getPromiseByFactId(factId);
    if (!promise) {
      return c.json({ error: `promise ${factId} not found` }, 404);
    }
    // BARE object — no envelope. iOS PromiseDetailRequest.Response = Promise.
    return c.json(promise);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export default openPromisesHandler;
