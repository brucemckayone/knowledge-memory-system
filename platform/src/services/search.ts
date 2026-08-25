/**
 * Hybrid search service (iOS API v1 — ASK-001 search arm).
 *
 * Two endpoints share this core:
 *   GET /api/search?q=<query>&limit=N   — ranked memories (RRR-fused)
 *   GET /api/search/entities?q=<query>  — entities linked to those memories
 *
 * The service runs the two retrieval arms the scoping doc pins
 * (BACKEND-INTEGRATION-SCOPING.md §"search-ask"), then reciprocal-rank-fuses
 * them. NO on-demand LLM composition here — that is the `ask` verb
 * (ASK-015, services/voice-c-composer.ts). This is the raw retrieval layer the
 * `ask` composer (and a future /api/ask) will call into.
 *
 *   VECTOR ARM  — ml.embedQuery -> searchMemoriesByUnit (undiluted unit vectors,
 *                 collapsed back to distinct parent windows). The source ids this
 *                 arm emits (UnitGroupedHit.id == parent_window_id == the
 *                 canonical memory id) are the ids the iOS annotation `source.id`
 *                 MUST carry so rise can resolve them.
 *   GRAPH ARM   — recallViaGraph (entity-anchor expansion + unit-grained cosine
 *                 re-rank), NOT findConnectedEntities (test-only). recallViaGraph
 *                 is normally a fallback; here it is an INDEPENDENT arm whose
 *                 parent_window_id hits are folded into the same RRF pool. It is
 *                 seeded by the vector arm's entity links (§4.1 strategy 1) so
 *                 it augments rather than duplicates.
 *
 * RRF fusion is the only net-new ranking (scoping doc). k=60 matches the
 * hybrid-search.test.ts HS-003 reference. Equal arm weight in v1 (the keyword
 * arm is deferred — pg_trgm is installed but no keyword retrieval primitive
 * exists yet).
 *
 * WIRE CONTRACT (camelCase — matches the iOS conventions in
 * Sources/MnemoBackend/ASK/Recent/RecentEntry.swift + Ask/AskResult.swift;
 * these GET /api/search* DTOs do not have a shipped iOS decoder yet, so the
 * field names follow the corpus's pinned camelCase):
 *
 *   GET /api/search?q=&limit=
 *   {
 *     "results": [
 *       {
 *         "memoryId":  "<uuid>",                 // canonical memory id (parent_window_id)
 *         "score":     <number>,                 // RRF-fused score (not normalized)
 *         "content":   "<string>",               // parent window body
 *         "createdAt": "<iso8601>",              // strict ISO-8601 Z
 *         "matchedUnits": <int>,                 // >=0; 0 = window-fallback path
 *         "arms":      ["vector"|"graph"]        // which arms surfaced it; never []
 *       }
 *     ]
 *   }
 *
 *   GET /api/search/entities?q=
 *   {
 *     "entities": [
 *       {
 *         "entityId": "<uuid>",
 *         "name":     "<string>",                // canonical_name
 *         "score":    <number>,                  // RRF of the entity's memories
 *         "kind":     "person"|"place"|...       // entity_type; never blank
 *       }
 *     ]
 *   }
 *
 * FAIL-LOUD wire normalization the iOS decoder family requires (mirrors
 * routes/recent.ts + routes/going.ts posture):
 *   - "results" / "entities" is ALWAYS an array, never null (empty => []).
 *   - memoryId / content / createdAt / entityId / name / kind are non-empty
 *     strings; a candidate failing any is DROPPED (warn-logged), never served.
 *   - createdAt is emitted via toISOString() (strict ISO-8601 Z).
 *   - matchedUnits is a non-negative int; arms is a non-empty array.
 *
 * DOCUMENTED DECISIONS:
 *   - The graph arm is run unconditionally (not only on vector failure as in
 *     graph-fallback.ts), because here it is a peer retrieval source, not a
 *     recovery path. recallViaGraph returns [] when it has no anchors, which is
 *     the correct "graph contributed nothing" outcome, not an error.
 *   - Entity ranking is derived: RRF-fuse the entity's MEMORY scores (an entity
 *     cited by a top-ranked memory ranks high). There is no direct
 *     entity-similarity primitive in scope for v1; this is the documented
 *     "reuses the memory ranking" approach the scoping doc implies.
 *   - The keyword arm (pg_trgm) is DEFERRED (scoping doc). RRF fuses 2 arms now
 *     and the fusion loop is arm-agnostic, so adding a keyword arm later is a
 *     new ranked-list push, not a rewrite.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { ml } from './ml-client.js';
import { searchMemoriesByUnit, type UnitGroupedHit } from './qdrant.js';
import { recallViaGraph, type FlatHit, type RankedUnit } from './graph-fallback.js';

// =============================================================================
// Tunable knobs
// =============================================================================

/** RRF smoothing constant. Matches hybrid-search.test.ts HS-003 (k=60). */
const RRF_K = 60;

