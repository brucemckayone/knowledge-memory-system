-- Migration 018: Obsidian sync state (W39)
-- Tracks per-file sync state for the Obsidian read adapter.

CREATE TABLE IF NOT EXISTS obsidian_sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  memory_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(vault_path, file_path)
);

CREATE INDEX IF NOT EXISTS idx_obsidian_sync_vault ON obsidian_sync_state(vault_path);
