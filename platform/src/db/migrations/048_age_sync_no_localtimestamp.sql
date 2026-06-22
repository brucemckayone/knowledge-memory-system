-- 039_age_sync_no_localtimestamp.sql — fix broken AGE entity/edge sync (nmemo-zgw)
--
-- BUG: sync_entity_to_graph and create_entity_edge (defined in 001) run a cypher
-- `SET ... = localtimestamp`. This AGE build REJECTS `localtimestamp` inside
-- cypher (SQLSTATE 42703 "could not find rte for localtimestamp"). The functions'
-- bare-catch swallows it as a WARNING, so EVERY entity/fact insert silently
-- populated ZERO AGE nodes/edges — the knowledge_graph stayed empty and all graph
-- traversal (findConnectedEntities, get_entity_neighbors, fallback retrieval)
-- returned []. Confirmed in cognitive_test: the same MERGE WITHOUT localtimestamp
-- succeeds and creates the vertex/edge.
--
-- FIX: drop the `localtimestamp` SET clauses. AGE is a traversal index only —
-- canonical timestamps live in public.entities/public.facts (the functions' own
-- comments say AGE node/edge props are non-canonical, and post-MERGE SET is
-- silently dropped by AGE in this version anyway). The MERGE still sets the
-- properties traversal reads (entity_id, name, type).
--
-- Also DROP the orphan 4-arg create_entity_edge(UUID,UUID,VARCHAR,JSONB) overload:
-- it has a `p_props JSONB DEFAULT` (legacy, reduced to 3-arg by nmemo-2yv.21 but
-- never dropped on long-lived DBs), so a 3-arg call matches BOTH signatures ->
-- "function is not unique".
--
-- SCHEMA NOTE: these functions live in ag_catalog (001 created them unqualified
-- under search_path = ag_catalog, public, so they landed in the first schema).
-- They are replaced IN PLACE there; explicit ag_catalog. qualifiers target the
-- existing functions and avoid creating public duplicates the trigger wouldn't
-- resolve (the trigger calls them unqualified -> ag_catalog wins on search_path).

-- Resolve the ambiguous overload first.
DROP FUNCTION IF EXISTS ag_catalog.create_entity_edge(UUID, UUID, VARCHAR, JSONB);

-- Entity node sync — drop `, e.updated_at = localtimestamp`.
CREATE OR REPLACE FUNCTION ag_catalog.sync_entity_to_graph(
  p_entity_id UUID, p_entity_name VARCHAR, p_entity_type VARCHAR, p_entity_props JSONB
) RETURNS void AS $$
BEGIN
  EXECUTE format(
    'SELECT * FROM cypher(''knowledge_graph'', $c$
      MERGE (e:Entity {entity_id: %L})
      SET e.name = %L, e.type = %L
      RETURN e
    $c$) as (v agtype)',
    p_entity_id::text, p_entity_name, p_entity_type
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'AGE sync_entity_to_graph failed for entity %: % (SQLSTATE %)',
    p_entity_id, SQLERRM, SQLSTATE;
END;
$$ LANGUAGE plpgsql;

-- Entity edge sync — drop `SET r.created_at = localtimestamp` (post-MERGE SET is
-- silently dropped by AGE anyway, per the original comment, and localtimestamp
-- errors). The comma-joined MATCH is retained (confirmed working in this build).
CREATE OR REPLACE FUNCTION ag_catalog.create_entity_edge(
  p_from UUID, p_to UUID, p_rel VARCHAR
) RETURNS void AS $$
DECLARE rel_type VARCHAR;
BEGIN
  rel_type := upper(replace(p_rel, '-', '_'));
  EXECUTE format(
    'SELECT * FROM cypher(''knowledge_graph'', $c$
      MATCH (a:Entity {entity_id: %L}), (b:Entity {entity_id: %L})
      MERGE (a)-[r:%s]->(b)
      RETURN r
    $c$) as (v agtype)',
    p_from::text, p_to::text, rel_type
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'AGE create_entity_edge failed (% -[%]-> %): % (SQLSTATE %)',
    p_from, p_rel, p_to, SQLERRM, SQLSTATE;
END;
$$ LANGUAGE plpgsql;
