/**
 * Demo restore — reverses snapshot-demo.ts. Reapplies the captured Postgres
 * dump, restores Qdrant collections from their snapshot files, and copies
 * learn.db back into place.
 *
 *   pnpm tsx scripts/restore-demo.ts --label=<short-name>
 *
 * Destructive: drops public schema in the platform DB before reapplying the
 * dump, and replaces existing Qdrant collections of the same name. Does not
 * prompt — only run this against the demo rig, never production.
 *
 * Env (same as snapshot-demo): DATABASE_URL, QDRANT_URL, LEARN_DB_PATH.
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile } from 'node:fs/promises';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEARN_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(LEARN_ROOT, '..');
const SNAPSHOT_BASE = path.join(LEARN_ROOT, 'demo-snapshots');

interface Manifest {
  label: string;
  createdAt: string;
  postgres: { dumpFile: string; size: number };
  qdrant: { url: string; collections: Array<{ name: string; file: string; size: number }> };
  learnDb: { file: string; size: number } | null;
}

async function loadEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const c of [path.join(REPO_ROOT, '.env'), path.join(REPO_ROOT, 'platform', '.env')]) {
    if (!existsSync(c)) continue;
    for (const line of (await readFile(c, 'utf-8')).split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
    }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

function parseLabel(): string {
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--label=(.+)$/);
    if (m) return m[1]!;
  }
  throw new Error('--label=<name> is required. Pass the snapshot label.');
}

const PSQL_CANDIDATES = [
  'psql',
  'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe',
  'C:\\Program Files\\PostgreSQL\\15\\bin\\psql.exe',
  'C:\\Program Files\\PostgreSQL\\14\\bin\\psql.exe',
  '/usr/local/bin/psql',
  '/usr/bin/psql',
  '/opt/homebrew/bin/psql',
];

function resolvePsql(): string {
  for (const c of PSQL_CANDIDATES) {
    const probe = spawnSync(c, ['--version'], { stdio: 'ignore', shell: false });
    if (probe.status === 0) return c;
  }
  throw new Error('psql not found on PATH or standard install paths.');
}

async function qdrantDeleteIfExists(qdrantUrl: string, name: string): Promise<void> {
  const exists = await fetch(`${qdrantUrl}/collections/${name}`);
  if (exists.status === 404) return;
  if (!exists.ok) throw new Error(`probe ${name} → ${exists.status}`);
  const del = await fetch(`${qdrantUrl}/collections/${name}`, { method: 'DELETE' });
  if (!del.ok) throw new Error(`delete ${name} → ${del.status}`);
}

async function qdrantUploadSnapshot(qdrantUrl: string, name: string, filePath: string): Promise<void> {
  // Qdrant supports recovery from a local snapshot file via the `/snapshots/upload`
  // endpoint when the snapshot is uploaded as multipart/form-data.
  const buf = await readFile(filePath);
  const form = new FormData();
  form.append('snapshot', new Blob([buf]), path.basename(filePath));
  const url = `${qdrantUrl}/collections/${name}/snapshots/upload?priority=snapshot`;
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`upload snapshot ${name} → ${res.status}: ${detail.slice(0, 300)}`);
  }
}

async function main(): Promise<void> {
  const label = parseLabel();
  const env = await loadEnv();
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL not set');
  const qdrantUrl = env.QDRANT_URL ?? 'http://localhost:6335';
  const learnDbPath = env.LEARN_DB_PATH ?? path.join(LEARN_ROOT, 'learn.db');

  const dir = path.join(SNAPSHOT_BASE, label);
  if (!existsSync(dir)) throw new Error(`snapshot not found: ${dir}`);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf-8')) as Manifest;
  console.log(`[restore] label=${label} createdAt=${manifest.createdAt}`);

  // --- Postgres restore ---
  const psql = resolvePsql();
  // Drop public schema then reapply. ag_catalog stays — AGE provides it.
  console.log('[restore] resetting public schema…');
  const drop = spawnSync(psql, [databaseUrl, '-c', 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'], {
    stdio: 'inherit',
    shell: false,
  });
  if (drop.status !== 0) throw new Error(`schema drop exited ${drop.status}`);
  console.log(`[restore] applying ${manifest.postgres.dumpFile}…`);
  const apply = spawnSync(psql, [databaseUrl, '-f', path.join(dir, manifest.postgres.dumpFile)], {
    stdio: 'inherit',
    shell: false,
  });
  if (apply.status !== 0) throw new Error(`psql apply exited ${apply.status}`);

  // --- Qdrant restore ---
  for (const col of manifest.qdrant.collections) {
    console.log(`[restore] qdrant: ${col.name}…`);
    await qdrantDeleteIfExists(qdrantUrl, col.name);
    await qdrantUploadSnapshot(qdrantUrl, col.name, path.join(dir, col.file));
  }

  // --- learn.db ---
  if (manifest.learnDb) {
    const src = path.join(dir, manifest.learnDb.file);
    await copyFile(src, learnDbPath);
    console.log(`[restore] learn.db copied → ${learnDbPath}`);
  }

  console.log('[restore] done.');
}

main().catch(err => {
  console.error('[restore] fatal:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
