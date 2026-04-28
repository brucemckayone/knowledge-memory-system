-- promotion-race.sql
-- Adversarial fixture for Phase 6 (Pattern Lifecycle)
--
-- Scenario: a pattern at the staging→candidate threshold (instance_count=5,
-- last_seen recent). Two concurrent callers race promotePatterns. The
-- inline test in causal-patterns.test.ts already covers this with
-- Promise.all, but this fixture provides a deterministic seed for
-- nmemo-klv.6 corpus-driven concurrency benchmarks under the test-harden
-- skill.
--
-- Expected behaviour: exactly one transition fires (the SQL CAS via
-- WHERE status=$prev RETURNING ensures the loser sees zero rows). Naming
-- is called exactly once.

BEGIN;

INSERT INTO public.causal_patterns (id, name, description, template_structure, template_length,
                                     status, instance_count, activation_count_30d,
                                     first_seen_at, last_seen_at, promoted_at)
VALUES
  ('40000000-0000-0000-0000-00000000ra01',
   NULL,
   NULL,
   '[{"entity_type":"standard_rule","predicate_category":"race_a"},
     {"entity_type":"standard_rule","predicate_category":"race_b"}]'::jsonb,
   2, 'staging', 5, 0,
   NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 hour', NULL)
ON CONFLICT (id) DO NOTHING;

COMMIT;
