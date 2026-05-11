-- 015_entity_clusters.sql — Phase 3 (T1 semantic-space) HDBSCAN clustering schema.
-- Implements docs/architecture/truth-graph/24.1-hdbscan-clustering.md §3.2 + §3.3
-- and the master §10 centroid-lifecycle lock B (21-cluster-bridging-master.md).
--
-- One row per entity that participated in the most recent clustering run.
-- entity_clusters.centroid_snapshot is the FROZEN copy of entity_meta.centroid
-- at clustering time; drift detection (24.2) compares live vs snapshot.
--
-- AGE search_path gotcha (per CLAUDE.md / 014 header): all DDL uses explicit
-- public. qualifiers so objects land in public, not ag_catalog.

-- ============================================================
-- entity_clusters — per-entity HDBSCAN cluster assignment (§3.2)
-- ============================================================
-- cluster_id is INTEGER (signed) — HDBSCAN's noise label is -1, preserved.
-- centroid_snapshot is NOT NULL: every row has a frozen vector at the moment
-- of clustering. Drift detection (24.2) compares the entity's current
-- entity_meta.centroid against this snapshot.
CREATE TABLE IF NOT EXISTS public.entity_clusters (
  entity_id              UUID PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,

  -- HDBSCAN output (canonicalised: 0 = largest cluster, 1 = next, ..., -1 = noise).
  cluster_id             INTEGER NOT NULL,

  -- Frozen centroid at clustering time (master §10 lock B). Drift detection
  -- compares live entity_meta.centroid against this snapshot.
  centroid_snapshot      VECTOR(768) NOT NULL,

  -- HDBSCAN soft probability of cluster membership (NULL for noise per §2.2).
  cluster_probability    FLOAT,

  -- Denormalised count of entities sharing this cluster_id (kept in sync per §3.2).
  cluster_size           INTEGER,

  -- Bookkeeping
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computation_version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_entity_clusters_cluster_id
  ON public.entity_clusters (cluster_id);
CREATE INDEX IF NOT EXISTS idx_entity_clusters_probability
  ON public.entity_clusters (cluster_probability);
CREATE INDEX IF NOT EXISTS idx_entity_clusters_version
  ON public.entity_clusters (computation_version);

-- ============================================================
-- clustering_compute_runs — concurrency / progress tracking (§8.1 mirror)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.clustering_compute_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  status              VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  computation_version INTEGER NOT NULL,
  entities_processed  INTEGER,
  cluster_count       INTEGER,
  noise_count         INTEGER,
  error_detail        TEXT,

  CONSTRAINT clustering_runs_status CHECK (status IN ('in_progress', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_clustering_runs_status
  ON public.clustering_compute_runs (status, started_at DESC);
