-- opposing-object-exclusive.sql
-- Level 1 fixture (negative case) for Phase 5 (Contradiction Detection)
--
-- Scenario: Same subject + predicate (`works_at` — EXCLUSIVE) with two
-- different active objects. Supersession would normally expire the older
-- on direct INSERT via trigger; we disable triggers here to leave BOTH
-- facts active and force the heuristic's predicate-exclusion path to
-- carry the load.
--
-- `works_at` is `is_exclusive = true` in `fact_predicates` (seeded by
-- migration 001). The heuristic's `NOT EXISTS (... is_exclusive=true ...)`
-- filter MUST suppress this case. If the filter is broken, the heuristic
-- falsely flags.
--
-- UUID map:
--   David:    00000000-...-101
--   Acme:     00000000-...-102
--   Globex:   00000000-...-103
--   Fact A:   10000000-...-601  (David works_at Acme, valid 5d ago)
--   Fact B:   10000000-...-602  (David works_at Globex, valid 3d ago)

BEGIN;
SET LOCAL session_replication_role = 'replica';  -- skip triggers (supersession)

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000101', 'David',  'person',  ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000102', 'Acme',   'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000103', 'Globex', 'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- Both facts active. With supersession bypassed, only the heuristic's
-- exclusive-predicate exclusion can prevent a false flag.
INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at) VALUES
  ('10000000-0000-0000-0000-000000000601',
   '00000000-0000-0000-0000-000000000101', 'works_at',
   '00000000-0000-0000-0000-000000000102', 0.9, NOW() - INTERVAL '5 days'),
  ('10000000-0000-0000-0000-000000000602',
   '00000000-0000-0000-0000-000000000101', 'works_at',
   '00000000-0000-0000-0000-000000000103', 0.9, NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- NOTE: real-world flow on createFact() would expire the older `works_at`
-- via supersession before the heuristic ever runs. This fixture isolates
-- the heuristic's own exclusion logic by skipping that trigger path.
