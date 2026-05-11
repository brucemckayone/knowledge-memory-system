-- Initialize Apache AGE extension
-- This runs automatically on container first start

CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';

-- Set search path to include AGE catalog — session-level for this init script
SET search_path = ag_catalog, "$user", public;

-- Make ag_catalog the default search_path for ALL future connections.
-- Without this, new connections can't resolve cypher() since it lives in ag_catalog.
ALTER DATABASE cognitive SET search_path = ag_catalog, public, "$user";

-- Create the knowledge graph
SELECT create_graph('knowledge_graph');

