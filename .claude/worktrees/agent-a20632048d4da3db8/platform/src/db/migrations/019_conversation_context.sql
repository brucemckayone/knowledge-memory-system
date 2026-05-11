-- Migration 019: Conversation context tables (W44)
-- Adaptive conversation windows and rollup summaries for stream sources.

CREATE TABLE IF NOT EXISTS conversation_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(50) NOT NULL,
  channel_id VARCHAR(255) NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_end TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  topic_drift_score REAL DEFAULT 0.0,
  active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source, channel_id, active)
);

CREATE INDEX IF NOT EXISTS idx_conversation_state_active ON conversation_state(source, channel_id) WHERE active = true;

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_state_id UUID NOT NULL REFERENCES conversation_state(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  key_topics TEXT[] NOT NULL DEFAULT '{}',
  participant_count INTEGER DEFAULT 1,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_summaries_state ON conversation_summaries(conversation_state_id);
