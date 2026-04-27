/**
 * Test Setup
 *
 * Per-test file setup providing utilities, database connections,
 * and cleanup functions.
 *
 * Exports extension availability flags so tests can skip appropriately
 * when optional dependencies (pgvector, pg_trgm) are not installed.
 */

// IMPORTANT: Set environment variables BEFORE any imports that might use them
// This ensures the db module from services uses the test database
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test';
process.env.ML_SERVICES_URL = process.env.ML_SERVICES_URL || 'http://127.0.0.1:8000';
process.env.QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6335';
// Provide test defaults for required config values
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-bot-token-for-testing';

import { beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Extension availability (loaded from global-setup output)
export interface ExtensionAvailability {
  vector: boolean;
  pg_trgm: boolean;
  uuid_ossp: boolean;
}

function loadExtensionAvailability(): ExtensionAvailability {
  const availabilityPath = join(__dirname, '.extension-availability.json');
  if (existsSync(availabilityPath)) {
    try {
      return JSON.parse(readFileSync(availabilityPath, 'utf-8'));
    } catch {
      console.warn('⚠️  Could not parse extension availability file');
    }
  }
  // Default: assume all extensions are available (for backwards compat)
  return { vector: true, pg_trgm: true, uuid_ossp: true };
}

export const extensions = loadExtensionAvailability();

// Convenience flags for test skipping
export const hasVectorExtension = extensions.vector;
export const hasTrgmExtension = extensions.pg_trgm;

// Test database connection
const TEST_DB_URL = process.env.TEST_DATABASE_URL ||
  `postgres://${process.env.PGUSER || 'cognitive'}:${process.env.PGPASSWORD || 'cognitive'}@${process.env.PGHOST || '127.0.0.1'}:${process.env.PGPORT || '5433'}/cognitive_test`;

export const testDb = postgres(TEST_DB_URL, {
  connection: {
    search_path: 'public, ag_catalog, "$user"',
  },
});

// ML Services URL
export const ML_SERVICES_URL = process.env.ML_SERVICES_URL || 'http://127.0.0.1:8000';

// Qdrant URL
export const QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6335';

/**
 * Check if ML services are available
 */
export async function isMLServiceAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${ML_SERVICES_URL}/health`, {
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Skip a suite or test from a beforeAll/it context.
 *
 * vitest 4.x removed ctx.skip() from beforeAll contexts (it only exists on
 * individual test contexts). This helper works in both:
 *   - beforeAll context: marks all child tasks as skipped via task.mode
 *   - it context: delegates to the native ctx.skip()
 */
export function skipCtx(ctx: any): void {
  if (typeof ctx.skip === 'function') {
    // Native test context (it/test) — use built-in skip
    ctx.skip();
  } else {
    // Suite hook context (beforeAll) — mark all children as skipped
    function markSkip(tasks: any[] = []) {
      for (const t of tasks) {
        t.mode = 'skip';
        if (t.tasks) markSkip(t.tasks);
      }
    }
    if (ctx?.task?.tasks) markSkip(ctx.task.tasks);
    if (ctx?.task) ctx.task.mode = 'skip';
  }
}

/**
 * Check if Qdrant is available
 */
export async function isQdrantAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${QDRANT_URL}/collections`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Options for the global-cleanup helpers below. The `acknowledgeGlobal: true`
 * flag is required by design — these functions delete EVERY row in the named
 * tables, not just rows owned by the current test, and they will race any
 * other test running in parallel against the same DB. Callers must opt in at
 * the call site so a drive-by reader of the test sees the global blast radius.
 *
 * See `nmemo-0dx.2` and `docs/handoff/test-debt-cleanup.md`.
 */
export interface GlobalCleanupOptions {
  /** Tables to nuke. Empty array or omitted → every table in the ordered list. */
  tables?: string[];
  /**
   * Required. Acknowledges that this deletes EVERY row in the named tables,
   * including rows owned by tests running in parallel workers. Future scoped
   * cleanup helpers (per-tag, per-worker) won't need this flag.
   */
  acknowledgeGlobal: true;
}

/**
 * Truncate all test tables
 * WARNING: Uses exclusive locks - avoid in parallel tests
 * @deprecated Use deleteFromTables({acknowledgeGlobal:true}) for parallel-safe cleanup
 */
export async function truncateAllTables(): Promise<void> {
  await testDb`TRUNCATE TABLE
    memory_entities,
    entity_aliases,
    entity_merges,
    facts,
    entities,
    tasks,
    task_dependencies,
    task_conflicts,
    user_preferences,
    epics,
    gardener_job_meta
    CASCADE`;
}

/**
 * Truncate specific tables across the WHOLE database.
 * WARNING: Uses exclusive locks - avoid in parallel tests.
 * @deprecated Prefer deleteFromTables({acknowledgeGlobal:true}) — DELETE doesn't
 *   take table-level locks and is friendlier to other parallel workers.
 */
export async function truncateTables(opts: GlobalCleanupOptions): Promise<void> {
  const tables = opts.tables ?? [];
  for (const table of tables) {
    await testDb.unsafe(`TRUNCATE TABLE ${table} CASCADE`);
  }
}

/**
 * Delete every row from the named tables (or every table in the ordered list
 * when `tables` is omitted), in FK-respecting order. Parallel-safe vs TRUNCATE
 * (no exclusive locks) but NOT scoped to the current test — wipes rows owned
 * by other workers too. The `acknowledgeGlobal` flag exists to make that blast
 * radius visible at every call site.
 */
export async function deleteFromTables(opts: GlobalCleanupOptions): Promise<void> {
  const tables = opts.tables ?? [];
  // Delete in reverse dependency order to avoid FK violations
  const orderedTables = [
    // Phase 1 audit tables — must go before facts / causal_edges because of FK
    'causal_edge_history',
    'fact_history',
    'memory_chunks',
    'memory_entities',
    'entity_aliases',
    'entity_merges',
    'contradiction_reviews',
    'causal_edges',
    'causal_events',
    'causal_patterns',
    'facts',
    'entities',
    'tasks',
    'task_dependencies',
    'task_conflicts',
    'user_preferences',
    'epics',
    'gardener_job_meta',
    'gardener_metrics',
    'fact_predicates',
    'context_uuid_audit',
    'context_summaries',
    'content_hashes',
    'ingest_sources',
    'communities',
    'channel_profiles',
    'insights',
    'obsidian_sync_state',
    'conversation_summaries',
    'conversation_state',
    'briefings',
    'memories_meta',
    'source_bindings',
    'association_ambiguities',
    'project_associations',
    'ingestion_session_members',
    'ingestion_sessions',
  ];

  const tablesToDelete = tables.length > 0
    ? orderedTables.filter((t) => tables.includes(t))
    : orderedTables;

  for (const table of tablesToDelete) {
    try {
      await testDb.unsafe(`DELETE FROM ${table}`);
    } catch {
      // Table might not exist or be empty - that's ok
    }
  }
}

/**
 * Generate a random UUID for testing
 */
export function randomUUID(): string {
  return crypto.randomUUID();
}

/** Default embedding dimensions — keep in sync with EMBED_DIMENSIONS in .env */
export const TEST_EMBED_DIMENSIONS = 768;

/**
 * Generate a random embedding vector matching the configured dimensions
 */
export function randomEmbedding(): number[] {
  return Array.from({ length: TEST_EMBED_DIMENSIONS }, () => Math.random() * 2 - 1);
}

/**
 * Normalize a vector to unit length
 */
export function normalizeVector(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map(v => v / magnitude);
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Vectors must be same length');
  const dotProduct = a.reduce((sum, ai, i) => sum + ai * (b[i] ?? 0), 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('Timeout waiting for condition');
}

/**
 * Create a test entity directly in the database
 */
export async function createTestEntity(data: {
  canonicalName: string;
  entityType: string;
  description?: string;
  properties?: Record<string, unknown>;
  embedding?: number[];
}): Promise<{ id: string }> {
  if (hasVectorExtension) {
    const embedding = data.embedding || randomEmbedding();
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await testDb`
      INSERT INTO entities (canonical_name, entity_type, description, properties, embedding)
      VALUES (
        ${data.canonicalName},
        ${data.entityType},
        ${data.description || null},
        ${JSON.stringify(data.properties || {})}::jsonb,
        ${embeddingStr}::vector
      )
      RETURNING id
    `;
    if (!result[0]) throw new Error('Failed to create entity');
    return { id: result[0].id };
  } else {
    // Insert without embedding when vector extension is not available
    const result = await testDb`
      INSERT INTO entities (canonical_name, entity_type, description, properties)
      VALUES (
        ${data.canonicalName},
        ${data.entityType},
        ${data.description || null},
        ${JSON.stringify(data.properties || {})}::jsonb
      )
      RETURNING id
    `;
    if (!result[0]) throw new Error('Failed to create entity');
    return { id: result[0].id };
  }
}

/**
 * Create a test fact directly in the database
 */
export async function createTestFact(data: {
  subjectEntityId: string;
  predicate: string;
  objectEntityId?: string;
  objectValue?: string;
  validAt?: Date;
  invalidAt?: Date;
  confidence?: number;
  createdAt?: Date;
  expiredAt?: Date;
}): Promise<{ id: string }> {
  if (data.createdAt || data.expiredAt) {
    // Use explicit created_at/expired_at (needed for temporal pipeline tests)
    const result = await testDb`
      INSERT INTO facts (
        subject_entity_id,
        predicate,
        object_entity_id,
        object_value,
        valid_at,
        invalid_at,
        confidence,
        created_at,
        expired_at
      )
      VALUES (
        ${data.subjectEntityId}::uuid,
        ${data.predicate},
        ${data.objectEntityId || null}::uuid,
        ${data.objectValue || null},
        ${data.validAt || null},
        ${data.invalidAt || null},
        ${data.confidence ?? 1.0},
        ${data.createdAt || new Date()},
        ${data.expiredAt || null}
      )
      RETURNING id
    `;
    if (!result[0]) throw new Error('Failed to create fact');
    return { id: result[0].id };
  }

  const result = await testDb`
    INSERT INTO facts (
      subject_entity_id,
      predicate,
      object_entity_id,
      object_value,
      valid_at,
      invalid_at,
      confidence
    )
    VALUES (
      ${data.subjectEntityId}::uuid,
      ${data.predicate},
      ${data.objectEntityId || null}::uuid,
      ${data.objectValue || null},
      ${data.validAt || null},
      ${data.invalidAt || null},
      ${data.confidence ?? 1.0}
    )
    RETURNING id
  `;
  if (!result[0]) throw new Error('Failed to create fact');
  return { id: result[0].id };
}

/**
 * Create a test memory entity link
 */
export async function createTestMemoryEntity(data: {
  memoryId: string;
  entityId: string;
  mentionText?: string;
  relationship?: string;
  confidence?: number;
}): Promise<{ id: string }> {
  const result = await testDb`
    INSERT INTO memory_entities (
      memory_id,
      entity_id,
      mention_text,
      relationship,
      confidence
    )
    VALUES (
      ${data.memoryId}::uuid,
      ${data.entityId}::uuid,
      ${data.mentionText || null},
      ${data.relationship || 'mentions'},
      ${data.confidence ?? 1.0}
    )
    RETURNING id
  `;
  if (!result[0]) throw new Error('Failed to create memory entity');
  return { id: result[0].id };
}

/**
 * Get entity by ID
 */
export async function getEntity(id: string): Promise<Record<string, unknown> | null> {
  const result = await testDb`
    SELECT * FROM entities WHERE id = ${id}::uuid
  `;
  return result[0] || null;
}

/**
 * Get fact by ID
 */
export async function getFact(id: string): Promise<Record<string, unknown> | null> {
  const result = await testDb`
    SELECT * FROM facts WHERE id = ${id}::uuid
  `;
  return result[0] || null;
}

/**
 * Get all active facts for an entity
 */
export async function getActiveFacts(entityId: string): Promise<Record<string, unknown>[]> {
  const result = await testDb`
    SELECT * FROM facts
    WHERE subject_entity_id = ${entityId}::uuid
      AND expired_at IS NULL
  `;
  return result;
}

/**
 * Mock fetch for testing ML services when unavailable
 */
export function mockMLService(responses: Record<string, unknown>) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    // Handle Request objects (used by generated API client)
    const urlStr = input instanceof Request ? input.url : input.toString();
    for (const [pattern, response] of Object.entries(responses)) {
      if (urlStr.includes(pattern)) {
        return {
          ok: true,
          json: async () => response,
        } as Response;
      }
    }
    return {
      ok: false,
      status: 404,
    } as Response;
  });
}

// Global hooks
beforeAll(async () => {
  // Verify database connection
  try {
    await testDb`SELECT 1`;
  } catch (error) {
    console.error('❌ Cannot connect to test database. Is PostgreSQL running?');
    throw error;
  }
});

afterAll(async () => {
  // Close database connection
  await testDb.end();
});

// Per-test hooks can be added in individual test files
