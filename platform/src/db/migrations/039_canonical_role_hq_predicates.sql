-- 039_canonical_role_hq_predicates.sql
-- Bead nmemo-hm4.10 — predicate canonicalization to restore supersession.
--
-- createFact() (services/facts.ts) only supersedes when the predicate's
-- is_exclusive flag is true. That flag is read from the fact_predicates TABLE
-- (facts.ts has its own local getPredicateInfo over fact_predicates) — NOT from
-- the predicate-ontology.ts module. So the ontology change that folds the
-- title/role and HQ alias sprawl onto the canonical `job_title` /
-- `headquartered_in` predicates is necessary but not sufficient: the canonical
-- predicates must ALSO exist in fact_predicates with is_exclusive=true, or the
-- agent (which normalizes the predicate before createFact) writes `job_title`
-- facts that never supersede.
--
-- The 001_consolidated.sql seed shipped `has_role` (exclusive) and `has_title`
-- (NOT exclusive) with EMPTY alias arrays and no `job_title`/`headquartered_in`
-- rows. This migration adds the two canonical predicates, exclusive, with the
-- same alias lists as predicate-ontology.ts::CANONICAL_ONTOLOGY so the DB and
-- the code agree.
--
-- Explicit public. qualifiers — 001 set search_path = ag_catalog, public at
-- session level (AGE gotcha; see CLAUDE.md / mig 029 / 037 headers). DO NOT
-- change it. ON CONFLICT DO NOTHING keeps this idempotent on re-run and a no-op
-- where a row already exists.

INSERT INTO public.fact_predicates
  (predicate, description, inverse_predicate, predicate_type, is_exclusive, category, aliases, status)
VALUES
  ('job_title',
   'Current job title/role held by a person',
   NULL, 'role', true, 'professional',
   ARRAY['title','role','position','job','occupation','role_at','current_title','job_role','current_role','designation'],
   'canonical'),
  ('headquartered_in',
   'Headquarters location of an organization',
   NULL, 'location', true, 'location',
   ARRAY['hq','headquarters','head_office','headquartered','hq_in','head_office_in'],
   'canonical')
ON CONFLICT (predicate) DO NOTHING;