/** How many memories to rank + return. The iOS view layers its own paging. */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** Over-fetch for the vector arm so RRF has a deeper pool before slicing. */
const VECTOR_OVERFETCH = 3;

/** How many memories the entities endpoint draws from to rank entities. */
const ENTITY_POOL = 20;

// =============================================================================
// Wire DTOs (camelCase — the corpus's pinned convention)
// =============================================================================

/** Which retrieval arm surfaced a memory. The set is closed; never []. */
export type SearchArm = 'vector' | 'graph';

export interface SearchResult {
  /** Canonical memory id (== parent_window_id == Qdrant parent window id). */
  memoryId: string;
  /** RRF-fused score. Monotone with relevance; not normalized to [0,1]. */
  score: number;
  /** Parent window body — rise resolves against this. */
  content: string;
  /** Strict ISO-8601 Z (from the parent window payload created_at). */
  createdAt: string;
  /** How many of this parent's units matched the query (0 = window-fallback). */
  matchedUnits: number;
  /** Arms that surfaced this memory. Non-empty (a memory with no arms is dropped). */
  arms: SearchArm[];
  /**
   * The UNDILUTED matched excerpt — `unit_text` of this parent's best-scoring
   * unit (`UnitGroupedHit.bestUnitText`), or `content` when the window-fallback
   * path surfaced it (pre-unit data, `matchedUnits === 0`).
   *
   * This is what the ask verb composes FROM. `content` is the whole parent
   * window; feeding 8 whole windows to a composer buries the answer in
   * surrounding prose, and the pre-96o8 deterministic floor concatenated them
   * verbatim (the "wall of underlined entries" the epic exists to fix). The
   * excerpt is the sentence-grained span that actually matched.
   *
   * Additive: NOT emitted on the `/api/search` wire (routes/search.ts
   * whitelists fields), so no iOS decoder sees it.
   */
  excerpt: string;
  /**
   * RAW cosine similarity of the best-matching unit (0..1), straight from
   * Qdrant — NOT the RRF `score`.
   *
   * RRF is rank-based: the top hit of a hopeless query scores identically to
   * the top hit of a perfect one (1/(k+1)), so `score` can never answer "is
   * anything here actually relevant?". That is why the honest-absence state
   * (ask.md §"Empty (no match)") was unreachable — only a literally empty
   * result set produced it. `vectorScore` is the calibrated signal the ask
   * relevance gate reads. 0 when only the graph arm surfaced the memory (no
   * unit vector was scored against the query).
   */
  vectorScore: number;
}
export interface SearchResponse {
  results: SearchResult[];
}

export interface EntitySearchResult {
  entityId: string;
  /** canonical_name. Non-empty. */
  name: string;
  /** Derived RRF score (max of the entity's surfaced memories). */
  score: number;
  /** entity_type. Non-empty; emitted verbatim. */
  kind: string;
}

export interface EntitySearchResponse {
  entities: EntitySearchResult[];
}

// =============================================================================
// RRF fusion
// =============================================================================

/** One ranked contribution to the RRF pool. `rank` is 0-based within its arm. */
interface RankedContribution {
  id: string;
  rank: number;
  arm: SearchArm;
}

/**
 * Reciprocal Rank Fusion (HS-003). Sums 1/(k + rank + 1) across arms; ties
 * broken by earlier rank then arm order for determinism. Equal arm weight in v1.
 */
function reciprocalRankFusion(
  contributions: RankedContribution[],
): Array<{ id: string; score: number; arms: SearchArm[] }> {
  const byId = new Map<string, { score: number; arms: Set<SearchArm> }>();
  for (const c of contributions) {
    const rrfScore = 1 / (RRF_K + c.rank + 1);
    let entry = byId.get(c.id);
    if (!entry) {
      entry = { score: 0, arms: new Set<SearchArm>() };
      byId.set(c.id, entry);
    }
    entry.score += rrfScore;
    entry.arms.add(c.arm);
  }
  return [...byId.entries()].map(([id, e]) => ({
    id,
    score: e.score,
    arms: [...e.arms],
  }));
}

