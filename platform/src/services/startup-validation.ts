/**
 * Startup-validation invariants (bead nmemo-2yv.132 — Review #14 C3).
 *
 * Every config value that spans code + .env + migrations drifts silently
 * eventually. Each boundary is supposed to cross-check at startup; a drifted
 * value should be fatal at boot rather than silently-running. This module
 * stands up the integration point with the four current validators:
 *
 *   1. `qdrant_dim`   — Qdrant collection dimension matches `EMBED_DIMENSIONS`.
 *   2. `ml_services`  — ml-services FastAPI is reachable + healthy.
 *   3. `transport`    — selected LLM_PROVIDER's transport process is healthy.
 *   4. `ports`        — PORT and PI_BRIDGE_PORT don't collide.
 *
 * Per-boundary fix beads (`.121 .126 .127 .112`) own the underlying check
 * logic; this module is the integration point that wires them into a single
 * pre-serve gate.
 *
 * Behaviour contract:
 *   - Every validator runs (no short-circuit on first failure — operators
 *     see the full picture).
 *   - Each validator has a 5s timeout; aggregate budget is bounded by
 *     VALIDATOR_TIMEOUT_MS × VALIDATORS.length.
 *   - Validators never throw to the caller; failures surface as
 *     `ok: false` with a `detail` message.
 *   - The caller (`src/index.ts`) decides what to do with the result list;
 *     production behaviour is fail-fast (`process.exit(1)` on any
 *     `!ok`).
 *
 * Why not a `STRICT_STARTUP` env opt-out: bead .132 Decision section
 * rejected that explicitly. An env-var escape hatch recreates the
 * silent-drift problem this module is fixing. Strict-only.
 */

import { config } from '../config.js';
import { ensureCollections } from './qdrant.js';
import { ml } from './ml-client.js';
import { checkGraphMcpHealth } from './causal-agent.js';
import { rawQuery } from '../db/raw.js';
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema.js';

export interface ValidatorResult {
  name: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

interface Validator {
  name: string;
  run: () => Promise<{ ok: boolean; detail?: string }>;
}

const VALIDATOR_TIMEOUT_MS = 5_000;

/** Wrap a validator with timing + timeout. The validator's own .run() may
 *  throw or take longer than the budget; either way we return a
 *  `ValidatorResult` rather than propagating. */
async function runValidator(v: Validator): Promise<ValidatorResult> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      v.run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`validator timeout after ${VALIDATOR_TIMEOUT_MS}ms`)), VALIDATOR_TIMEOUT_MS);
      }),
    ]);
    return { name: v.name, ok: result.ok, detail: result.detail, durationMs: Date.now() - t0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: v.name, ok: false, detail: message, durationMs: Date.now() - t0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ===========================================================================
// Validators
// ===========================================================================

const qdrantDimValidator: Validator = {
  name: 'qdrant_dim',
  run: async () => {
    // ensureCollections creates any missing collections AND throws when an
    // existing one's dim differs from config.EMBED_DIMENSIONS (bead .121).
    // Both behaviours are what we want at startup.
    await ensureCollections();
    return { ok: true };
  },
};

const mlServicesValidator: Validator = {
  name: 'ml_services',
  run: async () => {
    const healthy = await ml.health();
    if (!healthy) {
      return { ok: false, detail: `ml-services /health did not return 200 (URL=${config.ML_SERVICES_URL})` };
    }
    return { ok: true };
  },
};

const transportValidator: Validator = {
  name: 'transport',
  run: async () => {
    const provider = process.env.LLM_PROVIDER ?? 'pi';
    if (provider === 'zai') {
      // ZAI runs inside ml-services; no host transport process to probe.
      return { ok: true, detail: 'skipped (zai provider runs in ml-services)' };
    }
    if (provider === 'pi') {
      const piPort = process.env.PI_BRIDGE_PORT ?? '3099';
      const url = `http://localhost:${piPort}/health`;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) {
          return { ok: false, detail: `pi bridge /health returned ${response.status} at ${url}` };
        }
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, detail: `pi bridge /health unreachable at ${url}: ${message}` };
      }
    }
    if (provider === 'claude') {
      const result = await checkGraphMcpHealth();
      if (!result.ok) {
        return { ok: false, detail: `graph MCP probe failed: ${result.error ?? 'unknown error'}` };
      }
      return { ok: true };
    }
    return { ok: false, detail: `unknown LLM_PROVIDER='${provider}' (expected pi|claude|zai)` };
  },
};

const portsValidator: Validator = {
  name: 'ports',
  run: async () => {
    const platformPort = process.env.PORT ?? '3000';
    const piPort = process.env.PI_BRIDGE_PORT ?? '3099';
    if (platformPort === piPort) {
      return {
        ok: false,
        detail: `PORT and PI_BRIDGE_PORT both resolve to ${platformPort} — platform + Pi bridge would collide. Set distinct values in .env.`,
      };
    }
    return { ok: true };
  },
};

