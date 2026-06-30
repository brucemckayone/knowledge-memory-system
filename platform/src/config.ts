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

  // Embedding-unit splitter knobs (epic nmemo-yxj). store() embeds the whole
  // window as the canonical PARENT point AND also splits the window into small
  // OVERLAPPING units, each its own satellite Qdrant point, so retrieval hits a
  // topically-focused vector instead of a fact averaged into 6000 chars of
  // noise. Units are a RETRIEVAL index only — they never become the
  // agent-extraction unit (same Haiku call count) and never carry fact
  // provenance (that stays on the parent memoryId). Defaults come from the
  // yxj.1 micro-benchmark sweep (benchmarks/results/yxj1_embedding_unit_sweep.md):
  // unit_size=128/overlap=64 gave the best mean-needle score (0.771) and lifted
  // the degree needle from 0.471 (whole-window) into the 0.7+ band.
  // EMBED_UNIT_OVERLAP MUST be < EMBED_UNIT_CHARS (a stride of <=0 would loop
  // forever); loadConfig() enforces this below.
  EMBED_UNIT_CHARS: z.coerce.number().int().positive().default(128),
  EMBED_UNIT_OVERLAP: z.coerce.number().int().nonnegative().default(64),

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
  // Letter-prep patrol (ASK-011 / re-read async composition, MNEMO-tcg.6). The
  // re-read module's letters are PREGENERATED — iOS reads what is already prepared
  // and never waits (design/07-modules/re-read.md §"Letters are pregenerated"). This
  // patrol is the time-driven composer: each tick it selects the threads worth a
  // letter (open threads that need a first/fresh letter + replied threads whose
  // current letter has an unanswered reply) and composes IN-PROCESS via
  // composeReReadLetter. Same precedence shape as the drift/reasoning patrols: a raw
  // cron expression takes precedence over the minutes-interval convenience knob.
  // Default cadence is daily (1440 min) — letters are a slow, reflective surface;
  // composing once a day keeps the prepared set fresh without spamming compositions.
  // Respects the DISABLE_SCHEDULER gate like every other job.
  LETTER_PREP_PATROL_CRON: z.string().optional(),
  LETTER_PREP_PATROL_INTERVAL_MIN: z.coerce.number().int().positive().default(1440),
  // Per-tick cap on how many threads the letter-prep patrol composes in one pass
  // (selectThreadsWorthALetter LIMIT). Bounds the compose cost (one LLM compose per
  // thread) so a backlog of eligible threads drains across ticks rather than firing
  // a burst of LLM calls in a single tick. Default 10.
  LETTER_PREP_MAX_PER_TICK: z.coerce.number().int().positive().default(10),
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

  // Cost controls (nmemo-6do, B10). Optional per-request USD ceiling — when set,
  // a response whose summed estimated cost exceeds it is LOGGED (advisory). The
  // agentic loop runs inside one opaque claude -p subprocess (max_turns is the
  // in-loop cap), so this is post-hoc detection, not a mid-flight abort. Unset =
  // disabled (the default in dev).
  COST_CEILING_USD: z.coerce.number().nonnegative().optional(),
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

  // The unit splitter advances by (chars - overlap) each step; an overlap >=
  // chars yields a stride <= 0 and the splitter would never terminate. Reject
  // it at startup rather than hang at the first store().
  if (raw.EMBED_UNIT_OVERLAP >= raw.EMBED_UNIT_CHARS) {
    console.error(
      `EMBED_UNIT_OVERLAP=${raw.EMBED_UNIT_OVERLAP} must be < EMBED_UNIT_CHARS=${raw.EMBED_UNIT_CHARS} (overlap >= unit size gives a non-positive stride and the splitter would loop forever)`
    );
    process.exit(1);
  }

  return { ...raw, EMBED_DIMENSIONS: dims };
}

export const config = loadConfig();

// ===========================================================================
// LLM token-usage pricing (token-usage & cost-tracking epic — nmemo-6do, §4.4)
// ===========================================================================
// Cost is computed in EXACTLY ONE PLACE — here, in TypeScript. ml-services emits
// token counts only and never prices. Re-pricing is a one-file edit + a
// PRICING_VERSION bump; history re-prices from the stored token buckets. Rates
// are USD per 1,000,000 tokens. Non-Anthropic seed rates are verify-before-billing
// (verified:'estimated'); Anthropic rows are confirmed from the claude-api skill.

export const PRICING_VERSION = '2026-06-16';
export const BASELINE_MODEL = 'claude-haiku-4-5';      // stable anchor for blended multipliers
export const BLENDED_WEIGHTS = { input: 1, output: 2 }; // blended = (in + 2*out)/3 — output-heavy

export interface ModelRate {
  provider?: string;
  // standard usage-type keys (USD per MTok); extend with more keys as needed
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;   // Anthropic 5-min TTL write (~1.25x base input)
  cacheWrite1h?: number;   // Anthropic 1-hour TTL write (~2x base input)
  reasoningOutput?: number;
  // provenance
  sourceUrl?: string;
  asOf?: string;           // ISO date the rate was verified
  verified?: 'confirmed' | 'estimated';
}

