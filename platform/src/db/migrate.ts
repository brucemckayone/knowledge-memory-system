import postgres from 'postgres';
import { config } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runMigrate = async () => {
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

  for (const file of files) {
    console.log(`▶️  Running ${file}...`);
    const filePath = path.join(migrationsDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    
    try {
      // Split by semicolon to handle multiple statements if needed, 
      // but postgres.js .file() or direct query usually handles it if simple.
      // Better to just execute the content.
      await sql.unsafe(content);
      console.log(`✅ ${file} applied.`);
    } catch (e) {
      console.error(`❌ Failed to apply ${file}:`);
      console.error(e);
    }
  }

  // Debug: verify table exists
  const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'context_uuid_audit'`;
  console.log('🔍 Verification: Found tables:', tables);


  console.log('🏁 All migrations processed.');

  await sql.end();
  process.exit(0);
};

runMigrate().catch((err) => {
  console.error('❌ Migration failed');
  console.error(err);
  process.exit(1);
});
