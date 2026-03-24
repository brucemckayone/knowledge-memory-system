// Only load .env in non-test environments (tests set their own env vars)
// NOTE: dotenv.config() respects existing env vars and won't overwrite them
import dotenv from 'dotenv';
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}
import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().url(),

  // Qdrant
  QDRANT_URL: z.string().url().default('http://localhost:6333'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  WEBHOOK_URL: z.string().url().optional(),

  // ML Services
  ML_SERVICES_URL: z.string().url().default('http://localhost:8000'),

  // Embedding model — dimensions are derived from the model map below.
  // Override with EMBED_DIMENSIONS only for models not in the map.
  EMBED_MODEL: z.string().default('nomic-embed-text'),
  EMBED_DIMENSIONS: z.coerce.number().optional(),

  // Queue
  QUEUE_CONCURRENCY: z.coerce.number().default(2),

  // Rate limiting
  RATE_LIMIT_MESSAGES_PER_MINUTE: z.coerce.number().default(10),

  // Gardener Intervals (for testing/acceleration)
  GARDENER_FREQUENT_INTERVAL: z.string().default('5m'),
  GARDENER_PERIODIC_INTERVAL: z.string().default('1h'),

  // Ingestion session window (minutes) for cross-source context linking
  INGESTION_SESSION_WINDOW_MINUTES: z.coerce.number().default(15),

  // HTTP Ingest API key (W35)
  MNEMO_API_KEY: z.string().optional(),

  // File watcher (W36)
  WATCH_DIR: z.string().optional(),
  WATCH_ENABLED: z.coerce.boolean().default(false),

  // Obsidian (W39)
  OBSIDIAN_VAULT_PATH: z.string().optional(),
  OBSIDIAN_ENABLED: z.coerce.boolean().default(false),
});

/**
 * Known embedding models and their native output dimensions.
 * Add new models here when switching — prevents dimension mismatches.
 */
const EMBED_MODEL_DIMENSIONS: Record<string, number> = {
  'nomic-embed-text':          768,
  'nomic-embed-text-v2-moe':   768,
  'snowflake-arctic-embed-m':  768,
  'snowflake-arctic-embed2':  1024,
  'mxbai-embed-large':        1024,
  'bge-m3':                   1024,
  'all-minilm':                384,
};

type RawConfig = z.infer<typeof envSchema>;
export type Config = Omit<RawConfig, 'EMBED_DIMENSIONS'> & { EMBED_DIMENSIONS: number };

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  const raw = result.data;
  const mappedDims = EMBED_MODEL_DIMENSIONS[raw.EMBED_MODEL];
  const dims = raw.EMBED_DIMENSIONS ?? mappedDims;

  if (dims === undefined) {
    console.error(
      `Unknown embedding model "${raw.EMBED_MODEL}" — set EMBED_DIMENSIONS explicitly or add it to EMBED_MODEL_DIMENSIONS in config.ts`
    );
    process.exit(1);
  }

  if (raw.EMBED_DIMENSIONS !== undefined && mappedDims !== undefined && raw.EMBED_DIMENSIONS !== mappedDims) {
    console.error(
      `EMBED_DIMENSIONS=${raw.EMBED_DIMENSIONS} does not match known dimensions for "${raw.EMBED_MODEL}" (${mappedDims}). Fix .env or update EMBED_MODEL_DIMENSIONS in config.ts`
    );
    process.exit(1);
  }

  return { ...raw, EMBED_DIMENSIONS: dims };
}

export const config = loadConfig();
