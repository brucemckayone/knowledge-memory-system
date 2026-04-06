-- 002_causal_graph.sql — Graph C: Causal Layer tables + AGE causal_graph
-- Phase B of Sparse Truth Graph
--
-- NOTE: 001_consolidated.sql sets search_path = ag_catalog, public, "$user"
-- at session level. We MUST NOT change it — the existing Graph S triggers
-- and AGE's cypher() function depend on ag_catalog being in the path.
-- All table/index DDL uses explicit public. schema to ensure correct placement.

-- ============================================
-- 1. Causal Patterns (must exist before causal_edges FK)
-- ============================================
CREATE TABLE IF NOT EXISTS public.causal_patterns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name              VARCHAR(255),
  description       TEXT,

  -- Structure template
  template_structure JSONB NOT NULL,
  template_length   INTEGER NOT NULL,

  -- Pattern topology
  topology_type     VARCHAR(20),

  -- Embedding for pattern similarity
  pattern_embedding VECTOR(768),

  -- Lifecycle
  status            VARCHAR(20) NOT NULL DEFAULT 'staging',
  instance_count    INTEGER NOT NULL DEFAULT 0,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ,
  promoted_at       TIMESTAMPTZ,
  rejected_at       TIMESTAMPTZ,
  rejection_reason  TEXT,

  -- Frequency metrics
  avg_temporal_span INTERVAL,
  avg_strength      FLOAT,
  activation_count_30d INTEGER DEFAULT 0,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_pattern_status CHECK (
    status IN ('staging', 'candidate', 'provisional', 'canonical')
  ),
  CONSTRAINT valid_topology_type CHECK (
    topology_type IS NULL OR topology_type IN ('linear', 'loop', 'convergent', 'divergent', 'complex')
  )
);

CREATE INDEX IF NOT EXISTS idx_causal_patterns_status
  ON public.causal_patterns (status);

CREATE INDEX IF NOT EXISTS idx_causal_patterns_embedding
  ON public.causal_patterns USING hnsw (pattern_embedding vector_cosine_ops);

-- ============================================
-- 2. Causal Events (state transitions in Graph S)
-- ============================================
CREATE TABLE IF NOT EXISTS public.causal_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What changed in Graph S
  fact_id           UUID REFERENCES public.facts(id),
  transition_type   VARCHAR(20) NOT NULL,

  -- Transition metadata
  subject_entity_id UUID REFERENCES public.entities(id),
  predicate         VARCHAR(255),
  delta_confidence  FLOAT,

  -- Temporal
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Embedding for similarity search
  event_embedding   VECTOR(768),

  -- Provenance
  source_memory_id  UUID,
  source_text       TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_transition_type CHECK (
    transition_type IN ('created', 'strengthened', 'weakened', 'expired', 'invalidated')
  )
);

