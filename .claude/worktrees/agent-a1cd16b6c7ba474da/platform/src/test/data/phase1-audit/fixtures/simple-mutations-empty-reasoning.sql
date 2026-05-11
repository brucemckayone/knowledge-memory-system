-- MUST FAIL: empty reasoning string must be rejected at the service layer. The NOT NULL constraint does not catch '' — service-layer validation is the required line of defence.
-- simple-mutations-empty-reasoning.sql
-- Phase 1 adversarial variant — empty/whitespace reasoning rejection
-- Complexity score: 4 (rows=3, edges=0, stressors=2)
-- Stressors:
--   1. empty-reasoning=''        (row 2 — zero-length string)
--   2. whitespace-reasoning='   ' (row 3 — whitespace-only)
--
-- UUID map:
--   Alice             : 00000000-0000-0000-0000-000000000001
--   Acme Corp         : 00000000-0000-0000-0000-000000000010
--   Fact              : 10000000-0000-0000-0000-000000000001
--   fact_history 1..3 : 40000000-0000-0000-0000-0000000000b[1-3]

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

-- Row 1: legitimate baseline
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-0000000000b1',
   '10000000-0000-0000-0000-000000000001', 'created',
   NULL, 0.6,
   'Initial extraction from source memory',
   '[]'::jsonb,
   'graph_agent', NOW() - INTERVAL '10 days');

-- Row 2: STRESSOR: empty-reasoning='' — zero-length string must be rejected at service layer
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-0000000000b2',
   '10000000-0000-0000-0000-000000000001', 'confidence_raised',
   0.6, 0.9,
   '',
   '[]'::jsonb,
   'reasoning_agent', NOW() - INTERVAL '8 days');

-- Row 3: STRESSOR: whitespace-reasoning='   ' — whitespace-only string must also be rejected
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-0000000000b3',
   '10000000-0000-0000-0000-000000000001', 'confidence_lowered',
   0.9, 0.4,
   '   ',
   '[]'::jsonb,
   'reasoning_agent', NOW() - INTERVAL '7 days');

COMMIT;
