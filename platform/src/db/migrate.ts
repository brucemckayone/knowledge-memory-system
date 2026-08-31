import postgres from 'postgres';
import { config } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Migration runner.
 *
 * Bead nmemo-ajm: this used to catch each migration's error, log it, continue,
 * print "🏁 All migrations processed" and exit(0). Combined with the no-journal /
 * not-run-on-boot behaviour, a database could be missing migration 052's
 * composite FKs, or 054/055's tables entirely, while the migration step reported
 * success — so every "the constraint enforces X" claim rested on a migration
 * state nothing verified. The live cognitive DB was in exactly that state.
 *
 * NO JOURNAL, DELIBERATELY. Skipping already-applied files looks like the obvious
 * improvement and would break the schema: per the AGE notes in CLAUDE.md,
 * 001_consolidated.sql sets `search_path = ag_catalog, public, "$user"` at SESSION
 * level and every later migration's DDL depends on that still being set. A journal
 * that skipped 001 on a subsequent run would leave the path unset and land later
 * objects in the wrong schema. Migrations here are written to be idempotent and
 * re-run every time on purpose. (Bead nmemo-ved tracks the three that are not yet
 * idempotent and ERROR on re-run — those are why the loop still continues past a
 * failure rather than stopping at the first one.)
 */
const runMigrate = async (): Promise<void> => {
  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }

  const sql = postgres(config.DATABASE_URL, { max: 1 });

  console.log('⏳ Running migrations...');

  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    console.error(`❌ Migrations directory not found at: ${migrationsDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`Found ${files.length} migration files.`);

  const failures: Array<{ file: string; message: string }> = [];

  for (const file of files) {
    console.log(`▶️  Running ${file}...`);
    const filePath = path.join(migrationsDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');

    // Migration 007 creates an old version of contradiction_reviews.
    // Migration 013 supersedes it with a different schema — drop the old one first.
    if (file.includes('013_contradiction_reviews')) {
      await sql.unsafe('DROP TABLE IF EXISTS contradiction_reviews CASCADE');
    }

    try {
      await sql.unsafe(content);
      console.log(`✅ ${file} applied.`);
    } catch (e) {
      // Keep going so one bad file does not hide the state of the rest, but
      // RECORD it — the exit code below is what makes the run honest.
      const message = e instanceof Error ? e.message : String(e);
      failures.push({ file, message });
      console.error(`❌ Failed to apply ${file}: ${message}`);
    }
  }

  await sql.end();

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} of ${files.length} migrations FAILED:`);
    for (const f of failures) {
      console.error(`   • ${f.file}: ${f.message}`);
    }
    console.error(
      '\nThe database schema is NOT in the state this codebase expects. Do not trust any\n' +
      'DB-level guarantee (composite FKs, immutability triggers, corpus policies) until\n' +
      'these are resolved.',
    );
    process.exit(1);
  }

  console.log(`\n🏁 All ${files.length} migrations applied successfully.`);
  process.exit(0);
};

runMigrate().catch((err) => {
  console.error('❌ Migration failed');
  console.error(err);
  process.exit(1);
});
