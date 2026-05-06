/**
 * Cross-platform pg_dump / pg_restore resolver and runner.
 *
 * Doc 28 §2.6 specifies a probe order to find pg_dump:
 *   1. PG_DUMP_PATH env var
 *   2. host pg_dump via spawnSync (resolved on PATH)
 *   3. common host install paths (Windows + Unix)
 *   4. extension: docker exec into PG_DUMP_DOCKER_CONTAINER (default
 *      nmemo-postgres-1) — covers the dev box where Postgres lives only in
 *      Docker. This is a small extension to doc 28 §2.6; if the user wants
 *      it removed, drop the docker branch and rely on host installs only.
 *
 * pg_restore is resolved using the matching binary in the same place pg_dump
 * was found.
 */

import { spawnSync, spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, closeSync, createReadStream } from 'fs';
import { dirname } from 'path';

export interface PgToolResolution {
  /** "host" → invoke binary directly. "docker" → docker exec into a container. */
  mode: 'host' | 'docker';
  /** When mode === 'host', the absolute path or bare command for pg_dump. */
  pgDump: string;
  /** When mode === 'host', the absolute path or bare command for pg_restore. */
  pgRestore: string;
  /** When mode === 'docker', the container name to exec into. */
  container?: string;
  /** Human-readable note about how the resolution was reached. */
  note: string;
}

const WINDOWS_FALLBACKS = [
  'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\14\\bin\\pg_dump.exe',
];

const UNIX_FALLBACKS = [
  '/usr/bin/pg_dump',
  '/usr/local/bin/pg_dump',
  '/opt/homebrew/bin/pg_dump',
];

export class PgToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgToolsError';
  }
}

function tryDirectInvoke(cmd: string): boolean {
  try {
    const result = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function siblingRestore(pgDumpPath: string): string {
  if (pgDumpPath === 'pg_dump') return 'pg_restore';
  return pgDumpPath.replace(/pg_dump(\.exe)?$/, 'pg_restore$1');
}

export function resolvePgTools(): PgToolResolution {
  const envOverride = process.env.PG_DUMP_PATH;
  if (envOverride) {
    if (!existsSync(envOverride)) {
      throw new PgToolsError(
        `PG_DUMP_PATH points at a missing file: ${envOverride}`
      );
    }
    return {
      mode: 'host',
      pgDump: envOverride,
      pgRestore: siblingRestore(envOverride),
      note: `PG_DUMP_PATH=${envOverride}`,
    };
  }

  if (tryDirectInvoke('pg_dump')) {
    return {
      mode: 'host',
      pgDump: 'pg_dump',
      pgRestore: 'pg_restore',
      note: 'pg_dump resolved on PATH',
    };
  }

  const fallbacks = process.platform === 'win32' ? WINDOWS_FALLBACKS : UNIX_FALLBACKS;
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) {
      return {
        mode: 'host',
        pgDump: candidate,
        pgRestore: siblingRestore(candidate),
        note: `host fallback: ${candidate}`,
      };
    }
  }

  const container = process.env.PG_DUMP_DOCKER_CONTAINER || 'nmemo-postgres-1';
  if (tryDirectInvoke('docker')) {
    const probe = spawnSync('docker', ['exec', container, 'pg_dump', '--version'], {
      stdio: 'ignore',
      timeout: 10000,
    });
    if (probe.status === 0) {
      return {
        mode: 'docker',
        pgDump: 'pg_dump',
        pgRestore: 'pg_restore',
        container,
        note: `docker exec ${container}`,
      };
    }
  }

  throw new PgToolsError(
    'No usable pg_dump found. Set PG_DUMP_PATH, install Postgres client tools, ' +
    'or ensure the Postgres Docker container (default nmemo-postgres-1, ' +
    'override via PG_DUMP_DOCKER_CONTAINER) is running.'
  );
}

