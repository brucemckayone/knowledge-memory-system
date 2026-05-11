-- Migration 012: Gardener observability columns
-- Adds trace_id and outputs to gardener_job_meta for pipeline tracing and metrics recording.

ALTER TABLE gardener_job_meta ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE gardener_job_meta ADD COLUMN IF NOT EXISTS outputs JSONB;
CREATE INDEX IF NOT EXISTS idx_gardener_job_meta_trace ON gardener_job_meta(trace_id);
