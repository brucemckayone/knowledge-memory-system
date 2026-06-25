/**
 * GET /api/holding route handler (iOS API v1 — ASK-HOLDING).
 *
 * Thin HTTP wrapper over the getHolding service (src/services/holding.ts). This
 * file owns ONLY the wire concerns the iOS `HoldingResponse` contract pins:
 *
 *   - the route shape:    GET /api/holding?limit=N  (limit OPTIONAL, default 20)
 *   - status mapping:     sparse/fresh-DB / no self entity / no promise
 *                         predicates / no canonical patterns => 200 { items: [] };
 *                         any failure => 500 (iOS treats 500 as the "still
 *                         listening" fallback).
 *   - GET-ONLY: the nudge / let-go POSTs are NOT implemented here (they stay
 *     501 — the iOS MnemoBackendHoldingProvider already tolerates it). When the
 *     promise module (ASK-016) lands the fact-keyed mutation endpoints, those
 *     routes mount separately.
 *   - the response is ALWAYS `{ items: [...] }` — never null, never an omitted
 *     key. The service guarantees every item's required fields are non-empty /
 *     well-typed; a degenerate row is dropped (warn-logged) there, never served,
 *     so the client never rejects the whole payload over one bad row.
 *
 * The getHolding service does the source resolution (promise facts → held /
 * ripening; causal ghosts → open) and the ghost→prose placeholder (flagged
 * SPIKE). This handler must NOT be where new data logic lives — it only
 * guarantees the bytes iOS can decode.
 *
 * Wiring: src/index.ts mounts this in a LATER phase via
 *   app.get('/api/holding', holdingHandler)
 * Do NOT edit index.ts from here.
 */

import type { Context } from 'hono';
import { getHolding } from '../services/holding.js';

/**
 * Hono handler for GET /api/holding. Optional ?limit caps the items (default
 * 20, clamped [1,100]). Sparse data / fresh DB yields the well-formed empty
 * payload `{ items: [] }` (never null) so iOS renders the empty state. Any
 * other failure => 500.
 */
export async function holdingHandler(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  try {
    const result = await getHolding(limit ?? 20);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export default holdingHandler;
