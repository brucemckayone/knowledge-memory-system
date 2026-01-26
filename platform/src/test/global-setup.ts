/**
 * Global Test Setup
 *
 * Runs once before all tests to initialize test database and services.
 * Creates cognitive_test database and runs migrations.
 *
 * Gracefully handles missing extensions (pgvector, pg_trgm) by tracking
 * availability flags that tests can use to skip appropriately.
 */

// CRITICAL: Set environment variables BEFORE any imports
// This ensures all modules (including config.ts) use the test database
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/cognitive_test';
process.env.NODE_ENV = 'test';
process.env.ML_SERVICES_URL = process.env.ML_SERVICES_URL || 'http://localhost:8000';

import postgres from 'postgres';
import { writeFileSync } from 'fs';
import { join } from 'path';

const TEST_DB_NAME = 'cognitive_test';

// Extension availability tracking
export interface ExtensionAvailability {
  vector: boolean;
  pg_trgm: boolean;
  uuid_ossp: boolean;
}

const extensionAvailability: ExtensionAvailability = {
  vector: false,
  pg_trgm: false,
  uuid_ossp: false,
};

export async function setup() {
  console.log('\n🧪 Setting up test environment...\n');

  // Connect to default postgres database to create test database
  const adminSql = postgres({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    database: 'postgres',
    username: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
  });

  try {
    // Check if test database exists
    const result = await adminSql`
      SELECT 1 FROM pg_database WHERE datname = ${TEST_DB_NAME}
    `;

    if (result.length === 0) {
      // Create test database
      await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
      console.log(`✅ Created test database: ${TEST_DB_NAME}`);
    } else {
      console.log(`✅ Test database already exists: ${TEST_DB_NAME}`);
    }
  } catch (error) {
    console.error('❌ Failed to create test database:', error);
    throw error;
  } finally {
    await adminSql.end();
  }

  // Connect to test database to set up extensions and schema
  const testSql = postgres({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    database: TEST_DB_NAME,
    username: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
  });

  try {
    // Enable extensions with graceful fallback for missing ones
    const extensions = [
      { name: 'uuid-ossp', key: 'uuid_ossp' as const },
      { name: 'vector', key: 'vector' as const },
      { name: 'pg_trgm', key: 'pg_trgm' as const },
    ];

    for (const ext of extensions) {
      try {
        await testSql.unsafe(`CREATE EXTENSION IF NOT EXISTS "${ext.name}"`);
        extensionAvailability[ext.key] = true;
        console.log(`✅ Extension "${ext.name}" enabled`);
      } catch (error) {
        extensionAvailability[ext.key] = false;
        console.warn(`⚠️  Extension "${ext.name}" not available - tests requiring it will be skipped`);
      }
    }

    // Write extension availability to a temp file for test files to read
    const availabilityPath = join(__dirname, '.extension-availability.json');
    writeFileSync(availabilityPath, JSON.stringify(extensionAvailability, null, 2));
    console.log(`📝 Extension availability written to ${availabilityPath}`);

    // Create entities table (with or without vector column depending on extension availability)
    if (extensionAvailability.vector) {
      await testSql`
        CREATE TABLE IF NOT EXISTS entities (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          canonical_name VARCHAR(500) NOT NULL,
          entity_type VARCHAR(100) NOT NULL,
          description TEXT,
          properties JSONB DEFAULT '{}'::jsonb NOT NULL,
          merged_from UUID[] DEFAULT '{}',
          confidence REAL DEFAULT 1.0 NOT NULL,
          embedding vector(768),
          first_seen_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
          last_seen_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
        )
      `;
    } else {
      await testSql`
        CREATE TABLE IF NOT EXISTS entities (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          canonical_name VARCHAR(500) NOT NULL,
          entity_type VARCHAR(100) NOT NULL,
          description TEXT,
          properties JSONB DEFAULT '{}'::jsonb NOT NULL,
          merged_from UUID[] DEFAULT '{}',
          confidence REAL DEFAULT 1.0 NOT NULL,
          first_seen_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
          last_seen_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
        )
      `;
    }

    // Create entity_aliases table
    await testSql`
      CREATE TABLE IF NOT EXISTS entity_aliases (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        alias VARCHAR(500) NOT NULL,
        alias_type VARCHAR(50),
        source VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    // Create entity_merges table
    await testSql`
      CREATE TABLE IF NOT EXISTS entity_merges (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        source_entity_id UUID NOT NULL,
        target_entity_id UUID NOT NULL REFERENCES entities(id),
        merge_reason TEXT,
        merge_method VARCHAR(50),
        similarity_score REAL,
        merged_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        merged_by VARCHAR(100) DEFAULT 'system'
      )
    `;

    // Create memory_entities table
    await testSql`
      CREATE TABLE IF NOT EXISTS memory_entities (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        memory_id UUID NOT NULL,
        entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        mention_text VARCHAR(500),
        relationship VARCHAR(100) DEFAULT 'mentions',
        mention_start INTEGER,
        mention_end INTEGER,
        mention_context TEXT,
        confidence REAL DEFAULT 1.0,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    // Create fact_predicates table with Phase 4 columns
    await testSql`
      CREATE TABLE IF NOT EXISTS fact_predicates (
        predicate VARCHAR(255) PRIMARY KEY,
        description TEXT,
        inverse_predicate VARCHAR(255),
        predicate_type VARCHAR(50),
        is_exclusive BOOLEAN DEFAULT FALSE,
        category VARCHAR(50),
        aliases TEXT[] DEFAULT '{}',
        is_canonical BOOLEAN DEFAULT true,
        usage_count INTEGER DEFAULT 0,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    // Add Phase 4 columns if they don't exist (for existing tables)
    await testSql`ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS category VARCHAR(50)`;
    await testSql`ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT '{}'`;
    await testSql`ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS is_canonical BOOLEAN DEFAULT true`;
    await testSql`ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS usage_count INTEGER DEFAULT 0`;
    await testSql`ALTER TABLE fact_predicates ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`;

    // Create facts table (with or without vector column depending on extension availability)
    if (extensionAvailability.vector) {
      await testSql`
        CREATE TABLE IF NOT EXISTS facts (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          subject_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          predicate VARCHAR(255) NOT NULL,
          object_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
          object_value TEXT,
          valid_at TIMESTAMPTZ,
          invalid_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
          expired_at TIMESTAMPTZ,
          source_memory_id UUID,
          source_text TEXT,
          extraction_method VARCHAR(100),
          confidence REAL DEFAULT 1.0,
          fact_embedding vector(768)
        )
      `;
    } else {
      await testSql`
        CREATE TABLE IF NOT EXISTS facts (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          subject_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          predicate VARCHAR(255) NOT NULL,
          object_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
          object_value TEXT,
          valid_at TIMESTAMPTZ,
          invalid_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
          expired_at TIMESTAMPTZ,
          source_memory_id UUID,
          source_text TEXT,
          extraction_method VARCHAR(100),
          confidence REAL DEFAULT 1.0
        )
      `;
    }

    // Create tasks table
    await testSql`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        trace_id UUID,
        content TEXT NOT NULL,
        due_date TIMESTAMPTZ,
        priority VARCHAR(10) DEFAULT 'medium' NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' NOT NULL,
        epic_id UUID,
        context_id UUID,
        memory_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    // Create epics table
    await testSql`
      CREATE TABLE IF NOT EXISTS epics (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'active' NOT NULL,
        last_activity_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    // Create gardener_job_meta table
    await testSql`
      CREATE TABLE IF NOT EXISTS gardener_job_meta (
        job_id UUID PRIMARY KEY,
        job_type VARCHAR(100),
        tier VARCHAR(20),
        priority INTEGER DEFAULT 0,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        duration_ms INTEGER,
        attempts INTEGER DEFAULT 0,
        checkpoint JSONB,
        checkpoint_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    // Create memory_chunks table for chunked content processing
    await testSql`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        memory_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        token_estimate INTEGER,
        overlap_chars INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        UNIQUE(memory_id, chunk_index)
      )
    `;

    // Create indexes for memory_chunks
    await testSql`CREATE INDEX IF NOT EXISTS idx_memory_chunks_memory ON memory_chunks(memory_id)`;
    await testSql`CREATE INDEX IF NOT EXISTS idx_memory_chunks_unprocessed ON memory_chunks(memory_id) WHERE processed_at IS NULL`;

    // Create mab_state table for multi-armed bandit
    await testSql`
      CREATE TABLE IF NOT EXISTS mab_state (
        arm VARCHAR(100) PRIMARY KEY,
        pulls INTEGER DEFAULT 0,
        total_reward REAL DEFAULT 0,
        avg_reward REAL DEFAULT 0,
        ucb_score REAL DEFAULT 1.0,
        last_pulled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    // Drop old gardener_metrics table if it has wrong schema, then recreate
    // This is needed because migration 006 creates a different schema than 007
    try {
      // Check if the table has the old schema (job_type column means old schema)
      const oldSchemaCheck = await testSql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'gardener_metrics' AND column_name = 'job_type'
      `;
      if (oldSchemaCheck.length > 0) {
        await testSql`DROP TABLE IF EXISTS gardener_metrics CASCADE`;
      }
    } catch {
      // Table doesn't exist, that's fine
    }

    // Create gardener_metrics table for evaluator agent (W29)
    await testSql`
      CREATE TABLE IF NOT EXISTS gardener_metrics (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        job_id UUID,
        agent_name VARCHAR(100) NOT NULL,
        execution_time_ms INTEGER,
        success BOOLEAN,
        quality_score REAL,
        items_processed INTEGER DEFAULT 0,
        error_message TEXT,
        agent_specific_metrics JSONB DEFAULT '{}',
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    // Create index for gardener_metrics
    await testSql`CREATE INDEX IF NOT EXISTS idx_gardener_metrics_agent ON gardener_metrics(agent_name)`;
    await testSql`CREATE INDEX IF NOT EXISTS idx_gardener_metrics_time ON gardener_metrics(recorded_at)`;

    // Create gardener_agent_stats view
    await testSql`
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
      GROUP BY agent_name
    `;

    // Create context_summaries table for conversation tracking
    await testSql`
      CREATE TABLE IF NOT EXISTS context_summaries (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
      )
    `;

    // Create context_uuid_audit table for deterministic UUID tracking
    await testSql`
      CREATE TABLE IF NOT EXISTS context_uuid_audit (
        context_uuid UUID PRIMARY KEY,
        platform VARCHAR(50) NOT NULL,
        conversation_id VARCHAR(255) NOT NULL,
        first_seen_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    // Create indexes (pg_trgm indexes are conditional on extension availability)
    if (extensionAvailability.pg_trgm) {
      await testSql`CREATE INDEX IF NOT EXISTS idx_entities_canonical_name ON entities USING gin (canonical_name gin_trgm_ops)`;
      await testSql`CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases USING gin (alias gin_trgm_ops)`;
    } else {
      // Fallback to btree indexes for basic text search
      await testSql`CREATE INDEX IF NOT EXISTS idx_entities_canonical_name ON entities(canonical_name)`;
      await testSql`CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases(alias)`;
    }
    await testSql`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type)`;
    await testSql`CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity_id ON entity_aliases(entity_id)`;
    await testSql`CREATE INDEX IF NOT EXISTS idx_memory_entities_memory_id ON memory_entities(memory_id)`;
    await testSql`CREATE INDEX IF NOT EXISTS idx_memory_entities_entity_id ON memory_entities(entity_id)`;
    await testSql`CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject_entity_id)`;
    await testSql`CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object_entity_id)`;
    await testSql`CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate)`;
    await testSql`CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(expired_at) WHERE expired_at IS NULL`;

    // Create bi-temporal query function
    await testSql`
      CREATE OR REPLACE FUNCTION facts_at_time(query_time TIMESTAMPTZ)
      RETURNS SETOF facts AS $$
        SELECT * FROM facts
        WHERE created_at <= query_time
          AND (expired_at IS NULL OR expired_at > query_time)
          AND (valid_at IS NULL OR valid_at <= query_time)
          AND (invalid_at IS NULL OR invalid_at > query_time)
      $$ LANGUAGE sql STABLE
    `;

    // Create MAB update function
    await testSql`
      CREATE OR REPLACE FUNCTION update_mab_reward(arm_name VARCHAR, reward REAL)
      RETURNS void AS $$
      BEGIN
        INSERT INTO mab_state (arm, pulls, total_reward, avg_reward, ucb_score, last_pulled_at, updated_at)
        VALUES (arm_name, 1, reward, reward, 1.0, NOW(), NOW())
        ON CONFLICT (arm) DO UPDATE SET
          pulls = mab_state.pulls + 1,
          total_reward = mab_state.total_reward + reward,
          avg_reward = (mab_state.total_reward + reward) / (mab_state.pulls + 1),
          ucb_score = (mab_state.total_reward + reward) / (mab_state.pulls + 1) +
                      sqrt(2 * ln(GREATEST((SELECT SUM(pulls) FROM mab_state), 1)) / (mab_state.pulls + 1)),
          last_pulled_at = NOW(),
          updated_at = NOW();
      END;
      $$ LANGUAGE plpgsql
    `;

    // Insert default predicates
    await testSql`
      INSERT INTO fact_predicates (predicate, description, is_exclusive)
      VALUES
        ('works_at', 'Employment relationship', true),
        ('works_on', 'Project assignment', false),
        ('located_in', 'Physical location', false),
        ('has_role', 'Role or title', true),
        ('knows', 'Personal relationship', false),
        ('manages', 'Management relationship', false),
        ('part_of', 'Component relationship', false),
        ('uses', 'Technology or tool usage', false)
      ON CONFLICT (predicate) DO NOTHING
    `;

    console.log('✅ Test database schema created');
  } catch (error) {
    console.error('❌ Failed to set up test schema:', error);
    throw error;
  } finally {
    await testSql.end();
  }

  console.log('\n🎉 Test environment ready!\n');
}

export async function teardown() {
  console.log('\n🧹 Cleaning up test environment...\n');

  // Optionally drop the test database after all tests
  // For now, we keep it for debugging failed tests

  console.log('✅ Test cleanup complete\n');
}
