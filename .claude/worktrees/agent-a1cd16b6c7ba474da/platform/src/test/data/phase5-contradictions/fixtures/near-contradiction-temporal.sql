-- near-contradiction-temporal.sql
-- Level 1 adversarial fixture for Phase 5 (Contradiction Detection)
--
-- Scenario: Two `loved` facts on the same subject with different objects,
-- but with disjoint temporal windows (one has invalid_at set in the past,
-- the other is still current). detectOpposingObjects() must NOT flag —
-- the heuristic excludes facts with invalid_at NOT NULL.
--
-- This is the canonical "looks opposing but isn't" case the reasoning
-- agent would otherwise need to disambiguate. Filtering at the SQL layer
-- keeps the agent's PHASE 1.5 queue uncluttered.
--
-- UUID map:
--   Eva:      00000000-...-301
--   Bob:      00000000-...-302
--   Carol:    00000000-...-303
--   Fact A:   10000000-...-801  (Eva loved Bob, valid 2010, invalid 2015)
--   Fact B:   10000000-...-802  (Eva loved Carol, valid 2016, no invalid_at)

BEGIN;
SET LOCAL session_replication_role = 'replica';

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000301', 'Eva',   'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000302', 'Bob',   'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000303', 'Carol', 'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at, invalid_at) VALUES
  ('10000000-0000-0000-0000-000000000801',
   '00000000-0000-0000-0000-000000000301', 'loved',
   '00000000-0000-0000-0000-000000000302', 0.9,
   '2010-01-01 00:00:00+00', '2015-12-31 23:59:59+00'),
  ('10000000-0000-0000-0000-000000000802',
   '00000000-0000-0000-0000-000000000301', 'loved',
   '00000000-0000-0000-0000-000000000303', 0.9,
   '2016-01-01 00:00:00+00', NULL)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- NOTE: `loved` is non-exclusive (one can love many sequentially). The
-- heuristic's exclusion comes from invalid_at being SET on fact A, NOT from
-- predicate exclusivity. This is the temporal-windowing safeguard.
