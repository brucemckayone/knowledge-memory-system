-- 038_fact_subject_fk_restrict.sql
-- P3 (doc 38 — Approach B). Change facts.subject_entity_id off ON DELETE
-- CASCADE to ON DELETE RESTRICT so a reconcile merge running CONCURRENTLY with
-- live agent writes can't silently cascade-delete a fact (doc 05 Bug C).
--
-- mergeEntities re-points a source entity's facts BEFORE deleting it, so
-- RESTRICT is satisfied for non-racing merges (serial + epoch arms are
-- unaffected). A write that races a merge makes the source DELETE fail and the
-- merge transaction rolls back — retried on the next reconcile — instead of
-- destroying the fact. The object FK stays ON DELETE SET NULL; the whole-row
-- loss came from the subject-side CASCADE.
--
-- Explicit public. qualifiers — 001 set search_path = ag_catalog, public at
-- session level (AGE gotcha; see CLAUDE.md / mig 029 header). DO NOT change it.

-- Drop the existing subject FK by discovering its name (inline FKs are
-- auto-named), then add the RESTRICT variant. Idempotent: a re-run finds the
-- RESTRICT constraint, drops it, and re-adds it.
DO $$
DECLARE c_name text;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'public.facts'::regclass
    AND contype = 'f'
    AND pg_get_constraintdef(oid) ILIKE '%(subject_entity_id)%REFERENCES%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.facts DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE public.facts
  ADD CONSTRAINT facts_subject_entity_id_restrict
  FOREIGN KEY (subject_entity_id) REFERENCES public.entities(id) ON DELETE RESTRICT;
