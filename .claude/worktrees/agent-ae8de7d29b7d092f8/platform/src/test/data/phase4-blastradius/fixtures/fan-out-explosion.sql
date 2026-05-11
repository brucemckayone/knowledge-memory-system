-- fan-out-explosion.sql
-- Adversarial fixture for Phase 4
--
-- Scenario: 1 fact cited by 500 active causal_edges. Stresses the citation
-- lookup (findCitationDependents → findEdgesCitingReference → edge_source_refs
-- index scan) to verify the response stays sub-second.
--
-- Topology:
--   - 1 anchor entity
--   - 1 anchor fact (the citation target)
--   - 502 events: 1 cause + 500 effects + 1 distractor
--   - 500 edges, each citing the anchor fact via edge_source_refs
--
-- UUID space:
--   Anchor entity: 00000005-0000-0000-0000-000000000000
--   Anchor fact:   10000005-0000-0000-0000-000000000000
--   Cause event:   20000005-0000-0000-0000-000000000000
--   Effect events: 20000005-0000-0000-0000-(000000000001..0000000001f4)  -- 500 events
--   Edges:         30000005-0000-0000-0000-(000000000001..0000000001f4)  -- 500 edges

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, properties)
VALUES ('00000005-0000-0000-0000-000000000000', 'FanOutAnchor', 'concept', '{}'::jsonb);

INSERT INTO public.facts (id, subject_entity_id, predicate, object_value)
VALUES (
  '10000005-0000-0000-0000-000000000000',
  '00000005-0000-0000-0000-000000000000',
  'is',
  'cited everywhere'
);

INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text)
VALUES (
  '20000005-0000-0000-0000-000000000000',
  '10000005-0000-0000-0000-000000000000',
  'created',
  '00000005-0000-0000-0000-000000000000',
  'is',
  'fan-out cause'
);

-- 500 effect events
INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text)
SELECT
  ('20000005-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid,
  '10000005-0000-0000-0000-000000000000'::uuid,
  'strengthened',
  '00000005-0000-0000-0000-000000000000'::uuid,
  'is',
  'fan-out effect ' || i::text
FROM generate_series(1, 500) AS i;

-- 500 edges from cause -> each effect
INSERT INTO public.causal_edges (
  id, cause_event_id, effect_event_id, strength, reasoning,
  source_references, extraction_method, corroboration_count, initial_strength
)
SELECT
  ('30000005-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid,
  '20000005-0000-0000-0000-000000000000'::uuid,
  ('20000005-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid,
  0.7,
  'fan-out edge ' || i::text,
  '[]'::jsonb,
  'manual',
  1,
  0.7
FROM generate_series(1, 500) AS i;

-- Each edge cites the anchor fact via edge_source_refs (the Phase 3 index)
INSERT INTO public.edge_source_refs (edge_id, ref_type, ref_id)
SELECT
  ('30000005-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid,
  'fact',
  '10000005-0000-0000-0000-000000000000'::uuid
FROM generate_series(1, 500) AS i;

COMMIT;