const hnswIterativeScanValidator: Validator = {
  name: 'hnsw_iterative_scan',
  run: async () => {
    // Every filtered vector search in the codebase reads
    //   WHERE corpus_id = ... ORDER BY embedding <=> ... LIMIT k
    // and pgvector's HNSW index cannot apply that WHERE during the graph walk:
    // it returns the ef_search nearest candidates GLOBALLY and the filter drops
    // them afterwards, without going back for more. Measured on a 5,714-fact
    // corpus: recall@10 0.715 with 6 of 60 queries returning ZERO rows.
    // Migration 058 sets this at database level; this asserts it, because a
    // database-level guarantee nothing verifies is how the arc lost measurements
    // before (blocker 6 in the single-graph keep list).
    // current_setting with missing_ok=true rather than SHOW: SHOW names its
    // column after the full GUC ('hnsw.iterative_scan'), which is awkward to read
    // back, and plain current_setting ERRORS on an unknown GUC instead of
    // reporting it. This returns NULL and produces a clear message.
    const rows = await rawQuery<{ setting: string | null }>(
      sql`SELECT current_setting('hnsw.iterative_scan', true) AS setting`,
    );
    const setting = rows[0]?.setting;
    if (setting !== 'strict_order') {
      return {
        ok: false,
        detail:
          `hnsw.iterative_scan='${setting ?? 'unset'}' (expected 'strict_order'). ` +
          'Filtered vector search silently truncates or returns zero rows. Run migration 058, ' +
          "or: ALTER DATABASE <db> SET hnsw.iterative_scan = 'strict_order' (new sessions only).",
      };
    }
    return { ok: true };
  },
};

const schemaTablesValidator: Validator = {
  name: 'schema_tables',
  run: async () => {
    // Bead nmemo-ajm: startup-validation checked no arc table at all, so a DB
    // missing migration 052's composite FKs or 054/055's tables entirely would
    // start clean and every "the constraint enforces X" claim rested on a
    // migration state nothing verified. The live cognitive DB was in that state.
    //
    // The expected set is DERIVED from the drizzle schema rather than
    // hand-listed: a hand-maintained allowlist drifts silently the moment a
    // migration adds a table and nobody updates the check, which is the same
    // class of defect. Every table this codebase declares must exist.
    //
    // SCOPE, stated precisely so this is not read as "migration state verified":
    // it covers the 40 tables declared as drizzle objects, which is exactly the
    // set the TypeScript code queries through the ORM — so it catches the 42P01
    // failure mode. On a fully migrated DB (50 public tables) the 10 it does NOT
    // cover are the gardener/topology/clustering tables (entity_topology,
    // entity_clusters, topology_bridges, the *_compute_runs), which are reached
    // by raw SQL and have no drizzle object. Every ARC table IS covered:
    // corpus_policies, bridge_edges, bridge_source_refs, causal_edge_corroborations,
    // staging_causal_edges, staging_bridge_edges, arbiter_verdicts, fact_units.
    // `is(v, PgTable)` is the runtime test; the cast only bridges drizzle's
    // generic Table type, which does not accept a concrete PgTableWithColumns.
    type NamedTable = Parameters<typeof getTableName>[0];
    const expected: string[] = [];
    for (const v of Object.values(schema)) {
      if (is(v, PgTable)) expected.push(getTableName(v as unknown as NamedTable));
    }
    if (expected.length === 0) {
      return { ok: false, detail: 'no tables found in db/schema.ts — introspection is broken, not the DB' };
    }
    const present = new Set(
      (await rawQuery<{ tablename: string }>(
        sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      )).map((r) => r.tablename),
    );
    const missing = expected.filter((t) => !present.has(t)).sort();
    if (missing.length > 0) {
      return {
        ok: false,
        detail:
          `${missing.length} table(s) declared in db/schema.ts are absent from the database: ` +
          `${missing.join(', ')}. The DB lags migrations — run them (and check the exit code; ` +
          'the runner used to always exit 0).',
      };
    }
    return { ok: true, detail: `${expected.length} declared tables present` };
  },
};

/** The active validator list. Hand-maintained. Per-boundary fix beads
 *  (.121 .126 .127 .112) own the underlying check; new boundaries get a
 *  validator entry alongside their initial PR. */
const VALIDATORS: Validator[] = [
  qdrantDimValidator,
  mlServicesValidator,
  transportValidator,
  portsValidator,
  hnswIterativeScanValidator,
  schemaTablesValidator,
];

/** Run every validator (no short-circuit) and return the result list.
 *  The caller decides fail-fast vs. tolerate. Validators never throw out. */
export async function validateStartup(): Promise<ValidatorResult[]> {
  const results: ValidatorResult[] = [];
  for (const v of VALIDATORS) {
    results.push(await runValidator(v));
  }
  return results;
}

// Test-only handle to swap validators for unit-level coverage of the
// aggregator + reporting logic. NOT for production use.
export const _testOnly = { runValidator, VALIDATORS };
