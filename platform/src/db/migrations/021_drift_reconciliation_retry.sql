-- 021_drift_reconciliation_retry.sql — Drift-reconciliation attempt tracking.
--
-- Background: bead nmemo-2yv.83. The /reconciliation-agent/drift endpoint
-- exists in ml-services but has never been invoked from the platform. This
-- migration adds the bookkeeping column needed by the new platform-side
-- caller (triggerReconciliationDriftAfterCompute) to distinguish:
--   * transient failures (HTTP 5xx, timeouts, QueueFullError 503,
--     connection refused) — increment counter, retry on next cycle.
--   * permanent failures (HTTP 400/404 OR counter reaches
--     MAX_RECONCILIATION_ATTEMPTS) — flip triggered_action to
--     'reconciliation_failed' (the dead enum value at 016:87 becomes
--     reachable).
--
-- Decoupled from "rows from this call" selection — the caller queries ALL
-- pending rows where attempt_count < MAX, which is robust against process
-- crashes between compute and reconciliation.
--
-- AGE search_path gotcha (per CLAUDE.md / 016 header): explicit public.
-- qualifier so the ALTER lands on the right table even when the session
-- search_path puts ag_catalog first.

ALTER TABLE public.entity_drift_events
  ADD COLUMN IF NOT EXISTS reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0;

-- Composite index for the caller's hot SELECT: pending rows ordered by age.
-- Partial-on-pending shape keeps it tight (most rows are 'logged_only' or
-- already-resolved 'reconciliation_invoked' with a run_id).
CREATE INDEX IF NOT EXISTS idx_entity_drift_events_pending_reconciliation
  ON public.entity_drift_events (detected_at ASC)
  WHERE triggered_action = 'reconciliation_invoked'
    AND reconciliation_run_id IS NULL;
