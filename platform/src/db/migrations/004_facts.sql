-- Migration: 004_facts.sql
-- Phase 3: Bi-Temporal Facts for Knowledge Graph (Graphiti-inspired)
-- Created: 2026-01-24
-- 
-- Bi-temporal model with 4 timestamps:
-- - valid_at / invalid_at: When the fact was true in reality (event time)
-- - created_at / expired_at: When we recorded/corrected it (transaction time)

-- Requires btree_gist for temporal exclusion constraint
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================
-- FACTS: Bi-temporal knowledge triples
-- ============================================
CREATE TABLE IF NOT EXISTS facts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Triple structure: Subject → Predicate → Object
    subject_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    predicate VARCHAR(255) NOT NULL,  -- e.g., "works_at", "lives_in", "knows"
    object_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,  -- For entity objects
    object_value TEXT,  -- For literal values (numbers, dates, strings)
    
    -- Event time: When the fact was true in reality
    valid_at TIMESTAMPTZ,      -- When it became true
    invalid_at TIMESTAMPTZ,    -- When it stopped being true (NULL = still true)
    
    -- Transaction time: When we recorded/corrected it
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- When we learned it
    expired_at TIMESTAMPTZ,    -- When we learned it was wrong (NULL = not expired)
    
    -- Provenance
    source_memory_id UUID,     -- Link to source memory in Qdrant
    source_text TEXT,          -- Original text that stated the fact
    extraction_method VARCHAR(100),  -- llm, rule, user_input
    
    -- Quality
    confidence FLOAT DEFAULT 1.0,
    
    -- Embedding for semantic fact search
    fact_embedding VECTOR(768),
    
    -- Constraints
    CONSTRAINT valid_confidence CHECK (confidence >= 0.0 AND confidence <= 1.0),
    CONSTRAINT has_object CHECK (object_entity_id IS NOT NULL OR object_value IS NOT NULL)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject_entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object_entity_id) WHERE object_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate);
CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_memory_id) WHERE source_memory_id IS NOT NULL;

-- Temporal index for efficient point-in-time queries
CREATE INDEX IF NOT EXISTS idx_facts_valid_range ON facts (valid_at, invalid_at);

-- Index for active facts (not expired)
CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(subject_entity_id, predicate) 
    WHERE expired_at IS NULL;

-- Embedding index
CREATE INDEX IF NOT EXISTS idx_facts_embedding ON facts USING hnsw (fact_embedding vector_cosine_ops);

