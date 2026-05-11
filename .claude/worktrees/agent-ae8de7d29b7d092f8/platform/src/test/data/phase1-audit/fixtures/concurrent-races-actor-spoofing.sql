-- MUST FAIL: tests DB CHECK constraint rejects actor='attacker_script' — direct INSERT into fact_history with unknown actor must raise check_violation and leave fact_history row count unchanged.
-- concurrent-races-actor-spoofing.sql
-- Phase 1 adversarial variant — actor CHECK constraint under direct-INSERT attack
-- Complexity score: 14 (rows=3, edges=0, stressors=2, adversarial-weighted)
-- Stressors: spoofed-actor=1, direct-history-insert=1
--
-- UUID map:
--   00000000-0000-0000-0000-0000000000a1  subject
--   00000000-0000-0000-0000-0000000001a1  object
--   10000000-0000-0000-0000-0000000000a1  fact that spoofing targets
--   40000000-0000-0000-0000-00000000a001  fact_history row the attacker attempts

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'spoof_subject', 'person',  ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-0000000001a1', 'spoof_object',  'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at)
VALUES (
  '10000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000a1',
  'works_at',
  '00000000-0000-0000-0000-0000000001a1',
  0.75,
  NOW()
) ON CONFLICT (id) DO NOTHING;

COMMIT;

-- STRESSOR: spoofed-actor=1
-- Harness now attempts the following (wrapped in its own BEGIN/ROLLBACK) and
-- MUST observe a CHECK constraint violation on valid_fact_actor:
--
-- BEGIN;
--   INSERT INTO public.fact_history
--     (id, fact_id, event_type, reasoning, source_references, actor)
--   VALUES
--     ('40000000-0000-0000-0000-00000000a001',
--      '10000000-0000-0000-0000-0000000000a1',
--      'created',
--      'spoofing attempt',
--      '[]'::jsonb,
--      'attacker_script');
-- ROLLBACK;
--
-- Expected: CHECK constraint violation (SQLSTATE 23514); zero rows committed.
