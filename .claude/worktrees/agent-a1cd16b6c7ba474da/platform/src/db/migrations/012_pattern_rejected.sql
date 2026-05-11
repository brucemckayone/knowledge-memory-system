-- 012_pattern_rejected.sql — Phase 6 of Reasoning Layer Hardening (nmemo-d9v.1)
--
-- Extends `valid_pattern_status` on causal_patterns to allow `rejected` as a
-- terminal lifecycle status. Patterns reach `rejected` when they sit in
-- `staging` for the configured dwell window without ever activating — see
-- `promotePatterns()` rejection branch in services/causal-patterns.ts.
--
-- Schema otherwise unchanged: causal_patterns was created with the full
-- lifecycle in 002_causal_graph.sql, just without the `rejected` value.
--
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user"
-- at session level. DO NOT change it. All DDL uses explicit public. qualifier
-- so the constraint lands on the right table.
--
-- Forward-only and idempotent: the DO block re-checks the constraint state
-- before mutating, so re-running this migration is a no-op once `rejected`
-- is allowed.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'causal_patterns'
      AND c.conname = 'valid_pattern_status'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%rejected%'
  ) THEN
    ALTER TABLE public.causal_patterns DROP CONSTRAINT valid_pattern_status;
    ALTER TABLE public.causal_patterns ADD CONSTRAINT valid_pattern_status CHECK (
      status IN ('staging', 'candidate', 'provisional', 'canonical', 'rejected')
    );
  END IF;
END $$;
