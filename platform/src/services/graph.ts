/**
 * Graph Service — traversal over `public.facts`.
 *
 * WHY THIS IS NOT APACHE AGE ANY MORE (single-graph keep list blocker 5).
 *
 * These four functions used to run Cypher against the `knowledge_graph` AGE graph,
 * kept in sync by triggers. Measured on 2026-08-31:
 *
 *   cognitive       AGE 1,071 nodes / 2,000 edges  vs  4 entities / 2 active facts
 *   cognitive_test  AGE 7,250 nodes / 5,670 edges  vs  3,513 entities / 6,039 active facts
 *
 * The drift runs in BOTH directions: 52% of the substrate DB's AGE nodes have no
 * corresponding entity row, and AGE is simultaneously missing real edges. There is
 * no DELETE trigger and `/api/reset` does not touch the graph, so ghosts accumulate
 * monotonically across every reset. Three further problems make AGE unfixable as a
 * read path rather than merely stale:
 *
 *   1. It cannot represent expiry. Facts are bi-temporal (`expired_at`,
 *      `invalid_at`); an AGE edge is present or absent. A traversal over AGE
 *      therefore cannot answer "as of now", let alone "as of then".
 *   2. Edge properties do not persist via SET in this AGE version (CLAUDE.md), so
 *      confidence/validity could not be carried even in principle.
 *   3. AGE nodes carry no `corpus_id`, so every AGE traversal is a cross-corpus
 *      read-path leak by construction.
 *
 * Canonical data has always lived in the Postgres tables; AGE was a traversal
 * index. A recursive CTE over `public.facts` is exactly as expressive for what
 * these callers need, is expiry-correct, is corpus-scopable, and needs no sync.
 *
 * The AGE graph and its sync triggers are left in place by this change — nothing
 * READS them from here any more, which is what stops phantoms reaching retrieval.
 *
 * One behaviour is preserved deliberately: `getAllEdges` reports a relationship
 * type of `upper(replace(predicate, '-', '_'))`, which is what migration 001's
 * `create_entity_edge` used, so existing assertions keep their meaning.
 */

import { sql } from 'drizzle-orm';
import { rawQuery } from '../db/raw.js';

// NOTE: rawQuery (db/raw.ts) rewrites every result key snake_case -> camelCase.
// Row types below therefore read `entityId`, `viaFactId`, `relType` and so on,
// NOT the snake_case names the SQL aliases use. Getting this wrong is silent:
// the query succeeds, the field reads `undefined`, and a caller sees a populated
// array of empty values.

