-- opposing-object-simple.sql
-- Level 1 fixture for Phase 5 (Contradiction Detection)
--
-- Scenario: Same subject + predicate with two different active objects.
--   (Alice, knows, Bob) and (Alice, knows, Carol) — both active, neither superseded.
-- `knows` is NOT an exclusive predicate so supersession does not auto-resolve.
-- Expected: detectOpposingObjects() flags both facts as opposing_object contradiction.
--
-- UUID map:
--   Alice:   00000000-...-001
--   Bob:     00000000-...-002
--   Carol:   00000000-...-003
--   Fact A:  10000000-...-501  (Alice knows Bob)
--   Fact B:  10000000-...-502  (Alice knows Carol)

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Alice', 'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000002', 'Bob',   'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000003', 'Carol', 'person', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- Opposing facts (knows is non-exclusive — allows multiple active objects)
INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at) VALUES
  ('10000000-0000-0000-0000-000000000501',
   '00000000-0000-0000-0000-000000000001', 'knows',
   '00000000-0000-0000-0000-000000000002', 0.9, NOW() - INTERVAL '5 days'),
  ('10000000-0000-0000-0000-000000000502',
   '00000000-0000-0000-0000-000000000001', 'knows',
   '00000000-0000-0000-0000-000000000003', 0.9, NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- NOTE: `knows` naturally allows multiple objects (you can know many people).
-- This fixture is adversarial — real-world `knows` contradicts shouldn't flag.
-- The test expects the heuristic to flag this pair but marks the expected
-- behaviour as "flag, then expect reasoning agent to dismiss as both_valid".
-- This tests the full detect → resolve cycle, not just detect.