-- ============================================
-- FACT PREDICATES: Ontology of relationships
-- ============================================
CREATE TABLE IF NOT EXISTS fact_predicates (
    predicate VARCHAR(255) PRIMARY KEY,
    description TEXT,
    inverse_predicate VARCHAR(255),  -- e.g., "works_at" <-> "employs"
    predicate_type VARCHAR(50),  -- relation, attribute, temporal
    is_exclusive BOOLEAN DEFAULT FALSE,  -- Only one object allowed at a time
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed common predicates
INSERT INTO fact_predicates (predicate, description, inverse_predicate, predicate_type, is_exclusive) VALUES
    -- Relations (entity to entity)
    ('works_at', 'Employment relationship', 'employs', 'relation', true),
    ('employs', 'Employs person', 'works_at', 'relation', false),
    ('lives_in', 'Residence location', NULL, 'relation', true),
    ('knows', 'Personal acquaintance', 'known_by', 'relation', false),
    ('known_by', 'Known by person', 'knows', 'relation', false),
    ('member_of', 'Group membership', 'has_member', 'relation', false),
    ('has_member', 'Has member', 'member_of', 'relation', false),
    ('located_in', 'Physical location', 'contains', 'relation', false),
    ('contains', 'Contains location', 'located_in', 'relation', false),
    ('part_of', 'Part-whole relationship', 'has_part', 'relation', false),
    ('has_part', 'Has part', 'part_of', 'relation', false),
    ('created', 'Creator relationship', 'created_by', 'relation', false),
    ('created_by', 'Created by', 'created', 'relation', false),
    ('owns', 'Ownership relationship', 'owned_by', 'relation', false),
    ('owned_by', 'Owned by', 'owns', 'relation', false),
    ('reports_to', 'Reports to manager', 'manages', 'relation', true),
    ('manages', 'Manages person', 'reports_to', 'relation', false),
    ('related_to', 'General relationship', 'related_to', 'relation', false),
    ('collaborates_with', 'Collaboration', 'collaborates_with', 'relation', false),
    -- Attributes (entity to value)
    ('has_role', 'Role or position', NULL, 'attribute', false),
    ('has_title', 'Job title', NULL, 'attribute', false),
    ('has_email', 'Email address', NULL, 'attribute', false),
    ('has_phone', 'Phone number', NULL, 'attribute', false),
    ('has_status', 'Current status', NULL, 'attribute', false),
    ('has_description', 'Description', NULL, 'attribute', false),
    -- Temporal
    ('started_at', 'Start date of activity', NULL, 'temporal', false),
    ('ended_at', 'End date of activity', NULL, 'temporal', false),
    ('scheduled_for', 'Scheduled date', NULL, 'temporal', false),
    ('deadline', 'Deadline date', NULL, 'temporal', false)
ON CONFLICT (predicate) DO NOTHING;

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to expire a fact (mark as wrong/outdated)
CREATE OR REPLACE FUNCTION expire_fact(
    fact_id UUID,
    reason TEXT DEFAULT 'Superseded by new information'
) RETURNS void AS $$
BEGIN
    UPDATE facts
    SET expired_at = NOW()
    WHERE id = fact_id AND expired_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to invalidate a fact (mark as no longer true in reality)
CREATE OR REPLACE FUNCTION invalidate_fact(
    fact_id UUID,
    invalid_time TIMESTAMPTZ DEFAULT NOW()
) RETURNS void AS $$
BEGIN
    UPDATE facts
    SET invalid_at = invalid_time
    WHERE id = fact_id AND invalid_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to query facts at a point in time (bi-temporal query)
CREATE OR REPLACE FUNCTION facts_at_time(
    query_time TIMESTAMPTZ
) RETURNS TABLE (
    id UUID,
    subject_entity_id UUID,
    predicate VARCHAR(255),
    object_entity_id UUID,
    object_value TEXT,
    confidence FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        f.id,
        f.subject_entity_id,
        f.predicate,
        f.object_entity_id,
        f.object_value,
        f.confidence
    FROM facts f
    WHERE 
        -- Transaction time: known at query time
        f.created_at <= query_time
        AND (f.expired_at IS NULL OR f.expired_at > query_time)
        -- Event time: valid at query time
        AND (f.valid_at IS NULL OR f.valid_at <= query_time)
        AND (f.invalid_at IS NULL OR f.invalid_at > query_time);
END;
$$ LANGUAGE plpgsql;

-- Function to find facts that would be superseded by a new fact
CREATE OR REPLACE FUNCTION find_superseding_facts(
    new_fact_subject UUID,
    new_fact_predicate VARCHAR(255),
    new_fact_valid_at TIMESTAMPTZ,
    new_fact_invalid_at TIMESTAMPTZ
) RETURNS TABLE (
    fact_id UUID,
    old_valid_at TIMESTAMPTZ,
    old_invalid_at TIMESTAMPTZ,
    is_exclusive BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        f.id,
        f.valid_at,
        f.invalid_at,
        COALESCE(fp.is_exclusive, false)
    FROM facts f
    LEFT JOIN fact_predicates fp ON fp.predicate = f.predicate
    WHERE 
        f.subject_entity_id = new_fact_subject
        AND f.predicate = new_fact_predicate
        AND f.expired_at IS NULL  -- Only active facts
        -- Check temporal overlap
        AND (
            -- If no times specified, always check
            (new_fact_valid_at IS NULL AND new_fact_invalid_at IS NULL)
            -- Or if times overlap
            OR (
                (f.valid_at IS NULL OR new_fact_invalid_at IS NULL OR f.valid_at < new_fact_invalid_at)
                AND (f.invalid_at IS NULL OR new_fact_valid_at IS NULL OR f.invalid_at > new_fact_valid_at)
            )
        );
END;
$$ LANGUAGE plpgsql;

-- Function to get current facts for an entity
CREATE OR REPLACE FUNCTION get_entity_current_facts(
    entity_id UUID
) RETURNS TABLE (
    fact_id UUID,
    predicate VARCHAR(255),
    object_entity_id UUID,
    object_value TEXT,
    confidence FLOAT,
    valid_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        f.id,
        f.predicate,
        f.object_entity_id,
        f.object_value,
        f.confidence,
        f.valid_at
    FROM facts f
    WHERE 
        f.subject_entity_id = entity_id
        AND f.expired_at IS NULL
        AND (f.invalid_at IS NULL OR f.invalid_at > NOW())
    ORDER BY f.predicate, f.valid_at DESC;
END;
$$ LANGUAGE plpgsql;