// =============================================================================
// Wire normalization
// =============================================================================

function nonBlank(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Strict ISO-8601 Z string from a parent window payload value, or null. */
function toIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'string' || v.length === 0) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// =============================================================================
// Public entry points
// =============================================================================

/**
 * Hybrid search: embed the query, run the vector + graph arms, RRF-fuse, shape
 * to the iOS wire. Returns { results: [] } on an empty / sparse knowledge graph
 * (no memories, no entity anchors) — the iOS view layer renders the empty state.
 *
 * Callable directly (tests / the future /api/ask composer) or via the Hono
 * handler in routes/search.ts. Never throws on "found nothing" — only on a
 * transport / DB failure, which the handler maps to 500.
 */
export async function search(query: string, limit = DEFAULT_LIMIT): Promise<SearchResponse> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const q = (query ?? '').trim();
  if (q.length === 0) return { results: [] };

  // --- embed the query (nomic search_query prefix handled inside embedQuery).
  const embedResp = await ml.embedQuery(q);
  const queryVector = embedResp.vector;

  // --- VECTOR ARM: searchMemoriesByUnit (undiluted unit vectors -> parents).
  // Over-fetch so the RRF pool has depth before slicing to safeLimit.
  const vectorHits = await searchMemoriesByUnit(queryVector, {
    limit: safeLimit * VECTOR_OVERFETCH,
  });

  // --- GRAPH ARM: recallViaGraph, seeded by the vector arm's memory links
  // (§4.1 strategy 1 — entities in surviving flat hits). recallViaGraph re-ranks
  // expanded evidence units by unit-grained cosine; its parentWindowId hits are
  // the graph arm's memory contributions. It returns [] with no anchors, which
  // is a valid "graph contributed nothing", not an error.
  const flatHits: FlatHit[] = vectorHits.map((h) => ({ id: h.id, score: h.score }));
  let graphUnits: RankedUnit[] = [];
  try {
    graphUnits = await recallViaGraph(queryVector, flatHits, {
      limit: safeLimit * VECTOR_OVERFETCH,
    });
  } catch (err) {
    // The graph arm is a PEER source, not a hard dependency — a graph failure
    // degrades to vector-only rather than blanking search. Warn + continue.
    console.warn('[search] graph arm failed, continuing vector-only:', err instanceof Error ? err.message : err);
  }

  // --- RRF fusion. Each arm contributes its ranked distinct memory ids.
  // Vector arm: UnitGroupedHit.id is already distinct-per-parent.
  // Graph arm: collapse RankedUnit.parentWindowId -> best rank (first occurrence
  // after sorting by rerankScore, which recallViaGraph already returns sorted).
  const contributions: RankedContribution[] = vectorHits.map((h, i) => ({
    id: h.id,
    rank: i,
    arm: 'vector' as const,
  }));
  const seenGraph = new Set<string>();
  for (const u of graphUnits) {
    if (!u.parentWindowId) continue;
    if (seenGraph.has(u.parentWindowId)) continue;
    seenGraph.add(u.parentWindowId);
    contributions.push({ id: u.parentWindowId, rank: seenGraph.size - 1, arm: 'graph' });
  }

  const fused = reciprocalRankFusion(contributions).sort((a, b) => b.score - a.score);

  // --- shape to wire. We need each memory's content + createdAt, which live on
  // the parent window payload. The vector arm already fetched those; the graph
  // arm may surface parents the vector arm missed. Index by memoryId for O(1).
  const payloadById = new Map<string, UnitGroupedHit>();
  for (const h of vectorHits) payloadById.set(h.id, h);

  const results: SearchResult[] = [];
  for (const f of fused.slice(0, safeLimit)) {
    const hit = payloadById.get(f.id);
    // content/createdAt always come from the parent window payload. For a
    // graph-only id the vector arm didn't surface, the payload is absent here;
    // we cannot ship a result without content (the iOS decoder rejects empty),
    // so DROP it rather than serve a degenerate row.
    const payload = hit?.payload;
    const content = payload?.content;
    const createdAt = toIso(payload?.created_at);
    if (!nonBlank(content) || createdAt === null) {
      console.warn(`[search] dropping memory ${f.id}: missing/blank content or createdAt`);
      continue;
    }
    // arms is non-empty by construction (a fused id always has >=1 contributor),
    // but guard: an empty arms array would fail the wire contract.
    if (f.arms.length === 0) {
      console.warn(`[search] dropping memory ${f.id}: no contributing arms`);
      continue;
    }
    // The matched excerpt (MNEMO-96o8.1): the best unit's own text when the
    // unit-grained path surfaced this parent, else the whole window (the
    // pre-unit window-fallback, where no finer span exists). Blank unit text
    // degrades to `content` so `excerpt` is never empty — the ask composer
    // always has material.
    const bestUnit = hit?.bestUnitText;
    const excerpt = nonBlank(bestUnit) ? bestUnit.trim() : content;
    results.push({
      memoryId: f.id,
      score: f.score,
      content,
      createdAt,
      matchedUnits: Math.max(0, Math.trunc(hit?.matchedUnits ?? 0)),
      arms: f.arms,
      excerpt,
      // Raw cosine of the best unit. A graph-arm-only id has no vector-arm hit
      // here, so it carries 0 — correct: nothing was scored against the query,
      // and the ask gate must not treat a graph-expansion neighbour as a
      // semantic match on its own.
      vectorScore: Number.isFinite(hit?.score) ? (hit?.score ?? 0) : 0,
    });  }

  return { results };
}

