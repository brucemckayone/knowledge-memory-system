-- Initialize Apache AGE extension
-- This runs automatically on container first start

CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';

-- Set search path to include AGE catalog
SET search_path = ag_catalog, "$user", public;

-- Create the knowledge graph
SELECT create_graph('knowledge_graph');
