-- MUST FAIL: occurred_at in the future violates reverse-chronological ordering invariant; history query must surface an ordering-integrity failure.
-- simple-mutations-timing-attack.sql
-- Phase 1 adversarial variant — timing manipulation
-- Complexity score: 6 (rows=4, edges=0, stressors=2)
-- Stressors:
--   1. timing-attack=future-occurred_at (row 3 dated 10 years ahead)
--   2. timing-attack=far-past-occurred_at (row 2 dated 1970)
--
-- UUID map:
--   Alice             : 00000000-0000-0000-0000-000000000001
--   Acme Corp         : 00000000-0000-0000-0000-000000000010
--   Fact              : 10000000-0000-0000-0000-000000000001
--   fact_history 1..3 : 40000000-0000-0000-0000-0000000000a[1-3]

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Alice',     'person',  ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000010', 'Acme Corp', 'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at)
VALUES
  ('10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001', 'works_at',
   '00000000-0000-0000-0000-000000000010', 0.6, NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;

-- Row 1: legitimate created event
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-0000000000a1',
   '10000000-0000-0000-0000-000000000001', 'created',
   NULL, 0.6,
   'Initial extraction',
   '[]'::jsonb,
   'graph_agent', NOW() - INTERVAL '10 days');

-- Row 2: STRESSOR: timing-attack=far-past-occurred_at — occurred_at at 1970 epoch
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-0000000000a2',
   '10000000-0000-0000-0000-000000000001', 'confidence_raised',
   0.6, 0.8,
   'Attacker-authored row dated at epoch — should be rejected or flagged by ordering-integrity check',
   '[]'::jsonb,
   'reasoning_agent', TIMESTAMPTZ '1970-01-01 00:00:00+00');

-- Row 3: STRESSOR: timing-attack=future-occurred_at — occurred_at 10 years ahead
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-0000000000a3',
   '10000000-0000-0000-0000-000000000001', 'confidence_lowered',
   0.8, 0.2,
   'Forged future-dated row — would sort above the real latest row in reverse-chrono queries',
   '[]'::jsonb,
   'reasoning_agent', NOW() + INTERVAL '10 years');

COMMIT;
