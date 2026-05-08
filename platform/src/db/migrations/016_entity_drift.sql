-- 016_entity_drift.sql — Phase 3 (T1 semantic-space) ADWIN drift detection schema.
-- Implements docs/architecture/truth-graph/24.2-drift-detection.md §2.4 + §3
-- and the master §10 cluster-bridging locks for drift (21-cluster-bridging-master.md
-- lines 427-431).
--
-- Adds two side tables:
--   * entity_drift_state  — per-entity ADWIN detector state (pickle blob),
--     observation_count, last_cluster_id (reset trigger), river_version.
--   * entity_drift_events — append-only drift event log including
--     target_cluster_id (nearest cluster the entity drifted toward) and
--     triggered_action (logged_only / reconciliation_invoked / reconciliation_failed).
--
-- AGE search_path gotcha (per CLAUDE.md / 015 header): all DDL uses explicit
-- public. qualifiers so objects land in public, not ag_catalog.

-- ============================================================
-- entity_drift_state — per-entity ADWIN bookkeeping (§2.4)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.entity_drift_state (
  entity_id          UUID PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,

  -- Pickled river.drift.ADWIN object. Bytes only; not human-inspectable.
  -- Wrap pickle.loads in try/except — corrupted bytes reset to fresh.
  adwin_state_blob   BYTEA NOT NULL,

  observation_count  INTEGER NOT NULL DEFAULT 0,

  -- Master §10 cluster-reassignment lock (line 430). Compared against
  -- entity_clusters.cluster_id at compute time; mismatch resets ADWIN.
  last_cluster_id    INTEGER,

  -- Master §10 river-version lock (line 431). Read river.__version__ on
  -- unpickle; if mismatch, reset state and log a warning.
  river_version      VARCHAR(20) NOT NULL,

  last_updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_drift_state_last_cluster
  ON public.entity_drift_state (last_cluster_id);
CREATE INDEX IF NOT EXISTS idx_entity_drift_state_updated_at
  ON public.entity_drift_state (last_updated_at);

-- ============================================================
-- entity_drift_events — append-only drift event log (§3.2)
-- ============================================================
-- Per-event row: ADWIN flagged a distribution shift on this entity at this
-- time. drift_magnitude clamped to [0,1] in compute (review W2). Event is
-- preserved even if the reconciliation_agent invocation fails (master §10
-- lock + §6 edge case).
CREATE TABLE IF NOT EXISTS public.entity_drift_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,

  detected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- max(0, min(1, 1 - cosine(live, snapshot))). Clamped to [0,1] (§2.2 W2).
  drift_magnitude          REAL NOT NULL,

  -- Centroid pair captured at event time for audit / replay.
  centroid_snapshot        VECTOR(768) NOT NULL,
  centroid_current         VECTOR(768) NOT NULL,

  -- Cluster the entity belonged to at detection (entity_clusters.cluster_id).
  cluster_id_at_detection  INTEGER,

  -- Master §10 drifted-toward-cluster lock (line 429). Cluster whose
  -- centroid (mean of entity_clusters.centroid_snapshot per cluster_id) is
  -- nearest to centroid_current. Computed at event-emission time. NULL when
  -- no other cluster exists (single-cluster corpus, or all noise).
  target_cluster_id        INTEGER,

  -- 'logged_only' (below action threshold), 'reconciliation_invoked',
  -- 'reconciliation_failed'. Defaults to 'logged_only' so events without
  -- explicit action wiring still record cleanly.
  triggered_action         VARCHAR(40) NOT NULL DEFAULT 'logged_only',

  -- Optional run id from the reconciliation agent (success path).
  reconciliation_run_id    TEXT,

  -- Optional error message (failure path).
  error_detail             TEXT,

  computation_version      INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT entity_drift_events_action_check CHECK (
    triggered_action IN ('logged_only', 'reconciliation_invoked', 'reconciliation_failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_entity_drift_events_entity
  ON public.entity_drift_events (entity_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_drift_events_detected_at
  ON public.entity_drift_events (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_drift_events_action
  ON public.entity_drift_events (triggered_action);
CREATE INDEX IF NOT EXISTS idx_entity_drift_events_target_cluster
  ON public.entity_drift_events (target_cluster_id);

-- ============================================================
-- drift_compute_runs — concurrency / progress tracking (mirrors clustering_compute_runs)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.drift_compute_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  status               VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  computation_version  INTEGER NOT NULL,
  entities_processed   INTEGER,
  drift_events_count   INTEGER,
  error_detail         TEXT,

  CONSTRAINT drift_runs_status CHECK (status IN ('in_progress', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_drift_runs_status
  ON public.drift_compute_runs (status, started_at DESC);
