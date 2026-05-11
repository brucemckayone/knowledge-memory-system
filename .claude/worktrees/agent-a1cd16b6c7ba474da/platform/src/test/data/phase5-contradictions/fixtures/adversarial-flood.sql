-- adversarial-flood.sql
-- Adversarial-scale fixture for Phase 5 (Contradiction Detection)
--
-- Seeds 100 distinct subjects, each with two `knows` facts against different
-- objects (200 facts total, 300 entities total). detectOpposingObjects() must
-- flag exactly 100 contradictions and complete in < 2s on the test DB.
--
-- UUID namespaces:
--   subjects   '99999999-9999-9999-9999-XXXXXXXXXXXX'  (X = index 1..100, lpad 12)
--   objects A  'aaaaaaaa-aaaa-aaaa-aaaa-XXXXXXXXXXXX'
--   objects B  'bbbbbbbb-bbbb-bbbb-bbbb-XXXXXXXXXXXX'
--   facts A    '99999999-aaaa-9999-9999-XXXXXXXXXXXX'
--   facts B    '99999999-bbbb-9999-9999-XXXXXXXXXXXX'

BEGIN;
SET LOCAL session_replication_role = 'replica';

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
SELECT
  ('99999999-9999-9999-9999-' || lpad(n::text, 12, '0'))::uuid,
  'flood-subject-' || n,
  'person',
  ARRAY(SELECT random() FROM generate_series(1, 768))::vector,
  1.0
FROM generate_series(1, 100) AS n
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
SELECT
  ('aaaaaaaa-aaaa-aaaa-aaaa-' || lpad(n::text, 12, '0'))::uuid,
  'flood-obj-a-' || n,
  'person',
  ARRAY(SELECT random() FROM generate_series(1, 768))::vector,
  1.0
FROM generate_series(1, 100) AS n
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
SELECT
  ('bbbbbbbb-bbbb-bbbb-bbbb-' || lpad(n::text, 12, '0'))::uuid,
  'flood-obj-b-' || n,
  'person',
  ARRAY(SELECT random() FROM generate_series(1, 768))::vector,
  1.0
FROM generate_series(1, 100) AS n
ON CONFLICT (id) DO NOTHING;

-- Fact A: subject n → knows → object_A n
INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at)
SELECT
  ('99999999-aaaa-9999-9999-' || lpad(n::text, 12, '0'))::uuid,
  ('99999999-9999-9999-9999-' || lpad(n::text, 12, '0'))::uuid,
  'knows',
  ('aaaaaaaa-aaaa-aaaa-aaaa-' || lpad(n::text, 12, '0'))::uuid,
  0.9, NOW() - INTERVAL '5 days'
FROM generate_series(1, 100) AS n
ON CONFLICT (id) DO NOTHING;

-- Fact B: subject n → knows → object_B n
INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at)
SELECT
  ('99999999-bbbb-9999-9999-' || lpad(n::text, 12, '0'))::uuid,
  ('99999999-9999-9999-9999-' || lpad(n::text, 12, '0'))::uuid,
  'knows',
  ('bbbbbbbb-bbbb-bbbb-bbbb-' || lpad(n::text, 12, '0'))::uuid,
  0.9, NOW() - INTERVAL '5 days'
FROM generate_series(1, 100) AS n
ON CONFLICT (id) DO NOTHING;

COMMIT;
