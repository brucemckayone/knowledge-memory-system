-- 028_merge_entities_topology_repoint.sql — Add FK enforcement on
-- topology_bridges and clean up any pre-existing dangling rows. Bead
-- nmemo-2yv.65.
--
-- Background: mig 014 introduced topology_bridges with
-- source_entity_id/target_entity_id as UUID NOT NULL with NO REFERENCES
-- clause. mig 008 introduced reasoning_reports.entity_ids UUID[] (array,
-- FK not enforceable element-by-element). The PL/pgSQL merge_entities()
-- (mig 005, extended by 020, replaced by TS in mig 026) never re-pointed
-- either field. After a merge_entities() deletes the source entity,
-- topology_bridges retains rows referencing the deleted UUID and
-- reasoning_reports.entity_ids[] arrays retain the deleted UUID. Both
-- silently corrupt joins/lookups back to entities.
--
-- This migration:
--   (1) Cleans up any existing topology_bridges rows that reference an
--       entity id no longer present in entities (left over from prior
--       merges). The gardener's next topology recompute regenerates valid
--       bridges from the live graph.
--   (2) Adds ON DELETE CASCADE FK from topology_bridges.source_entity_id
--       to entities(id), and the symmetric FK for target_entity_id.
--       CASCADE is the right semantic here: bridges are derived data
--       (igraph.Graph.bridges() output, recomputed on every topology pass).
--       If an entity disappears for any reason, derived bridge rows
--       referencing it should disappear too — the gardener regenerates
--       them on the next pass.
--
-- reasoning_reports.entity_ids[] does NOT get FK treatment in this
-- migration — element-level FK on an array column isn't enforceable in
-- Postgres. The re-point is handled imperatively in the TS
-- mergeEntities() service (this same diff).
--
-- AGE search_path gotcha (per CLAUDE.md / 020-027 headers): explicit
-- public. qualifiers so DDL lands in public, not ag_catalog.

-- ============================================
-- 1. Clean up pre-existing dangling bridge rows.
-- ============================================
DELETE FROM public.topology_bridges
WHERE source_entity_id NOT IN (SELECT id FROM public.entities)
   OR target_entity_id NOT IN (SELECT id FROM public.entities);

-- ============================================
-- 2. Add FK enforcement going forward.
-- ============================================
ALTER TABLE public.topology_bridges
  ADD CONSTRAINT topology_bridges_source_entity_id_fkey
  FOREIGN KEY (source_entity_id)
  REFERENCES public.entities(id)
  ON DELETE CASCADE;

ALTER TABLE public.topology_bridges
  ADD CONSTRAINT topology_bridges_target_entity_id_fkey
  FOREIGN KEY (target_entity_id)
  REFERENCES public.entities(id)
  ON DELETE CASCADE;
