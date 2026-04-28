-- orphan-node.sql
-- Level 1 edge fixture for Phase 4
--
-- Scenario: An entity with NO facts, NO causal events, NO citations.
-- Verifies analyzeImpact returns an empty BlastRadiusReport
-- (totalAffected=0, all four buckets empty).
--
-- UUID map:
--   Orphan:   00000004-0000-0000-0000-000000000000

BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, properties)
VALUES ('00000004-0000-0000-0000-000000000000', 'OrphanNode', 'concept', '{}'::jsonb);

COMMIT;
