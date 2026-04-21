-- 009_audit_trail.sql — Phase 1 of Reasoning Layer Hardening
--
-- Audit trail for every mutation to facts and causal_edges. Every later
-- reasoning-layer capability (corroboration, decay, cascade, contradictions,
-- patterns) assumes this history exists.
--
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user"
-- at session level. DO NOT change it — AGE and Graph S triggers depend on
-- ag_catalog being in the path. All DDL uses explicit public. qualifier so
-- objects land in the right schema.
--
-- Forward-only: CREATE TABLE IF NOT EXISTS + guarded backfill. Running twice
-- is safe. Rolling back drops audit rows = data loss — fix forward instead.

-- ============================================
-- 1. fact_history — append-only log of fact mutations
-- ============================================
CREATE TABLE IF NOT EXISTS public.fact_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id               UUID NOT NULL REFERENCES public.facts(id),
  event_type            VARCHAR(20) NOT NULL,

  -- Bi-temporal deltas (only the ones relevant to this event need populating)
  previous_confidence   FLOAT,
  new_confidence        FLOAT,
  previous_valid_at     TIMESTAMPTZ,
  new_valid_at          TIMESTAMPTZ,
  previous_invalid_at   TIMESTAMPTZ,
  new_invalid_at        TIMESTAMPTZ,

  -- Narrative audit (non-negotiable)
  reasoning             TEXT NOT NULL,
  source_references     JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Provenance links
  reasoning_report_id   UUID REFERENCES public.reasoning_reports(id),
  causal_event_id       UUID REFERENCES public.causal_events(id),

  -- Who did this and when the observation landed
  actor                 VARCHAR(32) NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_fact_event_type CHECK (
    event_type IN ('created', 'confidence_raised', 'confidence_lowered',
                   'revised', 'superseded', 'expired', 'invalidated', 'restored')
  ),
  CONSTRAINT valid_fact_actor CHECK (
    actor IN ('graph_agent', 'reasoning_agent', 'gardener_agent',
              'reconciliation_agent', 'user', 'system_trigger', 'cascade')
  )
);

CREATE INDEX IF NOT EXISTS idx_fact_history_fact
  ON public.fact_history (fact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_history_report
  ON public.fact_history (reasoning_report_id)
  WHERE reasoning_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fact_history_actor
  ON public.fact_history (actor);
CREATE INDEX IF NOT EXISTS idx_fact_history_occurred
  ON public.fact_history (occurred_at DESC);

-- ============================================
-- 2. causal_edge_history — append-only log of causal_edge mutations
-- ============================================
CREATE TABLE IF NOT EXISTS public.causal_edge_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edge_id               UUID NOT NULL REFERENCES public.causal_edges(id),
  event_type            VARCHAR(20) NOT NULL,

  -- Strength and reasoning deltas
  previous_strength     FLOAT,
  new_strength          FLOAT,
  previous_reasoning    TEXT,
  new_reasoning         TEXT,
  added_source_refs     JSONB,

  -- Narrative audit (non-negotiable)
  reasoning             TEXT NOT NULL,

  -- Provenance link
  reasoning_report_id   UUID REFERENCES public.reasoning_reports(id),

  -- Who did this and when
  actor                 VARCHAR(32) NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_edge_event_type CHECK (
    event_type IN ('created', 'corroborated', 'strengthened', 'weakened',
                   'revised', 'expired', 'decayed')
  ),
  CONSTRAINT valid_edge_actor CHECK (
    actor IN ('graph_agent', 'reasoning_agent', 'gardener_agent',
              'reconciliation_agent', 'user', 'system_trigger', 'cascade')
  )
);

CREATE INDEX IF NOT EXISTS idx_edge_history_edge
  ON public.causal_edge_history (edge_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_edge_history_report
  ON public.causal_edge_history (reasoning_report_id)
  WHERE reasoning_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edge_history_actor
  ON public.causal_edge_history (actor);
CREATE INDEX IF NOT EXISTS idx_edge_history_occurred
  ON public.causal_edge_history (occurred_at DESC);

-- ============================================
-- 3. Backfill — synthesize 'created' rows for pre-existing facts/edges
-- ============================================
-- Guarded with NOT EXISTS so a second migration run doesn't double-insert.
-- Audit semantics: these rows say "system_trigger observed this row at its
-- original created_at before the audit trail existed" — the reasoning string
-- makes the backfill provenance clear.

INSERT INTO public.fact_history (
  fact_id, event_type, new_confidence, new_valid_at, new_invalid_at,
  reasoning, actor, occurred_at
)
SELECT
  f.id, 'created', f.confidence, f.valid_at, f.invalid_at,
  'Backfill: created before audit trail existed',
  'system_trigger', f.created_at
FROM public.facts f
WHERE NOT EXISTS (
  SELECT 1 FROM public.fact_history fh
  WHERE fh.fact_id = f.id AND fh.event_type = 'created'
);

INSERT INTO public.causal_edge_history (
  edge_id, event_type, new_strength, new_reasoning,
  reasoning, actor, occurred_at
)
SELECT
  e.id, 'created', e.strength, e.reasoning,
  'Backfill: created before audit trail existed',
  'system_trigger', e.created_at
FROM public.causal_edges e
WHERE NOT EXISTS (
  SELECT 1 FROM public.causal_edge_history eh
  WHERE eh.edge_id = e.id AND eh.event_type = 'created'
);
