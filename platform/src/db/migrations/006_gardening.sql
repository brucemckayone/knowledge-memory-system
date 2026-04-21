-- 006_gardening.sql — Graph Gardener: reports table
--
-- Stores structured reports from gardener agent sessions.
-- Each run produces a report with topology overview, actions taken,
-- and recommendations for future runs.
--
-- NOTE: Uses explicit public. schema qualifiers (AGE search_path).

CREATE TABLE IF NOT EXISTS public.gardening_reports (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What triggered this run
  trigger_type          VARCHAR(20) NOT NULL DEFAULT 'manual',  -- 'manual' | 'auto'

  -- Graph agent runs since last gardening (for auto-triggered)
  runs_since_last       INT NOT NULL DEFAULT 0,

  -- Structured action log
  -- [{type: 'same_as'|'merge'|'fact'|'summary'|'alias', entities: [...], reasoning: '...'}]
  actions               JSONB NOT NULL DEFAULT '[]',

  -- Counts for quick filtering
  same_as_created       INT NOT NULL DEFAULT 0,
  merges_executed       INT NOT NULL DEFAULT 0,
  facts_created         INT NOT NULL DEFAULT 0,
  summaries_updated     INT NOT NULL DEFAULT 0,

  -- Topology snapshot at time of run
  total_entities        INT,
  total_components      INT,
  islands_investigated  INT NOT NULL DEFAULT 0,

  -- Full agent report text (PHASE 4 output)
  report_text           TEXT NOT NULL,

  -- Timing
  duration_ms           INT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gardening_reports_created
  ON public.gardening_reports (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gardening_reports_trigger
  ON public.gardening_reports (trigger_type);
