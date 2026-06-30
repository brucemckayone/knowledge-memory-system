-- 050_llm_usage.sql — per-call LLM token usage + estimated cost.
--
-- The canonical reporting grain is ONE ROW PER LLM CALL. The per-response echo
-- totals (ml-services) are a derived convenience; reports group-by this table.
-- Rows are written batched + fire-and-forget from the TS HTTP wrappers (B7);
-- ml-services never prices — cost is computed in config.ts PRICING (B6).
--
-- AGE search_path gotcha (CLAUDE.md): 001_consolidated.sql sets the session
-- search_path to ag_catalog, public, "$user". Every object below is explicitly
-- public.-qualified and we do NOT change the session search_path (AGE triggers
-- + cypher() depend on it). See 049_ios_milestone1.sql for the same pattern.
--
-- /api/reset and /api/viz/clear do NOT prune this table — it is observability
-- data, never app state (verified: not in CLEARABLE_TABLES, index.ts:1237). The
-- table stores NO raw prompt/completion text: `source` is a structured
-- non-content identifier only, `memory_id` is an id, never content.
--
-- OpenTelemetry GenAI field mapping (design §4.8) — names align 1:1 so a future
-- OTel exporter is a projection, not a migration:
--   requested_model        -> gen_ai.request.model
--   resolved_model         -> gen_ai.response.model
--   provider               -> gen_ai.provider.name
--   request_id / gateway_request_id -> gen_ai.response.id
--   input_tokens           -> gen_ai.usage.input_tokens *
--   output_tokens          -> gen_ai.usage.output_tokens
--   reasoning_output_tokens -> gen_ai.usage.reasoning.output_tokens
--   cache_read_tokens      -> gen_ai.usage.cache_read.input_tokens
--   cache_write_5m/1h_tokens -> gen_ai.usage.cache_creation.input_tokens (split by TTL)
--   operation              -> gen_ai.operation.name + a mnemo.operation sub-attribute
-- * Inclusion-semantics: OTel's input_tokens INCLUDES cached tokens; we store the
--   UNCACHED remainder so buckets sum to the billed total (design §4.1). An
--   exporter re-adds: OTel input_tokens = our input_tokens + cache_read_tokens.

CREATE TABLE IF NOT EXISTS public.llm_usage (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  operation              VARCHAR(50)  NOT NULL,   -- closed taxonomy (config.ts operation enum, §4.7)
  requested_model        VARCHAR(120) NOT NULL,
  resolved_model         VARCHAR(120) NOT NULL,   -- priced off this; == requested for non-gateway
  model_group            VARCHAR(120),            -- routing alias when a gateway resolves one
  provider               VARCHAR(60)  NOT NULL DEFAULT 'unknown',
  input_tokens           INTEGER NOT NULL DEFAULT 0,   -- uncached remainder
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER,                 -- subset of output; reasoning models
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens           INTEGER NOT NULL DEFAULT 0,
  tool_calls             INTEGER,
  turns                  INTEGER,
  latency_ms             INTEGER,
  input_cost_usd         DOUBLE PRECISION,
  output_cost_usd        DOUBLE PRECISION,
  cache_cost_usd         DOUBLE PRECISION,
  saved_cache_cost_usd   DOUBLE PRECISION,         -- cache ROI: what reads would have cost uncached
  estimated_usd          DOUBLE PRECISION,         -- total; = gateway_reported_usd when present
  gateway_reported_usd   DOUBLE PRECISION,         -- authoritative when the gateway returns one
  cost_source            VARCHAR(12) NOT NULL DEFAULT 'local',     -- gateway | local | estimate
  cost_status            VARCHAR(20) NOT NULL DEFAULT 'priced',    -- priced | local_zero | unknown_model | no_usage_reported | estimated
  token_source           VARCHAR(12) NOT NULL DEFAULT 'provider',  -- provider | estimated
  pricing_version        VARCHAR(20) NOT NULL DEFAULT 'unknown',
  trace_id               VARCHAR(120),             -- platform-internal ingest-batch correlation (§4.5 option b)
  gateway_request_id     VARCHAR(120),             -- LiteLLM call id, joins to SpendLogs
  request_id             VARCHAR(120),
  memory_id              UUID,                     -- non-content id only
  source                 VARCHAR(255)              -- structured non-content identifier; no raw text
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_created    ON public.llm_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_resolved   ON public.llm_usage (resolved_model);
CREATE INDEX IF NOT EXISTS idx_llm_usage_operation  ON public.llm_usage (operation);
CREATE INDEX IF NOT EXISTS idx_llm_usage_provider   ON public.llm_usage (provider);
CREATE INDEX IF NOT EXISTS idx_llm_usage_coststatus ON public.llm_usage (cost_status);
CREATE INDEX IF NOT EXISTS idx_llm_usage_trace      ON public.llm_usage (trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_usage_gwreq      ON public.llm_usage (gateway_request_id) WHERE gateway_request_id IS NOT NULL;
