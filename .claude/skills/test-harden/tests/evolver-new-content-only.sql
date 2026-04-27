-- Extracted from live-evolver-output.md — only the NEW content the Evolver added in v1.2.
-- Used to verify the Evolver's contributions are schema-valid against cognitive_test
-- independently of the pre-existing v1.1 baseline issue (causal_events.event_type column).
-- This file is regenerated as needed; not part of the test suite.

-- New entity: Bob
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('00000000-0000-0000-0000-000000000002', 'Bob', 'person',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- Need Acme Corp + Bob in place before adding Bob fact
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('00000000-0000-0000-0000-000000000010', 'Acme Corp', 'company',
   ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

-- New fact: Bob works_at Acme (race target)
INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at)
VALUES
  ('10000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000002', 'works_at',
   '00000000-0000-0000-0000-000000000010', 0.5, NOW() - INTERVAL '7 days')
ON CONFLICT (id) DO NOTHING;

-- The 4 race-burst fact_history rows the Evolver added
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence,
   previous_valid_at, new_valid_at, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-00000000000a',
   '10000000-0000-0000-0000-000000000002', 'created',
   NULL, 0.5,
   NULL, NOW() - INTERVAL '7 days',
   'Initial extraction — Bob employment fact',
   '[{"type":"memory","id":"bbbbbbbb-0000-0000-0000-000000000001","relevance":"Bob hired at Acme"}]'::jsonb,
   'graph_agent', NOW() - INTERVAL '50 milliseconds');

INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-00000000000b',
   '10000000-0000-0000-0000-000000000002', 'confidence_raised',
   0.5, 0.75,
   'Concurrent reasoning pass corroborated Bob employment',
   '[{"type":"memory","id":"bbbbbbbb-0000-0000-0000-000000000002","relevance":"Bob @ Acme corroborated"}]'::jsonb,
   'reasoning_agent', NOW() - INTERVAL '40 milliseconds');

INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-00000000000c',
   '10000000-0000-0000-0000-000000000002', 'confidence_lowered',
   0.75, 0.6,
   'Gardener pass caught conflicting signal mid-flight — lowering',
   '[{"type":"memory","id":"bbbbbbbb-0000-0000-0000-000000000003","relevance":"Bob conflict signal"}]'::jsonb,
   'gardener_agent', NOW() - INTERVAL '40 milliseconds');

-- Note: this row references causal_event_id = 20...001 which the v1.1 fixture
-- was supposed to have inserted. For this isolated validation we skip the
-- causal_event reference since the v1.1 baseline INSERT into public.causal_events
-- is itself broken (uses 'event_type' column that doesn't exist on current
-- schema; column is named 'transition_type' and the value 'supersede' is not
-- in valid_transition_type CHECK either). Filed as a separate finding under
-- nmemo-w4j. The race-burst row B4 below has causal_event_id removed for this
-- isolated check.
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-00000000000d',
   '10000000-0000-0000-0000-000000000002', 'superseded',
   0.6, 0.6,
   'System trigger superseded Bob fact under concurrent write pressure',
   '[{"type":"memory","id":"bbbbbbbb-0000-0000-0000-000000000004","relevance":"Bob superseded"}]'::jsonb,
   'system_trigger', NOW() - INTERVAL '20 milliseconds');
