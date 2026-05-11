-- MUST FAIL: tests code rejects duplicate fact_id under concurrent load — only one createFact may win, 99 must raise a unique-violation and write NO fact_history row.
-- concurrent-races-dup-factid.sql
-- Phase 1 adversarial variant — duplicate-key collision under 100-way concurrency
-- Complexity score: 23 (rows=2, edges=0, stressors=2, adversarial-weighted)
-- Stressors: concurrency=100, duplicate-collision=100
--
-- UUID map:
--   00000000-0000-0000-0000-0000000000d1  subject
--   00000000-0000-0000-0000-0000000001d1  object
--   10000000-0000-0000-0000-0000000000d1  the contested fact UUID
--
-- Harness contract:
--   After loading, spawn 100 parallel workers. EVERY worker calls createFact
--   with the SAME fact_id and the SAME (subject, predicate, object) triple.
--   Reasoning = 'dup-iter-<N>', N=0..99.
--   Expected: exactly 1 surviving facts row; exactly 1 fact_history row
--   (event_type='created'); the 99 losers must have raised a unique-violation
--   error and written NOTHING to fact_history. No partial rows, no cascade
--   side-effects.

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'dup_subject', 'person',  ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90),
  ('00000000-0000-0000-0000-0000000001d1', 'dup_object',  'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 0.90)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- STRESSOR: duplicate-collision=100
-- Harness issues 100 parallel createFact calls all claiming fact_id
-- 10000000-0000-0000-0000-0000000000d1. Post-run assertion:
--   (SELECT COUNT(*) FROM public.facts WHERE id='10000000-...-d1') = 1
--   (SELECT COUNT(*) FROM public.fact_history WHERE fact_id='10000000-...-d1') = 1
--   Worker failure rate = 99/100 (all losers report unique-violation).
