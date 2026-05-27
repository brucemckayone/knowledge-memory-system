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

  // Auto-trigger knobs for derived-state computes (bead nmemo-2yv.84).
  // PLATFORM_PORT default 3000 matches the existing serve() call; surfaced
  // here so the scheduler's POST URL stays in sync with the listening port.
  PLATFORM_PORT: z.coerce.number().int().positive().default(3000),
  // Cron cadence for the drift patrol. node-cron supports 5-field cron
  // strings ("*/15 * * * *") and a 6-field form with leading seconds. We
  // accept a raw cron expression for full flexibility, or fall back to the
  // minutes-interval form via DRIFT_PATROL_INTERVAL_MIN when unset.
  DRIFT_PATROL_CRON: z.string().optional(),
  // Convenience knob for the common "every N minutes" cadence. Honoured only
  // when DRIFT_PATROL_CRON is unset. Default 60 minutes per the bead spec.
  DRIFT_PATROL_INTERVAL_MIN: z.coerce.number().int().positive().default(60),
  // Threshold for the post-ingest counter trigger. Once derived_freshness's
  // facts_since_compute crosses this value, topology + clustering compute
  // are fired together (fire-and-forget) and both rows reset.
  TOPOLOGY_CLUSTERING_FACT_THRESHOLD: z.coerce.number().int().positive().default(100),
  // Suppress the scheduler at startup (tests, scripts, one-off CLIs).
  // Set DISABLE_SCHEDULER=1 to skip startScheduler() registration.
  DISABLE_SCHEDULER: z.coerce.boolean().default(false),

  // Agent-invocation fetch timeouts (bead nmemo-2yv.76). Each of the three
  // ml-services agent endpoints (/reasoning-agent, /graph-agent, /gardener-
  // agent) shells out to Claude Code subprocesses that drive 40-70 MCP tool
  // calls per patrol. Without an AbortController-driven timeout, a hung
  // subprocess (stuck LLM call, network black-hole, frozen MCP server) leaks
  // the platform-side fetch indefinitely — viz buttons spin forever, success
  // counters never increment, and request context piles up until the OS-level
  // socket timeout (hours/days). Defaults match the observed upper bound for
  // a successful patrol pass (~10 min); ops can lengthen for unusually deep
  // reasoning or shorten for a tighter SLA.
  REASONING_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  GRAPH_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  GARDENER_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
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