export interface GraphEntity {
  entityId: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface GraphEdge {
  fromEntityId: string;
  toEntityId: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface GraphPath {
  nodes: GraphEntity[];
  edges: GraphEdge[];
  length: number;
}

/** A neighbour reached by traversal, with the hop it was first reached at and a
 *  fact that connects it inward. */
export interface TraversalNeighbour extends GraphEntity {
  /** First-reached (minimum) hop count from the nearest root. Roots are 0. */
  hops: number;
  /** A fact joining this neighbour to a node one hop closer. Null for roots. */
  viaFactId: string | null;
  /** That fact's predicate. Null for roots. */
  viaPredicate: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELATIONSHIP_TYPE_RE = /^[A-Z_]{1,64}$/;

/** Bi-temporal "live now" predicate for a fact row aliased `f`.
 *  AGE could express neither half of this. */
const LIVE_FACT = sql`f.expired_at IS NULL AND (f.invalid_at IS NULL OR f.invalid_at > NOW())`;

/**
 * Traverse outward from one or more root entities over active facts.
 *
 * THE sanctioned traversal primitive (keep list §2.2: "SQL recursion over
 * public.facts — the only expiry-correct traversal path in the codebase"). It
 * returns the neighbour, its first-reached hop, AND a connecting fact in ONE
 * query. That matters: `graph-fallback.expandFromAnchors` previously re-walked the
 * graph once per depth level purely to recover each neighbour's hop, then issued
 * one `getEntityFacts` per reachable entity per anchor.
 *
 * Traversal is undirected — a fact relates its two endpoints and reachability
 * should not depend on which side the extractor happened to put first.
 *
 * Roots are excluded from the result (callers want neighbours). Value-only facts
 * (`object_entity_id IS NULL`) have no traversable endpoint and are skipped.
 */
export async function traverseFromEntities(
  rootIds: string[],
  options: {
    maxHops?: number;
    /**
     * Restrict to one corpus. DEFAULTS TO `null` = every corpus, which preserves
     * the AGE behaviour this replaced exactly: AGE nodes carry no `corpus_id`, so
     * every Cypher walk was cross-corpus. Defaulting to `'default'` here would
     * have silently returned `[]` for every caller working on a non-default
     * corpus — including the retrieval measurement harnesses — which is the
     * silent-no-op failure this whole pass is about. Corpus-scoping the traversal
     * is a real improvement and a SEPARATE change, with its callers updated
     * deliberately; it is not something to slip into an AGE-to-SQL swap.
     */
    corpusId?: string | null;
    /** Restrict traversal to facts with this predicate. */
    predicate?: string;
    limit?: number;
  } = {},
): Promise<TraversalNeighbour[]> {
  for (const id of rootIds) {
    if (!UUID_RE.test(id)) throw new Error(`Invalid entityId: ${id}`);
  }
  if (rootIds.length === 0) return [];

  const maxHops = Math.max(1, Math.min(Math.floor(options.maxHops ?? 1), 5));
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 5000));
  const corpusId = options.corpusId ?? null;
  const corpusFilter = corpusId === null ? sql`` : sql`AND f.corpus_id = ${corpusId}`;
  const predicateFilter = options.predicate === undefined ? sql`` : sql`AND f.predicate = ${options.predicate}`;

  // `UNION` (not UNION ALL) in the recursive term dedups against the working set,
  // so cycles terminate; `hops` is additionally bounded by maxHops.
  const rows = await rawQuery<{
    entityId: string;
    name: string;
    type: string;
    hops: number;
    viaFactId: string | null;
    viaPredicate: string | null;
  }>(sql`
    WITH RECURSIVE reach(node, hops) AS (
      SELECT e.id, 0
      FROM public.entities e
      WHERE e.id = ANY(${sql.raw(`ARRAY[${rootIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})
      UNION
      SELECT
        CASE WHEN f.subject_entity_id = r.node THEN f.object_entity_id ELSE f.subject_entity_id END,
        r.hops + 1
      FROM reach r
      JOIN public.facts f
        ON (f.subject_entity_id = r.node OR f.object_entity_id = r.node)
      WHERE r.hops < ${maxHops}
        AND ${LIVE_FACT}
        ${corpusFilter}
        ${predicateFilter}
        AND CASE WHEN f.subject_entity_id = r.node THEN f.object_entity_id ELSE f.subject_entity_id END IS NOT NULL
    ),
    -- A node reachable by several routes appears at several hop counts; the
    -- honest anchor-proximity number is the smallest.
    first_hop AS (
      SELECT node, MIN(hops) AS hops FROM reach GROUP BY node
    ),
    -- One representative inward fact per neighbour: any live fact joining it to a
    -- node exactly one hop closer. DISTINCT ON + ORDER BY f.id makes the choice
    -- deterministic, so repeated runs return byte-identical rows.
    via AS (
      SELECT DISTINCT ON (fh.node) fh.node, f.id AS via_fact_id, f.predicate AS via_predicate
      FROM first_hop fh
      JOIN public.facts f
        ON (f.subject_entity_id = fh.node OR f.object_entity_id = fh.node)
      JOIN first_hop prev
        ON prev.node = CASE WHEN f.subject_entity_id = fh.node THEN f.object_entity_id ELSE f.subject_entity_id END
       AND prev.hops = fh.hops - 1
      WHERE fh.hops > 0
        AND ${LIVE_FACT}
        ${corpusFilter}
        ${predicateFilter}
      ORDER BY fh.node, f.id
    )
    SELECT
      e.id::text        AS entity_id,
      e.canonical_name  AS name,
      e.entity_type     AS type,
      fh.hops           AS hops,
      v.via_fact_id::text   AS via_fact_id,
      v.via_predicate       AS via_predicate
    FROM first_hop fh
    JOIN public.entities e ON e.id = fh.node
    LEFT JOIN via v ON v.node = fh.node
    WHERE fh.hops > 0
    ORDER BY fh.hops, e.canonical_name
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    entityId: r.entityId,
    name: r.name,
    type: r.type,
    hops: Number(r.hops),
    viaFactId: r.viaFactId,
    viaPredicate: r.viaPredicate,
  }));
}

