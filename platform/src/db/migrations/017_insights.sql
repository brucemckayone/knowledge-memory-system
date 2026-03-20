-- Migration 017: Insights table (W31)
-- Stores generated insights from community analysis.

CREATE TABLE IF NOT EXISTS insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID REFERENCES communities(id) ON DELETE SET NULL,
  insight_type VARCHAR(50) NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  entity_ids UUID[] NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5,
  relevance_score REAL NOT NULL DEFAULT 0.5,
  metadata JSONB DEFAULT '{}',
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insights_type ON insights(insight_type);
CREATE INDEX IF NOT EXISTS idx_insights_community ON insights(community_id);
CREATE INDEX IF NOT EXISTS idx_insights_active ON insights(created_at DESC) WHERE dismissed_at IS NULL;
