-- Migration: 005_apache_age.sql
-- Phase 3: Apache AGE Graph Extension
-- Created: 2026-01-24
-- 
-- Note: This migration assumes Apache AGE is already installed.
-- If running on existing container, extension needs to be installed first.
-- For new deployments, use the custom Postgres Dockerfile.

-- Load Apache AGE extension (if not auto-loaded via shared_preload_libraries)
DO $$
BEGIN
    -- Check if age extension exists
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'age') THEN
        CREATE EXTENSION age;
    END IF;
END $$;

-- Set search path to include AGE
SET search_path = ag_catalog, "$user", public;

-- Create knowledge graph if not exists
DO $$
BEGIN
    -- Check if graph already exists
    IF NOT EXISTS (SELECT 1 FROM ag_graph WHERE name = 'knowledge_graph') THEN
        PERFORM create_graph('knowledge_graph');
    END IF;
END $$;

-- ============================================
-- HELPER FUNCTIONS for Graph Operations
-- ============================================

-- Function to sync an entity to the graph
-- Note: Due to AGE Cypher limitations, this uses a simplified approach
CREATE OR REPLACE FUNCTION sync_entity_to_graph(
    p_entity_id UUID,
    p_entity_name VARCHAR,
    p_entity_type VARCHAR,
    p_entity_props JSONB
) RETURNS void AS $$
BEGIN
    -- Use AGE to create/update entity node
    -- The query creates a node with the entity data
    EXECUTE format(
        'SELECT * FROM cypher(''knowledge_graph'', $cypher$
            MERGE (e:Entity {entity_id: %L})
            SET e.name = %L, e.type = %L, e.updated_at = localtimestamp
            RETURN e
        $cypher$) as (v agtype)',
        p_entity_id::text,
        p_entity_name,
        p_entity_type
    );
EXCEPTION WHEN OTHERS THEN
    -- Silently ignore errors (graph may not be ready)
    NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to create an edge between entities
CREATE OR REPLACE FUNCTION create_entity_edge(
    p_from_entity_id UUID,
    p_to_entity_id UUID,
    p_relationship_type VARCHAR,
    p_edge_props JSONB DEFAULT '{}'
) RETURNS void AS $$
DECLARE
    rel_type VARCHAR;
BEGIN
    -- Sanitize relationship type for Cypher (uppercase, underscores)
    rel_type := upper(replace(p_relationship_type, '-', '_'));
    
    EXECUTE format(
        'SELECT * FROM cypher(''knowledge_graph'', $cypher$
            MATCH (a:Entity {entity_id: %L}), (b:Entity {entity_id: %L})
            MERGE (a)-[r:%s]->(b)
            SET r.created_at = localtimestamp
            RETURN r
        $cypher$) as (v agtype)',
        p_from_entity_id::text,
        p_to_entity_id::text,
        rel_type
    );
EXCEPTION WHEN OTHERS THEN
    -- Silently ignore errors
    NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to find paths between entities (simplified)
CREATE OR REPLACE FUNCTION find_entity_paths(
    p_from_entity_id UUID,
    p_to_entity_id UUID,
    p_max_hops INT DEFAULT 3
) RETURNS TABLE (
    path_info JSONB
) AS $$
BEGIN
    RETURN QUERY EXECUTE format(
        'SELECT row_to_json(t)::jsonb as path_info FROM (
            SELECT * FROM cypher(''knowledge_graph'', $cypher$
                MATCH path = (a:Entity {entity_id: %L})-[*1..%s]-(b:Entity {entity_id: %L})
                RETURN path
                LIMIT 10
            $cypher$) as (path agtype)
        ) t',
        p_from_entity_id::text,
        p_max_hops,
        p_to_entity_id::text
    );
EXCEPTION WHEN OTHERS THEN
    -- Return empty on error
    RETURN;
END;
$$ LANGUAGE plpgsql;

-- Function to get entity neighbors (simplified)
CREATE OR REPLACE FUNCTION get_entity_neighbors(
    p_entity_id UUID,
    p_max_depth INT DEFAULT 1
) RETURNS TABLE (
    neighbor_id TEXT,
    neighbor_name TEXT,
    neighbor_type TEXT
) AS $$
BEGIN
    RETURN QUERY EXECUTE format(
        'SELECT 
            (n->>''entity_id'')::text,
            (n->>''name'')::text,
            (n->>''type'')::text
        FROM cypher(''knowledge_graph'', $cypher$
            MATCH (a:Entity {entity_id: %L})-[*1..%s]-(b:Entity)
            RETURN DISTINCT b
            LIMIT 50
        $cypher$) as (n agtype)',
        p_entity_id::text,
        p_max_depth
    );
EXCEPTION WHEN OTHERS THEN
    -- Return empty on error
    RETURN;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- TRIGGERS for Auto-Sync
-- ============================================

-- Trigger function to sync entity changes to graph
CREATE OR REPLACE FUNCTION trigger_sync_entity() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        PERFORM sync_entity_to_graph(
            NEW.id,
            NEW.canonical_name,
            NEW.entity_type,
            NEW.properties
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on entities table
DROP TRIGGER IF EXISTS entities_sync_graph ON entities;
CREATE TRIGGER entities_sync_graph
    AFTER INSERT OR UPDATE ON entities
    FOR EACH ROW
    EXECUTE FUNCTION trigger_sync_entity();

-- Trigger function to sync fact relationships to graph
CREATE OR REPLACE FUNCTION trigger_sync_fact() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        IF NEW.object_entity_id IS NOT NULL AND NEW.expired_at IS NULL THEN
            PERFORM create_entity_edge(
                NEW.subject_entity_id,
                NEW.object_entity_id,
                NEW.predicate,
                jsonb_build_object(
                    'fact_id', NEW.id,
                    'confidence', NEW.confidence,
                    'valid_at', NEW.valid_at
                )
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on facts table
DROP TRIGGER IF EXISTS facts_sync_graph ON facts;
CREATE TRIGGER facts_sync_graph
    AFTER INSERT OR UPDATE ON facts
    FOR EACH ROW
    EXECUTE FUNCTION trigger_sync_fact();
