## Mutation proposal

**Fixture version:** v1.1 → v1.2
**Axis:** concurrency
**Criterion targeted:** "Every mutation path through `facts.ts` and `causal.ts` writes an audit row" + benchmark target `audit_row_written_atomically: true` (docs/architecture/truth-graph/12-audit-trail-foundation.md, Acceptance Criteria)
**Complexity delta:** +6 (from 14 to 20)

### Rationale

The `simple-mutations` scenario has plateaued with seven stressors all clustered on the structural, temporal, and breadth axes. Concurrency is the single axis with **zero coverage** in the existing stressor list, yet the phase doc explicitly asserts atomicity ("audit_row_written_atomically: true") and a universal write-on-every-mutation-path invariant. A serialized 8-row lifecycle cannot stress those guarantees — only contended, sub-millisecond-overlap inserts can. This mutation introduces a second fact (Bob → Acme Corp) plus a 4-row "race burst" region annotated for the harness's parallel writer pool, where four distinct actors mutate the same target fact inside a 100ms window with intentionally co-located `occurred_at` values. The criterion under test: regardless of write order, all four audit rows must persist (no lost row), the actor-distribution must remain exact, and the row_count assertion must hold without relying on chronological order to disambiguate. A pass proves audit writes are atomic under contention; a failure exposes either a lost-row race in the audit-trail write path or a non-deterministic ordering bug that the prior serial fixture could never surface.

### Fixture diff

```sql
-- simple-mutations.sql (v1.2)
-- Phase 1 (Audit Trail Foundation) — concurrency-stressed main fixture
-- Complexity score: 20 (rows=18, edges=0, stressors=9)
-- Stressors:
--   1. event-type breadth (6/8 enum values exercised)
--   2. actor diversity (7/7 enum values exercised across 8 history rows)
--   3. FK integrity — reasoning_report_id non-null on revised row
--   4. FK integrity — causal_event_id non-null on superseded + invalidated rows
--   5. confidence monotonicity violation check (raised then lowered then restored)
--   6. valid_at window mutation (revised event shifts both previous/new valid_at)
--   7. invalidated → restored round-trip (tests restoration path)
--   8. reverse-chronological ordering with dense occurred_at (sub-day deltas)
--   9. NEW v1.2: concurrency=4 — four parallel writers race against a second fact
--      inside a 100ms window. Tests audit-row atomicity under contention and
--      non-chronological ordering disambiguation (tie-breaking on id when
--      occurred_at collides).
--
-- UUID map:
--   Entity Alice     : 00000000-0000-0000-0000-000000000001
--   Entity Bob       : 00000000-0000-0000-0000-000000000002   (NEW v1.2)
--   Entity Acme Corp : 00000000-0000-0000-0000-000000000010
--   Fact Alice→Acme  : 10000000-0000-0000-0000-000000000001
--   Fact Bob→Acme    : 10000000-0000-0000-0000-000000000002   (NEW v1.2 — race target)
--   causal_event     : 20000000-0000-0000-0000-000000000001
--   reasoning_report : 50000000-0000-0000-0000-000000000001
--   fact_history A1..A8: 40000000-0000-0000-0000-00000000000[1-8]   (Alice fact)
--   fact_history B1..B4: 40000000-0000-0000-0000-0000000000[a-d]    (Bob fact, NEW v1.2)

BEGIN;

-- Subjects ------------------------------------------------------------------
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Alice',     'person',  ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000002', 'Bob',       'person',  ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0),
  ('00000000-0000-0000-0000-000000000010', 'Acme Corp', 'company', ARRAY(SELECT random() FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.facts (id, subject_entity_id, predicate, object_entity_id, confidence, valid_at)
VALUES
  ('10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000001', 'works_at',
   '00000000-0000-0000-0000-000000000010', 0.6, NOW() - INTERVAL '10 days'),
  -- NEW v1.2: race target
  ('10000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000002', 'works_at',
   '00000000-0000-0000-0000-000000000010', 0.5, NOW() - INTERVAL '7 days')
ON CONFLICT (id) DO NOTHING;

-- Referent rows for FK-integrity stressors ---------------------------------
-- STRESSOR: fk-integrity=causal_event_id — pre-seeded so history rows 5 & 7 reference a real row
INSERT INTO public.causal_events (id, fact_id, event_type, description, occurred_at)
VALUES
  ('20000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'supersede',
   'Alice role superseded by newer memory',
   NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- STRESSOR: fk-integrity=reasoning_report_id — pre-seeded so history row 3 references a real row
INSERT INTO public.reasoning_reports (id, summary, created_at)
VALUES
  ('50000000-0000-0000-0000-000000000001',
   'Periodic reasoning pass revised works_at validity window',
   NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- BLOCK A: Alice fact lifecycle (unchanged from v1.1) — serial 8-row history
-- ============================================================================

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

-- ============================================================================
-- BLOCK B: Bob fact race burst — 4 parallel writers, sub-100ms collision window
-- STRESSOR: concurrency=4
-- The harness reads this region marker and dispatches each tagged INSERT through
-- a distinct connection from a parallel writer pool. The four occurred_at values
-- are intentionally clustered inside a 100ms window with one exact collision
-- between rows B2 and B3 to force tie-breaking by id.
-- ============================================================================

-- PARALLEL_REGION_BEGIN: bob-fact-race
-- Race row B1: created (graph_agent)
-- STRESSOR: concurrency=4 — writer-1
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

-- Race row B2: confidence_raised (reasoning_agent) — collides with B3 occurred_at
-- STRESSOR: concurrency=4 — writer-2 + occurred_at-collision
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-00000000000b',
   '10000000-0000-0000-0000-000000000002', 'confidence_raised',
   0.5, 0.75,
   'Concurrent reasoning pass corroborated Bob employment',
   '[{"type":"memory","id":"bbbbbbbb-0000-0000-0000-000000000002","relevance":"Bob @ Acme corroborated"}]'::jsonb,
   'reasoning_agent', NOW() - INTERVAL '40 milliseconds');

-- Race row B3: confidence_lowered (gardener_agent) — collides with B2 occurred_at
-- STRESSOR: concurrency=4 — writer-3 + occurred_at-collision
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-00000000000c',
   '10000000-0000-0000-0000-000000000002', 'confidence_lowered',
   0.75, 0.6,
   'Gardener pass caught conflicting signal mid-flight — lowering',
   '[{"type":"memory","id":"bbbbbbbb-0000-0000-0000-000000000003","relevance":"Bob conflict signal"}]'::jsonb,
   'gardener_agent', NOW() - INTERVAL '40 milliseconds');

-- Race row B4: superseded (system_trigger, causal_event_id non-null)
-- STRESSOR: concurrency=4 — writer-4 + fk-integrity=causal_event_id under contention
INSERT INTO public.fact_history
  (id, fact_id, event_type, previous_confidence, new_confidence, reasoning, source_references, causal_event_id, actor, occurred_at)
VALUES
  ('40000000-0000-0000-0000-00000000000d',
   '10000000-0000-0000-0000-000000000002', 'superseded',
   0.6, 0.6,
   'System trigger superseded Bob fact under concurrent write pressure',
   '[{"type":"memory","id":"bbbbbbbb-0000-0000-0000-000000000004","relevance":"Bob superseded"}]'::jsonb,
   '20000000-0000-0000-0000-000000000001',
   'system_trigger', NOW() - INTERVAL '20 milliseconds');
-- PARALLEL_REGION_END: bob-fact-race

COMMIT;
```