/**
 * Get all edges in the graph (optionally filtered by relationship type).
 *
 * `type` is `upper(replace(predicate, '-', '_'))`, matching what migration 001's
 * `create_entity_edge` wrote into AGE, so the filter keeps its old meaning.
 */
export async function getAllEdges(
  options: { relationshipType?: string; limit?: number; corpusId?: string | null } = {},
): Promise<GraphEdge[]> {
  const { relationshipType, limit = 500 } = options;
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 5000));
  const corpusId = options.corpusId ?? null;
  const corpusFilter = corpusId === null ? sql`` : sql`AND f.corpus_id = ${corpusId}`;

  let typeFilter = sql``;
  if (relationshipType) {
    const safeType = relationshipType.toUpperCase();
    if (!RELATIONSHIP_TYPE_RE.test(safeType)) {
      throw new Error('Invalid relationshipType: must contain only A-Z and underscores (max 64 chars)');
    }
    typeFilter = sql`AND upper(replace(f.predicate, '-', '_')) = ${safeType}`;
  }

  const rows = await rawQuery<{ fromId: string; toId: string; relType: string }>(sql`
    SELECT f.subject_entity_id::text AS from_id,
           f.object_entity_id::text  AS to_id,
           upper(replace(f.predicate, '-', '_')) AS rel_type
    FROM public.facts f
    WHERE f.object_entity_id IS NOT NULL
      AND ${LIVE_FACT}
      ${corpusFilter}
      ${typeFilter}
    ORDER BY f.id
    LIMIT ${safeLimit}
  `);

  return rows.map((row) => ({
    fromEntityId: row.fromId,
    toEntityId: row.toId,
    type: row.relType,
  }));
}

/**
 * Degree (number of incident active facts) per entity. Undirected, counting each
 * fact once per incident entity.
 */
