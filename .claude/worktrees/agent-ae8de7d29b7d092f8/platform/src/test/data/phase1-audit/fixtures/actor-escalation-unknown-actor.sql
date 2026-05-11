-- MUST FAIL: tests DB CHECK constraint rejects actor='hacker' — value outside the seven-member whitelist must raise check_violation (SQLSTATE 23514).
-- actor-escalation-unknown-actor.sql
-- Phase 1 adversarial variant — actor CHECK constraint
-- Complexity score: 13 (rows=3, edges=0, stressors=1, adversarial-weighted)
-- Stressors: adversarial-structural=unknown-actor
--
-- UUID map: reuses entities/fact. Adds:
--   40000000-0000-0000-0000-0000000000aa  audit row with invalid actor value

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Acme Corp',     'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000002', 'BetaSoft Inc',  'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
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

-- ADVERSARIAL: actor outside the seven-member whitelist
-- STRESSOR: adversarial-structural=unknown-actor
INSERT INTO public.fact_history (
  id, fact_id, event_type, previous_confidence, new_confidence,
  reasoning, source_references, actor, occurred_at
) VALUES (
  '40000000-0000-0000-0000-0000000000aa',
  '10000000-0000-0000-0000-000000000001',
  'created',
  NULL, 0.70,
  'Injection attempt — actor must be in the seven-member whitelist.',
  '[]'::jsonb,
  'hacker',                              -- invalid
  TIMESTAMPTZ '2026-01-01 00:00:00+00'
);

COMMIT;
