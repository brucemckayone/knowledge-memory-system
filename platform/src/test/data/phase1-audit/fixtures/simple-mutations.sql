-- simple-mutations.sql (v1.1)
-- Phase 1 (Audit Trail Foundation) — hardened main fixture
-- Complexity score: 14 (rows=13, edges=0, stressors=8)
-- Stressors:
--   1. event-type breadth (6/8 enum values exercised)
--   2. actor diversity (7/7 enum values exercised across 8 history rows)
--   3. FK integrity — reasoning_report_id non-null on revised row
--   4. FK integrity — causal_event_id non-null on superseded + invalidated rows
--   5. confidence monotonicity violation check (raised then lowered then restored)
--   6. valid_at window mutation (revised event shifts both previous/new valid_at)
--   7. invalidated → restored round-trip (tests restoration path)
--   8. reverse-chronological ordering with dense occurred_at (sub-day deltas)
--
-- UUID map:
--   Entity Alice     : 00000000-0000-0000-0000-000000000001
--   Entity Acme Corp : 00000000-0000-0000-0000-000000000010
--   Fact (works_at)  : 10000000-0000-0000-0000-000000000001
--   causal_event     : 20000000-0000-0000-0000-000000000001
--   reasoning_report : 50000000-0000-0000-0000-000000000001
--   fact_history 1..8: 40000000-0000-0000-0000-00000000000[1-8]

BEGIN;

-- Subjects ------------------------------------------------------------------
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

-- Referent rows for FK-integrity stressors ---------------------------------
-- STRESSOR: fk-integrity=causal_event_id — pre-seeded so history rows 5 & 7 reference a real row
-- Live schema (migration 002): column is `transition_type`, CHECK enum is
-- ('created','strengthened','weakened','expired','invalidated'). The seeded
-- transition records the prior fact being invalidated by a newer assertion,
-- which lines up with the fact_history row 5 (invalidated) and row 7
-- (superseded) that both cite this causal_event_id.
INSERT INTO public.causal_events (id, fact_id, transition_type, source_text, occurred_at)
VALUES
  ('20000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'invalidated',
   'Alice role invalidated/superseded by newer memory',
   NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- STRESSOR: fk-integrity=reasoning_report_id — pre-seeded so history row 3 references a real row
-- Live schema (migration 008): required columns are mode (CHECK 'patrol'|'query')
-- and report (NOT NULL TEXT). The previous v1.1 fixture used a non-existent
-- `summary` column — corrected as part of nmemo-klv.1.
INSERT INTO public.reasoning_reports (id, mode, report, created_at)
VALUES
  ('50000000-0000-0000-0000-000000000001',
   'patrol',
   'Periodic reasoning pass revised works_at validity window',
   NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Audit trail (8 rows — dense occurred_at for reverse-chrono ordering check) --
-- Row 1: created (graph_agent, initial extraction)
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence,
   previous_valid_at, new_valid_at, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', 'created',
   NULL, 0.6,
   NULL, NOW() - INTERVAL '10 days',
   'Initial extraction from source memory',
   '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000001","relevance":"span: Alice works at Acme Corp"}]'::jsonb,
   'graph_agent', NOW() - INTERVAL '10 days');

-- Row 2: confidence_raised (reasoning_agent, corroborating evidence)
-- STRESSOR: actor-diversity=reasoning_agent
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-000000000002',
   '10000000-0000-0000-0000-000000000001', 'confidence_raised',
   0.6, 0.9,
   'Corroborating evidence found in second source memory',
   '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000002","relevance":"Alice @ Acme"}]'::jsonb,
   'reasoning_agent', NOW() - INTERVAL '8 days');

-- Row 3: revised (reasoning_agent, shifts valid_at window — non-null reasoning_report_id)
-- STRESSOR: valid_at-window-mutation + fk-integrity=reasoning_report_id
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_valid_at, new_valid_at, reasoning, source_references, reasoning_report_id, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-000000000003',
   '10000000-0000-0000-0000-000000000001', 'revised',
   NOW() - INTERVAL '10 days', NOW() - INTERVAL '12 days',
   'Revised valid_at backward — evidence shows employment began 2 days earlier',
   '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000003","relevance":"Alice joined Acme"}]'::jsonb,
   '50000000-0000-0000-0000-000000000001',
   'reasoning_agent', NOW() - INTERVAL '5 days');

-- Row 4: confidence_lowered (gardener_agent, contradictory signal)
-- STRESSOR: event-type=confidence_lowered + actor-diversity=gardener_agent
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-000000000004',
   '10000000-0000-0000-0000-000000000001', 'confidence_lowered',
   0.9, 0.55,
   'Gardener detected contradictory signal — lowering confidence pending reconciliation',
   '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000004","relevance":"Alice at different company"}]'::jsonb,
   'gardener_agent', NOW() - INTERVAL '3 days');

-- Row 5: invalidated (reconciliation_agent, causal_event_id non-null)
-- STRESSOR: event-type=invalidated + actor-diversity=reconciliation_agent + fk-integrity=causal_event_id
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence,
   previous_invalid_at, new_invalid_at, reasoning, source_references, causal_event_id, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-000000000005',
   '10000000-0000-0000-0000-000000000001', 'invalidated',
   0.55, 0.55,
   NULL, NOW() - INTERVAL '2 days',
   'Reconciliation agent invalidated fact after conflict resolution',
   '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000005","relevance":"conflict resolved"}]'::jsonb,
   '20000000-0000-0000-0000-000000000001',
   'reconciliation_agent', NOW() - INTERVAL '2 days');

-- Row 6: restored (user override — explicit user actor)
-- STRESSOR: event-type=restored + actor-diversity=user
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence,
   previous_invalid_at, new_invalid_at, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-000000000006',
   '10000000-0000-0000-0000-000000000001', 'restored',
   0.55, 0.7,
   NOW() - INTERVAL '2 days', NULL,
   'User override — invalidation was premature, fact restored with adjusted confidence',
   '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000006","relevance":"user confirms employment"}]'::jsonb,
   'user', NOW() - INTERVAL '36 hours');

-- Row 7: superseded (system_trigger, causal_event_id non-null)
-- STRESSOR: actor-diversity=system_trigger + fk-integrity=causal_event_id
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, causal_event_id, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-000000000007',
   '10000000-0000-0000-0000-000000000001', 'superseded',
   0.7, 0.7,
   'Superseded by newer extraction — system trigger fired on fact ingestion',
   '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000007","relevance":"Alice now at NewCo"}]'::jsonb,
   '20000000-0000-0000-0000-000000000001',
   'system_trigger', NOW() - INTERVAL '1 day');

-- Row 8: expired (cascade, terminal state — superseded chain reached TTL)
-- STRESSOR: actor-diversity=cascade + reverse-chrono-density (most recent row)
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence,
   previous_invalid_at, new_invalid_at, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-000000000008',
   '10000000-0000-0000-0000-000000000001', 'expired',
   0.7, 0.0,
   NULL, NOW(),
   'Fact expired via cascade — prior fact was superseded and cascade invalidated descendants',
   '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000007","relevance":"cascade expiry"}]'::jsonb,
   'cascade', NOW() - INTERVAL '30 minutes');

COMMIT;
