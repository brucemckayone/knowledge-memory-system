-- 018_resolution_enum_align.sql — Align merge_candidates.resolution CHECK
-- with the resolve_candidate tool enum used by the reconciliation agent.
--
-- Background: bead nmemo-2yv.60. The schema CHECK (003_graph_meta.sql:71)
-- allowed ('merge', 'alias', 'link', 'distinct') but every other layer of
-- the stack — the resolve_candidate tool's inputSchema enum in
-- causal-agent.ts, the reconciliation_agent.py system prompt, doc 27 §2.2,
-- and the same_as_links table name itself — uses 'same_as'. Every same_as
-- resolution silently failed the CHECK on close, leaving the originating
-- merge_candidates row in 'staging'/'candidate' forever and inflating
-- graph_stats.merge_candidates_pending.
--
-- This migration:
--   1. Defensively rewrites any pre-existing rows with resolution = 'alias'
--      to 'same_as' (the bead's grep found zero such rows in production
--      code; this UPDATE protects against fixture/bootstrap data).
--   2. Drops the old CHECK constraint.
--   3. Recreates it with 'same_as' in place of 'alias', matching the
--      vocabulary the rest of the system uses.
--
-- AGE search_path gotcha (per CLAUDE.md / 016/017 headers): explicit
-- public. qualifiers throughout so DDL lands in public, not ag_catalog.

UPDATE public.merge_candidates
SET resolution = 'same_as'
WHERE resolution = 'alias';

ALTER TABLE public.merge_candidates
  DROP CONSTRAINT IF EXISTS valid_resolution;

-- keep in sync with src/services/enums.ts:RESOLUTION_VALUES (bead nmemo-2yv.130)
ALTER TABLE public.merge_candidates
  ADD CONSTRAINT valid_resolution CHECK (
    resolution IS NULL OR resolution IN ('merge', 'same_as', 'link', 'distinct')
  );
