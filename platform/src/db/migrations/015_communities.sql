-- Migration 015: Communities table (W30)
-- Stores detected entity communities from Louvain clustering.

CREATE TABLE IF NOT EXISTS communities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  description TEXT,
  entity_ids UUID[] NOT NULL DEFAULT '{}',
  coherence_score REAL DEFAULT 0.0,
  size INTEGER NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_communities_size ON communities(size DESC);
CREATE INDEX IF NOT EXISTS idx_communities_detected ON communities(detected_at DESC);
