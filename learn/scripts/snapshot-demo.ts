/**
 * Demo snapshot — captures the full demo state so the stage rig is reproducible.
 *
 *   pnpm tsx scripts/snapshot-demo.ts [--label=<short-name>]
 *
 * Captures:
 *   - Postgres dump of the platform DB (entities, facts, causal_*, topology_*).
 *   - Qdrant collection snapshots (memory store).
 *   - learn.db SQLite copy (courses, sections, lessons, attempts, chat).
 *
 * Drops a manifest.json describing what was captured so the restore script
 * knows what to put back. Snapshots land under learn/demo-snapshots/<label>/.
 *
 * Requires: pg_dump on PATH (or one of the standard Windows install paths)
 *           and a running Qdrant on QDRANT_URL.
 *
 * Env:
 *   DATABASE_URL  postgres://user:pass@host:port/db   (default reads .env)
 *   QDRANT_URL    http://host:port                    (default http://localhost:6335)
 *   LEARN_DB_PATH absolute path to learn.db           (default learn/learn.db)
 */

import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEARN_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(LEARN_ROOT, '..');
const SNAPSHOT_BASE = path.join(LEARN_ROOT, 'demo-snapshots');

function nowLabel(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function parseLabel(): string {
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--label=(.+)$/);
    if (m) return m[1]!;
  }
  return nowLabel();
}

async function loadEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const candidate of [path.join(REPO_ROOT, '.env'), path.join(REPO_ROOT, 'platform', '.env')]) {
    if (!existsSync(candidate)) continue;
    const raw = await readFile(candidate, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
    }
  }
  // process.env wins over .env so an explicit override holds.
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// pg_dump resolver — copy of the platform's probe order, kept tight.
// ---------------------------------------------------------------------------

const PG_DUMP_CANDIDATES = [
  'pg_dump',
  'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\14\\bin\\pg_dump.exe',
  '/usr/local/bin/pg_dump',
  '/usr/bin/pg_dump',
  '/opt/homebrew/bin/pg_dump',
];

function resolvePgDump(): string {
  for (const c of PG_DUMP_CANDIDATES) {
    const probe = spawnSync(c, ['--version'], { stdio: 'ignore', shell: false });
    if (probe.status === 0) return c;
  }
  throw new Error('pg_dump not found on PATH or in standard install paths. Install PostgreSQL client tools.');
}

// ---------------------------------------------------------------------------
// Qdrant snapshot — POST /collections/{name}/snapshots returns a JSON object
// with { result: { name, ... } }. Copy via download endpoint.
// ---------------------------------------------------------------------------

interface QdrantSnapshotResp {
  result?: { name?: string };
  status?: string;
}

async function qdrantListCollections(qdrantUrl: string): Promise<string[]> {
  const res = await fetch(`${qdrantUrl}/collections`);
  if (!res.ok) throw new Error(`Qdrant /collections → ${res.status}`);
  const body = await res.json() as { result?: { collections?: Array<{ name: string }> } };
  return body.result?.collections?.map(c => c.name) ?? [];
}

async function qdrantSnapshotCollection(qdrantUrl: string, name: string, outPath: string): Promise<void> {
  // Trigger the snapshot.
  const trig = await fetch(`${qdrantUrl}/collections/${name}/snapshots`, { method: 'POST' });
  if (!trig.ok) throw new Error(`Qdrant POST snapshot for ${name} → ${trig.status}`);
  const trigBody = (await trig.json()) as QdrantSnapshotResp;
  const snapName = trigBody.result?.name;
  if (!snapName) throw new Error(`Qdrant snapshot response missing name for ${name}`);
  // Download.
  const dl = await fetch(`${qdrantUrl}/collections/${name}/snapshots/${snapName}`);
  if (!dl.ok) throw new Error(`Qdrant snapshot download for ${name}/${snapName} → ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  await writeFile(outPath, buf);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Manifest {
  label: string;
  createdAt: string;
  postgres: { dumpFile: string; size: number };
  qdrant: { url: string; collections: Array<{ name: string; file: string; size: number }> };
  learnDb: { file: string; size: number } | null;
}

async function main(): Promise<void> {
  const label = parseLabel();
  const env = await loadEnv();
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL not set (env or .env)');
  const qdrantUrl = env.QDRANT_URL ?? 'http://localhost:6335';
  const learnDbPath = env.LEARN_DB_PATH ?? path.join(LEARN_ROOT, 'learn.db');

  const outDir = path.join(SNAPSHOT_BASE, label);
  await mkdir(outDir, { recursive: true });
  console.log(`[snapshot] label=${label} → ${outDir}`);

  // --- Postgres dump ---
  const pgDump = resolvePgDump();
  const dumpFile = path.join(outDir, 'platform.sql');
  console.log(`[snapshot] pg_dump (${pgDump}) → ${dumpFile}`);
  const dump = spawnSync(pgDump, ['--no-owner', '--no-privileges', '-f', dumpFile, databaseUrl], {
    stdio: 'inherit',
    shell: false,
  });
  if (dump.status !== 0) throw new Error(`pg_dump exited ${dump.status}`);
  const dumpStat = (await import('node:fs/promises')).stat(dumpFile).then(s => s.size);

  // --- Qdrant snapshots ---
  console.log('[snapshot] qdrant — listing collections…');
  const cols = await qdrantListCollections(qdrantUrl);
  console.log(`[snapshot] qdrant — ${cols.length} collection(s): ${cols.join(', ')}`);
  const qdrantOut: Manifest['qdrant']['collections'] = [];
  for (const name of cols) {
    const file = path.join(outDir, `qdrant-${name}.snapshot`);
    console.log(`[snapshot] qdrant snapshot ${name}…`);
    await qdrantSnapshotCollection(qdrantUrl, name, file);
    const size = (await import('node:fs/promises')).stat(file).then(s => s.size);
    qdrantOut.push({ name, file: path.basename(file), size: await size });
  }

  // --- learn.db ---
  let learnDbEntry: Manifest['learnDb'] = null;
  if (existsSync(learnDbPath)) {
    const dest = path.join(outDir, 'learn.db');
    await copyFile(learnDbPath, dest);
    const size = (await (await import('node:fs/promises')).stat(dest)).size;
    learnDbEntry = { file: 'learn.db', size };
    console.log(`[snapshot] copied learn.db (${size} bytes)`);
  } else {
    console.warn(`[snapshot] learn.db not found at ${learnDbPath} — skipping`);
  }

  // --- manifest ---
  const manifest: Manifest = {
    label,
    createdAt: new Date().toISOString(),
    postgres: { dumpFile: 'platform.sql', size: await dumpStat },
    qdrant: { url: qdrantUrl, collections: qdrantOut },
    learnDb: learnDbEntry,
  };
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[snapshot] done → ${outDir}/manifest.json`);
}

main().catch(err => {
  console.error('[snapshot] fatal:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
