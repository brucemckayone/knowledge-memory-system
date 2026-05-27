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

const POSTGRES_OPTIONS = {
  connection: {
    search_path: 'public, ag_catalog, "$user"',
  },
} as const;

/**
 * Live postgres handle. Mutated by `closeTestDbPool` / `openTestDbPool` so
 * `ensureSnapshot` can drop and restore the cognitive_test database without
 * leaving stale connections behind. The exported `testDb` is a Proxy over
 * this handle so existing `import { testDb }` consumers stay backward-compatible
 * (ES module bindings are not live; mutating an export's value would not
 * propagate to importers, but a Proxy that forwards to the live handle does).
 */
let _testDbHandle: ReturnType<typeof postgres> = postgres(TEST_DB_URL, POSTGRES_OPTIONS);

/**
 * `testDb` proxies to the live `_testDbHandle`. Tagged-template usage
 * (`testDb\`SELECT 1\``) hits the apply trap; method usage (`testDb.unsafe`,
 * `testDb.begin`, `testDb.end`) hits the get trap. Both forward to whichever
 * handle is currently open.
 */
export const testDb: ReturnType<typeof postgres> = new Proxy(function () {} as unknown as ReturnType<typeof postgres>, {
  apply(_target, _thisArg, args: unknown[]) {
    return (_testDbHandle as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, prop, _receiver) {
    const value = (_testDbHandle as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === 'function') {
      return (value as (...a: unknown[]) => unknown).bind(_testDbHandle);
    }
    return value;
  },
}) as ReturnType<typeof postgres>;

/**
 * Close the live test-DB pool. Required before pg_restore --clean --if-exists
 * runs against cognitive_test, since active connections block the DROP.
 *
 * Safe to call when the pool is already closed (no-op).
 */
export async function closeTestDbPool(): Promise<void> {
  try {
    await _testDbHandle.end({ timeout: 5 });
  } catch {
    // Already closed or never opened — fine.
  }
}

/**
 * Reopen the live test-DB pool against `cognitive_test`. Pairs with
 * `closeTestDbPool`. Idempotent in the sense that the previous handle is
 * abandoned (closed first by the caller) and a fresh one takes its place.
 */
export async function openTestDbPool(): Promise<void> {
  _testDbHandle = postgres(TEST_DB_URL, POSTGRES_OPTIONS);
  // Verify the handle works against the freshly-restored DB.
  await _testDbHandle`SELECT 1`;
}

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

// ============================================================================
// mockMlServices — bead nmemo-2yv.86
// ============================================================================

/**
 * The ml-services routes the platform's compute endpoints proxy to. Keep
 * this union exhaustive: route-handler integration tests rely on it to
 * configure per-route mock responses, and a missing route falls through
 * to the unknown-route 404 branch (which usually surfaces as an unrelated
 * 502 in the route under test — annoying to debug).
 *
 * As of bead .86 the proxied routes are:
 *   - POST /topology/compute        (proxied by POST /api/topology/compute)
 *   - POST /clustering/compute      (proxied by POST /api/clustering/compute)
 *   - POST /drift/compute           (proxied by POST /api/drift/compute)
 *   - POST /reconciliation-agent/drift  (called by the bead .83 fire-and-forget
 *                                          helper from inside the drift/compute
 *                                          success path)
 *   - GET  /health                  (called by /health composition — bead .111)
 *
 * If a new ml-services route lands and a platform handler proxies to it,
 * add it here and document the platform call site in the JSDoc above.
 */
export type MockMlRoute =
  | '/topology/compute'
  | '/clustering/compute'
  | '/drift/compute'
  | '/reconciliation-agent/drift'
  | '/reasoning-agent'
  | '/health';

/**
 * The kinds of mocked responses each route can return. Each route can be
 * configured independently per test:
 *
 *   - `{ kind: 'ok', body? }`              — 200 with optional JSON body
 *   - `{ kind: 'error', status, body? }`   — non-2xx with optional body
 *   - `{ kind: 'timeout' }`                — never-resolving promise
 *                                            (use AbortSignal.timeout on the
 *                                            caller to validate timeout paths)
 *   - `{ kind: 'queue-full' }`             — 503 + { error: 'queue_full' }
 *                                            (matches the ml-services
 *                                            QueueFullError wire shape so
 *                                            platform-side detection paths
 *                                            see the canonical body)
 *   - `{ kind: 'throw', message }`         — fetch itself rejects (network
 *                                            blip / DNS / TLS error class)
 */
export type MockMlRouteResponse =
  | { kind: 'ok'; body?: unknown }
  | { kind: 'error'; status: number; body?: unknown }
  | { kind: 'timeout' }
  | { kind: 'queue-full' }
  | { kind: 'throw'; message?: string };

export interface MockMlServicesConfig {
  /**
   * Per-route response. Routes omitted from the config return the default
   * `{ kind: 'ok', body: { ok: true } }`. Use this map to vary one route
   * (e.g. /drift/compute returns ok, /reconciliation-agent/drift returns
   * 503) inside a single test.
   */
  responses?: Partial<Record<MockMlRoute, MockMlRouteResponse>>;
  /**
   * If true (default), unknown / unmocked URLs return a 404 with an
   * `{ error: 'unmocked endpoint: <url>' }` body so the test sees the
   * miss as a structured response rather than a fetch error. Set to
   * `'passthrough'` if a test needs unmocked URLs to hit real fetch
   * (rarely useful — almost always indicates the route catalogue above
   * needs a new entry).
   */
  unmocked?: '404' | 'passthrough';
}
export interface MockMlServicesHandle {
  /** Every URL fetch() was invoked with, in call order. Useful for assertions
   *  like "the platform fired both /topology/compute AND
   *  /reconciliation-agent/drift in the same request." */
  calls: Array<{ url: string; method: string; body?: unknown }>;
  /** Restore the original global fetch and clear call records. */
  restore: () => void;
  /** Mutate a single route's response mid-test (e.g. first call succeeds,
   *  second call returns 503). Per-route config replaces the previous one. */
  setRoute: (route: MockMlRoute, response: MockMlRouteResponse) => void;
}

/**
 * Install a global-fetch interceptor that knows the ml-services route
 * catalogue. Returns a handle for inspection + per-route reconfiguration.
 *
 * Usage pattern (bead nmemo-2yv.86):
 * ```ts
 * import { describe, it, expect, afterEach } from 'vitest';
 * import { app } from '../../index.js';
 * import { mockMlServices, type MockMlServicesHandle } from '../setup.js';
 *
 * let ml: MockMlServicesHandle;
 * afterEach(() => ml?.restore());
 *
 * it('POST /api/topology/compute 502s when ml-services is down', async () => {
 *   ml = mockMlServices({
 *     responses: { '/topology/compute': { kind: 'throw', message: 'ECONNREFUSED' } },
 *   });
 *   const res = await app.request('/api/topology/compute', { method: 'POST' });
 *   expect(res.status).toBe(502);
 * });
 * ```
 *
 * Reusable by bead `.20` (pipeline.ts integration), `.68` (gardener), `.79`
 * (reasoning-agent) when those add their own integration tests — they only
 * need to extend `MockMlRoute` with their proxied endpoints and reuse the
 * fetch interceptor.
 */
export function mockMlServices(initial: MockMlServicesConfig = {}): MockMlServicesHandle {
  const calls: MockMlServicesHandle['calls'] = [];
  const routes = new Map<MockMlRoute, MockMlRouteResponse>();
  if (initial.responses) {
    for (const [route, resp] of Object.entries(initial.responses)) {
      if (resp !== undefined) routes.set(route as MockMlRoute, resp);
    }
  }
  const unmocked = initial.unmocked ?? '404';

  function findRoute(url: string): MockMlRoute | undefined {
    // Longest-match wins so /reconciliation-agent/drift doesn't accidentally
    // match a hypothetical future /drift route.
    const routeList: MockMlRoute[] = [
      '/reconciliation-agent/drift',
      '/topology/compute',
      '/clustering/compute',
      '/drift/compute',
      '/reasoning-agent',
      '/health',
    ];
    for (const r of routeList) {
      if (url.includes(r)) return r;
    }
    return undefined;
  }

  function makeResponse(status: number, body: unknown): Response {
    const jsonStr = JSON.stringify(body);
    return new Response(jsonStr, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const realFetch = globalThis.fetch;
  const interceptor: typeof fetch = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body: unknown;
    try {
      const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      if (typeof rawBody === 'string' && rawBody.length > 0) {
        body = JSON.parse(rawBody);
      }
    } catch {
      // Non-JSON body — leave undefined; tests asserting body shape will see
      // the absence and notice. We don't reject the fetch itself.
    }
    calls.push({ url, method, body });

    const route = findRoute(url);
    if (!route) {
      if (unmocked === 'passthrough') return realFetch(input, init);
      return makeResponse(404, { error: `unmocked endpoint: ${url}` });
    }

    const resp = routes.get(route) ?? { kind: 'ok', body: { ok: true } };
    switch (resp.kind) {
      case 'ok':
        return makeResponse(200, resp.body ?? { ok: true });
      case 'error':
        return makeResponse(resp.status, resp.body ?? { error: `mock error ${resp.status}` });
      case 'queue-full':
        return makeResponse(503, { error: 'queue_full', detail: 'mock queue saturated' });
      case 'throw': {
        const err = new TypeError(resp.message ?? 'mock fetch failure');
        throw err;
      }
      case 'timeout':
        // Never resolve — let the caller's AbortSignal or test timeout kick in.
        // Returning a promise that respects the init.signal abort is friendlier:
        // the caller can pass AbortSignal.timeout(N) and observe an AbortError.
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
            else signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          }
          // else: hang forever — test must use vi.useFakeTimers or its own
          // timeout to bail.
        });
    }
  };

  globalThis.fetch = interceptor;

  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
      calls.length = 0;
    },
    setRoute: (route, response) => {
      routes.set(route, response);
    },
  };
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
    // reasoning_reports lives in canonical order as of bead nmemo-2yv.78 — its
    // FK referrers (fact_history.reasoning_report_id,
    // causal_edge_history.reasoning_report_id,
    // contradictions.resolution_report_id) are now ON DELETE SET NULL, so
    // wiping reasoning_reports either before or after the referrers is FK-safe.
    // Placed after the audit tables so semantically-dependent rows clear first.
    'reasoning_reports',
    'memory_chunks',
    'memory_entities',
    'entity_aliases',
    'entity_merges',
    'contradiction_reviews',
    'contradictions',
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

