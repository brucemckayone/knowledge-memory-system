import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL || 'postgres://cognitive:cognitive@localhost:5434/cognitive',
  },
  verbose: true,
  strict: true,
} satisfies Config;
