-- 052_extraction_failures.sql — durable extraction-failure signal (G5 partial)
--
-- drainExtraction() previously dropped a failed extract() silently (in-memory
-- only; a process restart lost it). This table is the durable, queryable
-- developer surface: every failed extract UPSERTs a row so an operator can
-- see which memories never got entities/edges and why. The full G5 durable-
-- jobs follow-up (re-enqueue-on-startup) is DEFERRED; this migration ships
-- only the table the catch-arm writes to.
--
-- Additive + idempotent (the migrate runner replays every .sql file on boot).
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user" at
-- session level and we MUST NOT change it. So all DDL uses explicit public.
-- qualifiers — without them new objects would land in ag_catalog. See
-- 050_recent_index.sql / 051_onboarding_state.sql for the same constraint.

-- ============================================
-- extraction_failures
-- ============================================
-- One row per memory_id whose extract() threw. UPSERTed by drainExtraction's
-- catch arm: attempts increments, last_error + last_attempted_at refresh.
-- memory_id has no FK (memories live in Qdrant, not Postgres) — same posture
-- as memory_index.memory_id / capture_idempotency.memory_id.
CREATE TABLE IF NOT EXISTS public.extraction_failures (
  memory_id          TEXT PRIMARY KEY,
  attempts           INT NOT NULL DEFAULT 1,
  last_error         TEXT,
  last_attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- capture_idempotency.memory_id NULL allowance
-- ============================================
-- /ingest's atomic dedup now INSERTs the idempotency row FIRST (with
-- onConflictDoNothing) BEFORE store() mints the memory_id, closing the
-- check-then-store TOCTOU. That requires the row to exist briefly with no
-- memory_id yet (NULL), backfilled once store() returns. Drop the NOT NULL
-- constraint 049 set. Idempotent: ALTER COLUMN ... DROP NOT NULL is a no-op on
-- re-run once the column is already nullable.
ALTER TABLE public.capture_idempotency
  ALTER COLUMN memory_id DROP NOT NULL;