/**
 * Load a SQL fixture file from src/test/data/ and execute it.
 *
 * The fixture is run as raw SQL via `testDb.unsafe`, so it's responsible for
 * its own transaction boundaries (typical fixtures wrap themselves in
 * BEGIN/COMMIT). Returns the wall-clock duration in milliseconds so callers
 * that record benchmarks can pick it up directly.
 */
export async function loadFixture(relativePath: string): Promise<{ durationMs: number }> {
  const fixturePath = join(__dirname, 'data', relativePath);
  if (!existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${relativePath} (resolved to ${fixturePath})`);
  }
  // postgres.js refuses raw BEGIN/COMMIT in `unsafe()` (UNSAFE_TRANSACTION).
  // Strip the outer transaction markers — fixtures keep them for psql/docker
  // exec compatibility — and run inside sql.begin() instead.
  const raw = readFileSync(fixturePath, 'utf-8');
  const stripped = raw
    .replace(/^\s*BEGIN\s*;\s*$/gmi, '')
    .replace(/^\s*COMMIT\s*;\s*$/gmi, '');
  const start = performance.now();
  await testDb.begin(async (tx) => {
    await tx.unsafe(stripped);
  });
  return { durationMs: performance.now() - start };
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

// ============================================
// Snapshot restoration helpers (doc 28 §3.6)
// ============================================
//
// Imported lazily via dynamic import so the regular vitest suite (which
// excludes *.snapshot.test.ts) does not pull in the snapshot scripts on
// every test-file evaluation. The helpers themselves stay synchronous-style
// from the caller's perspective.

/**
 * A bridge-pair record from a synthetic snapshot's `ground_truth.json`.
 * Mirrors the structure produced by `scripts/generate-synthetic.ts`.
 */
export interface BridgePair {
  a: string;
  b: string;
  reason: string;
}

/**
 * Doc 28 §3.6 helper. Closes the live test-DB pool (so `pg_restore --clean
 * --if-exists` can drop `cognitive_test`), invokes `snapshot:ensure` to
 * regenerate the cached snapshot file if missing or hash-mismatched, then
 * loads that snapshot into `cognitive_test` and reopens the pool against
 * the freshly-restored DB.
 *
 * After this resolves, `testDb` queries see exactly the snapshot's state.
 *
 * Must be called from within `vitest.snapshot.config.ts` (single-fork,
 * file-parallelism off) — the default suite excludes `*.snapshot.test.ts`
 * to avoid pool-conflicts during pg_restore.
 */
export async function ensureSnapshot(name: string): Promise<void> {
  // 1. Close the existing connection pool (so pg_restore can drop the DB).
  await closeTestDbPool();
  // 2. Invoke snapshot-ensure.ts (regenerates if missing or hash mismatch).
  //    This populates the cached dump file under platform/test-snapshots/<name>/
  //    but does not yet touch cognitive_test.
  const ensureMod = await import('../../scripts/snapshot-ensure.js');
  await ensureMod.ensureSnapshot(name);
  // 3. Restore the cached snapshot into cognitive_test. The doc 28 §3.6
  //    contract is that ensureSnapshot leaves the DB in the snapshot's state,
  //    so the caller can immediately query it via testDb.
  const loadMod = await import('../../scripts/load-snapshot.js');
  await loadMod.loadSnapshot(name);
  // 4. Reopen the pool against the freshly-restored DB.
  await openTestDbPool();
}

/**
 * Doc 28 §3.6 helper. Reads the side-channel `ground_truth.json` for a
 * synthetic snapshot and returns the labelled bridge-pair list. Errors
 * clearly when the file is missing (per §6 edge cases — instructing the
 * caller to run `pnpm snapshot:ensure --force <name>`).
 *
 * Synchronous file IO behind an async signature so the helper can grow
 * additional checks (e.g. hash verification) without changing callers.
 */
export async function loadGroundTruth(name: string): Promise<BridgePair[]> {
  // Dynamic import keeps the regular suite from pulling the manifest module
  // on unrelated test-file evaluations.
  const manifestMod = await import('../../scripts/lib/manifest.js');
  const entry = manifestMod.findEntry(manifestMod.loadManifest(), name);
  const groundTruthAbs = manifestMod.entryFileAbsPath(entry, 'ground_truth');
  if (!groundTruthAbs) {
    throw new Error(
      `loadGroundTruth: snapshot "${name}" has no files.ground_truth in the manifest. ` +
      `Only synthetic snapshots ship a ground_truth.json. Synthetic-only contract per doc 28 §3.3.`
    );
  }
  if (!existsSync(groundTruthAbs)) {
    throw new Error(
      `loadGroundTruth: ground_truth.json missing for "${name}" at ${groundTruthAbs}. ` +
      `Run \`pnpm snapshot:ensure --force ${name}\` to regenerate.`
    );
  }
  const raw = readFileSync(groundTruthAbs, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`loadGroundTruth: ground_truth.json for "${name}" is not valid JSON: ${detail}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`loadGroundTruth: ground_truth.json for "${name}" is not an object`);
  }
  const bridgePairs = (parsed as Record<string, unknown>).bridge_pairs;
  if (!Array.isArray(bridgePairs)) {
    throw new Error(`loadGroundTruth: ground_truth.json for "${name}" missing bridge_pairs array`);
  }
  return bridgePairs as BridgePair[];
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
  await closeTestDbPool();
});

// Per-test hooks can be added in individual test files
