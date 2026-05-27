-- 036_entity_summary_updated_at.sql — Add freshness timestamp for entity_meta.summary
--
-- Bead nmemo-2yv.52 — Viz entity-detail panel surfaces agent-authored summary +
-- freshness. The panel's "Updated N hours/days ago" indicator needs a
-- summary-specific timestamp (entity_meta.updated_at is touched by every
-- column writer — mention count, centroid recompute, fact count — so it is
-- not a summary-staleness signal). See docs/architecture/truth-graph/
-- 37-entity-living-summary.md §8 ("Staleness — two timestamps, two meanings").
--
-- Sibling bead nmemo-2yv.51 (IN_PROGRESS) owns the broader entity-profile.ts
-- assembler + GET /api/entity/:id/profile + COMMENT ON COLUMN annotations.
-- This migration ships the minimal column required to deliver .52 without
-- waiting on .51. .51's migration 018 will add the COMMENT ON COLUMN docs
-- and the optimistic-locking precondition that .55 builds on.
--
-- AGE search_path gotcha (per CLAUDE.md): explicit public. qualifier so the
-- DDL lands in public, not ag_catalog.

DO $$ BEGIN
  ALTER TABLE public.entity_meta ADD COLUMN summary_updated_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
