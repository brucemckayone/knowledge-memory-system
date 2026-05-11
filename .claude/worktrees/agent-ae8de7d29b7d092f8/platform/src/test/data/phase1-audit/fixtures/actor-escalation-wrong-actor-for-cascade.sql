-- MUST FAIL: tests code rejects cascade event emitted without an upstream trigger (both causal_event_id and reasoning_report_id NULL — cascade row without traceable cause is a business-rule violation).
-- actor-escalation-wrong-actor-for-cascade.sql
-- Phase 1 adversarial variant — cascade invariant
-- Complexity score: 17 (rows=5, edges=0, stressors=1, adversarial-weighted)
-- Stressors: adversarial-structural=cascade-without-cause
--
-- UUID map: reuses entities/fact/report from main. Adds:
--   40000000-0000-0000-0000-000000000099  orphan cascade audit row (target of FAIL)

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Acme Corp',     'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000002', 'BetaSoft Inc',  'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.reasoning_reports (id, mode, report, created_at)
VALUES
  ('50000000-0000-0000-0000-000000000001',
   'patrol',
   'Corroborated by secondary source.',
   TIMESTAMPTZ '2026-01-01 00:30:00+00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at, invalid_at)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'acquired',
  '00000000-0000-0000-0000-000000000002',
  0.70,
  TIMESTAMPTZ '2026-01-01 00:00:00+00',
  NULL
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.fact_history (
  id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at
) VALUES (
  '40000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'created',
  NULL, 0.70,
  'Initial extraction.',
  '[]'::jsonb,
  'graph_agent',
  TIMESTAMPTZ '2026-01-01 00:00:00+00'
);

-- ADVERSARIAL: cascade row with no upstream reference. Expected rejection.
-- STRESSOR: adversarial-structural=cascade-without-cause
INSERT INTO public.fact_history (
  id, fact_id, event_type, previous_confidence, new_confidence,
  reasoning, source_references, reasoning_report_id, causal_event_id,
  actor, occurred_at
) VALUES (
  '40000000-0000-0000-0000-000000000099',
  '10000000-0000-0000-0000-000000000001',
  'expired',
  0.70, 0.70,
  'Cascade expiry with no declared upstream — business invariant violation.',
  '[]'::jsonb,
  NULL,   -- no reasoning_report_id
  NULL,   -- no causal_event_id  <- invariant breach
  'cascade',
  TIMESTAMPTZ '2026-01-01 06:00:00+00'
);

COMMIT;
