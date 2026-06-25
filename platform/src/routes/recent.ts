/**
 * GET /api/recent route handler (iOS API v1 — ASK-002).
 *
 * Thin HTTP wrapper over the getRecent service (src/services/recent.ts). This
 * file owns ONLY the wire concerns the iOS RecentResponse contract pins:
 *
 *   - the route shape:    GET /api/recent?limit=N   (limit OPTIONAL, default ~20)
 *   - status mapping:     empty / sparse => 200 { entries: [] };
 *                         any failure => 500
 *   - "entries" is ALWAYS an array, never null (the service guarantees this;
 *     the iOS RecentResponse decoder rejects explicit null).
 *
 * The getRecent service does the recency read + Qdrant content fetch + italic
 * entity join + fail-loud row dropping. This handler must NOT be where new data
 * logic lives — it only guarantees the bytes iOS can decode.
 *
 * Wiring: src/index.ts mounts this in a LATER phase via
 *   app.get('/api/recent', recentHandler)
 * Do NOT edit index.ts from here.
 */

import type { Context } from 'hono';
import { getRecent } from '../services/recent.js';

/** Default + bounds mirror the iOS RecentRequest default (limit 3 display, but
 *  the endpoint serves a wider recency window for the timeline). */
const DEFAULT_LIMIT = 20;

/**
 * Hono handler for GET /api/recent.
 *
 * ?limit is optional (default 20, clamped to [1,100] by the service). An empty
 * knowledge graph yields the well-formed empty payload { entries: [] } (never
 * null). Any failure yields 500 with an error body; iOS treats 500 as the
 * "still listening" fallback.
 */
export async function recentHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  try {
    const result = await getRecent(limit ?? DEFAULT_LIMIT);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export default recentHandler;