export interface ConnInfo {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Run pg_dump, streaming binary output to `outputPath` on the host filesystem.
 * Works for both host-binary and docker-exec modes.
 */
export async function runPgDump(
  resolution: PgToolResolution,
  conn: ConnInfo,
  flags: string[],
  outputPath: string,
): Promise<void> {
  mkdirSync(dirname(outputPath), { recursive: true });

  const baseArgs = [
    `--host=${resolution.mode === 'docker' ? hostFromDocker(conn.host) : conn.host}`,
    `--port=${resolution.mode === 'docker' ? '5432' : String(conn.port)}`,
    `--username=${conn.user}`,
    `--dbname=${conn.database}`,
    ...flags,
  ];

  const env = { ...process.env, PGPASSWORD: conn.password };
  const fd = openSync(outputPath, 'w');
  try {
    if (resolution.mode === 'host') {
      await runStreamingProcess(resolution.pgDump, baseArgs, env, fd);
    } else {
      const dockerArgs = [
        'exec',
        '-i',
        '-e', `PGPASSWORD=${conn.password}`,
        resolution.container!,
        'pg_dump',
        ...baseArgs,
      ];
      await runStreamingProcess('docker', dockerArgs, process.env, fd);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Apply a plain-text SQL dump via psql. Used for synthetic snapshots, which
 * dump with `--format=plain` so byte-stable hashes survive regeneration (the
 * custom format embeds a per-run timestamp in its header). Streams the file
 * on stdin in docker-exec mode.
 */
export async function runPsqlFile(
  resolution: PgToolResolution,
  conn: ConnInfo,
  inputPath: string,
): Promise<void> {
  const baseArgs = [
    `--host=${resolution.mode === 'docker' ? hostFromDocker(conn.host) : conn.host}`,
    `--port=${resolution.mode === 'docker' ? '5432' : String(conn.port)}`,
    `--username=${conn.user}`,
    `--dbname=${conn.database}`,
    '--no-psqlrc',
    '--quiet',
    '-v', 'ON_ERROR_STOP=0',
  ];
  const env = { ...process.env, PGPASSWORD: conn.password };
  if (resolution.mode === 'host') {
    const psql = resolution.pgDump.replace(/pg_dump(\.exe)?$/, 'psql$1');
    await runProcessStdinFromFile(psql, baseArgs, env, inputPath);
  } else {
    const dockerArgs = [
      'exec',
      '-i',
      '-e', `PGPASSWORD=${conn.password}`,
      resolution.container!,
      'psql',
      ...baseArgs,
    ];
    await runProcessStdinFromFile('docker', dockerArgs, env, inputPath);
  }
}

/**
 * Run pg_restore against an input file. The input file is streamed on stdin
 * in docker-exec mode so the container does not need a mounted host path.
 */
export async function runPgRestore(
  resolution: PgToolResolution,
  conn: ConnInfo,
  flags: string[],
  inputPath: string,
): Promise<void> {
  const baseArgs = [
    `--host=${resolution.mode === 'docker' ? hostFromDocker(conn.host) : conn.host}`,
    `--port=${resolution.mode === 'docker' ? '5432' : String(conn.port)}`,
    `--username=${conn.user}`,
    `--dbname=${conn.database}`,
    ...flags,
  ];

  const env = { ...process.env, PGPASSWORD: conn.password };
  if (resolution.mode === 'host') {
    await runProcessFromFile(resolution.pgRestore, [...baseArgs, inputPath], env);
  } else {
    const dockerArgs = [
      'exec',
      '-i',
      '-e', `PGPASSWORD=${conn.password}`,
      resolution.container!,
      'pg_restore',
      ...baseArgs,
    ];
    await runProcessStdinFromFile('docker', dockerArgs, env, inputPath);
  }
}

/** Inside the postgres container the host loopback maps differently. */
function hostFromDocker(host: string): string {
  if (host === '127.0.0.1' || host === 'localhost') return 'localhost';
  return host;
}

function runStreamingProcess(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  outFd: number,
): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', outFd, 'pipe'],
      env,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0) return res();
      rej(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function runProcessFromFile(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stderr = '';
    child.stdout.on('data', () => { /* discard */ });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0) return res();
      rej(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function runProcessStdinFromFile(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  inputPath: string,
): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stderr = '';
    child.stdout.on('data', () => { /* discard */ });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0) return res();
      rej(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
    const fileStream = createReadStream(inputPath);
    fileStream.on('error', rej);
    fileStream.pipe(child.stdin);
  });
}
