-- 031_trigger_type_check.sql — Add CHECK constraint enumerating the two
-- valid trigger_type values on gardening_reports. Bead nmemo-2yv.69.
--
-- Background: migration 006_gardening.sql added trigger_type VARCHAR(20)
-- NOT NULL DEFAULT 'manual' to gardening_reports (doc 36 §8.1) but did
-- NOT add a CHECK constraint. The set of valid values is fixed at
-- exactly two: 'manual' (from POST /api/garden in index.ts) and 'auto'
-- (from the pipeline's auto-trigger via recordGardeningRun, see
-- pipeline.ts:364 / 375 — bead nmemo-2yv.67).
--
-- The TypeScript writers (RecordGardeningRunOpts.trigger in
-- src/services/gardening.ts and the schema.ts column declaration) use
-- the 'manual' | 'auto' union; a typo in either site would land
-- silently because the column has only a documentation comment
-- ('manual' | 'auto') not a schema-level enforcement. Downstream
-- analytics over trigger_type (filter counts by source surface) would
-- silently miscount on such a typo.
--
-- This matches the smaller-scale version of the same review-7 pattern
-- captured by bead nmemo-2yv.93 (valid_candidate_source on
-- merge_candidates, mig 030). Sibling CHECK constraints on the same
-- review surface include:
--   - valid_candidate_status (003_graph_meta.sql:67)
--   - valid_resolution (018_resolution_enum_align.sql:33)
--   - valid_candidate_source (030_candidate_source_check.sql:45)
--
-- Future new-trigger onboarding (no concrete next-source today; doc 36
-- §1-§2 lists only manual + auto) ships a follow-up migration that
-- drops + recreates the CHECK with the new value included, paired with
-- the TS-side TRIGGER_TYPE_VALUES tuple update.
--
-- Idempotent re-run: DROP CONSTRAINT IF EXISTS clears any prior
-- definition before re-adding. The ALTER ADD itself fails if existing
-- rows violate the predicate — by design (data corruption signal).
--
-- AGE search_path gotcha (per CLAUDE.md / 020+ headers): 001 set
-- search_path = ag_catalog, public, "$user" at session level. DO NOT
-- change it — AGE and Graph S triggers depend on ag_catalog being in
-- the path. Explicit public. qualifier on every DDL statement.

ALTER TABLE public.gardening_reports
  DROP CONSTRAINT IF EXISTS valid_trigger_type;

-- keep in sync with src/services/enums.ts:TRIGGER_TYPE_VALUES (bead nmemo-2yv.69)
ALTER TABLE public.gardening_reports
  ADD CONSTRAINT valid_trigger_type CHECK (
    trigger_type IN ('manual', 'auto')
  );
