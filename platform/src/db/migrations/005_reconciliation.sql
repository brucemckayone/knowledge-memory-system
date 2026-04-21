-- 005_reconciliation.sql — Reconciliation Layer: same_as identity links + extraction reports
--
-- Adds:
--   1. same_as_links     — non-destructive identity links between entities (preserves both nodes + facts)
--   2. extraction_reports — stored PHASE 6 agent reports for reconciliation consumption
--   3. merge_entities()  — fixed to also re-point causal_events.subject_entity_id
--
-- NOTE: Uses explicit public. schema qualifiers (AGE sets search_path = ag_catalog first,
-- so unqualified names resolve to ag_catalog not public).

-- ============================================
-- 1. same_as_links — Non-destructive identity links
-- ============================================
--
-- When two entities represent the same real-world referent but carry different
-- narrative meaning (e.g. "the stranger" described by Walton vs "Victor Frankenstein"
-- narrating his own story), we link them here rather than merging.
-- Both entities and their facts are preserved intact.

CREATE TABLE IF NOT EXISTS public.same_as_links (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The pair (canonical ordering: a < b matches merge_candidates pattern)
  entity_a_id         UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  entity_b_id         UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,

  -- Why these are the same identity
  reasoning           TEXT NOT NULL,

  -- Every source that informed this conclusion (like causal_edges.source_references)
  -- [{type: 'memory'|'fact'|'entity'|'alias'|'report', id: UUID, relevance: text}]
  source_evidence     JSONB NOT NULL DEFAULT '[]',

  -- 0.0-1.0 confidence in the identity link
  confidence          FLOAT NOT NULL DEFAULT 0.8,

  -- Who created this link
  created_by          VARCHAR(50) NOT NULL DEFAULT 'reconciliation_agent',

  -- Link back to merge candidate that prompted this resolution (if any)
  merge_candidate_id  UUID REFERENCES public.merge_candidates(id),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT same_as_links_unique UNIQUE(entity_a_id, entity_b_id),
  CONSTRAINT same_as_links_ordering CHECK(entity_a_id < entity_b_id),
  CONSTRAINT same_as_links_confidence CHECK(confidence >= 0.0 AND confidence <= 1.0)
);

CREATE INDEX IF NOT EXISTS idx_same_as_entity_a
  ON public.same_as_links (entity_a_id);

CREATE INDEX IF NOT EXISTS idx_same_as_entity_b
  ON public.same_as_links (entity_b_id);

CREATE INDEX IF NOT EXISTS idx_same_as_created
  ON public.same_as_links (created_at DESC);

-- ============================================
-- 2. extraction_reports — Stored agent reports
-- ============================================
--
-- The PHASE 6 structured report from each graph agent run.
-- Reconciliation agent reads these to find evidence of cross-entity connections
-- that the extraction agent noted but couldn't act on (unconfirmed aliases,
-- skipped facts, difficulties resolving pronouns, etc.)

CREATE TABLE IF NOT EXISTS public.extraction_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   UUID NOT NULL,   -- Qdrant memory this report belongs to (no FK — lives in Qdrant)
  report_text TEXT NOT NULL,   -- Full PHASE 6 structured text from the graph agent
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_extraction_reports_memory
  ON public.extraction_reports (memory_id);

CREATE INDEX IF NOT EXISTS idx_extraction_reports_created
  ON public.extraction_reports (created_at DESC);

-- ============================================
-- 3. Fix merge_entities() — add causal_events re-pointing
-- ============================================
--
-- The original function in 001_consolidated.sql re-points facts but not causal_events.
-- This causes causal_events.subject_entity_id to still reference deleted entities
-- after a merge, breaking Graph C integrity.
-- The fix: re-point causal_events BEFORE deleting the source entity.

CREATE OR REPLACE FUNCTION merge_entities(
  source_id UUID, target_id UUID,
  reason TEXT DEFAULT 'Duplicate detected', method VARCHAR(50) DEFAULT 'auto', score FLOAT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE source_name VARCHAR(500);
BEGIN
  SELECT canonical_name INTO source_name FROM public.entities WHERE id = source_id;
  IF source_name IS NULL THEN RAISE EXCEPTION 'Source entity % not found', source_id; END IF;

  INSERT INTO public.entity_merges (source_entity_id, target_entity_id, merge_reason, merge_method, similarity_score)
  VALUES (source_id, target_id, reason, method, score);

  INSERT INTO public.entity_aliases (entity_id, alias, alias_type, source)
  SELECT target_id, alias, alias_type, 'merge' FROM public.entity_aliases WHERE entity_id = source_id
  ON CONFLICT (entity_id, alias) DO NOTHING;

  INSERT INTO public.entity_aliases (entity_id, alias, alias_type, source)
  VALUES (target_id, source_name, 'merged_name', 'merge')
  ON CONFLICT (entity_id, alias) DO NOTHING;

  UPDATE public.facts SET subject_entity_id = target_id WHERE subject_entity_id = source_id;
  UPDATE public.facts SET object_entity_id = target_id WHERE object_entity_id = source_id;

  -- Deduplicate exact-match facts after re-pointing
  WITH ranked AS (
    SELECT f.id, ROW_NUMBER() OVER (
      PARTITION BY f.subject_entity_id, f.predicate,
        COALESCE(f.object_entity_id::text, ''), COALESCE(f.object_value, '')
      ORDER BY f.confidence DESC NULLS LAST, f.created_at DESC
    ) AS rn
    FROM public.facts f
    WHERE (f.subject_entity_id = target_id OR f.object_entity_id = target_id) AND f.expired_at IS NULL
  )
  UPDATE public.facts SET expired_at = NOW(), expire_reason = 'Duplicate removed during entity merge'
  WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

  UPDATE public.entity_merges SET target_entity_id = target_id WHERE target_entity_id = source_id;

  DELETE FROM public.memory_entities WHERE entity_id = source_id
    AND memory_id IN (SELECT memory_id FROM public.memory_entities WHERE entity_id = target_id);
  UPDATE public.memory_entities SET entity_id = target_id WHERE entity_id = source_id;

  DELETE FROM public.entity_aliases WHERE entity_id = source_id;

  -- Re-point causal events from source to target (must come before DELETE)
  UPDATE public.causal_events SET subject_entity_id = target_id WHERE subject_entity_id = source_id;

  -- Re-point same_as links that reference the source entity
  UPDATE public.same_as_links SET entity_a_id = target_id
    WHERE entity_a_id = source_id AND target_id < entity_b_id;
  UPDATE public.same_as_links SET entity_b_id = target_id
    WHERE entity_b_id = source_id AND entity_a_id < target_id;
  -- Delete any same_as links that would become self-referential or duplicate after re-point
  DELETE FROM public.same_as_links
    WHERE entity_a_id = entity_b_id
       OR (entity_a_id = target_id AND entity_b_id = target_id);

  UPDATE public.entities SET merged_from = merged_from || source_id,
    last_seen_at = GREATEST(last_seen_at, (SELECT last_seen_at FROM public.entities WHERE id = source_id)),
    updated_at = NOW()
  WHERE id = target_id;

  DELETE FROM public.entities WHERE id = source_id;
  RETURN target_id;
END;
$$ LANGUAGE plpgsql;
