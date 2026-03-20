-- Migration 016: Channel profiles table (W43)
-- Configures per-channel/source processing behavior.

CREATE TABLE IF NOT EXISTS channel_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(50) NOT NULL,
  channel_id VARCHAR(255) NOT NULL,
  profile_name VARCHAR(100) NOT NULL DEFAULT 'default',
  config JSONB NOT NULL DEFAULT '{}',
  extraction_strategy VARCHAR(50) NOT NULL DEFAULT 'standard',
  chunking_enabled BOOLEAN NOT NULL DEFAULT true,
  chunk_size INTEGER NOT NULL DEFAULT 4000,
  chunk_overlap INTEGER NOT NULL DEFAULT 200,
  entity_extraction BOOLEAN NOT NULL DEFAULT true,
  relationship_extraction BOOLEAN NOT NULL DEFAULT true,
  task_extraction BOOLEAN NOT NULL DEFAULT true,
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_profiles_source ON channel_profiles(source);
