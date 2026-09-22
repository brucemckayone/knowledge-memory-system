/**
 * Drop / recreate / migrate the target snapshot database.
 *
 * Doc 28 §3.4 step 2-3 ("Drops + recreates the test database. Applies all
 * migrations.") The admin connection points at the `cognitive` database (or
 * whatever ADMIN_DATABASE resolves to) and is *not* destructive against that
 * DB — it only issues CREATE / DROP DATABASE for the target.
 *
 * The migration loop mirrors `src/test/global-setup.ts:188` so snapshots and
 * the regular vitest test bootstrap stay in lockstep.
 */

import postgres from 'postgres';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ConnInfo } from './pg-tools.js';
import { PLATFORM_ROOT } from './manifest.js';

const ADMIN_DATABASE = process.env.PG_ADMIN_DATABASE || 'cognitive';

// Above this many entities, the target is not a fixture database and we refuse
// to drop it. See assertTargetIsDisposable.
const DISPOSABLE_MAX_ENTITIES = Number(process.env.MNEMO_DISPOSABLE_MAX_ENTITIES || 20_000);

/**
 * Refuse to DROP a database that is holding real data (bead nmemo-doso).
 *
 * The pre-existing guard (`scripts/lib/db-guard.ts`) allowlists by NAME —
 * `cognitive_test` and `cognitive_snapshot_*`. That was not enough, and on
 * 2026-09-22 it cost 135,000 entities / 343,000 facts / 1,043 causal edges:
 * `cognitive_test` is BOTH on the allowlist AND where the research substrate
 * lives (CLAUDE.md), so a snapshot test dropped the substrate with the guard
 * passing exactly as designed. A name tells you nothing about contents.
 *
 * So: count first, and abort if the target looks like real data rather than a
 * fixture. The threshold sits above the largest legitimate fixture
 * (synthetic-10k) and far below a real substrate. Override deliberately with
 * MNEMO_ALLOW_DESTRUCTIVE_DROP=1 when you genuinely mean it.
 *
 * Fails OPEN only when there is provably nothing to lose: no such database, or
 * no `entities` table yet (a fresh bootstrap).
 */
async function assertTargetIsDisposable(target: ConnInfo): Promise<void> {
  if (process.env.MNEMO_ALLOW_DESTRUCTIVE_DROP === '1') {
    console.warn(
      `  ! MNEMO_ALLOW_DESTRUCTIVE_DROP=1 — skipping the disposable-target check on "${target.database}"`
    );
    return;
  }
  const probe = postgres({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    // Do not let a missing DB hang the bootstrap.
    connect_timeout: 10,
    max: 1,
  });
  try {
    const rows = await probe.unsafe<Array<{ n: string }>>(`
      SELECT CASE WHEN to_regclass('public.entities') IS NULL THEN '0'
                  ELSE (SELECT count(*)::text FROM public.entities) END AS n
    `);
    const n = Number(rows[0]?.n ?? 0);
    if (n > DISPOSABLE_MAX_ENTITIES) {
      throw new Error(
        `REFUSING to drop database "${target.database}": it holds ${n.toLocaleString()} entities, ` +
        `which is more than a disposable fixture database (limit ${DISPOSABLE_MAX_ENTITIES.toLocaleString()}). ` +
        `This is the guard for bead nmemo-doso — on 2026-09-22 this exact call destroyed the ` +
        `294-document research substrate, because the name allowlist permits "cognitive_test" ` +
        `and the substrate lives there. Point the run at a throwaway database ` +
        `(MNEMO_TEST_DB_NAME=cognitive_vitest for the test suite), or set ` +
        `MNEMO_ALLOW_DESTRUCTIVE_DROP=1 if you really do intend to destroy it.`
      );
    }
    console.log(`  → target "${target.database}" holds ${n} entities — treating as disposable`);
  } catch (err) {
    // Rethrow our own refusal; swallow "database does not exist" and friends,
    // where there is nothing to protect.
    if (err instanceof Error && err.message.startsWith('REFUSING to drop database')) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`  → target "${target.database}" not readable (${detail}) — nothing to protect`);
  } finally {
    await probe.end({ timeout: 5 }).catch(() => {});
  }
}

export async function dropAndRecreateDatabase(target: ConnInfo): Promise<void> {
  await assertTargetIsDisposable(target);
  const adminSql = postgres({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: ADMIN_DATABASE,
  });
  try {
    await adminSql.unsafe(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${target.database}' AND pid <> pg_backend_pid()
    `);
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${target.database}`);
    await adminSql.unsafe(`CREATE DATABASE ${target.database}`);
    await adminSql.unsafe(
      `ALTER DATABASE ${target.database} SET search_path = ag_catalog, public, "$user"`
    );
    // Filtered vector search silently drops rows without this — see migration
    // 058. Set at create time so a bootstrapped DB is correct before migrations.
    await adminSql.unsafe(
      `ALTER DATABASE ${target.database} SET hnsw.iterative_scan = 'strict_order'`
    );
  } finally {
    await adminSql.end();
  }
}

/**
 * Pre-load every extension the snapshot was dumped against. pg_dump captures
 * `DROP EXTENSION IF EXISTS age;` (and similar) into the dump's --clean
 * preamble; if the freshly-created target DB doesn't have the extension
 * loaded, `pg_restore --clean --if-exists` errors on the SET search_path
 * preamble before the DROP can run. Loading extensions up-front mirrors the
 * source DB's state at dump time.
 */
export async function loadExtensions(target: ConnInfo): Promise<void> {
  const sql = postgres({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
  });
  try {
    for (const ext of ['uuid-ossp', 'vector', 'pg_trgm', 'btree_gist', 'age']) {
      try {
        await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  ⚠ extension ${ext} unavailable: ${msg.slice(0, 100)}`);
      }
    }
  } finally {
    await sql.end();
  }
}

export async function enableExtensionsAndMigrate(target: ConnInfo): Promise<{
  migrationsApplied: number;
}> {
  await loadExtensions(target);
  const sql = postgres({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
  });
  try {
    const migrationsDir = join(PLATFORM_ROOT, 'src', 'db', 'migrations');
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql') && !f.includes('apache_age'))
      .sort();
    for (const file of files) {
      const raw = readFileSync(join(migrationsDir, file), 'utf-8');
      try {
        await sql.unsafe(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  ⚠ ${file}: ${msg.slice(0, 120)}`);
      }
    }
    await sql.unsafe(`
      DROP TABLE IF EXISTS ag_catalog.memory_entities CASCADE;
      DROP TABLE IF EXISTS ag_catalog.entity_aliases CASCADE;
      DROP TABLE IF EXISTS ag_catalog.entity_merges CASCADE;
      DROP TABLE IF EXISTS ag_catalog.entity_type_history CASCADE;
      DROP TABLE IF EXISTS ag_catalog.fact_predicates CASCADE;
      DROP TABLE IF EXISTS ag_catalog.facts CASCADE;
      DROP TABLE IF EXISTS ag_catalog.entities CASCADE;
      DROP TABLE IF EXISTS ag_catalog.entity_types CASCADE;
    `);
    return { migrationsApplied: files.length };
  } finally {
    await sql.end();
  }
}

export async function countEntitiesAndFacts(target: ConnInfo): Promise<{
  total_entities: number;
  total_facts: number;
}> {
  const sql = postgres({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
  });
  try {
    const e = await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM entities`;
    const f = await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM facts`;
    return {
      total_entities: parseInt(e[0]?.c ?? '0', 10),
      total_facts: parseInt(f[0]?.c ?? '0', 10),
    };
  } finally {
    await sql.end();
  }
}
