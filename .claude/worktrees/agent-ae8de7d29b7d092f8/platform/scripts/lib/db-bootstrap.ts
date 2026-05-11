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

export async function dropAndRecreateDatabase(target: ConnInfo): Promise<void> {
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
