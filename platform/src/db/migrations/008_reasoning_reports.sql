-- 008: Reasoning reports — provenance and continuity for the reasoning agent.
--
-- Each reasoning pass (patrol or query) produces a report linked to the
-- entities, facts, and causal edges it touched. Future passes read prior
-- reports to build on previous reasoning rather than starting from scratch.
--
-- NOTE: Uses explicit public. schema qualifiers (see 002_causal_graph.sql header).

-- ============================================
-- 1. Reasoning Reports
-- ============================================
CREATE TABLE IF NOT EXISTS public.reasoning_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Operating mode
  mode              VARCHAR(20) NOT NULL CHECK (mode IN ('patrol', 'query')),
  question          TEXT,                     -- user's question (query mode only)

  -- The report itself
  report            TEXT NOT NULL,            -- structured markdown: findings, actions, confidence
  actions_taken     JSONB NOT NULL DEFAULT '{}',  -- freeform structured log; consumer-defined, no canonical shape

  -- Linked graph objects (what this report touched)
  entity_ids        UUID[] NOT NULL DEFAULT '{}',
  fact_ids          UUID[] NOT NULL DEFAULT '{}',
  causal_edge_ids   UUID[] NOT NULL DEFAULT '{}',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Find reports that touched a specific entity
CREATE INDEX IF NOT EXISTS idx_reasoning_reports_entity_ids
  ON public.reasoning_reports USING gin (entity_ids);

-- Find reports by mode and recency
CREATE INDEX IF NOT EXISTS idx_reasoning_reports_mode_created
  ON public.reasoning_reports (mode, created_at DESC);

-- ============================================
-- 2. Add last_reasoned_at to entity_meta
-- ============================================
ALTER TABLE public.entity_meta
  ADD COLUMN IF NOT EXISTS last_reasoned_at TIMESTAMPTZ;