### Expected JSON diff

```json
{
  "scenario": "simple-mutations",
  "version": "1.2",
  "data_set_level": 1,
  "fixture": "phase1-audit/fixtures/simple-mutations.sql",
  "description": "Single-fact lifecycle (Alice/Acme, 8 rows) plus a 4-writer concurrency burst on a second fact (Bob/Acme) with an intentional occurred_at collision. Exercises 6/8 event_type values, all 7 actor values, and adds a concurrency=4 stressor on the audit-write path.",
  "mutation_sequence_as_seeded": [
    { "step": 1, "event_type": "created",              "actor": "graph_agent",          "fact_history_id": "40000000-0000-0000-0000-000000000001", "new_confidence": 0.6 },
    { "step": 2, "event_type": "confidence_raised",    "actor": "reasoning_agent",      "fact_history_id": "40000000-0000-0000-0000-000000000002", "previous_confidence": 0.6, "new_confidence": 0.9 },
    { "step": 3, "event_type": "revised",              "actor": "reasoning_agent",      "fact_history_id": "40000000-0000-0000-0000-000000000003", "reasoning_report_id": "50000000-0000-0000-0000-000000000001" },
    { "step": 4, "event_type": "confidence_lowered",   "actor": "gardener_agent",       "fact_history_id": "40000000-0000-0000-0000-000000000004", "previous_confidence": 0.9, "new_confidence": 0.55 },
    { "step": 5, "event_type": "invalidated",          "actor": "reconciliation_agent", "fact_history_id": "40000000-0000-0000-0000-000000000005", "causal_event_id": "20000000-0000-0000-0000-000000000001" },
    { "step": 6, "event_type": "restored",             "actor": "user",                 "fact_history_id": "40000000-0000-0000-0000-000000000006", "new_confidence": 0.7 },
    { "step": 7, "event_type": "superseded",           "actor": "system_trigger",       "fact_history_id": "40000000-0000-0000-0000-000000000007", "causal_event_id": "20000000-0000-0000-0000-000000000001" },
    { "step": 8, "event_type": "expired",              "actor": "cascade",              "fact_history_id": "40000000-0000-0000-0000-000000000008", "new_confidence": 0.0 }
  ],
  "race_burst_as_seeded": {
    "fact_id": "10000000-0000-0000-0000-000000000002",
    "writer_pool_size": 4,
    "rows": [
      { "writer": "writer-1", "event_type": "created",            "actor": "graph_agent",     "fact_history_id": "40000000-0000-0000-0000-00000000000a" },
      { "writer": "writer-2", "event_type": "confidence_raised",  "actor": "reasoning_agent", "fact_history_id": "40000000-0000-0000-0000-00000000000b" },
      { "writer": "writer-3", "event_type": "confidence_lowered", "actor": "gardener_agent",  "fact_history_id": "40000000-0000-0000-0000-00000000000c" },
      { "writer": "writer-4", "event_type": "superseded",         "actor": "system_trigger",  "fact_history_id": "40000000-0000-0000-0000-00000000000d", "causal_event_id": "20000000-0000-0000-0000-000000000001" }
    ],
    "occurred_at_collision_pair": [
      "40000000-0000-0000-0000-00000000000b",
      "40000000-0000-0000-0000-00000000000c"
    ]
  },
  "assertions": [
    {
      "type": "row_count",
      "table": "fact_history",
      "filter": { "fact_id": "10000000-0000-0000-0000-000000000001" },
      "expected": 8,
      "because": "Eight mutation events seeded for Alice fact; no loss after load"
    },
    {
      "type": "row_count",
      "table": "fact_history",
      "filter": { "fact_id": "10000000-0000-0000-0000-000000000002" },
      "expected": 4,
      "because": "Concurrency burst: four parallel writers must all persist; no lost rows under contention (atomicity criterion)"
    },
    {
      "type": "row_count_total",
      "table": "fact_history",
      "filter": { "fact_id_in": ["10000000-0000-0000-0000-000000000001", "10000000-0000-0000-0000-000000000002"] },
      "expected": 12,
      "because": "Aggregate post-load count must equal serial(8) + concurrent(4); any deficit indicates a lost write"
    },
    {
      "type": "column_sequence",
      "table": "fact_history",
      "filter": { "fact_id": "10000000-0000-0000-0000-000000000001" },
      "order_by": "occurred_at ASC",
      "column": "event_type",
      "expected": ["created","confidence_raised","revised","confidence_lowered","invalidated","restored","superseded","expired"],
      "because": "Forward-chronological order of the seeded Alice lifecycle"
    },
    {
      "type": "column_sequence",
      "table": "fact_history",
      "filter": { "fact_id": "10000000-0000-0000-0000-000000000001" },
      "order_by": "occurred_at DESC",
      "column": "event_type",
      "expected": ["expired","superseded","restored","invalidated","confidence_lowered","revised","confidence_raised","created"],
      "because": "Reverse-chronological ordering criterion (Alice fact)"
    },
    {
      "type": "set_equality",
      "table": "fact_history",
      "filter": { "fact_id": "10000000-0000-0000-0000-000000000002" },
      "column": "event_type",
      "expected_set": ["created", "confidence_raised", "confidence_lowered", "superseded"],
      "because": "Bob race burst: all four event_types must appear regardless of arrival order — set equality, not sequence equality, because two rows share occurred_at"
    },
    {
      "type": "set_equality",
      "table": "fact_history",
      "filter": { "fact_id": "10000000-0000-0000-0000-000000000002" },
      "column": "actor",
      "expected_set": ["graph_agent", "reasoning_agent", "gardener_agent", "system_trigger"],
      "because": "Each parallel writer's actor identity must persist exactly once — no audit row substitution under contention"
    },
    {
      "type": "tiebreak_ordering",
      "table": "fact_history",
      "filter": { "fact_id": "10000000-0000-0000-0000-000000000002" },
      "order_by": ["occurred_at ASC", "id ASC"],
      "expected": "deterministic_total_order",
      "because": "Two rows share occurred_at; tie-breaking on id (or another stable column) must yield a deterministic order so the reverse-chronological criterion remains well-defined"
    },
    {
      "type": "actor_distribution",
      "table": "fact_history",
      "filter": { "fact_id": "10000000-0000-0000-0000-000000000001" },
      "expected": { "graph_agent": 1, "reasoning_agent": 2, "gardener_agent": 1, "reconciliation_agent": 1, "user": 1, "system_trigger": 1, "cascade": 1 },
      "because": "All 7 actors exercised at least once on the Alice fact"
    },
    {
      "type": "column_values",
      "table": "fact_history",
      "filter": { "id": "40000000-0000-0000-0000-000000000002" },
      "assertions": [
        { "column": "previous_confidence", "expected": 0.6 },
        { "column": "new_confidence", "expected": 0.9 },
        { "column": "actor", "expected": "reasoning_agent" }
      ],
      "because": "confidence_raised captures both values + acting agent"
    },
    {
      "type": "column_values",
      "table": "fact_history",
      "filter": { "id": "40000000-0000-0000-0000-000000000003" },
      "assertions": [
        { "column": "event_type", "expected": "revised" },
        { "column": "reasoning_report_id", "expected": "50000000-0000-0000-0000-000000000001" }
      ],
      "because": "Revised event links to a real reasoning_report"
    },
    {
      "type": "foreign_key_integrity",
      "table": "fact_history",
      "columns": ["reasoning_report_id", "causal_event_id", "fact_id"],
      "rule": "non_null_values_reference_existing_rows",
      "because": "FK integrity is a Phase 1 acceptance criterion — must hold for both serial and concurrent inserts"
    },
    {
      "type": "orphan_retention",
      "description": "Deleting public.facts row 10000000-...-001 leaves the 8 fact_history rows intact",
      "expected": true,
      "because": "Audit rows must not cascade-delete with parent fact"
    },
    {
      "type": "orphan_retention",
      "description": "Deleting public.facts row 10000000-...-002 leaves the 4 race-burst fact_history rows intact",
      "expected": true,
      "because": "Audit retention guarantee must also hold for rows written under concurrent contention"
    },
    {
      "type": "limit_param",
      "description": "getFactHistory(fact_id=Alice, limit=3) returns only 3 most recent rows",
      "expected_event_types": ["expired","superseded","restored"],
      "because": "Limit param respected on the deterministic Alice fact"
    },
    {
      "type": "atomicity_under_contention",
      "description": "After parallel-writer pool drains for fact 10000000-...-002, exactly 4 rows exist and each has a non-null occurred_at and a non-empty reasoning column",
      "expected": true,
      "because": "audit_row_written_atomically benchmark target — no partial inserts, no lost rows, no NULL leakage under concurrent writes"
    }
  ],
  "benchmark_targets": {
    "insert_single_history_row_p95_ms": 5,
    "history_query_8_rows_p95_ms": 10,
    "history_query_with_limit_p95_ms": 8,
    "audit_row_written_atomically": true,
    "concurrent_4_writers_no_lost_rows": true,
    "concurrent_4_writers_p95_total_ms": 200
  },
  "adversarial_variants": [
    { "fixture": "simple-mutations-timing-attack.sql", "expected_failure_mode": "ordering_invariant_violation_or_check_rejection" },
    { "fixture": "simple-mutations-empty-reasoning.sql", "expected_failure_mode": "service_layer_rejection" }
  ],
  "graduation_notes": "Ready for L2 when: Alice 8-row block loads cleanly; Bob race burst yields exactly 4 rows with all 4 distinct event_types and actors; aggregate row count = 12; tie-breaking ordering is deterministic; orphan retention verified for both facts; both adversarial variants fail at expected layer."
}
```

### Regression-test promise

This mutation MUST pass on iteration N+1. If it fails, either:
(a) there's a real bug in the code (file bead via Code Analyser) — likely candidates: a lost-row race on the audit-trail write path (row_count for fact 2 < 4), a non-deterministic ordering bug surfaced by the occurred_at collision (tiebreak_ordering assertion), or a NULL leakage on `occurred_at`/`reasoning` under contention (atomicity_under_contention assertion), or
(b) the fixture has a malformed assertion (self-correct and retry) — most likely the harness's parallel-writer dispatch interpreting the `PARALLEL_REGION_BEGIN`/`END` markers, or the `set_equality` assertion shape if the harness doesn't yet support unordered comparison.
