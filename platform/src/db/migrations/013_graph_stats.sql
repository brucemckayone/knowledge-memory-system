-- 013_graph_stats.sql — Graph-level aggregate statistics (singleton)
-- Operationalises 06-graph-meta-layer.md lines 150-202 ("Graph-Level
-- Statistics — Phase 2+"). Phase 1 of cluster-bridging master plan (21).
-- Spec: 22-graph-stats-foundation.md §3.1.
--
-- Why a singleton: graph_stats answers "what does the graph look like in
-- aggregate" — the question has exactly one answer at any instant. History
-- (graph_stats_history) is doc 06 line 146 future work, deferred.
--
-- AGE search_path gotcha (per CLAUDE.md): 001_consolidated.sql sets
-- search_path = ag_catalog, public, "$user" at session level. DO NOT change
-- it. All DDL uses explicit public. qualifier so the table lands in public,
-- not ag_catalog.
--
-- Forward-only and idempotent: CREATE TABLE IF NOT EXISTS + ON CONFLICT
-- DO NOTHING for the seed row.

CREATE TABLE IF NOT EXISTS public.graph_stats (
  id                          INTEGER PRIMARY KEY DEFAULT 1,

  -- Scale
  total_entities              INTEGER NOT NULL DEFAULT 0,
  total_facts                 INTEGER NOT NULL DEFAULT 0,
  total_active_facts          INTEGER NOT NULL DEFAULT 0,
  total_memories              INTEGER NOT NULL DEFAULT 0,

  -- Embedding clusters (populated by Phase 3 HDBSCAN; NULL until then).
  -- Terminology lock per master §10: "embedding cluster" = HDBSCAN output,
  -- not the legacy "culture" term from doc 06.
  embedding_cluster_count     INTEGER,
  mean_intra_cluster_distance FLOAT,
  mean_inter_cluster_distance FLOAT,

  -- Centroid distribution (sampled pairwise centroid similarities)
  centroid_sim_mean           FLOAT,
  centroid_sim_median         FLOAT,
  centroid_sim_p10            FLOAT,
  centroid_sim_p90            FLOAT,
  centroid_sample_size        INTEGER,

  -- Graph health
  fact_density                FLOAT,
  orphan_rate                 FLOAT,
  predicate_diversity         INTEGER,
  merge_candidates_pending    INTEGER NOT NULL DEFAULT 0,

  -- Bookkeeping
  computed_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computed_duration_ms        INTEGER,
  computation_version         INTEGER NOT NULL DEFAULT 1,
  cluster_columns_version     INTEGER,

  CONSTRAINT graph_stats_singleton CHECK (id = 1)
);

INSERT INTO public.graph_stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
