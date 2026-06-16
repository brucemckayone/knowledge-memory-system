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
  // Cron cadence for the reasoning patrol (bead nmemo-2yv.71). Same precedence
  // shape as DRIFT_PATROL_CRON: raw cron expression takes precedence over the
  // minutes-interval convenience knob.
  REASONING_PATROL_CRON: z.string().optional(),
  // Convenience knob for the reasoning-patrol cadence. Default 30 minutes —
  // patrol is more expensive than drift (Claude Code subprocess, 40-70 MCP
  // tool calls per pass), so it ticks half as often. A freshness gate
  // suppresses the actual fire when no entity has been mentioned since the
  // last patrol, so the effective cadence is "every 30 min IF the graph
  // moved" rather than "every 30 min unconditionally".
  REASONING_PATROL_INTERVAL_MIN: z.coerce.number().int().positive().default(30),
  // Source-references drift patrol (bead nmemo-d1r.7). Phase 3 carries the
  // edge_source_refs reverse-lookup index alongside causal_edges.source_references
  // (JSONB authoritative). Every wired mutation path keeps them in step today,
  // but a future un-instrumented path could silently desync the index — at
  // which point findEdgesCitingReference() returns false negatives without
  // any user-visible failure. The patrol is a low-cost background check that
  // surfaces drift as a warn log so ops + the reasoning agent see it. Default
  // cadence is monthly (drift accumulates slowly; ADR notes hourly would be
  // overkill); raw cron expression overrides the monthly default. The
  // minutes-interval knob exists for integration tests + ad-hoc shorter
  // cadences and is honoured only when SOURCE_REFS_DRIFT_PATROL_CRON is unset.
  SOURCE_REFS_DRIFT_PATROL_CRON: z.string().optional(),
  SOURCE_REFS_DRIFT_PATROL_INTERVAL_MIN: z.coerce.number().int().positive().optional(),
  // Threshold for the post-ingest counter trigger. Once derived_freshness's
  // facts_since_compute crosses this value, topology + clustering compute
  // are fired together (fire-and-forget) and both rows reset.
  TOPOLOGY_CLUSTERING_FACT_THRESHOLD: z.coerce.number().int().positive().default(100),
  // Bead nmemo-2yv.72 — pattern-detection and graph-stats cadences are now
  // DB-reactive (same shape as topology/clustering, separate counters). Each
  // has its own threshold reflecting its cost profile:
  //   - pattern_detection: walks all active causal chains, clusters by
  //     template, upserts patterns. Moderate cost — default 50 facts.
  //   - graph_stats: single-pass aggregate counts over entities + facts.
  //     Cheap — default 20 facts so health telemetry stays fresh.
  // Both compute in-process (no ml-services hop), so the thresholds are
  // tuned to the SQL/CPU cost of the platform-side function rather than to
  // an HTTP round-trip.
  PATTERN_DETECTION_FACT_THRESHOLD: z.coerce.number().int().positive().default(50),
  GRAPH_STATS_FACT_THRESHOLD: z.coerce.number().int().positive().default(20),

  // Epoch-v2 causal pass (doc 41 §6, §12 #6; bead nmemo-vpz.6 / E6). The causal
  // pass is post-promotion, conditional, and delta-scoped:
  //   - CAUSAL_PASS_FACT_THRESHOLD (N): trigger (b) — run the pass when a single
  //     promotion settles at least this many facts (a substantive enough change to
  //     be worth one informed causal look). Triggers (a) explicit causal language
  //     and (c) a touched entity with prior causal edges fire independently.
  //   - CAUSAL_PASS_SCOPE_CAP: hard cap on the number of causal events pushed to the
  //     agent (minted events + the touched entities' causal neighbourhood). Keeps the
  //     pass a bounded, single informed pass — not a full re-reason of the graph.
  //   - CAUSAL_PROMOTION_STRENGTH: default strength stamped on a promoted causal edge.
  //     The propose contract carries no strength (the agent asserts existence +
  //     reasoning, not magnitude), so disposal applies this default. Tunable.
  CAUSAL_PASS_FACT_THRESHOLD: z.coerce.number().int().positive().default(5),
  CAUSAL_PASS_SCOPE_CAP: z.coerce.number().int().positive().default(200),
  CAUSAL_PROMOTION_STRENGTH: z.coerce.number().min(0).max(1).default(0.6),
  // Suppress the scheduler at startup (tests, scripts, one-off CLIs).
  // Set DISABLE_SCHEDULER=1 to skip startScheduler() registration.
  DISABLE_SCHEDULER: z.coerce.boolean().default(false),

  // Orphan entity detection threshold (bead nmemo-yh2). An entity is "aged
  // orphan" when entity_meta.fact_count = 0, mention_count > 0, and
  // first_mentioned_at is older than this many minutes. The MVP surface is
  // detection-only — resolution agent integration is deferred. Default 60min
  // matches the spec's intent of "don't flag immediately — give later chunks
  // a chance to add facts" while staying short enough for ops to observe in
  // a typical dev session.
  ORPHAN_AGE_THRESHOLD_MIN: z.coerce.number().int().nonnegative().default(60),

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
