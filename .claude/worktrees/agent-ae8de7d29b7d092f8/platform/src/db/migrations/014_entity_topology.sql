-- 014_entity_topology.sql — Phase 2 (T0 topology primitives) shared schema.
-- Implements docs/architecture/truth-graph/23-topology-primitives.md §2.1, §2.2, §8.1.
-- One row per entity covering all five Phase 2 features (component / k-core /
-- articulation / community / centrality), one bridges table, one runs table.
--
-- DP1 (a) per scoping report: full Phase 2 schema lands here in one migration.
-- Children .2.1–.2.5 write progressively into NULL-tolerant columns; no
-- per-feature migration churn.
--
-- AGE search_path gotcha (CLAUDE.md / 013 header): all DDL uses explicit
-- public. qualifiers so objects land in public, not ag_catalog.
--
-- predicate_signature VECTOR(25) per master §10 lock B (cold-eyes review,
-- 21 §10) — Phase 4 role_similarity needs it on entity_topology. Column
-- lands here NULL-by-default; the compute path is owned by a Phase 2 child
-- (TBD) or Phase 4 prep. N=25 reflects the canonical vocabulary in
-- src/services/predicates.ts at migration time.

-- ============================================================
-- entity_topology — per-entity topology summary (§2.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.entity_topology (
  entity_id              UUID PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,

  -- 23.1 Connected components
  component_id           INTEGER,                  -- 0..N-1; NULL until first compute
  component_size         INTEGER,                  -- size of this entity's component

  -- 23.2 k-core decomposition
  k_core                 INTEGER,                  -- 0=orphan, 1=leaf, k≥2=embedded

  -- 23.3 Articulation
  is_articulation_point  BOOLEAN NOT NULL DEFAULT FALSE,
  -- (Bridges live in topology_bridges below — they're edge-level.)

  -- 23.4 Community detection (Leiden)
  community_id           INTEGER,
  participation_coef     FLOAT,                    -- Guimerà-Amaral

  -- 23.5 Centrality
  pagerank               FLOAT,                    -- normalised so column sums to 1
  betweenness_sampled    FLOAT,

  -- Master §10 lock B — Phase 4 role_similarity input
  predicate_signature    VECTOR(25),               -- L2-normalised sparse vector over canonical predicate vocab

  -- Bookkeeping
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computation_version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_entity_topology_component
  ON public.entity_topology (component_id);
CREATE INDEX IF NOT EXISTS idx_entity_topology_community
  ON public.entity_topology (community_id);
CREATE INDEX IF NOT EXISTS idx_entity_topology_articulation
  ON public.entity_topology (is_articulation_point) WHERE is_articulation_point = TRUE;
CREATE INDEX IF NOT EXISTS idx_entity_topology_pagerank
  ON public.entity_topology (pagerank DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_entity_topology_betweenness
  ON public.entity_topology (betweenness_sampled DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_entity_topology_version
  ON public.entity_topology (computation_version);

-- ============================================================
-- topology_bridges — edge-level bridges (§2.2). Empty until Phase 2 23.3 lands.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.topology_bridges (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id             UUID,
  same_as_link_id     UUID,
  source_entity_id    UUID NOT NULL,
  target_entity_id    UUID NOT NULL,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computation_version INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT topology_bridges_one_kind CHECK (
    (fact_id IS NOT NULL)::int + (same_as_link_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT topology_bridges_ordering CHECK (source_entity_id < target_entity_id),
  CONSTRAINT topology_bridges_unique UNIQUE (source_entity_id, target_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_topology_bridges_source
  ON public.topology_bridges (source_entity_id);
CREATE INDEX IF NOT EXISTS idx_topology_bridges_target
  ON public.topology_bridges (target_entity_id);

-- ============================================================
-- topology_compute_runs — concurrency / progress tracking (§8.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.topology_compute_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  status              VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  computation_version INTEGER NOT NULL,
  entities_processed  INTEGER,
  error_detail        TEXT,

  CONSTRAINT topology_runs_status CHECK (status IN ('in_progress', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_topology_runs_status
  ON public.topology_compute_runs (status, started_at DESC);
