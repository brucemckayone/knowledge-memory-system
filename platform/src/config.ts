// Only load .env in non-test environments (tests set their own env vars)
// NOTE: dotenv.config() respects existing env vars and won't overwrite them
import dotenv from 'dotenv';
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().url(),

  // Qdrant
  QDRANT_URL: z.string().url().default('http://localhost:6333'),

  // ML Services
  ML_SERVICES_URL: z.string().url().default('http://localhost:8000'),

  // Embedding model — dimensions are derived from the model map below.
  // Override with EMBED_DIMENSIONS only for models not in the map.
  EMBED_MODEL: z.string().default('nomic-embed-text'),
  EMBED_DIMENSIONS: z.coerce.number().optional(),

  // Anthropic API (Phase B: causal agent)
  ANTHROPIC_API_KEY: z.string().optional(),

  // Drift-reconciliation retry cap (bead nmemo-2yv.83). After N transient
  // failures, the helper transitions triggered_action='reconciliation_failed'
  // and stops retrying. Default 3 mirrors the bead's locked spec.
  MAX_RECONCILIATION_ATTEMPTS: z.coerce.number().int().positive().default(3),
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
