-- nmemo-2yv.92 — Cross-cluster generator telemetry run table.
--
-- Mirrors topology_compute_runs / clustering_compute_runs so the generator's
-- skip-rate, drift-driven-candidate ratio, and duration trend become first-class
-- operational signals instead of dying in a console.log. Closes T9 (observability
-- gap) for the cross-cluster compute.
--
-- The writer (cross-cluster-generator.ts) INSERTs a 'running' row in a short
-- separate transaction BEFORE opening the advisory-lock transaction, then
-- UPDATEs the row to 'completed' / 'skipped' / 'error' after the main tx
-- resolution. The separate-tx INSERT means the row survives main-tx rollback —
-- error paths still leave a forensic record.

CREATE TABLE IF NOT EXISTS public.cross_cluster_runs (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at              TIMESTAMPTZ,
  status                    VARCHAR(20) NOT NULL DEFAULT 'running',
  skipped_reason            VARCHAR(40),
  component_pairs_evaluated INTEGER,
  candidates_inserted       INTEGER,
  drift_driven_candidates   INTEGER,
  duration_ms               INTEGER,
  error                     TEXT,
  CONSTRAINT cross_cluster_runs_status CHECK (status IN ('running','completed','skipped','error'))
);

CREATE INDEX IF NOT EXISTS idx_cross_cluster_runs_started
  ON public.cross_cluster_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cross_cluster_runs_status
  ON public.cross_cluster_runs (status)
  WHERE status != 'completed';
