/**
 * Global Test Setup
 *
 * Runs once before all tests to initialize the test database.
 *
 * Strategy:
 *   1. Create cognitive_test database if not exists
 *   2. Enable PostgreSQL extensions (track availability for test gating)
 *   3. Run migration SQL files from db/migrations/ in order
 *
 * All table definitions come from migration files — zero hand-written
 * CREATE TABLE in this file. Migration files are the single source of truth
 * (derived from schema.ts via db:generate, or hand-written for functions/seeds).
 *
 * Extension handling: pgvector and pg_trgm are optional. When unavailable,
 * migration content is preprocessed to strip extension-dependent SQL
 * (vector columns, hnsw indexes, trgm indexes). Tests use extension
 * availability flags to skip appropriately.
 */

// CRITICAL: Set environment variables BEFORE any imports
// This ensures all modules (including config.ts) use the test database
process.env.DATABASE_URL = 'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test';
process.env.NODE_ENV = 'test';
process.env.ML_SERVICES_URL = process.env.ML_SERVICES_URL || 'http://127.0.0.1:8000';

import postgres from 'postgres';
import { writeFileSync, readdirSync, readFileSync } from 'fs';
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

  // ── 1. Create test database ────────────────────────────────────
  const adminSql = postgres({
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '5433'),
    database: 'cognitive',
    username: process.env.PGUSER || 'cognitive',
    password: process.env.PGPASSWORD || 'cognitive',
  });

  try {
    const result = await adminSql`
      SELECT 1 FROM pg_database WHERE datname = ${TEST_DB_NAME}
    `;
    if (result.length === 0) {
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

  // ── 2. Enable extensions ───────────────────────────────────────
  const testSql = postgres({
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '5433'),
    database: TEST_DB_NAME,
    username: process.env.PGUSER || 'cognitive',
    password: process.env.PGPASSWORD || 'cognitive',
  });

  try {
    for (const ext of [
      { name: 'uuid-ossp', key: 'uuid_ossp' as const },
      { name: 'vector', key: 'vector' as const },
      { name: 'pg_trgm', key: 'pg_trgm' as const },
    ]) {
      try {
        await testSql.unsafe(`CREATE EXTENSION IF NOT EXISTS "${ext.name}"`);
        extensionAvailability[ext.key] = true;
        console.log(`✅ Extension "${ext.name}" enabled`);
      } catch {
        extensionAvailability[ext.key] = false;
        console.warn(`⚠️  Extension "${ext.name}" not available - tests requiring it will be skipped`);
      }
    }

    // btree_gist used by facts temporal constraints (migration 004)
    try {
      await testSql.unsafe(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    } catch {
      console.warn('⚠️  Extension btree_gist not available');
    }

    // Write extension availability for test files to read
    const availabilityPath = join(__dirname, '.extension-availability.json');
    writeFileSync(availabilityPath, JSON.stringify(extensionAvailability, null, 2));
    console.log(`📝 Extension availability written to ${availabilityPath}`);

    // ── 3. Run migration files ─────────────────────────────────
    await runMigrations(testSql, extensionAvailability);

    console.log('✅ Test database schema ready');
  } catch (error) {
    console.error('❌ Failed to set up test schema:', error);
    throw error;
  } finally {
    await testSql.end();
  }

  console.log('\n🎉 Test environment ready!\n');
}

// ============================================
// Migration runner
// ============================================

/**
 * Preprocess a migration file to handle optional extensions and idempotency.
 *
 * - Strips CREATE EXTENSION (already handled above)
 * - Strips vector columns / hnsw indexes when pgvector is unavailable
 * - Strips trgm indexes when pg_trgm is unavailable
 * - Ensures all CREATE INDEX are idempotent (IF NOT EXISTS)
 */
function preprocessMigration(content: string, ext: ExtensionAvailability): string {
  let processed = content;

  // Remove extension creation — handled in step 2
  processed = processed.replace(/CREATE EXTENSION IF NOT EXISTS[^;]+;\s*\n?/g, '');

  if (!ext.vector) {
    // Strip vector column definitions
    processed = processed.replace(/,?\s*\n\s*embedding\s+VECTOR\(\d+\)/gi, '');
    processed = processed.replace(/,?\s*\n\s*fact_embedding\s+VECTOR\(\d+\)/gi, '');
    // Strip hnsw indexes on vector columns
    processed = processed.replace(/CREATE INDEX[^;]*hnsw[^;]*vector_cosine_ops[^;]*;\s*\n?/gi, '');
  }

  if (!ext.pg_trgm) {
    // Strip trgm indexes
    processed = processed.replace(/CREATE INDEX[^;]*gin_trgm_ops[^;]*;\s*\n?/gi, '');
  }

  // Make all CREATE INDEX idempotent
  processed = processed.replace(/CREATE INDEX(?!\s+IF\s+NOT\s+EXISTS)/gi, 'CREATE INDEX IF NOT EXISTS');
  processed = processed.replace(/CREATE UNIQUE INDEX(?!\s+IF\s+NOT\s+EXISTS)/gi, 'CREATE UNIQUE INDEX IF NOT EXISTS');

  return processed;
}

/**
 * Run migration SQL files from db/migrations/ in order.
 *
 * All tables, functions, triggers, views, and seed data come from these files.
 * Extension-dependent content is preprocessed to handle missing pgvector/pg_trgm.
 */
async function runMigrations(sql: postgres.Sql, ext: ExtensionAvailability) {
  const migrationsDir = join(__dirname, '../db/migrations');
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`📂 Running ${files.length} migration files...`);

  for (const file of files) {
    // Skip Apache AGE — optional extension, references wrong DB name
    // (cognitive vs cognitive_test), and AGE-dependent tests gate themselves.
    if (file.includes('apache_age')) {
      console.log(`⏭️  Skipped ${file} (Apache AGE — optional, test-gated)`);
      continue;
    }

    // Migration 007 creates an old version of contradiction_reviews (Phase 4).
    // Migration 013 supersedes it with the Phase 5 schema (different columns).
    // Since both use CREATE TABLE IF NOT EXISTS, we must drop the old version
    // before 013 runs so the new schema takes effect.
    if (file.includes('013_contradiction_reviews')) {
      await sql.unsafe('DROP TABLE IF EXISTS contradiction_reviews CASCADE');
    }

    const raw = readFileSync(join(migrationsDir, file), 'utf-8');
    const content = preprocessMigration(raw, ext);

    try {
      await sql.unsafe(content);
      console.log(`✅ ${file}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);

      const isExtensionError =
        msg.includes('type "vector" does not exist') ||
        msg.includes('operator class "vector_cosine_ops"') ||
        msg.includes('operator class "gin_trgm_ops"') ||
        msg.includes('function similarity');

      if (isExtensionError) {
        console.warn(`⚠️  ${file} — partial (missing extension): ${msg.slice(0, 80)}`);
      } else {
        console.error(`❌ ${file}: ${msg.slice(0, 120)}`);
      }
    }
  }
}

export async function teardown() {
  console.log('\n🧹 Cleaning up test environment...\n');
  // Keep test database for debugging failed tests
  console.log('✅ Test cleanup complete\n');
}
