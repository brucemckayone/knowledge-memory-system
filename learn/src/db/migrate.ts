import { createClient } from '@libsql/client';
import { config } from '../config.js';

const DDL = `
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  topic TEXT,
  source_type TEXT NOT NULL DEFAULT 'generated',
  source_text TEXT,
  nmemo_memory_id TEXT,
  status TEXT NOT NULL DEFAULT 'building',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  learning_objectives TEXT NOT NULL DEFAULT '[]',
  concept_entity_ids TEXT NOT NULL DEFAULT '[]',
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  expected_answer TEXT,
  explanation TEXT,
  difficulty INTEGER NOT NULL DEFAULT 3,
  question_type TEXT NOT NULL DEFAULT 'static',
  concept_entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  learner_id TEXT NOT NULL DEFAULT 'default',
  answer_text TEXT NOT NULL,
  score REAL,
  feedback TEXT,
  agent_reasoning TEXT,
  nmemo_updates TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
  learner_id TEXT NOT NULL DEFAULT 'default',
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  nmemo_updates TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  related_entity_ids TEXT NOT NULL DEFAULT '[]',
  related_course_ids TEXT NOT NULL DEFAULT '[]',
  related_fact_ids TEXT NOT NULL DEFAULT '[]',
  related_section_ids TEXT NOT NULL DEFAULT '[]',
  actionable_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed_at TEXT,
  viewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_insights_created_at ON insights(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_insights_dismissed_at ON insights(dismissed_at);
CREATE INDEX IF NOT EXISTS idx_insights_type ON insights(type);

CREATE TABLE IF NOT EXISTS patrol_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  insights_produced INTEGER NOT NULL DEFAULT 0,
  mcp_calls INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error_text TEXT
);
`;

// Lesson columns added in v0.2 — wrapped in try/catch because SQLite ALTER TABLE
// has no IF NOT EXISTS support; "duplicate column name" is the expected error
// on subsequent runs.
const ALTER_STMTS: string[] = [
  `ALTER TABLE sections ADD COLUMN lesson_content TEXT`,
  `ALTER TABLE sections ADD COLUMN lesson_generated_at TEXT`,
  `ALTER TABLE sections ADD COLUMN lesson_read_minutes INTEGER`,
  `ALTER TABLE sections ADD COLUMN lesson_key_takeaways TEXT`,
  `ALTER TABLE insights ADD COLUMN idempotency_key TEXT`,
];

const POST_ALTER_STMTS: string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_idempotency_key ON insights(idempotency_key)`,
];

async function migrate() {
  const client = createClient({ url: `file:${config.DB_PATH}` });
  for (const stmt of DDL.split(';').map(s => s.trim()).filter(Boolean)) {
    await client.execute(stmt);
  }

  for (const stmt of ALTER_STMTS) {
    try {
      await client.execute(stmt);
      console.log(`Applied: ${stmt}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('duplicate column')) {
        // Already applied — fine
      } else {
        throw err;
      }
    }
  }

  for (const stmt of POST_ALTER_STMTS) {
    await client.execute(stmt);
  }

  console.log('Migrations applied.');
  await client.close();
}

migrate().catch(err => { console.error(err); process.exit(1); });