/**
 * Entity search: rank entities by the RRF scores of the memories that cite them.
 * Runs the memory search over an internal pool, joins memory_entities ⋈ entities,
 * and assigns each entity the MAX (best) score among its surfaced memories
 * (an entity cited by several strong memories ranks high; ties broken by
 * canonical_name for determinism). Returns { entities: [] } when no memories
 * surface or none have linked entities.
 */
export async function searchEntities(query: string, limit = DEFAULT_LIMIT): Promise<EntitySearchResponse> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const q = (query ?? '').trim();
  if (q.length === 0) return { entities: [] };

  // Rank a memory pool, then join. The pool is wider than the display limit so
  // a memory-poor but entity-rich query still surfaces its entities.
  const memResp = await search(q, ENTITY_POOL);
  if (memResp.results.length === 0) return { entities: [] };

  const memoryIds = memResp.results.map((r) => r.memoryId);
  const scoreByMemory = new Map<string, number>(
    memResp.results.map((r) => [r.memoryId, r.score]),
  );

  // memory_entities ⋈ entities: canonical_name + entity_type for each linked id.
  // drizzle inArray over the UUID column; cast ids to uuid for the join.
  const idList = sql.join(
    memoryIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (e.id)
           e.id::text          AS entity_id,
           e.canonical_name    AS canonical_name,
           e.entity_type       AS entity_type
      FROM public.memory_entities me
      JOIN public.entities e ON e.id = me.entity_id
     WHERE me.memory_id IN (${idList})
  `)) as unknown as Array<{
    entity_id: string;
    canonical_name: string;
    entity_type: string;
  }>;

  // An entity's score = the MAX score among the surfaced memories that cite it.
  // Re-query the memory_id per entity so we can take that max (the DISTINCT ON
  // above collapsed to one row per entity without the score context).
  const citeRows = (await db.execute(sql`
    SELECT me.entity_id::text AS entity_id, me.memory_id::text AS memory_id
      FROM public.memory_entities me
     WHERE me.memory_id IN (${idList})
  `)) as unknown as Array<{ entity_id: string; memory_id: string }>;

  const bestScoreByEntity = new Map<string, number>();
  for (const c of citeRows) {
    const s = scoreByMemory.get(c.memory_id);
    if (s === undefined) continue;
    const prev = bestScoreByEntity.get(c.entity_id);
    if (prev === undefined || s > prev) bestScoreByEntity.set(c.entity_id, s);
  }

  const entitiesOut: EntitySearchResult[] = [];
  for (const r of rows) {
    if (!nonBlank(r.entity_id) || !nonBlank(r.canonical_name) || !nonBlank(r.entity_type)) {
      console.warn('[search/entities] dropping entity: blank id/name/type');
      continue;
    }
    const score = bestScoreByEntity.get(r.entity_id);
    if (score === undefined) continue; // entity not cited by any surfaced memory
    entitiesOut.push({
      entityId: r.entity_id,
      name: r.canonical_name,
      kind: r.entity_type,
      score,
    });
  }

  entitiesOut.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return { entities: entitiesOut.slice(0, safeLimit) };
}

// silence "unused" on the re-export consumers may import directly.
export type { UnitGroupedHit };
