-- actor-escalation.sql (v1.1)
-- Phase 1 (Audit Trail Foundation) — L2 cross-actor sequence
-- Complexity score: 24 (rows=12, edges=0, stressors=2)
-- Stressors:
--   actor-diversity=7 (all seven valid actors appear in final audit trail)
--   cross-actor-sequence=7 (seven-step lifecycle over a single fact)
--
-- UUID map:
--   entities:
--     00000000-0000-0000-0000-000000000001  subject            ("Acme Corp")
--     00000000-0000-0000-0000-000000000002  object_initial     ("BetaSoft Inc" — pre-gardener-merge)
--     00000000-0000-0000-0000-000000000003  object_after_merge ("BetaSoft"     — canonical form gardener merges to)
--   facts:
--     10000000-0000-0000-0000-000000000001  the fact under audit (Acme Corp acquired BetaSoft Inc)
--   causal_events:
--     20000000-0000-0000-0000-000000000001  upstream cause for cascade row (step 7)
--   reasoning_reports:
--     50000000-0000-0000-0000-000000000001  corroboration report (steps 2/3/4)
--   fact_history seven-step lifecycle (40000000-...-001..007):
--     1: graph_agent          created            (t=base+0h)
--     2: reasoning_agent      confidence_raised  (reasoning_report_id=5000...01, t=base+1h)
--     3: gardener_agent       revised            (entity merge object_initial → object_after_merge, t=base+2h)
--     4: reconciliation_agent revised            (merge-candidate resolution, t=base+3h)
--     5: user                 invalidated        (manual override, t=base+4h)
--     6: system_trigger       restored           (new evidence surfaced, t=base+5h)
--     7: cascade              expired            (upstream fact expiry, causal_event_id required, t=base+6h)
--
-- Base timestamp for deterministic ordering: 2026-01-01T00:00:00Z
-- Live schema notes (nmemo-klv.10 reconciliation):
--   reasoning_reports requires (mode CHECK 'patrol'|'query', report TEXT NOT NULL).
--     The previous v1.0 fixture targeted a non-existent `summary` column.
--   causal_events uses transition_type (CHECK enum 'created'|'strengthened'|
--     'weakened'|'expired'|'invalidated'); source_text not description.

BEGIN;

-- Entities ------------------------------------------------------------------
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Acme Corp',     'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000002', 'BetaSoft Inc',  'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000003', 'BetaSoft',      'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- Reasoning report (FK target for steps 2/3/4) ------------------------------
INSERT INTO public.reasoning_reports (id, mode, report, created_at)
VALUES
  ('50000000-0000-0000-0000-000000000001',
   'patrol',
   'Corroborated by secondary source: SEC 8-K filing 2026-01-02 confirms acquisition.',
   TIMESTAMPTZ '2026-01-01 00:30:00+00')
ON CONFLICT (id) DO NOTHING;

-- Fact under audit ----------------------------------------------------------
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