export async function getEntityDegrees(
  entityIds?: string[],
  options: { corpusId?: string | null } = {},
): Promise<Map<string, number>> {
  if (entityIds) {
    for (const id of entityIds) {
      if (!UUID_RE.test(id)) throw new Error(`Invalid entityId: ${id}`);
    }
    if (entityIds.length === 0) return new Map();
  }
  const corpusId = options.corpusId ?? null;
  const corpusFilter = corpusId === null ? sql`` : sql`AND f.corpus_id = ${corpusId}`;
  const idFilter = entityIds
    ? sql`WHERE e.id = ANY(${sql.raw(`ARRAY[${entityIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})`
    : sql``;

  const rows = await rawQuery<{ id: string; degree: number }>(sql`
    SELECT e.id::text AS id, count(f.id) AS degree
    FROM public.entities e
    LEFT JOIN public.facts f
      ON (f.subject_entity_id = e.id OR f.object_entity_id = e.id)
     AND ${LIVE_FACT}
     ${corpusFilter}
    ${idFilter}
    GROUP BY e.id
  `);

  const degrees = new Map<string, number>();
  for (const row of rows) degrees.set(row.id, Number(row.degree));
  return degrees;
}

/**
 * Subgraph around a set of seed entities: the seeds, everything within
 * `maxDepth` hops, and the active facts among them.
 */
export async function getSubgraph(
  seedEntityIds: string[],
  options: { maxDepth?: number; limit?: number; corpusId?: string | null } = {},
): Promise<{ nodes: GraphEntity[]; edges: GraphEdge[] }> {
  const { maxDepth = 2, limit = 200 } = options;
  const safeDepth = Math.max(1, Math.min(Math.floor(maxDepth), 5));
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));

  for (const id of seedEntityIds) {
    if (!UUID_RE.test(id)) throw new Error(`Invalid entityId: ${id}`);
  }
  if (seedEntityIds.length === 0) return { nodes: [], edges: [] };

  const neighbours = await traverseFromEntities(seedEntityIds, {
    maxHops: safeDepth,
    limit: safeLimit,
    corpusId: options.corpusId,
  });

  // Seeds are part of their own subgraph; traverseFromEntities returns neighbours only.
  const seedRows = await rawQuery<{ entityId: string; name: string; type: string }>(sql`
    SELECT e.id::text AS entity_id, e.canonical_name AS name, e.entity_type AS type
    FROM public.entities e
    WHERE e.id = ANY(${sql.raw(`ARRAY[${seedEntityIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})
  `);

  const nodes: GraphEntity[] = [
    ...seedRows.map((r) => ({ entityId: r.entityId, name: r.name, type: r.type })),
    ...neighbours
      .filter((n) => !seedEntityIds.includes(n.entityId))
      .map((n) => ({ entityId: n.entityId, name: n.name, type: n.type })),
  ];

  const nodeIds = nodes.map((n) => n.entityId);
  if (nodeIds.length === 0) return { nodes, edges: [] };

  const corpusId = options.corpusId ?? null;
  const corpusFilter = corpusId === null ? sql`` : sql`AND f.corpus_id = ${corpusId}`;
  const idArray = sql.raw(`ARRAY[${nodeIds.map((id) => `'${id}'`).join(',')}]::uuid[]`);

  const edgeRows = await rawQuery<{ fromId: string; toId: string; relType: string }>(sql`
    SELECT f.subject_entity_id::text AS from_id,
           f.object_entity_id::text  AS to_id,
           upper(replace(f.predicate, '-', '_')) AS rel_type
    FROM public.facts f
    WHERE f.subject_entity_id = ANY(${idArray})
      AND f.object_entity_id = ANY(${idArray})
      AND ${LIVE_FACT}
      ${corpusFilter}
    ORDER BY f.id
    LIMIT ${safeLimit}
  `);

  return {
    nodes,
    edges: edgeRows.map((r) => ({ fromEntityId: r.fromId, toEntityId: r.toId, type: r.relType })),
  };
}

/**
 * Entities connected to a given entity within `maxDepth` hops.
 *
 * The API is unchanged from the AGE implementation so its four callers
 * (causal-agent, entity-profile, graph-fallback) need no edit — they now
 * read a graph that matches Postgres and honours expiry.
 *
 * `relationshipType` keeps the AGE convention (uppercased, underscored) and is
 * mapped back onto the predicate.
 */
export async function findConnectedEntities(
  entityId: string,
  options: { relationshipType?: string; maxDepth?: number; limit?: number; corpusId?: string | null } = {},
): Promise<GraphEntity[]> {
  const { relationshipType, maxDepth = 1, limit = 50 } = options;

  if (!UUID_RE.test(entityId)) {
    throw new Error('Invalid entityId: must be a valid UUID');
  }

  let predicate: string | undefined;
  if (relationshipType) {
    const safeType = relationshipType.toUpperCase();
    if (!RELATIONSHIP_TYPE_RE.test(safeType)) {
      throw new Error('Invalid relationshipType: must contain only A-Z and underscores (max 64 chars)');
    }
    // AGE stored upper(replace(predicate,'-','_')); predicates are lower-case with
    // underscores, so the inverse is a lower-case. A predicate that used a hyphen
    // is not recoverable from the uppercased form, which is a pre-existing
    // limitation of the AGE convention, not a new one.
    predicate = safeType.toLowerCase();
  }

  const neighbours = await traverseFromEntities([entityId], {
    maxHops: Math.max(1, Math.min(Math.floor(maxDepth), 5)),
    limit: Math.max(1, Math.min(Math.floor(limit), 200)),
    corpusId: options.corpusId,
    predicate,
  });

  return neighbours.map((n) => ({ entityId: n.entityId, name: n.name, type: n.type }));
}
