-- 011_contradictions.sql — Phase 5 of Reasoning Layer Hardening
--
-- Surfaces contradictions as first-class records: same-subject/predicate facts
-- with different objects, edges citing expired facts, causal cycles without
-- temporal separation, edges where cause occurs after effect, and (later)
-- agent-detected chain conflicts.
--
-- Detection is cheap SQL run on the same periodic counter as confidence decay
-- (`pipeline.ts`'s DECAY_RUN_INTERVAL). Resolution is thoughtful and auditable,
-- executed by the reasoning agent during patrol via two new MCP tools.
--
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user"
-- at session level. DO NOT change it — AGE and Graph S triggers depend on
-- ag_catalog being in the path. All DDL uses explicit public. qualifier so
-- objects land in the right schema.
--
-- Forward-only and idempotent: CREATE TABLE/INDEX IF NOT EXISTS. Re-running is
-- safe.

-- ============================================
-- 1. contradictions — first-class flagged conflicts
-- ============================================
--
-- Polymorphic node references — every contradiction touches at least one of
-- (facts, causal_edges, entities). The CHECK at_least_one_node enforces this.
-- Heuristic-specific column usage:
--   opposing_object     → fact_a_id, fact_b_id, entity_id (the shared subject)
--   expired_but_cited   → edge_a_id, fact_a_id (the cited expired fact)
--   cyclic_causal       → edge_a_id, edge_b_id (the two edges forming a cycle)
--   temporal_impossible → edge_a_id (cause.occurred_at > effect.occurred_at)
--   chain_conflict      → set by the reasoning agent during patrol; columns
--                         per its judgement

CREATE TABLE IF NOT EXISTS public.contradictions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contradiction_type       VARCHAR(32) NOT NULL,

  -- Polymorphic node references (at least one non-null)
  fact_a_id                UUID REFERENCES public.facts(id),
  fact_b_id                UUID REFERENCES public.facts(id),
  edge_a_id                UUID REFERENCES public.causal_edges(id),
  edge_b_id                UUID REFERENCES public.causal_edges(id),
  entity_id                UUID REFERENCES public.entities(id),

  -- Detection metadata
  detected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detected_by              VARCHAR(32) NOT NULL,
  detection_reasoning      TEXT NOT NULL,
  detection_context        JSONB,
  severity                 VARCHAR(10) NOT NULL DEFAULT 'medium',

  -- Resolution
  resolved_at              TIMESTAMPTZ,
  resolved_by              VARCHAR(32),
  resolution_type          VARCHAR(20),
  resolution_reasoning     TEXT,
  resolution_report_id     UUID REFERENCES public.reasoning_reports(id),

  -- Dismissal / lifecycle
  dismissed_reason         TEXT,

  CONSTRAINT valid_contradiction_type CHECK (
    contradiction_type IN ('opposing_object', 'expired_but_cited',
                           'cyclic_causal', 'chain_conflict', 'temporal_impossible')
  ),
  CONSTRAINT valid_detected_by CHECK (
    detected_by IN ('sql_heuristic', 'reasoning_agent', 'user')
  ),
  CONSTRAINT valid_resolution_type CHECK (
    resolution_type IS NULL OR resolution_type IN (
      'expire_a', 'expire_b', 'expire_both', 'reconcile', 'both_valid',
      'invalidate_a', 'invalidate_b', 'dismissed'
    )
  ),
  CONSTRAINT valid_severity CHECK (severity IN ('critical', 'high', 'medium', 'low')),

  -- At least one node reference required
  CONSTRAINT at_least_one_node CHECK (
    fact_a_id IS NOT NULL OR fact_b_id IS NOT NULL OR
    edge_a_id IS NOT NULL OR edge_b_id IS NOT NULL OR
    entity_id IS NOT NULL
  )
);

-- ============================================
-- 2. Indexes
-- ============================================

-- Common lookup: unresolved contradictions, newest first
CREATE INDEX IF NOT EXISTS idx_contradictions_unresolved
  ON public.contradictions (detected_at DESC)
  WHERE resolved_at IS NULL;

-- Filter by type
CREATE INDEX IF NOT EXISTS idx_contradictions_type
  ON public.contradictions (contradiction_type);

-- Filter by entity (for opposing_object scope)
CREATE INDEX IF NOT EXISTS idx_contradictions_entity
  ON public.contradictions (entity_id)
  WHERE entity_id IS NOT NULL;

-- Resolution-report linkage for provenance queries
CREATE INDEX IF NOT EXISTS idx_contradictions_resolution_report
  ON public.contradictions (resolution_report_id)
  WHERE resolution_report_id IS NOT NULL;

-- Dedup: prevent re-detecting the same conflict while it's still open. The
-- partial index covers ALL four heuristic types — NULL columns map to a
-- zero-UUID sentinel via COALESCE so the unique tuple is well-defined for
-- every detection pattern. Once resolved, a new row may be created if the
-- same conflict re-emerges (the WHERE resolved_at IS NULL ensures this).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contradictions_unique_active
  ON public.contradictions (
    contradiction_type,
    COALESCE(fact_a_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(fact_b_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(edge_a_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(edge_b_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE resolved_at IS NULL;
