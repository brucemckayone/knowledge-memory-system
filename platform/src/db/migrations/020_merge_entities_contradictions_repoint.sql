-- 020_merge_entities_contradictions_repoint.sql — Re-point contradictions
-- through merge_entities() so the source's contradiction rows follow the
-- survivor entity instead of blocking the merge.
--
-- Background: bead nmemo-2yv.63. mig 011 added contradictions.entity_id with
-- a FK to entities(id) but NO ON DELETE clause (PostgreSQL default is
-- NO ACTION). mig 005 merge_entities() ends with DELETE FROM entities
-- WHERE id = source_id (line 152). Any source entity with at least one
-- contradictions row blocks the merge with FK violation, the entire merge
-- transaction rolls back, and the reconciliation agent moves on without
-- resolving the duplicate.
--
-- Two viable fixes were considered:
--   (a) ON DELETE CASCADE on contradictions.entity_id — silently deletes
--       the contradiction data.
--   (b) Re-point source contradictions to target before the DELETE —
--       preserves the conflict trail and (if unresolved) lets resolution
--       continue on the survivor.
-- This migration takes (b), the bead's locked recommendation.
--
-- Dedup: the partial UNIQUE INDEX idx_contradictions_unique_active (mig 011
-- line 113-122) covers (type, fact_a, fact_b, edge_a, edge_b, entity_id)
-- WHERE resolved_at IS NULL. After re-point, a source row whose fact/edge
-- columns match an unresolved target row would violate that index. We
-- delete the source duplicate before re-pointing — the target's existing
-- unresolved row already carries the conflict; keeping both would inflate
-- detection_* analytics and confuse the agent.
--
-- AGE search_path gotcha (per CLAUDE.md / 016-019 headers): explicit
-- public. qualifiers throughout so DDL lands in public, not ag_catalog.

CREATE OR REPLACE FUNCTION public.merge_entities(
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

  -- nmemo-2yv.63: re-point contradictions from source to target so the
  -- DELETE on the source entity does not violate the contradictions.entity_id
  -- FK. The partial UNIQUE INDEX idx_contradictions_unique_active covers
  -- entity_id, so we drop any source row that would clash with an existing
  -- unresolved target row (same type + same fact/edge tuple) before
  -- re-pointing the rest.
  DELETE FROM public.contradictions src
  WHERE src.entity_id = source_id
    AND src.resolved_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.contradictions tgt
      WHERE tgt.entity_id = target_id
        AND tgt.resolved_at IS NULL
        AND tgt.contradiction_type = src.contradiction_type
        AND COALESCE(tgt.fact_a_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(src.fact_a_id, '00000000-0000-0000-0000-000000000000'::uuid)
        AND COALESCE(tgt.fact_b_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(src.fact_b_id, '00000000-0000-0000-0000-000000000000'::uuid)
        AND COALESCE(tgt.edge_a_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(src.edge_a_id, '00000000-0000-0000-0000-000000000000'::uuid)
        AND COALESCE(tgt.edge_b_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(src.edge_b_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );
  UPDATE public.contradictions SET entity_id = target_id WHERE entity_id = source_id;

  UPDATE public.entities SET merged_from = merged_from || source_id,
    last_seen_at = GREATEST(last_seen_at, (SELECT last_seen_at FROM public.entities WHERE id = source_id)),
    updated_at = NOW()
  WHERE id = target_id;

  DELETE FROM public.entities WHERE id = source_id;
  RETURN target_id;
END;
$$ LANGUAGE plpgsql;
