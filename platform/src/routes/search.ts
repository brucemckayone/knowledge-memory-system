/**
 * GET /api/search + GET /api/search/entities route handlers (iOS API v1 —
 * ASK-001 search arm).
 *
 * Thin HTTP wrappers over the search / searchEntities services
 * (src/services/search.ts). These files own ONLY the wire concerns the iOS
 * contract pins:
 *
 *   - route shape:   GET /api/search?q=<query>&limit=N   (q REQUIRED, limit
 *                    OPTIONAL default 10, clamped [1,50] by the service)
 *                    GET /api/search/entities?q=<query>  (q REQUIRED)
 *   - status mapping: empty / sparse => 200 { results: [] } / { entities: [] };
 *                     any failure => 500
 *   - "results" / "entities" is ALWAYS an array, never null (the service
 *                     guarantees this; the iOS decoder family rejects null).
 *
 * The search service does embed + vector arm (searchMemoriesByUnit) + graph arm
 * (recallViaGraph) + RRF fusion + wire shaping; the entities service derives
 * entity ranking off the memory ranking. This handler must NOT be where new data
 * logic lives — it only guarantees the bytes iOS can decode.
 *
 * Wiring: src/index.ts mounts these in a LATER phase via
 *   app.get('/api/search', searchHandler)
 *   app.get('/api/search/entities', searchEntitiesHandler)
 * Do NOT edit index.ts from here (an integration agent mounts all routes).
 */

import type { Context } from 'hono';
import { search, searchEntities, type SearchResponse, type EntitySearchResponse } from '../services/search.js';

const DEFAULT_LIMIT = 10;

/**
 * Read `q` and `limit` off the querystring. `q` is required — an absent / blank
 * query yields the well-formed empty payload (200, not 400): the search simply
 * found nothing, matching the iOS empty-result posture (ask.md §"Empty").
 */
function readQuery(c: Context): { q: string; limit: number | undefined } {
  const q = (c.req.query('q') ?? '').trim();
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  return { q, limit };
}

/**
 * FAIL-LOUD wire guard: the service already enforces the decoder contract, but
 * this re-validates at the boundary so a future service edit cannot ship a row
 * the iOS JSONDecoder would reject. A bad row is dropped (warn-logged), not
 * fatal — one bad result must not blank the whole list (mirrors routes/going.ts).
 */
function nonBlank(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function toWireResults(res: SearchResponse): SearchResponse {
  const results = [];
  for (const r of res.results ?? []) {
    if (!nonBlank(r.memoryId) || !nonBlank(r.content) || !nonBlank(r.createdAt)) {
      console.warn('[search] dropping result: blank memoryId/content/createdAt');
      continue;
    }
    if (!Array.isArray(r.arms) || r.arms.length === 0) {
      console.warn(`[search] dropping result ${r.memoryId}: empty arms`);
      continue;
    }
    results.push({
      memoryId: r.memoryId,
      score: Number.isFinite(r.score) ? r.score : 0,
      content: r.content,
      createdAt: r.createdAt,
      matchedUnits: Math.max(0, Math.trunc(r.matchedUnits ?? 0)),
      arms: r.arms,
    });
  }
  return { results };
}

function toWireEntities(res: EntitySearchResponse): EntitySearchResponse {
  const list = [];
  for (const e of res.entities ?? []) {
    if (!nonBlank(e.entityId) || !nonBlank(e.name) || !nonBlank(e.kind)) {
      console.warn('[search/entities] dropping entity: blank id/name/kind');
      continue;
    }
    list.push({
      entityId: e.entityId,
      name: e.name,
      kind: e.kind,
      score: Number.isFinite(e.score) ? e.score : 0,
    });
  }
  return { entities: list };
}

/**
 * Hono handler for GET /api/search. Empty / blank / sparse queries yield
 * { results: [] } (never null). Any failure => 500 with an error body; iOS
 * treats 500 as the "still listening" fallback.
 */
export async function searchHandler(c: Context): Promise<Response> {
  const { q, limit } = readQuery(c);
  try {
    const result = await search(q, limit ?? DEFAULT_LIMIT);
    return c.json(toWireResults(result));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

/**
 * Hono handler for GET /api/search/entities. Empty / blank / sparse queries
 * yield { entities: [] } (never null). Any failure => 500.
 */
export async function searchEntitiesHandler(c: Context): Promise<Response> {
  const { q } = readQuery(c);
  try {
    const result = await searchEntities(q);
    return c.json(toWireEntities(result));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

export default searchHandler;
