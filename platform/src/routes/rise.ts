/**
 * GET /api/rise/:annotationId route handler (iOS API v1 — ASK-009 degraded v1).
 *
 * Thin HTTP wrapper over the rise service (src/services/rise.ts). Owns ONLY the
 * wire concerns the iOS `RiseData` decoder pins:
 *
 *   - GET /api/rise/:annotationId
 *       -> 200 <bare RiseData object>   (iOS RiseRequest.Response = RiseData)
 *       -> 200 { sources: [], patternMatch: null, isHardTopic: false }
 *          for an UNKNOWN / gone source id — NOT a 404. iOS detects empty
 *          `sources` on the SUCCESS path and renders "this source has been let
 *          go" (RiseData.swift: [] is a legitimate zero-source rise). The
 *          service returns that shape directly, so this handler just passes it
 *          through.
 *       -> 500 reserved for REAL failures (Qdrant/DB unreachable).
 *
 * iOS decodes a BARE RiseData object (no envelope). 404 is deliberately NOT used
 * for a missing source — that would surface as a transport error in iOS rather
 * than the intended "let go" affordance.
 *
 * Wiring: src/index.ts mounts this via
 *   app.get('/api/rise/:annotationId', riseHandler)
 * Do NOT edit index.ts from here.
 */

import type { Context } from 'hono';
import { composeRise } from '../services/rise.js';

/**
 * Hono handler for GET /api/rise/:annotationId. Returns a BARE RiseData object.
 * An unknown / gone source id yields the let-go success-shape (200 with empty
 * sources) — the service owns that mapping, so this is a passthrough. 500 only
 * on a real failure.
 */
export async function riseHandler(c: Context): Promise<Response> {
  const annotationId = c.req.param('annotationId');
  if (!annotationId) return c.json({ error: 'annotationId is required' }, 400);
  try {
    const data = await composeRise(annotationId);
    // BARE object — iOS RiseRequest.Response = RiseData. Empty sources is a
    // legitimate 200 (the "source let go" success-shape), not a 404.
    return c.json(data);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export default riseHandler;
