-- Migration 001: Core tables (Phase 1-2)
-- These tables were originally created via `pnpm db:push` from schema.ts.
-- Adding migration files retroactively so the full schema can be
-- set up from migrations alone (used by test global-setup).

CREATE TABLE IF NOT EXISTS epics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'active' NOT NULL,
  last_activity_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID,
  content TEXT NOT NULL,
  due_date TIMESTAMPTZ,
  priority VARCHAR(10) DEFAULT 'medium' NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' NOT NULL,
  epic_id UUID,
  context_id UUID,
  memory_id UUID,
  parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  hierarchy_level INTEGER DEFAULT 0 NOT NULL,
  estimated_duration_minutes INTEGER,
  duration_confidence REAL,
  decomposition_reasoning TEXT,
  auto_suggested_deadline TIMESTAMPTZ,
  auto_suggested_priority VARCHAR(20),
  suggestions JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_type VARCHAR(50) NOT NULL,
  confidence REAL DEFAULT 1.0,
  detected_by VARCHAR(50) DEFAULT 'llm',
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(task_id, depends_on_task_id, dependency_type)
);

CREATE TABLE IF NOT EXISTS task_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id_1 UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_id_2 UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  conflict_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20),
  description TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolution_status VARCHAR(50) DEFAULT 'open',
  resolution_action VARCHAR,
  UNIQUE(task_id_1, task_id_2, conflict_type)
);

CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  preference_key VARCHAR(100) NOT NULL,
  preference_value JSONB NOT NULL,
  confidence REAL DEFAULT 0.5,
  last_observed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  sample_count INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(user_id, preference_key)
);

CREATE TABLE IF NOT EXISTS processing_state (
  conversation_id VARCHAR(255) PRIMARY KEY NOT NULL,
  pending_messages JSONB DEFAULT '[]'::jsonb NOT NULL,
  messages_since_update INTEGER DEFAULT 0 NOT NULL,
  last_processed_at TIMESTAMPTZ,
  next_analysis_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS context_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id VARCHAR(255) UNIQUE NOT NULL,
  platform VARCHAR(50) NOT NULL,
  name VARCHAR(255),
  summary TEXT,
  message_count INTEGER DEFAULT 0 NOT NULL,
  participants_json JSONB DEFAULT '[]' NOT NULL,
  last_analyzed_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
