/**
 * Clustering service (bead nmemo-2yv.88).
 *
 * Phase 3 (doc 24.1) clustering read functions, extracted from inline route
 * handlers in index.ts so the SELECT/serialisation logic is testable in
 * isolation and so the auto-trigger plumbing from .84 has a natural home.
 *
 * Mirrors the pattern of `cross-cluster-generator.ts` and `derived-freshness.ts`
 * — pure functions over `db.execute(sql\`...\`)`, no Hono types, no req/res
 * shaping beyond the JSON-friendly DTO.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/** ============================================================
 * /api/clusters snapshot (viz.3). One row per entity that participated in
 * the most recent clustering run. centroid_snapshot is intentionally skipped
 * (768 floats × N is too heavy for a polled endpoint); getClusterEntities()
 * returns it on demand per-cluster.
 * ============================================================ */

export interface ClusterEntitySummaryDTO {
  id: string;
  clusterId: number;
  clusterProbability: number | null;
  clusterSize: number | null;
}

export interface ClustersSnapshot {
  entities: ClusterEntitySummaryDTO[];
  summary: Record<string, number>;
  noiseCount: number;
  clusterCount: number;
  computedAt: string | null;
}

interface ClusterEntityRow {
  entity_id: string;
  cluster_id: number;
  cluster_probability: number | null;
  cluster_size: number | null;
  computed_at: Date;
}

interface ClusterSummaryRow {
  cluster_id: number;
  size: number;
}

export async function getClustersSnapshot(): Promise<ClustersSnapshot> {
  const [entityRows, summaryRows] = await Promise.all([
    db.execute(sql`
      SELECT
        entity_id::text       AS entity_id,
        cluster_id,
        cluster_probability,
        cluster_size,
        computed_at
      FROM public.entity_clusters
    `) as unknown as Promise<ClusterEntityRow[]>,
    db.execute(sql`
      SELECT cluster_id, COUNT(*)::int AS size
      FROM public.entity_clusters
      GROUP BY cluster_id
      ORDER BY cluster_id
    `) as unknown as Promise<ClusterSummaryRow[]>,
  ]);

  const summary: Record<string, number> = {};
  let noiseCount = 0;
  let clusterCount = 0;
  for (const r of summaryRows) {
    summary[String(r.cluster_id)] = r.size;
    if (r.cluster_id === -1) noiseCount = r.size;
    else clusterCount += 1;
  }

  let computedAt: string | null = null;
  if (entityRows.length > 0 && entityRows[0]!.computed_at instanceof Date) {
    computedAt = entityRows[0]!.computed_at.toISOString();
  }

  return {
    entities: entityRows.map((r) => ({
      id: r.entity_id,
      clusterId: r.cluster_id,
      clusterProbability: r.cluster_probability,
      clusterSize: r.cluster_size,
    })),
    summary,
    noiseCount,
    clusterCount,
    computedAt,
  };
}

/** ============================================================
 * /api/clusters/:cluster_id — entities in a single cluster, ordered by
 * cluster_probability DESC. cluster_id = -1 is the HDBSCAN noise bucket;
 * the route handler validates the integer parse but otherwise this function
 * accepts any integer and returns a shaped empty result for unknown ids.
 * ============================================================ */

export interface ClusterEntityDTO {
  id: string;
  canonical_name: string;
  entity_type: string;
  cluster_probability: number | null;
}

export interface ClusterDetails {
  cluster_id: number;
  /** `cluster_size` from the head row, which may be NULL in older datasets;
   *  empty-result branch returns 0. Caller (the route serialiser) passes
   *  through unchanged for wire compatibility with the inline-route shape. */
  size: number | null;
  computed_at?: string;
  computation_version?: number;
  entities: ClusterEntityDTO[];
}

interface ClusterDetailRow {
  entity_id: string;
  canonical_name: string;
  entity_type: string;
  cluster_id: number;
  cluster_size: number | null;
  cluster_probability: number | null;
  computed_at: Date;
  computation_version: number;
}

export async function getClusterEntities(clusterId: number): Promise<ClusterDetails> {
  const rows = (await db.execute(sql`
    SELECT
      e.id::text             AS entity_id,
      e.canonical_name       AS canonical_name,
      e.entity_type          AS entity_type,
      ec.cluster_id          AS cluster_id,
      ec.cluster_size        AS cluster_size,
      ec.cluster_probability AS cluster_probability,
      ec.computed_at         AS computed_at,
      ec.computation_version AS computation_version
    FROM public.entity_clusters ec
    JOIN public.entities e ON e.id = ec.entity_id
    WHERE ec.cluster_id = ${clusterId}
    ORDER BY ec.cluster_probability DESC NULLS LAST, e.canonical_name ASC
  `)) as unknown as ClusterDetailRow[];

  if (rows.length === 0) {
    return { cluster_id: clusterId, size: 0, entities: [] };
  }

  const head = rows[0]!;
  return {
    cluster_id: head.cluster_id,
    size: head.cluster_size,
    computed_at: head.computed_at instanceof Date ? head.computed_at.toISOString() : String(head.computed_at),
    computation_version: head.computation_version,
    entities: rows.map((r) => ({
      id: r.entity_id,
      canonical_name: r.canonical_name,
      entity_type: r.entity_type,
      cluster_probability: r.cluster_probability,
    })),
  };
}
