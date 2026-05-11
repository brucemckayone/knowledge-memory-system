-- 003_graph_meta.sql — Graph Meta: Entity statistics + merge candidate detection
--
-- Graph M sits alongside Graph S (knowledge) and Graph C (causality).
-- It computes per-entity statistics from source vectors and graph structure,
-- and stages merge candidates through a confidence lifecycle.
--
-- NOTE: Uses explicit public. schema qualifiers (see 002_causal_graph.sql header).

-- ============================================
-- 1. Entity Meta (per-entity statistics)
-- ============================================
CREATE TABLE IF NOT EXISTS public.entity_meta (
  entity_id           UUID PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,

  -- Mention statistics
  mention_count       INTEGER NOT NULL DEFAULT 0,
  source_memory_count INTEGER NOT NULL DEFAULT 0,
  fact_count          INTEGER NOT NULL DEFAULT 0,

  -- Source-derived embedding (centroid of source memory vectors)
  centroid            VECTOR(768),
  spread              FLOAT,              -- avg distance from centroid (context diversity)

  -- Temporal span
  first_mentioned_at  TIMESTAMPTZ,
  last_mentioned_at   TIMESTAMPTZ,

  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_meta_mention_count
  ON public.entity_meta (mention_count DESC);

CREATE INDEX IF NOT EXISTS idx_entity_meta_centroid
  ON public.entity_meta USING hnsw (centroid vector_cosine_ops);

-- ============================================
-- 2. Merge Candidates (pairwise analysis)
-- ============================================
CREATE TABLE IF NOT EXISTS public.merge_candidates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The pair (canonical ordering: a < b)
  entity_a_id           UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  entity_b_id           UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,

  -- Three resolution signals
  centroid_similarity   FLOAT,              -- cosine similarity of source centroids
  memory_overlap        FLOAT,              -- Jaccard coefficient of shared source memories
  structural_similarity FLOAT,              -- Jaccard coefficient of shared outgoing facts
  combined_score        FLOAT NOT NULL,     -- weighted combination

  -- Lifecycle
  status                VARCHAR(20) NOT NULL DEFAULT 'staging',
  detection_count       INTEGER NOT NULL DEFAULT 1,
  first_detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Resolution (NULL until resolved)
  resolution            VARCHAR(20),        -- merge, alias, link, distinct
  resolution_reasoning  TEXT,
  resolved_at           TIMESTAMPTZ,
  resolved_by           VARCHAR(50),        -- auto, agent, user

  CONSTRAINT merge_candidates_unique UNIQUE(entity_a_id, entity_b_id),
  CONSTRAINT merge_candidates_ordering CHECK(entity_a_id < entity_b_id),
  CONSTRAINT valid_candidate_status CHECK (
    status IN ('staging', 'candidate', 'provisional', 'resolved')
  ),
  CONSTRAINT valid_resolution CHECK (
    resolution IS NULL OR resolution IN ('merge', 'alias', 'link', 'distinct')
  )
);

CREATE INDEX IF NOT EXISTS idx_merge_candidates_score
  ON public.merge_candidates (combined_score DESC) WHERE status != 'resolved';

CREATE INDEX IF NOT EXISTS idx_merge_candidates_status
  ON public.merge_candidates (status) WHERE status != 'resolved';

CREATE INDEX IF NOT EXISTS idx_merge_candidates_entity_a
  ON public.merge_candidates (entity_a_id);

CREATE INDEX IF NOT EXISTS idx_merge_candidates_entity_b
  ON public.merge_candidates (entity_b_id);
