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
 *   - POST /api/promises/:factId/nudge
 *       -> 200 <bare Promise object>          (the shifted promise, reshaped)
 *       -> 404 when not a commitment / missing
 *       -> 409 when there is no valid_at to shift (state `open`) OR nudge_count
 *          is at NUDGE_LIMIT (3) — nudge only applies to ripening/held/nudged.
 *
 *   - POST /api/promises/:factId/done
 *       -> 204 empty                          (completion_resolution='done')
 *       -> 404 when not a commitment / missing.
 *
 *   - POST /api/promises/:factId/let-go
 *       -> 204 empty                          (completion_resolution='let_go'; never a delete)
 *       -> 404 when not a commitment / missing.
 *
 *   - POST /api/promises/:factId/recategorize
 *       -> 204 empty                          (predicate → 'mentioned', drops the promise set)
 *       -> 404 when not a commitment / missing.
 *
 *   - POST /api/promises/:factId/dismiss-completion-suggestion
 *       -> 204 empty (v1 no-op stub — suggestions land in slice 4). Never 4xx.
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
import {
  getOpenPromises,
  getPromiseByFactId,
  nudgePromise,
  markPromiseDone,
  releasePromise,
  recategorizePromise,
  dismissCompletionSuggestion,
} from '../services/promises.js';

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

// =============================================================================
// MUTATION handlers (ASK-016 slice 3)
// =============================================================================

/**
 * POST /api/promises/:fact_id/nudge. Shifts the deadline +24h and bumps
 * nudge_count/last_nudged_at. 200 returns the reshaped bare Promise. 404 when
 * not a commitment/missing; 409 when there's no deadline to shift (state
 * `open`) or nudge_count has hit NUDGE_LIMIT (3). 500 on any other failure.
 */
export async function nudgePromiseHandler(c: Context): Promise<Response> {
  const factId = c.req.param('fact_id');
  if (!factId) return c.json({ error: 'fact_id is required' }, 400);
  try {
    const result = await nudgePromise(factId);
    switch (result.kind) {
      case 'ok':
        // BARE shifted Promise — iOS decodes Response = Promise.
        return c.json(result.promise);
      case 'not_found':
        return c.json({ error: `promise ${factId} not found` }, 404);
      case 'no_deadline':
        return c.json({ error: 'promise has no deadline to nudge' }, 409);
      case 'nudge_limit':
        return c.json({ error: 'nudge limit reached' }, 409);
    }
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/**
 * POST /api/promises/:fact_id/done. Marks the promise completed. 204 empty on
 * success (iOS EmptyResponse). 404 when not a commitment/missing. 500 otherwise.
 */
export async function markDoneHandler(c: Context): Promise<Response> {
  const factId = c.req.param('fact_id');
  if (!factId) return c.json({ error: 'fact_id is required' }, 400);
  try {
    const ok = await markPromiseDone(factId);
    if (!ok) return c.json({ error: `promise ${factId} not found` }, 404);
    return c.body(null, 204);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/**
 * POST /api/promises/:fact_id/let-go. Releases the promise (never a hard
 * delete — CLAUDE.md rule 9). 204 empty on success. 404 when not a
 * commitment/missing. 500 otherwise.
 */
export async function letGoHandler(c: Context): Promise<Response> {
  const factId = c.req.param('fact_id');
  if (!factId) return c.json({ error: 'fact_id is required' }, 400);
  try {
    const ok = await releasePromise(factId);
    if (!ok) return c.json({ error: `promise ${factId} not found` }, 404);
    return c.body(null, 204);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/**
 * POST /api/promises/:fact_id/recategorize. Marks the row as "not a promise"
 * (predicate → 'mentioned', dropping it from the commitment set). 204 empty on
 * success. 404 when not a commitment/missing. 500 otherwise.
 */
export async function recategorizeHandler(c: Context): Promise<Response> {
  const factId = c.req.param('fact_id');
  if (!factId) return c.json({ error: 'fact_id is required' }, 400);
  try {
    const ok = await recategorizePromise(factId);
    if (!ok) return c.json({ error: `promise ${factId} not found` }, 404);
    return c.body(null, 204);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/**
 * POST /api/promises/:fact_id/dismiss-completion-suggestion. v1 has no
 * suggestion surface (slice 4 owns it), so this is a documented no-op: 204
 * empty regardless of factId. Never 4xx — the call is acknowledged and ignored.
 */
export async function dismissSuggestionHandler(c: Context): Promise<Response> {
  const factId = c.req.param('fact_id');
  if (!factId) return c.json({ error: 'fact_id is required' }, 400);
  try {
    await dismissCompletionSuggestion(factId);
    return c.body(null, 204);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export default openPromisesHandler;
