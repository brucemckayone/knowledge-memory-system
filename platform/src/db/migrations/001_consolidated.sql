-- 001_consolidated.sql — Sparse Truth Graph: Graph S tables
-- Consolidates migrations 003, 004, 005, 022, 023, 024, 025

-- ============================================
-- Extensions
-- ============================================
CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- trigram similarity
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- temporal exclusion constraints
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- UUID generation

-- Apache AGE (assumes extension installed via shared_preload_libraries)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'age') THEN
    CREATE EXTENSION age;
  END IF;
END $$;

-- Set search path to include AGE catalog for current session
SET search_path = ag_catalog, public, "$user";

-- ============================================
-- 1. Entity Types Registry
-- ============================================
CREATE TABLE IF NOT EXISTS public.entity_types (
  name VARCHAR(100) PRIMARY KEY,
  description TEXT,
  status VARCHAR(20) DEFAULT 'canonical' NOT NULL,
  promoted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT valid_entity_type_status CHECK (
    status IN ('canonical', 'provisional', 'deprecated')
  )
);

INSERT INTO public.entity_types (name, description, status) VALUES
  ('person',  'A human individual',                        'canonical'),
  ('company', 'A business organization or corporation',    'canonical'),
  ('project', 'A project, product, or initiative',         'canonical'),
  ('concept', 'An abstract concept, idea, or topic',       'canonical'),
  ('place',   'A geographic location',                     'canonical'),
  ('event',   'A specific event or occurrence',            'canonical'),
  ('other',   'Uncategorized entity type',                 'canonical')
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- 2. Entities
-- ============================================
CREATE TABLE IF NOT EXISTS public.entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name VARCHAR(500) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  description TEXT,
  properties JSONB DEFAULT '{}',
  merged_from UUID[] DEFAULT '{}',
  confidence FLOAT DEFAULT 1.0,
  embedding VECTOR(768),
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_confidence CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON public.entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name_trgm ON public.entities USING gin(canonical_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_created ON public.entities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_embedding ON public.entities USING hnsw (embedding vector_cosine_ops);

-- ============================================
-- 3. Entity Aliases
-- ============================================
CREATE TABLE IF NOT EXISTS public.entity_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  alias VARCHAR(500) NOT NULL,
  alias_type VARCHAR(50),
  source VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(entity_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_aliases_alias ON public.entity_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_aliases_alias_trgm ON public.entity_aliases USING gin(alias gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_aliases_entity ON public.entity_aliases(entity_id);

-- ============================================
-- 4. Entity Merges (audit trail)
-- ============================================
CREATE TABLE IF NOT EXISTS public.entity_merges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID NOT NULL,
  target_entity_id UUID NOT NULL REFERENCES public.entities(id),
  merge_reason TEXT,
  merge_method VARCHAR(50),
  similarity_score FLOAT,
  merged_at TIMESTAMPTZ DEFAULT NOW(),
  merged_by VARCHAR(100) DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_merges_source ON public.entity_merges(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_merges_target ON public.entity_merges(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_merges_time ON public.entity_merges(merged_at DESC);

-- ============================================
-- 5. Memory Entities (link Qdrant memories to entities)
-- ============================================
CREATE TABLE IF NOT EXISTS public.memory_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL,
  entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  mention_text VARCHAR(500),
  relationship VARCHAR(100) DEFAULT 'mentions',
  mention_start INT,
  mention_end INT,
  mention_context TEXT,
  confidence FLOAT DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entities_unique
  ON public.memory_entities (memory_id, entity_id, COALESCE(mention_start, -1));
CREATE INDEX IF NOT EXISTS idx_memory_entities_memory ON public.memory_entities(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON public.memory_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_entities_created ON public.memory_entities(created_at DESC);

-- ============================================
-- 6. Fact Predicates (ontology)
-- ============================================
CREATE TABLE IF NOT EXISTS public.fact_predicates (
  predicate VARCHAR(255) PRIMARY KEY,
  description TEXT,
  inverse_predicate VARCHAR(255),
  predicate_type VARCHAR(50),
  is_exclusive BOOLEAN DEFAULT FALSE,
  category VARCHAR(50),
  aliases TEXT[] DEFAULT '{}',
  is_canonical BOOLEAN DEFAULT TRUE,
  usage_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Staging lifecycle
  status VARCHAR(20) DEFAULT 'canonical',
  first_seen_at TIMESTAMPTZ,
  distinct_memory_count INTEGER DEFAULT 0,
  promoted_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  CONSTRAINT valid_predicate_status CHECK (
    status IN ('staging', 'candidate', 'provisional', 'canonical', 'rejected')
  )
);

CREATE INDEX IF NOT EXISTS idx_predicates_staging
  ON public.fact_predicates(status, usage_count DESC) WHERE status IN ('staging', 'candidate');

-- Seed canonical predicates (7 categories)
INSERT INTO public.fact_predicates (predicate, description, inverse_predicate, predicate_type, is_exclusive, category, aliases, status) VALUES
  -- Professional (6)
  ('works_at',      'Employment relationship',                  'employs',     'relation', true,  'professional', ARRAY['employed_at','works_for','employee_of','working_at','worked_at','formerly_at','ex_employee_of','used_to_work_at'], 'canonical'),
  ('employs',       'Employs person',                           'works_at',    'relation', false, 'professional', ARRAY[]::text[], 'canonical'),
  ('manages',       'Manages another person',                   'reports_to',  'relation', false, 'professional', ARRAY['supervises','leads','directs','oversees'], 'canonical'),
  ('reports_to',    'Reports to another person',                'manages',     'relation', true,  'professional', ARRAY['managed_by','supervised_by','under'], 'canonical'),
  ('founded',       'Founded an organization',                  NULL,          'relation', false, 'professional', ARRAY['started','established','co_founded'], 'canonical'),
  ('ceo_of',        'CEO of organization',                      NULL,          'relation', true,  'professional', ARRAY['chief_executive_of','runs','heads'], 'canonical'),
  ('member_of',     'Member of organization/group',             'has_member',  'relation', false, 'professional', ARRAY['belongs_to','part_of','affiliated_with'], 'canonical'),
  ('has_member',    'Has member',                               'member_of',   'relation', false, 'professional', ARRAY[]::text[], 'canonical'),
  ('collaborates_with', 'Collaboration',                        NULL,          'relation', false, 'professional', ARRAY[]::text[], 'canonical'),
  -- Personal (6)
  ('knows',         'Knows another person',                     'known_by',    'relation', false, 'personal', ARRAY['acquainted_with','met','familiar_with'], 'canonical'),
  ('known_by',      'Known by person',                          'knows',       'relation', false, 'personal', ARRAY[]::text[], 'canonical'),
  ('friend_of',     'Friends with another person',              NULL,          'relation', false, 'personal', ARRAY['friends_with','close_to'], 'canonical'),
  ('married_to',    'Married to another person',                NULL,          'relation', true,  'personal', ARRAY['spouse_of','husband_of','wife_of','partner_of'], 'canonical'),
  ('parent_of',     'Parent of another person',                 'child_of',    'relation', false, 'personal', ARRAY['father_of','mother_of'], 'canonical'),
  ('child_of',      'Child of another person',                  'parent_of',   'relation', false, 'personal', ARRAY['son_of','daughter_of'], 'canonical'),
  ('sibling_of',    'Sibling of another person',                NULL,          'relation', false, 'personal', ARRAY['brother_of','sister_of'], 'canonical'),
  -- Location (3)
  ('lives_in',      'Residential relationship',                 NULL,          'relation', true,  'location', ARRAY['resides_in','based_in','located_in','living_in','lived_in','formerly_in','used_to_live_in'], 'canonical'),
  ('born_in',       'Born in location',                         NULL,          'relation', true,  'location', ARRAY['birthplace','native_of','from'], 'canonical'),
  ('visited',       'Visited a location',                       NULL,          'relation', false, 'location', ARRAY['traveled_to','went_to','been_to'], 'canonical'),
  -- Education (2)
  ('studied_at',    'Studied at institution',                   NULL,          'relation', false, 'education', ARRAY['attended','enrolled_at','graduated_from','alumnus_of'], 'canonical'),
  ('has_degree',    'Has academic degree',                      NULL,          'attribute', false, 'education', ARRAY['earned_degree','holds_degree','degree_in'], 'canonical'),
  -- Creation/Ownership (4)
  ('created',       'Created something',                        'created_by',  'relation', false, 'creation', ARRAY['authored','built','made','developed','wrote','designed'], 'canonical'),
  ('created_by',    'Created by',                               'created',     'relation', false, 'creation', ARRAY[]::text[], 'canonical'),
  ('owns',          'Owns something',                           'owned_by',    'relation', false, 'creation', ARRAY['has','possesses','owner_of'], 'canonical'),
  ('owned_by',      'Owned by',                                 'owns',        'relation', false, 'creation', ARRAY[]::text[], 'canonical'),
  -- Skills/Knowledge (3)
  ('knows_about',   'Has knowledge of topic',                   NULL,          'attribute', false, 'skills', ARRAY['understands','familiar_with_topic','knowledgeable_in'], 'canonical'),
  ('skilled_in',    'Has skill in area',                        NULL,          'attribute', false, 'skills', ARRAY['proficient_in','expert_in','good_at','specializes_in'], 'canonical'),
  ('interested_in', 'Interested in topic',                      NULL,          'attribute', false, 'skills', ARRAY['likes','enjoys','passionate_about','into'], 'canonical'),
  -- Events (3)
  ('attended_event','Attended an event',                        NULL,          'relation', false, 'events', ARRAY['went_to_event','participated_in'], 'canonical'),
  ('organized',     'Organized an event',                       NULL,          'relation', false, 'events', ARRAY['hosted','arranged','planned'], 'canonical'),
  ('spoke_at',      'Spoke at an event',                        NULL,          'relation', false, 'events', ARRAY['presented_at','gave_talk_at','keynote_at'], 'canonical'),
  -- Structural (general-purpose)
  ('related_to',    'General relationship',                     'related_to',  'relation', false, 'structural', ARRAY[]::text[], 'canonical'),
  ('located_in',    'Physical location',                        'contains',    'relation', false, 'structural', ARRAY[]::text[], 'canonical'),
  ('contains',      'Contains location',                        'located_in',  'relation', false, 'structural', ARRAY[]::text[], 'canonical'),
  ('part_of',       'Part-whole relationship',                  'has_part',    'relation', false, 'structural', ARRAY[]::text[], 'canonical'),
  ('has_part',      'Has part',                                 'part_of',     'relation', false, 'structural', ARRAY[]::text[], 'canonical'),
  -- Attributes
  ('has_role',      'Role or position',                         NULL,          'attribute', true,  'attributes', ARRAY[]::text[], 'canonical'),
  ('has_title',     'Job title',                                NULL,          'attribute', false, 'attributes', ARRAY[]::text[], 'canonical'),
  ('has_email',     'Email address',                            NULL,          'attribute', false, 'attributes', ARRAY[]::text[], 'canonical'),
  ('has_phone',     'Phone number',                             NULL,          'attribute', false, 'attributes', ARRAY[]::text[], 'canonical'),
  ('has_status',    'Current status',                           NULL,          'attribute', false, 'attributes', ARRAY[]::text[], 'canonical'),
  ('has_description','Description',                             NULL,          'attribute', false, 'attributes', ARRAY[]::text[], 'canonical'),
  -- Temporal
  ('started_at',    'Start date of activity',                   NULL,          'temporal', false, 'temporal', ARRAY[]::text[], 'canonical'),
  ('ended_at',      'End date of activity',                     NULL,          'temporal', false, 'temporal', ARRAY[]::text[], 'canonical'),
  ('scheduled_for', 'Scheduled date',                           NULL,          'temporal', false, 'temporal', ARRAY[]::text[], 'canonical'),
  ('deadline',      'Deadline date',                            NULL,          'temporal', false, 'temporal', ARRAY[]::text[], 'canonical')
ON CONFLICT (predicate) DO NOTHING;

-- ============================================
-- 7. Facts (bi-temporal knowledge triples)
-- ============================================
CREATE TABLE IF NOT EXISTS public.facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  predicate VARCHAR(255) NOT NULL,
  object_entity_id UUID REFERENCES public.entities(id) ON DELETE SET NULL,
  object_value TEXT,
  -- Event time
  valid_at TIMESTAMPTZ,
  invalid_at TIMESTAMPTZ,
  -- Transaction time
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expired_at TIMESTAMPTZ,
  expire_reason TEXT,
  -- Provenance
  source_memory_id UUID,
  source_text TEXT,
  extraction_method VARCHAR(100),
  -- Quality
  confidence FLOAT DEFAULT 1.0,
  fact_embedding VECTOR(768),
  CONSTRAINT valid_fact_confidence CHECK (confidence >= 0.0 AND confidence <= 1.0),
  CONSTRAINT has_object CHECK (object_entity_id IS NOT NULL OR object_value IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_facts_subject ON public.facts(subject_entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_object ON public.facts(object_entity_id) WHERE object_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facts_predicate ON public.facts(predicate);
CREATE INDEX IF NOT EXISTS idx_facts_created ON public.facts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_source ON public.facts(source_memory_id) WHERE source_memory_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facts_valid_range ON public.facts(valid_at, invalid_at);
CREATE INDEX IF NOT EXISTS idx_facts_active ON public.facts(subject_entity_id, predicate) WHERE expired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_embedding ON public.facts USING hnsw (fact_embedding vector_cosine_ops);

-- ============================================
-- 8. Entity Type History (bi-temporal typing)
-- ============================================
CREATE TABLE IF NOT EXISTS public.entity_type_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  previous_type VARCHAR(100) NOT NULL,
  new_type VARCHAR(100) NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  changed_by VARCHAR(50) DEFAULT 'system',
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_entity_type_history_entity ON public.entity_type_history(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_type_history_time ON public.entity_type_history(changed_at DESC);

-- ============================================
-- Functions
-- ============================================

-- Auto-update updated_at on entities
CREATE OR REPLACE FUNCTION update_entity_timestamp() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entities_updated_at ON public.entities;
CREATE TRIGGER entities_updated_at
  BEFORE UPDATE ON public.entities FOR EACH ROW
  EXECUTE FUNCTION update_entity_timestamp();

-- Expire a fact
CREATE OR REPLACE FUNCTION expire_fact(fact_id UUID, reason TEXT DEFAULT 'Superseded by new information')
RETURNS void AS $$
BEGIN
  UPDATE public.facts SET expired_at = NOW(), expire_reason = reason WHERE id = fact_id AND expired_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Invalidate a fact (no longer true in reality)
CREATE OR REPLACE FUNCTION invalidate_fact(fact_id UUID, invalid_time TIMESTAMPTZ DEFAULT NOW())
RETURNS void AS $$
BEGIN
  UPDATE public.facts SET invalid_at = invalid_time WHERE id = fact_id AND invalid_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Bi-temporal query: facts valid at a point in time
CREATE OR REPLACE FUNCTION facts_at_time(query_time TIMESTAMPTZ)
RETURNS TABLE (id UUID, subject_entity_id UUID, predicate VARCHAR(255), object_entity_id UUID, object_value TEXT, confidence FLOAT) AS $$
BEGIN
  RETURN QUERY
  SELECT f.id, f.subject_entity_id, f.predicate, f.object_entity_id, f.object_value, f.confidence
  FROM public.facts f
  WHERE f.created_at <= query_time AND (f.expired_at IS NULL OR f.expired_at > query_time)
    AND (f.valid_at IS NULL OR f.valid_at <= query_time)
    AND (f.invalid_at IS NULL OR f.invalid_at > query_time);
END;
$$ LANGUAGE plpgsql;

-- Current facts for an entity
CREATE OR REPLACE FUNCTION get_entity_current_facts(p_entity_id UUID)
RETURNS TABLE (fact_id UUID, predicate VARCHAR(255), object_entity_id UUID, object_value TEXT, confidence FLOAT, valid_at TIMESTAMPTZ) AS $$
BEGIN
  RETURN QUERY
  SELECT f.id, f.predicate, f.object_entity_id, f.object_value, f.confidence, f.valid_at
  FROM public.facts f
  WHERE f.subject_entity_id = p_entity_id AND f.expired_at IS NULL
    AND (f.invalid_at IS NULL OR f.invalid_at > NOW())
  ORDER BY f.predicate, f.valid_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Find superseding facts
CREATE OR REPLACE FUNCTION find_superseding_facts(
  new_fact_subject UUID, new_fact_predicate VARCHAR(255),
  new_fact_valid_at TIMESTAMPTZ, new_fact_invalid_at TIMESTAMPTZ
) RETURNS TABLE (fact_id UUID, old_valid_at TIMESTAMPTZ, old_invalid_at TIMESTAMPTZ, is_exclusive BOOLEAN) AS $$
BEGIN
  RETURN QUERY
  SELECT f.id, f.valid_at, f.invalid_at, COALESCE(fp.is_exclusive, false)
  FROM public.facts f LEFT JOIN public.fact_predicates fp ON fp.predicate = f.predicate
  WHERE f.subject_entity_id = new_fact_subject AND f.predicate = new_fact_predicate AND f.expired_at IS NULL
    AND ((new_fact_valid_at IS NULL AND new_fact_invalid_at IS NULL)
      OR ((f.valid_at IS NULL OR new_fact_invalid_at IS NULL OR f.valid_at < new_fact_invalid_at)
        AND (f.invalid_at IS NULL OR new_fact_valid_at IS NULL OR f.invalid_at > new_fact_valid_at)));
END;
$$ LANGUAGE plpgsql;

-- Merge two entities (with post-merge fact dedup)
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

  UPDATE public.entities SET merged_from = merged_from || source_id,
    last_seen_at = GREATEST(last_seen_at, (SELECT last_seen_at FROM public.entities WHERE id = source_id)),
    updated_at = NOW()
  WHERE id = target_id;

  DELETE FROM public.entities WHERE id = source_id;
  RETURN target_id;
END;
$$ LANGUAGE plpgsql;

-- Trigram name search
CREATE OR REPLACE FUNCTION find_similar_entities_by_name(
  search_name VARCHAR, similarity_threshold FLOAT DEFAULT 0.3, max_results INT DEFAULT 10
) RETURNS TABLE (entity_id UUID, canonical_name VARCHAR(500), entity_type VARCHAR(100), similarity FLOAT) AS $$
BEGIN
  RETURN QUERY
  SELECT e.id, e.canonical_name, e.entity_type, similarity(e.canonical_name, search_name) AS sim
  FROM public.entities e
  WHERE e.canonical_name % search_name AND similarity(e.canonical_name, search_name) >= similarity_threshold
  ORDER BY sim DESC LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Apache AGE: Knowledge Graph
-- ============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM ag_graph WHERE name = 'knowledge_graph') THEN
    PERFORM create_graph('knowledge_graph');
  END IF;
END $$;

-- Sync entity to AGE graph.
-- Bare-catch is intentional: AGE is a traversal index (canonical data lives in
-- public.entities/facts), so we must not break ingest. Errors are surfaced as
-- WARNINGs so AGE drift is observable in logs without losing data.
CREATE OR REPLACE FUNCTION sync_entity_to_graph(
  p_entity_id UUID, p_entity_name VARCHAR, p_entity_type VARCHAR, p_entity_props JSONB
) RETURNS void AS $$
BEGIN
  EXECUTE format(
    'SELECT * FROM cypher(''knowledge_graph'', $c$
      MERGE (e:Entity {entity_id: %L})
      SET e.name = %L, e.type = %L, e.updated_at = localtimestamp
      RETURN e
    $c$) as (v agtype)',
    p_entity_id::text, p_entity_name, p_entity_type
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'AGE sync_entity_to_graph failed for entity %: % (SQLSTATE %)',
    p_entity_id, SQLERRM, SQLSTATE;
END;
$$ LANGUAGE plpgsql;

-- Create AGE edge between entities.
-- Bare-catch is intentional (see sync_entity_to_graph comment); errors are
-- surfaced as WARNINGs so caller and operator can see edge-sync drift.
-- AGE is a traversal index only — canonical edge data (fact_id, confidence,
-- valid_at, etc.) lives in public.facts. Re-add edge properties at MERGE time
-- (e.g. MERGE (a)-[r:REL {confidence: ...}]->(b)) if AGE-native filtered
-- traversal is ever needed; post-MERGE SET r.prop is silently dropped by AGE
-- in this version.
CREATE OR REPLACE FUNCTION create_entity_edge(
  p_from UUID, p_to UUID, p_rel VARCHAR
) RETURNS void AS $$
DECLARE rel_type VARCHAR;
BEGIN
  rel_type := upper(replace(p_rel, '-', '_'));
  EXECUTE format(
    'SELECT * FROM cypher(''knowledge_graph'', $c$
      MATCH (a:Entity {entity_id: %L}), (b:Entity {entity_id: %L})
      MERGE (a)-[r:%s]->(b) SET r.created_at = localtimestamp
      RETURN r
    $c$) as (v agtype)',
    p_from::text, p_to::text, rel_type
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'AGE create_entity_edge failed (% -[%]-> %): % (SQLSTATE %)',
    p_from, p_rel, p_to, SQLERRM, SQLSTATE;
END;
$$ LANGUAGE plpgsql;

-- Find paths between entities.
-- Bare-catch returns empty so callers degrade gracefully; the RAISE WARNING
-- makes traversal failure distinguishable from a genuine empty result.
CREATE OR REPLACE FUNCTION find_entity_paths(p_from UUID, p_to UUID, p_max_hops INT DEFAULT 3)
RETURNS TABLE (path_info JSONB) AS $$
BEGIN
  RETURN QUERY EXECUTE format(
    'SELECT row_to_json(t)::jsonb FROM (
      SELECT * FROM cypher(''knowledge_graph'', $c$
        MATCH path = (a:Entity {entity_id: %L})-[*1..%s]-(b:Entity {entity_id: %L})
        RETURN path LIMIT 10
      $c$) as (path agtype)
    ) t',
    p_from::text, p_max_hops, p_to::text
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'AGE find_entity_paths failed (% -> %, %h): % (SQLSTATE %)',
    p_from, p_to, p_max_hops, SQLERRM, SQLSTATE;
  RETURN;
END;
$$ LANGUAGE plpgsql;

-- Get entity neighbors.
-- Bare-catch returns empty so callers degrade gracefully; the RAISE WARNING
-- makes traversal failure distinguishable from a genuine empty result.
CREATE OR REPLACE FUNCTION get_entity_neighbors(p_entity_id UUID, p_max_depth INT DEFAULT 1)
RETURNS TABLE (neighbor_id TEXT, neighbor_name TEXT, neighbor_type TEXT) AS $$
BEGIN
  RETURN QUERY EXECUTE format(
    'SELECT (n->>''entity_id'')::text, (n->>''name'')::text, (n->>''type'')::text
     FROM cypher(''knowledge_graph'', $c$
       MATCH (a:Entity {entity_id: %L})-[*1..%s]-(b:Entity)
       RETURN DISTINCT b LIMIT 50
     $c$) as (n agtype)',
    p_entity_id::text, p_max_depth
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'AGE get_entity_neighbors failed (% depth %): % (SQLSTATE %)',
    p_entity_id, p_max_depth, SQLERRM, SQLSTATE;
  RETURN;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Triggers: auto-sync to AGE
-- ============================================
CREATE OR REPLACE FUNCTION trigger_sync_entity() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    PERFORM sync_entity_to_graph(NEW.id, NEW.canonical_name, NEW.entity_type, NEW.properties);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entities_sync_graph ON public.entities;
CREATE TRIGGER entities_sync_graph
  AFTER INSERT OR UPDATE ON public.entities FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_entity();

CREATE OR REPLACE FUNCTION trigger_sync_fact() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.object_entity_id IS NOT NULL AND NEW.expired_at IS NULL THEN
      PERFORM create_entity_edge(NEW.subject_entity_id, NEW.object_entity_id, NEW.predicate);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS facts_sync_graph ON public.facts;
CREATE TRIGGER facts_sync_graph
  AFTER INSERT OR UPDATE ON public.facts FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_fact();
