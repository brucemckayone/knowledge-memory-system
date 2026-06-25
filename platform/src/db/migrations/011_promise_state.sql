-- 011_promise_state.sql — Promise state columns (ASK-016)
--
-- Adds the promise-lifecycle columns to facts so commitment predicates
-- (plans_to / intends_to / committed_to — see predicate-ontology.ts) can carry
-- nudge state and a completion resolution. Surfaced as the home "holding" set;
-- the state machine (held -> ripening -> nudged -> done / let-go) derives from
-- valid_at + these columns (per _research/backend-asks.md §ASK-016).
--
-- Only meaningful for commitment facts; null / default on ordinary facts.
--
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user"
-- at session level. DO NOT change it. All DDL uses explicit public.
-- qualifier so objects land in the right schema (not ag_catalog).
--
-- Forward-only and idempotent: ADD COLUMN IF NOT EXISTS. Running twice is safe.

ALTER TABLE public.facts
  ADD COLUMN IF NOT EXISTS nudge_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_nudged_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS completion_resolution varchar(20),
  ADD COLUMN IF NOT EXISTS completion_metadata jsonb;