export const PRICING: Record<string, ModelRate> = {
  // Anthropic — authoritative (claude-api skill). cache: read 0.1x, 5m write 1.25x, 1h write 2x base input.
  'claude-haiku-4-5':  { provider: 'anthropic', input: 1.00, output: 5.00,  cacheRead: 0.10, cacheWrite5m: 1.25, cacheWrite1h: 2.00, verified: 'confirmed', asOf: '2026-06-16' },
  'claude-sonnet-4-6': { provider: 'anthropic', input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite5m: 3.75, cacheWrite1h: 6.00, verified: 'confirmed', asOf: '2026-06-16' },
  'claude-opus-4-8':   { provider: 'anthropic', input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite5m: 6.25, cacheWrite1h: 10.00, verified: 'confirmed', asOf: '2026-06-16' },

  // Candidate routing models — VERIFY before billing use; stamp asOf/sourceUrl per row.
  'deepseek-v4-flash': { input: 0.14,  output: 0.28, cacheRead: 0.0028, verified: 'estimated' },
  'deepseek-v4-pro':   { input: 0.435, output: 0.87, cacheRead: 0.0036, verified: 'estimated' }, // promo; confirm permanent
  'mimo-v2-5-pro':     { input: 0.435, output: 0.87, cacheRead: 0.0036, verified: 'estimated' }, // promo framing expired 2026-05-31; confirm
  'mimo-v2-5':         { input: 0.14,  output: 0.28, verified: 'estimated', sourceUrl: 'https://openrouter.ai/xiaomi/mimo-v2.5' }, // corrected from 0.40/2.00
  'qwen-3-6-35b-a3b':  { input: 0.33,  output: 1.95, verified: 'estimated' },
  'glm-5':             { input: 1.00,  output: 3.20, cacheRead: 0.20, verified: 'estimated' },
  'kimi-k2-6':         { input: 0.95,  output: 4.00, cacheRead: 0.16, verified: 'estimated' }, // corrected from 0.60/2.50 (was K2.5 input)
  'minimax-m2-7':      { input: 0.28,  output: 1.20, verified: 'estimated' },
  'gemini-3-flash':    { provider: 'google', input: 0.50, output: 3.00,  cacheRead: 0.05, verified: 'estimated' },
  'gemini-3-5-flash':  { provider: 'google', input: 1.50, output: 9.00, verified: 'estimated' },
  'gemini-3-1-pro':    { provider: 'google', input: 2.00, output: 12.00, verified: 'estimated' },
  'gpt-5-4-nano':      { provider: 'openai', input: 0.20, output: 1.25, verified: 'estimated' },
  'gpt-5-4-mini':      { provider: 'openai', input: 0.75, output: 4.50, verified: 'estimated' },
  'gpt-5-4':           { provider: 'openai', input: 2.50, output: 15.00, verified: 'estimated' },

  // Local — recorded for completeness, zero cost
  'nomic-embed-text':  { provider: 'ollama', input: 0, output: 0, verified: 'confirmed' },
};

/**
 * Operation taxonomy (§4.7) — a closed vocabulary so reports group cleanly,
 * defined ONCE here and imported by every call site (not scattered string
 * literals). Split into ACTIVE (on the live call graph — capture is wired in)
 * vs RESERVED/future (endpoint test-only or not yet live — no capture, so
 * reports never show empty dimensions). `notify.phrase` is reserved: today
 * routes/notifications.ts assembles template prose with no LLM call.
 */
export const OPERATION_VALUES = [
  // active
  'graph_agent', 'reasoning_agent', 'reconciliation_agent', 'gardener_agent',
  'drift', 'judge', 'embed.document', 'embed.query',
  // reserved / future
  'extract.entities', 'extract.relationships', 'extract.facts',
  'summarize', 'classify', 'notify.phrase',
] as const;
export type Operation = typeof OPERATION_VALUES[number];

/** Token buckets a cost is computed from — matches the echoed UsageRecord (snake_case wire shape). */
export interface UsageTokens {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number | null;
  cache_read_tokens?: number;
  cache_write_5m_tokens?: number;
  cache_write_1h_tokens?: number;
}

export interface CostBreakdown {
  input_cost_usd: number | null;
  output_cost_usd: number | null;
  cache_cost_usd: number | null;
  saved_cache_cost_usd: number | null;   // cache ROI: what the reads would have cost uncached
  estimated_usd: number | null;
  cost_status: 'priced' | 'unknown_model';
}

const _warnedUnknownModels = new Set<string>();

/**
 * Per-call cost, keyed off the RESOLVED model (§4.4). Buckets are summed so the
 * breakdown reconciles to the total. An unknown model yields cost_status
 * 'unknown_model' with NULL costs (logged once per model) so reports can exclude
 * it rather than silently summing zero. A gateway-reported total, when present,
 * takes precedence over the locally-computed sum.
 *
 * reasoning_output_tokens is a SUBSET of output_tokens, so it is priced by
 * SPLITTING output (non-reasoning at rate.output, reasoning at rate.reasoningOutput)
 * — never added on top, which would double-count.
 */