CREATE INDEX IF NOT EXISTS idx_causal_events_occurred
  ON public.causal_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_causal_events_entity
  ON public.causal_events (subject_entity_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_causal_events_fact
  ON public.causal_events (fact_id);

CREATE INDEX IF NOT EXISTS idx_causal_events_embedding
  ON public.causal_events USING hnsw (event_embedding vector_cosine_ops);

-- ============================================
-- 3. Causal Edges (directed causal links)
-- ============================================
CREATE TABLE IF NOT EXISTS public.causal_edges (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The causal relationship
  cause_event_id      UUID NOT NULL REFERENCES public.causal_events(id),
  effect_event_id     UUID NOT NULL REFERENCES public.causal_events(id),

  -- Causal properties
  strength            FLOAT NOT NULL DEFAULT 0.5,
  temporal_span       INTERVAL,
  extraction_method   VARCHAR(20) NOT NULL,

  -- Reasoning & traceability (NON-NEGOTIABLE)
  reasoning           TEXT NOT NULL,
  source_references   JSONB NOT NULL,

  -- Pathway (mediator events)
  pathway_event_ids   UUID[],

  -- Provenance
  source_memory_id    UUID,
  source_text         TEXT,

  -- Corroboration tracking
  corroboration_count INTEGER NOT NULL DEFAULT 1,
  last_corroborated   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Confidence decay
  initial_strength    FLOAT NOT NULL,
  decay_applied       BOOLEAN NOT NULL DEFAULT false,

  -- Pattern membership
  pattern_id          UUID REFERENCES public.causal_patterns(id),
  pattern_position    INTEGER,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expired_at          TIMESTAMPTZ,
  expire_reason       TEXT,

  -- No self-loops
  CHECK (cause_event_id != effect_event_id),

  CONSTRAINT valid_edge_strength CHECK (strength >= 0.0 AND strength <= 1.0),
  CONSTRAINT valid_initial_strength CHECK (initial_strength >= 0.0 AND initial_strength <= 1.0)
);

CREATE INDEX IF NOT EXISTS idx_causal_edges_cause
  ON public.causal_edges (cause_event_id) WHERE expired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_causal_edges_effect
  ON public.causal_edges (effect_event_id) WHERE expired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_causal_edges_pattern
  ON public.causal_edges (pattern_id) WHERE pattern_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_causal_edges_strength
  ON public.causal_edges (strength DESC) WHERE expired_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_causal_edges_unique
  ON public.causal_edges (cause_event_id, effect_event_id)
  WHERE expired_at IS NULL;

-- ============================================
-- 4. Apache AGE: Causal Graph
-- ============================================

-- search_path already includes ag_catalog from 001_consolidated.sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'causal_graph') THEN
    PERFORM ag_catalog.create_graph('causal_graph');
  END IF;
END $$;

-- ============================================
-- 5. Sync triggers: causal_events → AGE :Transition nodes
-- ============================================

-- These trigger functions rely on ag_catalog being in the session search_path
-- (set by 001_consolidated.sql). Same pattern as the existing Graph S triggers.
CREATE OR REPLACE FUNCTION sync_causal_event_to_graph()
RETURNS TRIGGER AS $$
BEGIN
  EXECUTE format(
    'SELECT * FROM cypher(''causal_graph'', $c$
      MERGE (e:Transition {event_id: %L})
      SET e.fact_id = %L,
          e.transition_type = %L,
          e.entity_id = %L,
          e.predicate = %L,
          e.occurred_at = %L
      RETURN e
    $c$) as (v agtype)',
    NEW.id::text, NEW.fact_id::text, NEW.transition_type,
    NEW.subject_entity_id::text, NEW.predicate,
    NEW.occurred_at::text
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sync_causal_event_to_graph failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_sync_causal_event ON public.causal_events;
CREATE TRIGGER trigger_sync_causal_event
  AFTER INSERT OR UPDATE ON public.causal_events
  FOR EACH ROW EXECUTE FUNCTION sync_causal_event_to_graph();

-- ============================================
-- 6. Sync triggers: causal_edges → AGE :CAUSED edges
-- ============================================
CREATE OR REPLACE FUNCTION sync_causal_edge_to_graph()
RETURNS TRIGGER AS $$
BEGIN
  EXECUTE format(
    'SELECT * FROM cypher(''causal_graph'', $c$
      MATCH (cause:Transition {event_id: %L}),
            (effect:Transition {event_id: %L})
      MERGE (cause)-[r:CAUSED]->(effect)
      SET r.strength = %s,
          r.method = %L,
          r.pattern_id = %L
      RETURN r
    $c$) as (v agtype)',
    NEW.cause_event_id::text, NEW.effect_event_id::text,
    NEW.strength, NEW.extraction_method,
    NEW.pattern_id::text
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sync_causal_edge_to_graph failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_sync_causal_edge ON public.causal_edges;
CREATE TRIGGER trigger_sync_causal_edge
  AFTER INSERT ON public.causal_edges
  FOR EACH ROW
  WHEN (NEW.expired_at IS NULL)
  EXECUTE FUNCTION sync_causal_edge_to_graph();
