-- Migration 021: Project association tables (W45)

CREATE TABLE IF NOT EXISTS project_associations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(500) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  entity_ids UUID[] NOT NULL DEFAULT '{}',
  tag_patterns TEXT[] NOT NULL DEFAULT '{}',
  auto_detected BOOLEAN NOT NULL DEFAULT true,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_assoc_status ON project_associations(status);

CREATE TABLE IF NOT EXISTS source_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES project_associations(id) ON DELETE CASCADE,
  source VARCHAR(50) NOT NULL,
  channel_id VARCHAR(255) NOT NULL,
  binding_type VARCHAR(50) NOT NULL DEFAULT 'auto',
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, source, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_source_bindings_project ON source_bindings(project_id);

CREATE TABLE IF NOT EXISTS association_ambiguities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL,
  candidate_project_ids UUID[] NOT NULL DEFAULT '{}',
  scores JSONB NOT NULL DEFAULT '{}',
  resolved_project_id UUID REFERENCES project_associations(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assoc_ambiguities_unresolved ON association_ambiguities(created_at DESC) WHERE resolved_at IS NULL;
