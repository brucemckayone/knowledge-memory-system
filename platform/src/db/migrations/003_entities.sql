-- Migration: 003_entities.sql
-- Phase 3: Entity Schema for Knowledge Graph
-- Created: 2026-01-24

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- For trigram similarity search
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector for embeddings

-- ============================================
-- ENTITIES: Canonical knowledge graph nodes
-- ============================================
CREATE TABLE IF NOT EXISTS entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Identity
    canonical_name VARCHAR(500) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,  -- person, company, project, concept, place, event, other
    description TEXT,
    
    -- Properties (flexible JSON)
    properties JSONB DEFAULT '{}',
    
    -- Merge tracking
    merged_from UUID[] DEFAULT '{}',  -- IDs of entities merged into this one
    
    -- Quality
    confidence FLOAT DEFAULT 1.0,  -- 0.0 - 1.0
    
    -- Embedding for similarity search (pgvector)
    embedding VECTOR(768),
    
    -- Timestamps
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT valid_entity_type CHECK (
        entity_type IN ('person', 'company', 'project', 'concept', 'place', 'event', 'other')
    ),
    CONSTRAINT valid_confidence CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name_trgm ON entities USING gin(canonical_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_created ON entities(created_at DESC);

-- ============================================
-- ENTITY ALIASES: Alternative names
-- ============================================
CREATE TABLE IF NOT EXISTS entity_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    
    -- Alias info
    alias VARCHAR(500) NOT NULL,
    alias_type VARCHAR(50),  -- abbreviation, nickname, typo, former_name, merged_name
    source VARCHAR(100),     -- extraction, user_input, merge
    
    -- When discovered
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Unique constraint: no duplicate aliases per entity
    UNIQUE(entity_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_aliases_alias ON entity_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_aliases_alias_trgm ON entity_aliases USING gin(alias gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);

-- ============================================
-- ENTITY MERGES: Audit trail
-- ============================================
CREATE TABLE IF NOT EXISTS entity_merges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- What was merged
    source_entity_id UUID NOT NULL,  -- Entity that was merged away
    target_entity_id UUID NOT NULL REFERENCES entities(id),  -- Entity that absorbed it
    
    -- Why
    merge_reason TEXT,
    merge_method VARCHAR(50),  -- auto_high_confidence, llm_verified, manual
    similarity_score FLOAT,
    
    -- When
    merged_at TIMESTAMPTZ DEFAULT NOW(),
    merged_by VARCHAR(100) DEFAULT 'system'  -- system, user, llm
);

CREATE INDEX IF NOT EXISTS idx_merges_source ON entity_merges(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_merges_target ON entity_merges(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_merges_time ON entity_merges(merged_at DESC);

-- ============================================
-- MEMORY ENTITIES: Link memories to entities
-- ============================================
CREATE TABLE IF NOT EXISTS memory_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Links
    memory_id UUID NOT NULL,  -- References Qdrant trace_id
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    
    -- How the entity appears in the memory
    mention_text VARCHAR(500),  -- Original text that mentioned the entity
    relationship VARCHAR(100) DEFAULT 'mentions',  -- mentions, about, by, authored_by
    
    -- Position in text (for highlighting)
    mention_start INT,
    mention_end INT,
    
    -- Context around the mention
    mention_context TEXT,
    
    -- Confidence of this mention
    confidence FLOAT DEFAULT 1.0,
    
    -- When extracted
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add unique constraint separately to handle NULL values properly
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entities_unique 
    ON memory_entities (memory_id, entity_id, COALESCE(mention_start, -1));

CREATE INDEX IF NOT EXISTS idx_memory_entities_memory ON memory_entities(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_entities_created ON memory_entities(created_at DESC);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to merge two entities
CREATE OR REPLACE FUNCTION merge_entities(
    source_id UUID,
    target_id UUID,
    reason TEXT DEFAULT 'Duplicate detected',
    method VARCHAR(50) DEFAULT 'auto',
    score FLOAT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    source_name VARCHAR(500);
    result UUID;
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
    
    -- Update memory_entities to point to target
    UPDATE memory_entities 
    SET entity_id = target_id 
    WHERE entity_id = source_id;
    
    -- Update merged_from array on target
    UPDATE entities 
    SET merged_from = merged_from || source_id,
        last_seen_at = GREATEST(last_seen_at, (SELECT last_seen_at FROM entities WHERE id = source_id)),
        updated_at = NOW()
    WHERE id = target_id;
    
    -- Delete source entity
    DELETE FROM entities WHERE id = source_id;
    
    RETURN target_id;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_entity_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entities_updated_at ON entities;
CREATE TRIGGER entities_updated_at
    BEFORE UPDATE ON entities
    FOR EACH ROW
    EXECUTE FUNCTION update_entity_timestamp();

-- Function to find similar entities by name
CREATE OR REPLACE FUNCTION find_similar_entities_by_name(
    search_name VARCHAR,
    similarity_threshold FLOAT DEFAULT 0.3,
    max_results INT DEFAULT 10
) RETURNS TABLE (
    entity_id UUID,
    canonical_name VARCHAR(500),
    entity_type VARCHAR(100),
    similarity FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id,
        e.canonical_name,
        e.entity_type,
        similarity(e.canonical_name, search_name) as sim
    FROM entities e
    WHERE e.canonical_name % search_name
      AND similarity(e.canonical_name, search_name) >= similarity_threshold
    ORDER BY sim DESC
    LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

-- Create embedding index after extension is loaded
-- Note: ivfflat requires data first, so using hnsw for empty tables
CREATE INDEX IF NOT EXISTS idx_entities_embedding 
    ON entities USING hnsw (embedding vector_cosine_ops);
