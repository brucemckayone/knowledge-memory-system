-- actor-escalation.sql (v1.0)
-- Phase 1 (Audit Trail Foundation) — L2 cross-actor sequence
-- Complexity score: 24 (rows=6, edges=0, stressors=2)
-- Stressors:
--   actor-diversity=7 (all seven valid actors must appear in final audit trail)
--   cross-actor-sequence=7 (seven-step lifecycle over a single fact)
--
-- UUID map:
--   entities:
--     00000000-0000-0000-0000-000000000001  subject            ("Acme Corp")
--     00000000-0000-0000-0000-000000000002  object_initial     ("BetaSoft Inc" — pre-gardener-merge)
--     00000000-0000-0000-0000-000000000003  object_after_merge ("BetaSoft"     — canonical form gardener merges to)
--   facts:
--     10000000-0000-0000-0000-000000000001  the fact under audit (Acme Corp acquired BetaSoft Inc)
--   reasoning_reports:
--     50000000-0000-0000-0000-000000000001  corroboration report used by reasoning_agent step
--   fact_history pre-seed:
--     40000000-0000-0000-0000-000000000001  initial 'created' event by graph_agent
--
-- Harness-driven mutation sequence (after loading this fixture):
--   Step 1: [PRE-SEEDED]   graph_agent          created            (t=base+0h)
--   Step 2: reasoning_agent       confidence_raised (reasoning_report_id=5000...01, t=base+1h)
--   Step 3: gardener_agent        revised           (entity merge object_initial → object_after_merge, t=base+2h)
--   Step 4: reconciliation_agent  revised           (merge-candidate resolution, t=base+3h)
--   Step 5: user                  invalidated       (manual override, t=base+4h)
--   Step 6: system_trigger        restored          (new evidence surfaced, t=base+5h)
--   Step 7: cascade               expired           (upstream fact expiry, references causal_event_id, t=base+6h)
--
-- Base timestamp for deterministic ordering: 2026-01-01T00:00:00Z

BEGIN;

-- Entities ------------------------------------------------------------------
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Acme Corp',     'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000002', 'BetaSoft Inc',  'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000003', 'BetaSoft',      'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- Reasoning report (FK target for the reasoning_agent step) -----------------
INSERT INTO public.reasoning_reports (id, summary, created_at)
VALUES
  ('50000000-0000-0000-0000-000000000001',
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

-- Initial audit row: graph_agent created the fact ---------------------------
-- All six downstream steps are driven by the harness through the service layer
-- so that each code path writes its own audit row with its own actor.
-- STRESSOR: actor-diversity=7 starts here; remaining 6 actors are driven live.
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

COMMIT;
