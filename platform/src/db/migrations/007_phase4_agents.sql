-- Phase 4: KARMA Agents Infrastructure
-- Memory chunks, predicate ontology extensions, and contradiction reviews

-- Memory chunks for ingestion agent (W22)
-- Stores chunked content for processing long memories
CREATE TABLE IF NOT EXISTS memory_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  token_estimate INTEGER,
  overlap_chars INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE(memory_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_memory ON memory_chunks(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_unprocessed ON memory_chunks(memory_id) WHERE processed_at IS NULL;

-- Extend fact_predicates for schema alignment (W27)
ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS category VARCHAR(50);
ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT '{}';
ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS is_canonical BOOLEAN DEFAULT true;
ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS usage_count INTEGER DEFAULT 0;
ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Create index for non-canonical predicates (need alignment)
CREATE INDEX IF NOT EXISTS idx_predicates_non_canonical ON fact_predicates(predicate) WHERE is_canonical = false;

-- Contradiction reviews for conflict resolution (W28)
-- Tracks contradictions that need human review
CREATE TABLE IF NOT EXISTS contradiction_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id_1 UUID REFERENCES facts(id) ON DELETE CASCADE,
  fact_id_2 UUID REFERENCES facts(id) ON DELETE CASCADE,
  contradiction_type VARCHAR(50),
  severity VARCHAR(20) CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  resolution VARCHAR(50) CHECK (resolution IN ('pending', 'supersede', 'invalidate', 'coexist', 'flag', 'resolved')),
  resolution_notes TEXT,
  auto_resolved BOOLEAN DEFAULT false,
  resolved_by VARCHAR(100),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contradiction_reviews_pending ON contradiction_reviews(created_at) WHERE resolution = 'pending';
CREATE INDEX IF NOT EXISTS idx_contradiction_reviews_facts ON contradiction_reviews(fact_id_1, fact_id_2);

-- Memory metadata for reader agent (W23)
-- Stores parsed content metadata
CREATE TABLE IF NOT EXISTS memory_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id TEXT NOT NULL UNIQUE,
  content_type VARCHAR(50),  -- thought, task, link, event, note, question
  title VARCHAR(500),
  summary TEXT,
  extracted_dates JSONB DEFAULT '[]',
  extracted_links JSONB DEFAULT '[]',
  extracted_tags TEXT[] DEFAULT '{}',
  mentioned_entities TEXT[] DEFAULT '{}',
  word_count INTEGER,
  language VARCHAR(10),
  sentiment VARCHAR(20),
  parsed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_metadata_type ON memory_metadata(content_type);
CREATE INDEX IF NOT EXISTS idx_memory_metadata_memory ON memory_metadata(memory_id);

-- Memory summaries for summarizer agent (W24)
CREATE TABLE IF NOT EXISTS memory_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id TEXT NOT NULL,
  summary_type VARCHAR(50) DEFAULT 'standard',  -- standard, brief, detailed, key_points
  summary TEXT NOT NULL,
  key_points JSONB DEFAULT '[]',
  embedding_updated BOOLEAN DEFAULT false,
  model_used VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_summaries_memory ON memory_summaries(memory_id);

-- Gardener metrics for evaluator agent (W29)
-- Extended metrics table for quality tracking
CREATE TABLE IF NOT EXISTS gardener_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID,
  agent_name VARCHAR(100) NOT NULL,
  execution_time_ms INTEGER,
  success BOOLEAN,
  quality_score REAL,  -- 0.0 to 1.0
  items_processed INTEGER DEFAULT 0,
  error_message TEXT,
  agent_specific_metrics JSONB DEFAULT '{}',
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gardener_metrics_agent ON gardener_metrics(agent_name);
CREATE INDEX IF NOT EXISTS idx_gardener_metrics_time ON gardener_metrics(recorded_at);
CREATE INDEX IF NOT EXISTS idx_gardener_metrics_quality ON gardener_metrics(agent_name, quality_score);

-- Insert canonical predicates for ontology (W27)
INSERT INTO fact_predicates (predicate, description, predicate_type, is_exclusive, category, aliases)
VALUES
  -- Professional relationships
  ('works_at', 'Currently employed at organization', 'employment', true, 'professional', ARRAY['employed_at', 'works_for', 'employee_of']),
  ('worked_at', 'Previously employed at organization', 'employment', false, 'professional', ARRAY['formerly_at', 'ex_employee_of']),
  ('manages', 'Manages another person', 'hierarchy', false, 'professional', ARRAY['supervises', 'leads', 'directs']),
  ('reports_to', 'Reports to another person', 'hierarchy', true, 'professional', ARRAY['managed_by', 'supervised_by']),
  ('founded', 'Founded an organization', 'founding', false, 'professional', ARRAY['created', 'started', 'established']),
  ('ceo_of', 'CEO of organization', 'role', true, 'professional', ARRAY['chief_executive_of', 'runs']),
  ('member_of', 'Member of organization/group', 'membership', false, 'professional', ARRAY['belongs_to', 'part_of']),

  -- Personal relationships
  ('knows', 'Knows another person', 'social', false, 'personal', ARRAY['acquainted_with', 'met']),
  ('friend_of', 'Friends with another person', 'social', false, 'personal', ARRAY['friends_with']),
  ('married_to', 'Married to another person', 'family', true, 'personal', ARRAY['spouse_of', 'husband_of', 'wife_of']),
  ('parent_of', 'Parent of another person', 'family', false, 'personal', ARRAY['father_of', 'mother_of']),
  ('sibling_of', 'Sibling of another person', 'family', false, 'personal', ARRAY['brother_of', 'sister_of']),

  -- Location relationships
  ('lives_in', 'Currently lives in location', 'residence', true, 'location', ARRAY['resides_in', 'based_in', 'located_in']),
  ('lived_in', 'Previously lived in location', 'residence', false, 'location', ARRAY['formerly_in']),
  ('born_in', 'Born in location', 'origin', true, 'location', ARRAY['birthplace']),
  ('visited', 'Visited a location', 'travel', false, 'location', ARRAY['traveled_to', 'went_to']),

  -- Education
  ('studied_at', 'Studied at institution', 'education', false, 'education', ARRAY['attended', 'enrolled_at', 'graduated_from']),
  ('has_degree', 'Has academic degree', 'qualification', false, 'education', ARRAY['earned_degree', 'holds_degree']),

  -- Creation/Ownership
  ('created', 'Created something', 'creation', false, 'creation', ARRAY['authored', 'built', 'made', 'developed']),
  ('owns', 'Owns something', 'ownership', false, 'creation', ARRAY['has', 'possesses']),

  -- Knowledge/Skills
  ('knows_about', 'Has knowledge of topic', 'knowledge', false, 'skills', ARRAY['understands', 'familiar_with']),
  ('skilled_in', 'Has skill in area', 'skill', false, 'skills', ARRAY['proficient_in', 'expert_in', 'good_at']),
  ('interested_in', 'Interested in topic', 'interest', false, 'skills', ARRAY['likes', 'enjoys', 'passionate_about']),

  -- Events
  ('attended', 'Attended an event', 'participation', false, 'events', ARRAY['went_to', 'participated_in']),
  ('organized', 'Organized an event', 'participation', false, 'events', ARRAY['hosted', 'arranged']),
  ('spoke_at', 'Spoke at an event', 'participation', false, 'events', ARRAY['presented_at', 'gave_talk_at'])
ON CONFLICT (predicate) DO UPDATE SET
  category = EXCLUDED.category,
  aliases = EXCLUDED.aliases,
  is_canonical = true;

-- Function to get canonical predicate for an alias
CREATE OR REPLACE FUNCTION get_canonical_predicate(p_alias TEXT)
RETURNS TEXT AS $$
DECLARE
  v_canonical TEXT;
BEGIN
  -- Check if it's already a canonical predicate
  SELECT predicate INTO v_canonical
  FROM fact_predicates
  WHERE predicate = p_alias AND is_canonical = true;

  IF v_canonical IS NOT NULL THEN
    RETURN v_canonical;
  END IF;

  -- Search in aliases
  SELECT predicate INTO v_canonical
  FROM fact_predicates
  WHERE p_alias = ANY(aliases) AND is_canonical = true
  LIMIT 1;

  RETURN COALESCE(v_canonical, p_alias);
END;
$$ LANGUAGE plpgsql;

-- Rolling average view for evaluator metrics
CREATE OR REPLACE VIEW gardener_agent_stats AS
SELECT
  agent_name,
  COUNT(*) as total_jobs,
  SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful_jobs,
  AVG(quality_score) as avg_quality_score,
  STDDEV(quality_score) as quality_stddev,
  AVG(execution_time_ms) as avg_execution_time,
  AVG(items_processed) as avg_items_processed,
  MAX(recorded_at) as last_run
FROM gardener_metrics
WHERE recorded_at > NOW() - INTERVAL '7 days'
GROUP BY agent_name;

-- Add comments
COMMENT ON TABLE memory_chunks IS 'Chunked memory content for processing long texts (W22 Ingestion Agent)';
COMMENT ON TABLE contradiction_reviews IS 'Contradiction cases flagged for review (W28 Conflict Resolution Agent)';
COMMENT ON TABLE memory_metadata IS 'Parsed content metadata from memories (W23 Reader Agent)';
COMMENT ON TABLE memory_summaries IS 'Generated summaries of memories (W24 Summarizer Agent)';
COMMENT ON TABLE gardener_metrics IS 'Agent execution metrics for quality tracking (W29 Evaluator Agent)';
