/**
 * Destructive-DB guard (doc 28 §3.3 / cold-eyes review S5).
 *
 * Snapshot scripts drop and recreate the target database. This guard parses
 * DATABASE_URL and aborts if the target is anything other than the test or
 * snapshot databases. It must be called before any DROP / TRUNCATE / restore
 * step.
 */

const ALLOWED_DBNAME_PATTERNS: RegExp[] = [
  /^cognitive_test$/,
  /^cognitive_snapshot_[a-z0-9_-]+$/,
];

export interface ParsedDatabaseUrl {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class DatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseGuardError';
  }
}

export function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new DatabaseGuardError(`DATABASE_URL is not a valid URL: ${detail}`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new DatabaseGuardError(`DATABASE_URL protocol must be postgres:// — got ${parsed.protocol}`);
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (!database) {
    throw new DatabaseGuardError('DATABASE_URL has no database path component');
  }
  return {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? parseInt(parsed.port, 10) : 5432,
    user: decodeURIComponent(parsed.username) || 'postgres',
    password: decodeURIComponent(parsed.password) || '',
    database,
  };
}

export function isDatabaseAllowed(name: string): boolean {
  return ALLOWED_DBNAME_PATTERNS.some((rx) => rx.test(name));
}

/**
 * Throws unless the parsed DATABASE_URL points at an allowlisted destructive
 * target. Snapshot scripts MUST call this before issuing any DROP / restore.
 */
export function assertDestructiveTargetAllowed(parsed: ParsedDatabaseUrl): void {
  if (!isDatabaseAllowed(parsed.database)) {
    throw new DatabaseGuardError(
      `Refusing to operate on database "${parsed.database}". ` +
      `Snapshot scripts only run against cognitive_test or cognitive_snapshot_* ` +
      `(see doc 28 §3.3). Set DATABASE_URL to a permitted target and retry.`
    );
  }
}

export function loadAndAssertDatabaseUrl(): ParsedDatabaseUrl {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new DatabaseGuardError('DATABASE_URL is not set');
  }
  const parsed = parseDatabaseUrl(url);
  assertDestructiveTargetAllowed(parsed);
  return parsed;
}
