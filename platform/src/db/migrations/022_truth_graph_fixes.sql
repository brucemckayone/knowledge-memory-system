-- Migration 022: Truth Graph Fixes
-- 1. Add expire_reason column to facts (audit trail for why facts were expired)
-- 2. Update expire_fact() to store reason
-- 3. Update merge_entities() with dedup after re-pointing
-- Created: 2026-03-24

-- ============================================
-- 1. Add expire_reason column
-- ============================================
ALTER TABLE facts ADD COLUMN IF NOT EXISTS expire_reason TEXT;

-- ============================================
-- 2. Update expire_fact() to store the reason
-- ============================================
CREATE OR REPLACE FUNCTION expire_fact(
    fact_id UUID,
    reason TEXT DEFAULT 'Superseded by new information'
) RETURNS void AS $$
BEGIN
    UPDATE facts
    SET expired_at = NOW(),
        expire_reason = reason
    WHERE id = fact_id AND expired_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 3. Update merge_entities() with dedup logic
-- ============================================
-- After re-pointing facts from source→target, expire exact-match duplicates
-- (same subject + predicate + same object). Conflicting facts with different
-- objects are preserved for the conflict-resolution agent.
CREATE OR REPLACE FUNCTION merge_entities(
    source_id UUID,
    target_id UUID,
    reason TEXT DEFAULT 'Duplicate detected',
    method VARCHAR(50) DEFAULT 'auto',
    score FLOAT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    source_name VARCHAR(500);
BEGIN
    -- Get source name before deletion
    SELECT canonical_name INTO source_name FROM entities WHERE id = source_id;

    IF source_name IS NULL THEN
        RAISE EXCEPTION 'Source entity % not found', source_id;
    END IF;

    -- Record the merge
    INSERT INTO entity_merges (source_entity_id, target_entity_id, merge_reason, merge_method, similarity_score)
    VALUES (source_id, target_id, reason, method, score);

    -- Move aliases from source to target
    INSERT INTO entity_aliases (entity_id, alias, alias_type, source)
    SELECT target_id, alias, alias_type, 'merge'
    FROM entity_aliases WHERE entity_id = source_id
    ON CONFLICT (entity_id, alias) DO NOTHING;

    -- Add source's canonical name as alias of target
    INSERT INTO entity_aliases (entity_id, alias, alias_type, source)
    VALUES (target_id, source_name, 'merged_name', 'merge')
    ON CONFLICT (entity_id, alias) DO NOTHING;

    -- Re-point facts from source to target (before delete to avoid CASCADE)
    UPDATE facts SET subject_entity_id = target_id WHERE subject_entity_id = source_id;
    UPDATE facts SET object_entity_id = target_id WHERE object_entity_id = source_id;

    -- Deduplicate exact-match facts created by re-pointing.
    -- Keeps highest confidence (then newest created_at) per unique triple.
    -- Uses soft-delete (expire) to preserve audit trail.
    WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY subject_entity_id, predicate,
                               COALESCE(object_entity_id::text, ''),
                               COALESCE(object_value, '')
                   ORDER BY confidence DESC NULLS LAST, created_at DESC
               ) AS rn
        FROM facts
        WHERE (subject_entity_id = target_id OR object_entity_id = target_id)
          AND expired_at IS NULL
    )
    UPDATE facts
    SET expired_at = NOW(),
        expire_reason = 'Duplicate removed during entity merge'
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

    -- Re-point merge audit trail (for transitive chains: A→B then B→C)
    UPDATE entity_merges SET target_entity_id = target_id WHERE target_entity_id = source_id;

    -- Update memory_entities to point to target (delete conflicts first)
    DELETE FROM memory_entities
    WHERE entity_id = source_id
      AND memory_id IN (SELECT memory_id FROM memory_entities WHERE entity_id = target_id);
    UPDATE memory_entities
    SET entity_id = target_id
    WHERE entity_id = source_id;

    -- Delete source aliases (already copied above)
    DELETE FROM entity_aliases WHERE entity_id = source_id;

    -- Update merged_from array on target
    UPDATE entities
    SET merged_from = merged_from || source_id,
        last_seen_at = GREATEST(last_seen_at, (SELECT last_seen_at FROM entities WHERE id = source_id)),
        updated_at = NOW()
    WHERE id = target_id;

    -- Delete source entity (now safe — no dependent rows remain)
    DELETE FROM entities WHERE id = source_id;

    RETURN target_id;
END;
$$ LANGUAGE plpgsql;
