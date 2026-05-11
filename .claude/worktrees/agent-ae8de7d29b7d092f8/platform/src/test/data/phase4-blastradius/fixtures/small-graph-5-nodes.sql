-- small-graph-5-nodes.sql
-- Level 1 fixture for Phase 4 (Blast Radius Analysis)
--
-- Scenario: 5 entities, 5 facts, 4 causal events linked by 4 edges.
-- Deterministic IDs let the impact tree be predicted exactly.
--
-- Topology:
--   Alice (E001) --[knows]--> Bob (E002)
--   Alice (E001) --[knows]--> Carol (E003)
--   Bob   (E002) --[works_at]--> Acme (E004)
--   Carol (E003) --[lives_in]--> Boston (E005)
--   Alice (E001) --[lives_in]--> Boston (E005)
--
--   Causal: F1.created -> F2.created -> F3.created -> F4.created (linear)
--
-- UUID map:
--   Alice    : 00000000-0000-0000-0000-000000000001
--   Bob      : 00000000-0000-0000-0000-000000000002
--   Carol    : 00000000-0000-0000-0000-000000000003
--   Acme     : 00000000-0000-0000-0000-000000000004
--   Boston   : 00000000-0000-0000-0000-000000000005
--
-- Used by:
--   - C5 fixture-loader smoke test
--   - klv.4 (Phase 4 test-data hardening) graduation gate
--

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, properties)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Alice',  'person',   '{}'::jsonb),
  ('00000000-0000-0000-0000-000000000002', 'Bob',    'person',   '{}'::jsonb),
  ('00000000-0000-0000-0000-000000000003', 'Carol',  'person',   '{}'::jsonb),
  ('00000000-0000-0000-0000-000000000004', 'Acme',   'company',  '{}'::jsonb),
  ('00000000-0000-0000-0000-000000000005', 'Boston', 'place',    '{}'::jsonb);

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id)
VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'knows',     '00000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'knows',     '00000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'works_at',  '00000000-0000-0000-0000-000000000004'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 'lives_in',  '00000000-0000-0000-0000-000000000005'),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'lives_in',  '00000000-0000-0000-0000-000000000005');

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text)
VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'created', '00000000-0000-0000-0000-000000000001', 'knows',    'small graph'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'created', '00000000-0000-0000-0000-000000000001', 'knows',    'small graph'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'created', '00000000-0000-0000-0000-000000000002', 'works_at', 'small graph'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000005', 'created', '00000000-0000-0000-0000-000000000001', 'lives_in', 'small graph');

INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, reasoning,
  source_references, extraction_method, corroboration_count, initial_strength
)
VALUES
  ('30000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002',
   0.7, 'Alice expanded her social circle', '[]'::jsonb, 'manual', 1, 0.7),
  ('30000000-0000-0000-0000-000000000002',
   '20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000003',
   0.6, 'Knowing someone leads to job referrals', '[]'::jsonb, 'manual', 1, 0.6),
  ('30000000-0000-0000-0000-000000000003',
   '20000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000004',
   0.5, 'Working at Acme prompted relocation', '[]'::jsonb, 'manual', 1, 0.5);

COMMIT;
