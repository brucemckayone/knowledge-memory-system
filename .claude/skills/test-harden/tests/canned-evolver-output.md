## Mutation proposal

**Fixture version:** v1.1 -> v1.2-canned
**Axis:** adversarial-temporal
**Criterion targeted:** "Reverse-chronological ordering with dense occurred_at (sub-day deltas)"
**Complexity delta:** +6 (from 14 to 20)

### Rationale
The current v1.1 fixture seeds 8 history rows with day-level offsets. This canned mutation tightens 3 of them to sub-second offsets while keeping the relative ordering, to verify that getFactHistory's ORDER BY occurred_at DESC remains stable when the timestamps are visually ambiguous to a human reader. STRESSOR adds dense-timestamps marker.

### Fixture diff
```sql
-- simple-mutations.sql (v1.2-canned) — test-harden canned smoke fixture
-- Mutation: tighten 3 history-row deltas to sub-second offsets
-- STRESSOR: dense-timestamps=sub-second
BEGIN;

INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Alice',     'person',  ARRAY(SELECT 0.0 FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000010', 'Acme Corp', 'company', ARRAY(SELECT 0.0 FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at)
VALUES
  ('10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001', 'works_at',
   '00000000-0000-0000-0000-000000000010', 0.6, NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence,
   reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', 'created',
   NULL, 0.6,
   'Initial extraction from source memory',
   '[]'::jsonb,
   'graph_agent', NOW() - INTERVAL '10 days');

COMMIT;
```

### Expected JSON diff
```json
{
  "scenario": "simple-mutations",
  "version": "1.2-canned",
  "data_set_level": 1,
  "fixture": "phase1-audit/fixtures/simple-mutations.sql",
  "description": "Canned smoke test: minimal viable fixture with 1 history row, used to verify the apply-evolver-output.py pipeline.",
  "assertions": [
    {
      "type": "row_count",
      "table": "fact_history",
      "filter": { "fact_id": "10000000-0000-0000-0000-000000000001" },
      "expected": 1,
      "because": "Canned smoke fixture seeds exactly one history row"
    }
  ],
  "benchmark_targets": {
    "insert_single_history_row_p95_ms": 5
  }
}
```

### Regression-test promise
This mutation MUST pass on iteration N+1. If it fails, either (a) there's a real bug in the code, or (b) the fixture has a malformed assertion.
