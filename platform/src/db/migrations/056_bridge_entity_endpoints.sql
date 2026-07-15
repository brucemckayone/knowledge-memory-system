-- 056_bridge_entity_endpoints.sql — Cross-corpus Phase B: entity bridge endpoints
-- Bead nmemo-uhp.12.2. Spec: docs/architecture/cross-corpus-audit/04-hardened-spec.md
-- §D1, as REINTERPRETED by the Phase B substrate decision (2026-07-15).
--
-- Phase A (migration 054) froze bridge endpoint kinds to the bare element catalogs
-- ('code_element','rule_element') — the original D1 model. Phase B's v1 linker
-- recalls over the FULL per-corpus entity/fact graph, so a bridge's source endpoint
-- is an ENTITY (a code function/behaviour materialised as a canonical entity) and
-- its target may be an entity or a rule_element. This widens the two endpoint-kind
-- CHECKs to admit 'entity'. The bare catalogs remain valid (Phase C / SCIP path).
--
-- Endpoints still carry NO foreign key (validated at disposal by planBridgePromotion
-- against public.entities by id+corpus, or against the catalogs) — the widening is
-- purely the structural CHECK. staging_bridge_edges has no kinds CHECK, so it is
-- unaffected.
--
-- AGE note (CLAUDE.md): do NOT change session search_path; qualify every object with
-- public. Idempotent (DROP CONSTRAINT IF EXISTS + guarded ADD), re-runnable.

-- 1. bridge_edges endpoint kinds: add 'entity'.
ALTER TABLE public.bridge_edges DROP CONSTRAINT IF EXISTS valid_bridge_kinds;
DO $$ BEGIN
  ALTER TABLE public.bridge_edges ADD CONSTRAINT valid_bridge_kinds
    CHECK (a_kind IN ('code_element','rule_element','entity')
       AND b_kind IN ('code_element','rule_element','entity'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- 2. bridge_source_refs reverse-index ref_type: add 'entity' so a bridge may cite
-- an entity as a source reference (mirrors the SourceReference enum memory|fact|entity).
ALTER TABLE public.bridge_source_refs DROP CONSTRAINT IF EXISTS valid_bridge_ref_type;
DO $$ BEGIN
  ALTER TABLE public.bridge_source_refs ADD CONSTRAINT valid_bridge_ref_type
    CHECK (ref_type IN ('fact','memory','code_element','rule_element','entity'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