export function computeCost(
  usage: UsageTokens,
  resolvedModel: string,
  opts?: { pricing?: Record<string, ModelRate>; gatewayReportedUsd?: number | null },
): CostBreakdown {
  const pricing = opts?.pricing ?? PRICING;
  // The CLI reports a DATED model id (e.g. claude-haiku-4-5-20251001) while
  // PRICING is keyed by the alias (claude-haiku-4-5). Try the exact id, then fall
  // back to the date-suffix-stripped alias. Found by the B11 live E2E.
  const rate = pricing[resolvedModel] ?? pricing[resolvedModel.replace(/-\d{6,8}$/, '')];
  if (!rate) {
    if (!_warnedUnknownModels.has(resolvedModel)) {
      _warnedUnknownModels.add(resolvedModel);
      console.warn(
        `[pricing] unknown resolved_model "${resolvedModel}" — cost left NULL ` +
        `(cost_status=unknown_model). Add it to PRICING in config.ts.`,
      );
    }
    return {
      input_cost_usd: null, output_cost_usd: null, cache_cost_usd: null,
      saved_cache_cost_usd: null, estimated_usd: null, cost_status: 'unknown_model',
    };
  }

  const inputTok = usage.input_tokens ?? 0;
  const outputTok = usage.output_tokens ?? 0;
  const reasoningTok = usage.reasoning_output_tokens ?? 0;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const cw5 = usage.cache_write_5m_tokens ?? 0;
  const cw1 = usage.cache_write_1h_tokens ?? 0;

  const nonReasoningOutput = Math.max(outputTok - reasoningTok, 0);
  const input_cost_usd = (inputTok * rate.input) / 1e6;
  const output_cost_usd =
    (nonReasoningOutput * rate.output + reasoningTok * (rate.reasoningOutput ?? rate.output)) / 1e6;
  const cache_cost_usd =
    (cacheRead * (rate.cacheRead ?? 0)
      + cw5 * (rate.cacheWrite5m ?? 0)
      + cw1 * (rate.cacheWrite1h ?? 0)) / 1e6;
  const saved_cache_cost_usd = (cacheRead * rate.input) / 1e6;

  const gw = opts?.gatewayReportedUsd;
  const estimated_usd =
    gw !== undefined && gw !== null ? gw : input_cost_usd + output_cost_usd + cache_cost_usd;

  return { input_cost_usd, output_cost_usd, cache_cost_usd, saved_cache_cost_usd, estimated_usd, cost_status: 'priced' };
}

/**
 * Blended $/MTok for a model under BLENDED_WEIGHTS (default 1:2 input:output).
 * Returns 0 for an unknown model. NOTE: token-mix-blended and CACHE-BLIND —
 * report input/output/cache multipliers separately where the mix matters.
 */
export function blendedRate(model: string, pricing: Record<string, ModelRate> = PRICING): number {
  const rate = pricing[model];
  if (!rate) return 0;
  const { input: wi, output: wo } = BLENDED_WEIGHTS;
  return (rate.input * wi + rate.output * wo) / (wi + wo);
}

/**
 * Blended cost multiplier of `model` versus the baseline (default BASELINE_MODEL).
 * Returns 1 when both rates compute to 0; 0 when only the baseline is unknown
 * (no meaningful ratio). Same token-mix / cache-blind caveats as blendedRate.
 */
export function multiplier(
  model: string,
  baselineModel: string = BASELINE_MODEL,
  pricing: Record<string, ModelRate> = PRICING,
): number {
  const base = blendedRate(baselineModel, pricing);
  const m = blendedRate(model, pricing);
  if (base === 0) return m === 0 ? 1 : 0;
  return m / base;
}

// ===========================================================================
// Cost controls (token-usage epic — nmemo-6do, B10). An ADVISORY layer over
// capture (design §6): capture (B1-B8) works with these absent or disabled, and
// nothing here ever blocks an insert or a response. True mid-flight USD
// enforcement is deferred to the future per-call gateway architecture — today
// each agent endpoint is one opaque subprocess, so the platform only sees a
// trace's cost AFTER it completes.
// ===========================================================================

/** Optional per-request USD ceiling (env COST_CEILING_USD). null = disabled. */
export const COST_CEILING_USD_PER_REQUEST: number | null = config.COST_CEILING_USD ?? null;

export interface OperationBudget {
  maxUsd: number;
  maxCalls: number;
}

/**
 * Per-operation daily budgets for advisory alerting on llm_usage rollups, keyed
 * by the `operation` taxonomy. Empty by default — a deployment fills it in. When
 * a day's rollup for an operation exceeds maxUsd or maxCalls, a structured error
 * is LOGGED (never blocks). The budget-check helper accepts an override so tests
 * can inject thresholds.
 */
export const OPERATION_DAILY_BUDGETS: Partial<Record<Operation, OperationBudget>> = {};