-- Upstream causal event (FK target for the cascade row at step 7) -----------
INSERT INTO public.causal_events (id, fact_id, transition_type, source_text, occurred_at)
VALUES
  ('20000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'expired',
   'Upstream fact in acquisition chain expired; cascade descendants',
   TIMESTAMPTZ '2026-01-01 06:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- fact_history — seven-step lifecycle ---------------------------------------
-- Step 1: graph_agent created (initial extraction)
INSERT INTO public.fact_history (
  id, fact_id, event_type,
  previous_confidence, new_confidence,
  previous_valid_at, new_valid_at,
  reasoning, source_references, actor, occurred_at
) VALUES (
  '40000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'created',
  NULL, 0.70,
  NULL, TIMESTAMPTZ '2026-01-01 00:00:00+00',
  'Extracted from source document "acme-press-release-2026-01-01.txt" by graph extraction pipeline.',
  '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000001","relevance":"press release span 0..142"}]'::jsonb,
  'graph_agent',
  TIMESTAMPTZ '2026-01-01 00:00:00+00'
);

-- Step 2: reasoning_agent confidence_raised (corroborated, links report)
INSERT INTO public.fact_history (
  id, fact_id, event_type,
  previous_confidence, new_confidence,
  reasoning, source_references, reasoning_report_id, actor, occurred_at
) VALUES (
  '40000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  'confidence_raised',
  0.70, 0.88,
  'Reasoning agent corroborated acquisition via SEC 8-K filing — confidence raised.',
  '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000002","relevance":"SEC 8-K cite"}]'::jsonb,
  '50000000-0000-0000-0000-000000000001',
  'reasoning_agent',
  TIMESTAMPTZ '2026-01-01 01:00:00+00'
);

-- Step 3: gardener_agent revised (gardener merged BetaSoft Inc → BetaSoft)
INSERT INTO public.fact_history (
  id, fact_id, event_type,
  reasoning, source_references, reasoning_report_id, actor, occurred_at
) VALUES (
  '40000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  'revised',
  'Gardener merge of object entity: BetaSoft Inc → BetaSoft (canonical form).',
  '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000003","relevance":"alias resolution"}]'::jsonb,
  '50000000-0000-0000-0000-000000000001',
  'gardener_agent',
  TIMESTAMPTZ '2026-01-01 02:00:00+00'
);

-- Step 4: reconciliation_agent revised (merge-candidate resolution)
INSERT INTO public.fact_history (
  id, fact_id, event_type,
  reasoning, source_references, reasoning_report_id, actor, occurred_at
) VALUES (
  '40000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000001',
  'revised',
  'Reconciliation agent resolved a merge-candidate conflict on the object entity.',
  '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000004","relevance":"merge-candidate conflict"}]'::jsonb,
  '50000000-0000-0000-0000-000000000001',
  'reconciliation_agent',
  TIMESTAMPTZ '2026-01-01 03:00:00+00'
);

-- Step 5: user invalidated (manual override)
INSERT INTO public.fact_history (
  id, fact_id, event_type,
  previous_confidence, new_confidence,
  previous_invalid_at, new_invalid_at,
  reasoning, source_references, actor, occurred_at
) VALUES (
  '40000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000001',
  'invalidated',
  0.88, 0.88,
  NULL, TIMESTAMPTZ '2026-01-01 04:00:00+00',
  'User-initiated override — questioned the acquisition close date.',
  '[]'::jsonb,
  'user',
  TIMESTAMPTZ '2026-01-01 04:00:00+00'
);

-- Step 6: system_trigger restored (new evidence reverses invalidation)
INSERT INTO public.fact_history (
  id, fact_id, event_type,
  previous_confidence, new_confidence,
  previous_invalid_at, new_invalid_at,
  reasoning, source_references, actor, occurred_at
) VALUES (
  '40000000-0000-0000-0000-000000000006',
  '10000000-0000-0000-0000-000000000001',
  'restored',
  0.88, 0.85,
  TIMESTAMPTZ '2026-01-01 04:00:00+00', NULL,
  'System trigger fired on new corroboration — invalidation reversed.',
  '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000006","relevance":"new corroborating source"}]'::jsonb,
  'system_trigger',
  TIMESTAMPTZ '2026-01-01 05:00:00+00'
);

-- Step 7: cascade expired (upstream fact expiry — references causal_event)
-- STRESSOR: actor=cascade requires causal_event_id non-null (business invariant).
INSERT INTO public.fact_history (
  id, fact_id, event_type,
  previous_confidence, new_confidence,
  reasoning, source_references, causal_event_id, actor, occurred_at
) VALUES (
  '40000000-0000-0000-0000-000000000007',
  '10000000-0000-0000-0000-000000000001',
  'expired',
  0.85, 0.0,
  'Cascade expiry — upstream causal event marked the chain expired.',
  '[{"type":"memory","id":"aaaaaaaa-0000-0000-0000-000000000007","relevance":"cascade expiry"}]'::jsonb,
  '20000000-0000-0000-0000-000000000001',
  'cascade',
  TIMESTAMPTZ '2026-01-01 06:00:00+00'
);

COMMIT;
