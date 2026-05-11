-- concurrent-races.sql (v1.0)
-- Phase 1 (Audit Trail Foundation) — L1 concurrency scenario
-- Complexity score: 32 (rows=24, edges=0, stressors=5)
-- Stressors:
--   concurrency=100, fan-out=10, predicate-pool=5,
--   duplicate-collision=100 (see dup-factid variant),
--   spoofed-actor=1 (see actor-spoofing variant)
--
-- UUID map:
--   00000000-0000-0000-0000-0000000000SS  subject entities (SS = 01..0A)
--   00000000-0000-0000-0000-0000000001OO  object entities  (OO = 01..0A)
--   20000000-0000-0000-0000-0000000000EE  causal_events pool (EE = 01..04)
--
-- Harness contract:
--   Spawn 100 parallel workers. Each picks a random (subject, object, predicate)
--   triple from the pool and calls createFact with reasoning = 'race-iter-<N>'
--   where N = 0..99 (worker index). Each worker uses a distinct fact UUID of the
--   form 10000000-0000-0000-0000-0000000000NN (NN = worker index hex).
--   Predicate pool: works_at, located_in, reports_to, collaborates_with, manages.
--   Expected: 100 facts rows + 100 fact_history rows (event_type=created),
--   no duplicate audit rows, no lost audit rows, ordering preserved per fact_id.

BEGIN;

-- STRESSOR: fan-out=10 (subjects)
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000001', 'alice',   'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000002', 'bob',     'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000003', 'carol',   'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000004', 'dave',    'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000005', 'eve',     'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000006', 'frank',   'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000007', 'grace',   'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000008', 'heidi',   'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000009', 'ivan',    'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-00000000000a', 'judy',    'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90)
ON CONFLICT (id) DO NOTHING;

-- STRESSOR: fan-out=10 (objects)
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000101', 'acme_corp',   'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000102', 'globex',      'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000103', 'initech',     'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000104', 'umbrella',    'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000105', 'soylent',     'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000106', 'cyberdyne',   'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000107', 'wayne_ent',   'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000108', 'stark_ind',   'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-000000000109', 'oscorp',      'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-00000000010a', 'tyrell_corp', 'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- STRESSOR: concurrency=100 + predicate-pool=5
-- The harness now executes 100 parallel createFact operations against the
-- entity pool above. Expected post-run state:
--   SELECT COUNT(*) FROM public.facts WHERE id LIKE '10000000-%'  = 100
--   SELECT COUNT(*) FROM public.fact_history
--     WHERE fact_id LIKE '10000000-%' AND event_type='created'    = 100
--   SELECT COUNT(DISTINCT fact_id) FROM public.fact_history
--     WHERE fact_id LIKE '10000000-%'                             = 100
