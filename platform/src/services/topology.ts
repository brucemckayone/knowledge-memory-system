/**
 * Topology service (bead nmemo-2yv.88).
 *
 * Phase 2 (doc 23 §2.4 + 23.1 §3.3) topology read functions, extracted from
 * inline route handlers in index.ts so the SELECT/serialisation logic is
 * testable in isolation (without spinning up the full Hono app) and so the
 * auto-trigger plumbing from .84 has a natural home.
 *
 * Mirrors the pattern of `cross-cluster-generator.ts` and `derived-freshness.ts`
 * — pure functions over `db.execute(sql\`...\`)`, no Hono types, no req/res
 * shaping beyond the JSON-friendly DTO. The route handler in index.ts becomes
 * a thin: parse request → call service → format response.
 *
 * Shared `parsePredicateSignature` helper lives here (rather than in a generic
 * util file) because the topology snapshot is the canonical consumer of the
 * predicate_signature column; cross-cluster-generator imports it to satisfy
 * bead acceptance item 5 (deduplicate parseVector/predicate_signature parsing).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/** ============================================================
 * Shared pgvector text parser.
 *
 * pgvector returns "[0.1,0.2,...]" when cast to text. Returns null when the
 * source value is missing or unparseable (zero-norm column, malformed text).
 *
 * Single source of truth for the predicate_signature column parse — both this
 * module (GET /api/topology serialisation) and cross-cluster-generator.ts
 * (signal computation input) call it. See bead nmemo-2yv.88 acceptance item 5.
 * ============================================================ */
export function parsePredicateSignature(raw: unknown): number[] | null {
  if (raw == null) return null;
  const s = String(raw);
  if (!s) return null;
  const trimmed = s.replace(/^\[|\]$/g, '');
  if (!trimmed) return null;
  const parts = trimmed.split(',').map((x) => Number.parseFloat(x));
  return parts.every((x) => Number.isFinite(x)) ? parts : null;
}

/** ============================================================
 * /api/topology snapshot (viz.2). One row per entity with all 5 Phase 2
 * features plus the global bridges list. Cheap when pre-computed.
 * ============================================================ */

export interface TopologyEntityDTO {
  id: string;
  componentId: number | null;
  componentSize: number | null;
  kCore: number | null;
  isArticulationPoint: boolean;
  communityId: number | null;
  participationCoef: number | null;
  pagerank: number | null;
  betweennessSampled: number | null;
  predicateSignature: number[] | null;
  computedAt: string | null;
}

export interface TopologyBridgeDTO {
  sourceEntityId: string;
  targetEntityId: string;
  factId: string | null;
  sameAsLinkId: string | null;
  computedAt: string;
}

export interface TopologySnapshot {
  entities: TopologyEntityDTO[];
  bridges: TopologyBridgeDTO[];
}

interface TopologyEntityRow {
  entity_id: string;
  component_id: number | null;
  component_size: number | null;
  k_core: number | null;
  is_articulation_point: boolean;
  community_id: number | null;
  participation_coef: number | null;
  pagerank: number | null;
  betweenness_sampled: number | null;
  predicate_signature: string | null;
  computed_at: Date | null;
  computation_version: number | null;
}

interface TopologyBridgeRow {
  source_entity_id: string;
  target_entity_id: string;
  fact_id: string | null;
  same_as_link_id: string | null;
  computed_at: Date;
}

export async function getTopologySnapshot(): Promise<TopologySnapshot> {
  const entityRows = (await db.execute(sql`
    SELECT
      entity_id::text             AS entity_id,
      component_id,
      component_size,
      k_core,
      is_articulation_point,
      community_id,
      participation_coef,
      pagerank,
      betweenness_sampled,
      predicate_signature::text   AS predicate_signature,
      computed_at,
      computation_version
    FROM public.entity_topology
  `)) as unknown as TopologyEntityRow[];

  const bridgeRows = (await db.execute(sql`
    SELECT
      source_entity_id::text  AS source_entity_id,
      target_entity_id::text  AS target_entity_id,
      fact_id::text           AS fact_id,
      same_as_link_id::text   AS same_as_link_id,
      computed_at
    FROM public.topology_bridges
  `)) as unknown as TopologyBridgeRow[];

  const entities: TopologyEntityDTO[] = entityRows.map((r) => ({
    id: r.entity_id,
    componentId: r.component_id,
    componentSize: r.component_size,
    kCore: r.k_core,
    isArticulationPoint: r.is_articulation_point,
    communityId: r.community_id,
    participationCoef: r.participation_coef,
    pagerank: r.pagerank,
    betweennessSampled: r.betweenness_sampled,
    predicateSignature: parsePredicateSignature(r.predicate_signature),
    computedAt: r.computed_at instanceof Date ? r.computed_at.toISOString() : null,
  }));

  const bridges: TopologyBridgeDTO[] = bridgeRows.map((r) => ({
    sourceEntityId: r.source_entity_id,
    targetEntityId: r.target_entity_id,
    factId: r.fact_id,
    sameAsLinkId: r.same_as_link_id,
    computedAt: r.computed_at instanceof Date ? r.computed_at.toISOString() : String(r.computed_at),
  }));

  return { entities, bridges };
}

/** ============================================================
 * /api/components/:component_id — entities sharing a component_id.
 * Returns null when the parsed id is non-integer (route handler maps to 400).
 * Empty-component case is shaped (size=0, entities=[]) — caller doesn't need
 * to special-case the "no rows" branch.
 * ============================================================ */

export interface ComponentEntityDTO {
  id: string;
  canonical_name: string;
  entity_type: string;
}

export interface ComponentDetails {
  component_id: number;
  size: number;
  computed_at?: string;
  computation_version?: number;
  entities: ComponentEntityDTO[];
}

interface ComponentRow {
  entity_id: string;
  canonical_name: string;
  entity_type: string;
  component_id: number;
  component_size: number;
  computed_at: Date;
  computation_version: number;
}

export async function getComponentEntities(componentId: number): Promise<ComponentDetails> {
  const rows = (await db.execute(sql`
    SELECT
      e.id::text             AS entity_id,
      e.canonical_name       AS canonical_name,
      e.entity_type          AS entity_type,
      et.component_id        AS component_id,
      et.component_size      AS component_size,
      et.computed_at         AS computed_at,
      et.computation_version AS computation_version
    FROM public.entity_topology et
    JOIN public.entities e ON e.id = et.entity_id
    WHERE et.component_id = ${componentId}
    ORDER BY e.canonical_name ASC
  `)) as unknown as ComponentRow[];

  if (rows.length === 0) {
    return { component_id: componentId, size: 0, entities: [] };
  }

  const head = rows[0]!;
  return {
    component_id: head.component_id,
    size: head.component_size,
    computed_at: head.computed_at instanceof Date ? head.computed_at.toISOString() : String(head.computed_at),
    computation_version: head.computation_version,
    entities: rows.map((r) => ({
      id: r.entity_id,
      canonical_name: r.canonical_name,
      entity_type: r.entity_type,
    })),
  };
}
