# Token Usage & Cost Tracking — Design

Status: **Design** (no code yet). Author: platform team. Last updated: 2026-06-16.

This document specifies how Mnemo will capture, persist, price, and report LLM
token usage across the whole system. It is a design specification, not an
implementation. Everything below describes *what we will build* so a later
implementation pass (or a beads epic) can be driven without ambiguity.

> **Revision note (2026-06-16):** this revision folds in the companion hardening
> review ([`01-hardening-review.md`](./01-hardening-review.md)) — a multi-agent
> fleet check against the live repo and primary vendor/standard docs. It corrects
> the two blocking errors found (the capture mechanism and the cache-token
> accounting), fixes the call graph, pricing rows, and file paths, and absorbs the
> SOTA strengthenings (OpenTelemetry GenAI alignment, gateway reconciliation,
> resolved-model capture, per-bucket cost, cost-status flags) and the structural
> risks (write-path shape, retention, PII, cost ceilings, cache-write TTL split,
> streaming). Items the review marked unverifiable were dropped.

> **Decoupling review (2026-06-16):** a follow-up maintainability pass hardened
> three boundaries so the tracker doesn't become a maintenance burden. (1) Pricing
> is **single-source-of-truth in TypeScript** (4.4) — ml-services never prices.
> (2) `ResourcePool` **stays generic** (4.1) — the per-request accumulator is a
> normal argument to the provider callable, not a pool kwarg, so the pool stays
> usage-agnostic. (3) Cost **enforcement is separated from capture** (6) — the
> accumulator is pure capture and never raises; the per-trace ceiling is a separate
> optional guard that reads the running total. It also added a schema-drift guard
> for the hand-synced `llm_usage` table (4.3) and made `operation` a single enum
> imported by every call site (4.7).

---

## 1. Context

Mnemo makes many LLM calls per ingest and per query — the graph agent (which does
extraction), the reasoning/query agent, reconciliation, the gardener, drift
investigation, the benchmark judge, and embeddings. **None of their token usage is
recorded.** Usage is read off the provider response in two places and then
discarded:

- `ml-services/app/core/llm.py`
  - `ClaudeCodeProvider` parses `input_tokens` / `output_tokens` /
    `estimated_usd` from the Claude CLI JSON envelope and writes a single log
    line (around `llm.py:296-303`).
  - `ZAIProvider` never reads `response.usage` — the usage is discarded at the
    return (`llm.py:425`; method body `:403-430`).
  - `PiBridgeProvider` logs usage but does not return it.
- `platform/src/services/pi-agent-bridge.ts`
  - `BridgeResponse.cost` carries rich usage (input / output / cache-read /
    cache-write tokens, estimated USD, tool-call count, turn count) around
    `pi-agent-bridge.ts:293-301, 555-567`, but nothing downstream persists it.

The usage is **lost at the HTTP boundary**. Every ml-services response model
(`/chat`, `/graph-agent`, `/reasoning-agent`, `/gardener-agent`,
`/reconciliation-agent`, `/embed`, and the test-only `/extract-entities` /
`/extract-relationships`) omits usage, so the TypeScript platform never receives
it. There is **no database table** for usage or cost (verified against
`platform/src/db/schema.ts`), and the benchmark run envelopes
(`benchmarks/_common/results.py`) record only accuracy and timing.

The closest existing thing is `fact_predicates.usage_count`, which counts how
many facts use a predicate — unrelated to LLM tokens.

### Why now

We are moving toward a **multi-model routing architecture**: a self-hosted
LiteLLM gateway routing across cheap open-weight models (DeepSeek V4 Flash/Pro,
MiMo V2.5 Pro, Qwen, GLM, Kimi, MiniMax), proprietary mid-tier models (Gemini
3.x, GPT-5.4 mini), and Claude as premium escalation. Choosing models per-agent
and proving the savings is impossible without measured, per-operation,
per-model, per-provider token and cost data.

This design is the instrumentation that makes cost estimation and optimisation
possible. It must be **model- and provider-aware from day one**, and pricing
must be expressed as **configurable, versioned multipliers** rather than
hardcoded Claude rates — because the prices move fast and we will be comparing
many models. It must also **reconcile against the gateway's own cost ledger**
once LiteLLM lands (see 4.6), not silently diverge from it.

---

## 2. Goals and non-goals

### Goals

1. Capture **every** LLM call's usage: requested + resolved model, provider, the
   token buckets (input / output / cache-read / cache-write-5m / cache-write-1h,
   plus reasoning output where applicable), tool-call count, turn count, latency.
2. Persist durably in a new `llm_usage` table, queryable across production and
   benchmarks and over time.
3. Compute a per-bucket cost breakdown and `estimated_usd` from a **versioned,
   config-driven pricing map** keyed by resolved model id (and provider) — and,
   when a gateway reports authoritative cost, store and prefer that.
4. Roll up usage per **benchmark run** into the `RunEnvelope`, accumulated
   in-memory from echoed per-response usage (must survive `/api/reset`, which
   wipes Postgres between questions).
5. Support **per-operation / per-model / per-provider** cost reporting and
   **blended cost multipliers** versus a baseline model — the lever for routing
   decisions and scale projections — with every rollup surfacing the share of
   calls/tokens that are unpriced or estimated.
6. Be **forward-compatible** with the LiteLLM routing future: one normalised
   usage record plus per-provider adapters and an OpenTelemetry-GenAI-aligned
   field vocabulary, so adding a model or provider is a config change, not new
   plumbing, and so a future OTel exporter is a projection rather than a
   migration.

### Non-goals (for this design)

- **Live price verification.** The non-Claude seed rates come from a mid-2026
  market analysis. They are marked *verify before billing use*. Re-pricing is a
  one-file edit plus a version bump.
- **Building the LiteLLM gateway**, ZDR routing, or PII redaction. This design
  only ensures the tracker drops cleanly into that future and never stores raw
  content.
- **Non-LLM infrastructure cost** (vector DB, graph storage, GPU/serving
  compute). At low per-user volume this is the larger cost, but it is out of
  scope for token tracking.

---

## 3. Current call graph

High-level operations and where each one calls an LLM (corrected against the live
pipeline):

```
/ingest
  store(text)
    embed(text)                  -> POST /embed         -> Ollama nomic-embed-text   (no usage from API)
  extract(memoryId)
    invokeGraphAgent()           -> POST /graph-agent   -> llm.py provider           (usage logged, lost)
                                    (the unified ORIENT/EXTRACT/RELATE/CAUSE/VERIFY agent;
                                     this is the SOLE extraction LLM path)

/api/reason/query
  invokeReasoningAgent()         -> POST /reasoning-agent -> llm.py provider          (usage logged, lost)

background
  invokeGardenerAgent()          -> POST /gardener-agent
  invokeReconciliationAgent()    -> POST /reconciliation-agent
  drift investigation            -> reasoning/agent calls

benchmark only
  Judge.score()                  -> `claude -p` subprocess (Sonnet)                   (separate from platform)

legacy / test-only (NOT on the live extract path):
  /extract-entities, /extract-relationships  -> invoked only from platform/src/test/services/ml-client.test.ts
  /chat                                       -> no fact-extraction call in the live extract path
```

`llm.py` providers: `ClaudeCodeProvider` (subprocess to the Claude CLI),
`PiBridgeProvider` (HTTP to `pi-agent-bridge.ts`), `ZAIProvider` (OpenAI-
compatible HTTP to Z.AI). Embeddings go through Ollama, which returns no token
usage.

> Correction (was wrong in the first draft): `extract()` calls **only**
> `invokeGraphAgent()` (`platform/src/pipeline.ts:500`). The earlier draft showed
> separate `/extract-entities`, `/extract-relationships`, and a `/chat` fact call
> on the extract path; those endpoints exist but are invoked only from test code
> (`platform/src/test/services/ml-client.test.ts:190,199`). The operation taxonomy
> (4.7) is split into active vs reserved accordingly.

---

## 4. Design

### 4.1 Normalised usage record (core abstraction)

A single provider-agnostic shape that every LLM call produces. This is the
contract that survives the multi-model migration.

```
UsageRecord = {
  requested_model:        str          # model id we asked for (alias/group ok)
  resolved_model:         str          # model that actually served (== requested for non-gateway providers)
  model_group:            str | None   # routing alias, when a gateway resolves one
  provider:               str          # anthropic | zai | ollama | deepinfra | together | fireworks | google | openai | litellm
  input_tokens:           int          # UNCACHED input remainder (normalisation contract below)
  output_tokens:          int
  reasoning_output_tokens: int | None  # subset of output; reasoning models only
  cache_read_tokens:      int
  cache_write_5m_tokens:  int          # Anthropic 5-min-TTL cache writes
  cache_write_1h_tokens:  int          # Anthropic 1-hour-TTL cache writes (priced 2x base input)
  tool_calls:             int | None   # agent loop length; agents only
  turns:                  int | None
  latency_ms:             int | None
  request_id:             str | None   # upstream provider request id if exposed
  gateway_request_id:     str | None   # LiteLLM call id, for SpendLogs reconciliation
  gateway_reported_usd:   float | None # authoritative cost when the gateway returns one
}
```

**Per-provider normalisation contract (resolves the blocking cache-accounting
bug).** The four token buckets must *sum to the billed total*, which means
`input_tokens` is the **uncached remainder**, never the full prompt:

- **Anthropic-shaped** (Claude CLI, Pi bridge): `input_tokens` is already the
  uncached remainder, and `cache_read` / `cache_creation` are separate. Map
  straight through; map `cache_creation.ephemeral_5m_input_tokens` and
  `ephemeral_1h_input_tokens` to the two cache-write buckets.
- **OpenAI-shaped** (ZAI today; LiteLLM/OpenRouter tomorrow): the provider's
  `prompt_tokens` is the **total** prompt and `prompt_tokens_details.cached_tokens`
  is a **subset** of it, not an addend. Adapters MUST compute
  `input_tokens = prompt_tokens - cached_tokens` and `cache_read_tokens = cached_tokens`.
  A per-adapter unit test asserts `input_tokens + cache_read_tokens` equals the
  provider's reported `prompt_tokens` on a captured sample.

Read usage and cost from the response **body** — for streamed responses the
final SSE chunk's `usage` object, never an HTTP header (LiteLLM and OpenRouter do
not return the cost header on streamed calls).

**Provider adapters** populate the record, in `llm.py`:

- `ClaudeCodeProvider` — parse the CLI cost envelope it already reads.
- `PiBridgeProvider` — map the bridge's `cost` object (cache, tool-call count,
  turn count) into the split buckets.
- `ZAIProvider` — **read `response.usage`** (currently discarded) and apply the
  OpenAI-shaped remainder rule above.
- Ollama embeddings — the API returns no usage; record `input_tokens` from the
  model tokenizer (preferred) or a characters/4 estimate, set `provider = "ollama"`,
  `token_source = "estimated"`, `cost_status = "local_zero"`, and cost 0.
- **Future LiteLLM** — read usage + authoritative cost from the gateway response
  (`gateway_reported_usd`, `gateway_request_id`), plus `resolved_model` /
  `model_group`. No other code changes.

**Capture mechanism (replaces the broken contextvar premise).** The first draft
assumed a request-scoped `ContextVar` set in a FastAPI dependency would be visible
where usage is read. It is **not**: every LLM call dispatches through
`ResourcePool.submit(...)`, whose long-lived worker tasks are created once at pool
startup (`asyncio.create_task(self._worker(i))`, `concurrency.py:66`) and run
providers via `await asyncio.to_thread(fn, ...)` (`:73-79`). A ContextVar set in
the request runs in a different context than the worker, so it is invisible at
capture, and the 6 shared workers (`ML_LLM_WORKERS=6`, `:26`) would interleave
usage across concurrent requests.

Instead, **pass an explicit per-request accumulator object as a normal argument to
the provider callable** handed to `submit()`: the request handler creates an
accumulator, passes it into each `submit(fn, …, accumulator)` call, and each
provider adapter appends its `UsageRecord` to that exact object after a successful
call. **`ResourcePool` is not modified** — `submit(fn, *args, **kwargs)`
(`concurrency.py:91`) already forwards args/kwargs verbatim into the worker's
`to_thread(fn, …)` (`:79`), so the accumulator reaches the provider untouched and
the pool stays generic and usage-agnostic (it is shared by `ollama_pool` and
`llm_pool`; a token-tracking concern must not leak into it). Do **not** add an
`accumulator` kwarg to the pool. (A `contextvars.copy_context()` variant is
possible but unnecessary — the explicit argument is simpler and keeps the pool
oblivious.) A concurrency test fires N parallel `/graph-agent`
requests and asserts each response's `usage.calls` contains only its own calls
(no cross-request bleed). See 4.7 — only operations on the live call graph get an
accumulator wired in.

### 4.2 HTTP echo

Every ml-services response gains a `usage` field built from the per-request
accumulator:

```json
"usage": {
  "calls": [ /* UsageRecord, ... */ ],
  "totals": { "input": 0, "output": 0, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0, "calls": 0 }
}
```

A FastAPI dependency attaches this to every response body. Usage is read from the
body (final SSE chunk for streams), never from headers.

This echo is the **only** path that works for benchmarks, because `/api/reset`
wipes Postgres between questions. Benchmark rollups are accumulated in-memory from
echoed responses during the run, never read back from the table after the fact.

### 4.3 Persistence — the `llm_usage` table

The latest migration on `feat/cognitive-platform-v1` is
`039_age_sync_no_localtimestamp.sql`, so the next is **`040_llm_usage.sql`**.

It follows the AGE search_path rule (`CLAUDE.md`): `001_consolidated.sql` sets the
session search_path to `ag_catalog, public, "$user"`, so **all DDL is explicitly
`public.`-qualified** and we do **not** change the session search_path. Both
`schema.ts` (Drizzle) and the raw `.sql` migration are updated and kept in sync by
hand; `migrate.ts` runs `.sql` files in alphabetical order. Because this is a dual
source of truth, a **schema-drift test** introspects the live `llm_usage` columns
(`information_schema`) and asserts they match the Drizzle table's column set, so the
hand-sync cannot silently rot.

**Write path (resolves the hot-path / unbounded-growth risk).** Insert **one
batched row-set per HTTP response, fire-and-forget** (mirroring the existing
fire-and-forget extraction-report insert at `platform/src/pipeline.ts:516`), not
one synchronous insert per call holding an agent-pool connection — a single
extract can be ~45 calls, an ingest ~80 windows. The canonical reporting grain is
**one row per LLM call**; the per-response echo totals are a derived convenience,
and reports group-by the table. Add a **retention/partitioning policy** (e.g.
monthly partitions, prune raw rows past N months into a rollup); `/api/reset` does
**not** clear `llm_usage` (it is observability data), so retention is the only
thing bounding growth.

**No raw content.** The table stores no prompt or completion text. `source` holds
only a structured non-content identifier (e.g. a benchmark source path) and is
optional; `memory_id` is a foreign-key-style id, never content. This keeps the
table consistent with the ZDR goal even though `/api/reset` never prunes it.

**SQL — `platform/src/db/migrations/040_llm_usage.sql`:**

```sql
-- 040_llm_usage.sql — per-call LLM token usage + estimated cost.
-- AGE search_path gotcha (CLAUDE.md): 001_consolidated.sql sets the session
-- search_path to ag_catalog, public, "$user". Every object below is explicitly
-- public.-qualified; we do NOT change the session search_path.

CREATE TABLE IF NOT EXISTS public.llm_usage (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  operation              VARCHAR(50)  NOT NULL,   -- see operation taxonomy (4.7)
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
  trace_id               VARCHAR(120),             -- correlation (see 4.5)
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
```

**Drizzle — `platform/src/db/schema.ts`** (mirrors existing patterns: uuid PK with
`.defaultRandom()`, `timestamp(..., { withTimezone: true })`, snake_case columns
mapped to camelCase TS, indexes declared in the table callback):

```ts
export const llmUsage = pgTable('llm_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  operation: varchar('operation', { length: 50 }).notNull(),
  requestedModel: varchar('requested_model', { length: 120 }).notNull(),
  resolvedModel: varchar('resolved_model', { length: 120 }).notNull(),
  modelGroup: varchar('model_group', { length: 120 }),
  provider: varchar('provider', { length: 60 }).default('unknown').notNull(),
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  reasoningOutputTokens: integer('reasoning_output_tokens'),
  cacheReadTokens: integer('cache_read_tokens').default(0).notNull(),
  cacheWrite5mTokens: integer('cache_write_5m_tokens').default(0).notNull(),
  cacheWrite1hTokens: integer('cache_write_1h_tokens').default(0).notNull(),
  totalTokens: integer('total_tokens').default(0).notNull(),
  toolCalls: integer('tool_calls'),
  turns: integer('turns'),
  latencyMs: integer('latency_ms'),
  inputCostUsd: doublePrecision('input_cost_usd'),
  outputCostUsd: doublePrecision('output_cost_usd'),
  cacheCostUsd: doublePrecision('cache_cost_usd'),
  savedCacheCostUsd: doublePrecision('saved_cache_cost_usd'),
  estimatedUsd: doublePrecision('estimated_usd'),
  gatewayReportedUsd: doublePrecision('gateway_reported_usd'),
  costSource: varchar('cost_source', { length: 12 }).default('local').notNull(),
  costStatus: varchar('cost_status', { length: 20 }).default('priced').notNull(),
  tokenSource: varchar('token_source', { length: 12 }).default('provider').notNull(),
  pricingVersion: varchar('pricing_version', { length: 20 }).default('unknown').notNull(),
  traceId: varchar('trace_id', { length: 120 }),
  gatewayRequestId: varchar('gateway_request_id', { length: 120 }),
  requestId: varchar('request_id', { length: 120 }),
  memoryId: uuid('memory_id'),
  source: varchar('source', { length: 255 }),
}, (t) => ({
  createdIdx: index('idx_llm_usage_created').on(t.createdAt),
  resolvedIdx: index('idx_llm_usage_resolved').on(t.resolvedModel),
  operationIdx: index('idx_llm_usage_operation').on(t.operation),
  providerIdx: index('idx_llm_usage_provider').on(t.provider),
  costStatusIdx: index('idx_llm_usage_coststatus').on(t.costStatus),
}));
export type LlmUsage = typeof llmUsage.$inferSelect;
export type NewLlmUsage = typeof llmUsage.$inferInsert;
```

**Writing rows.** The TS HTTP wrappers (`mlFetch` in `ml-client.ts`, the
`agentFetch` wrapper in `causal-agent.ts`) read `response.usage.calls`, compute the
per-bucket cost and `estimated_usd`, stamp `pricing_version`, set `cost_source` /
`cost_status` / `token_source`, and insert the response's rows as one batched
fire-and-forget write tagged with the `operation` (known at the call site) and an
optional `trace_id`. A helper (`platform/src/services/usage.ts`) wraps the batch
insert and the cost computation, mirroring the existing inline
`db.insert(...).values(...)` pattern.

### 4.4 Pricing model — versioned, config-driven, multiplier-capable

Pricing lives in `platform/src/config.ts` (the repo's existing config module — there
is no `platform/src/config/` directory) as an exported `PRICING` map plus helpers.
**Cost is computed in exactly one place — TypeScript.** ml-services never prices: it
emits token counts plus `cost_status` / `token_source` hints only (the lone `cost 0`
for local Ollama is a status, not a rate; today the only Python `estimated_usd` is
the value the Claude CLI itself returns, at `llm.py:300,562` — there is no rate table
in Python). There is **no Python pricing mirror** — re-pricing must stay a one-file TS
edit, and history re-prices from the stored token buckets. Rates are **USD per
1,000,000 tokens**. `ModelRate` is an **open map keyed by usage type** so
reasoning/multimodal models stay config-only, plus per-row provenance.

```ts
export const PRICING_VERSION = '2026-06-16';
export const BASELINE_MODEL  = 'claude-haiku-4-5';      // stable anchor for blended multipliers
export const BLENDED_WEIGHTS = { input: 1, output: 2 }; // blended = (in + 2*out)/3 — output-heavy; see caveat

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
```

**Cost computation** (per call). Cost is keyed off `resolved_model`. Buckets are
summed so the breakdown reconciles to the total:

```
input_cost   = input_tokens          * rate.input          / 1e6
output_cost  = output_tokens          * rate.output         / 1e6
            (+ reasoning_output_tokens * rate.reasoningOutput / 1e6, if present)
cache_cost   = ( cache_read_tokens     * (rate.cacheRead    ?? 0)
              +  cache_write_5m_tokens  * (rate.cacheWrite5m ?? 0)
              +  cache_write_1h_tokens  * (rate.cacheWrite1h ?? 0) ) / 1e6
estimated_usd = (cost_source == 'gateway' && gateway_reported_usd != null)
                ? gateway_reported_usd
                : input_cost + output_cost + cache_cost
saved_cache_cost = cache_read_tokens * rate.input / 1e6   -- what reads would have cost uncached
```

When the gateway returns authoritative cost, `cost_source = 'gateway'` and
`estimated_usd = gateway_reported_usd`; the locally-computed buckets are still
stored for reconciliation. Otherwise `cost_source = 'local'`. An unknown
`resolved_model` sets `cost_status = 'unknown_model'`, leaves costs NULL, and is
logged once — and because `cost_status` is a column (not just a log line), reports
can exclude it rather than silently summing it as zero.

**Blended multiplier** — computed in the reporting layer from `PRICING`, **never
written into prose by hand** (a CI check regenerates the illustrative table so it
cannot drift from the shipped rates):

```
blended($/MTok, m) = (rate.input * w_in + rate.output * w_out) / (w_in + w_out)
multiplier(m)      = blended(m) / blended(BASELINE_MODEL)
```

Caveats stated wherever the multiplier appears: it is **token-mix-blended**
(the 1:2 output weighting, used because agentic loops are output-heavy, is the
opposite mix from 4.6's 70/30 ingest assumption — report input/output/cache
multipliers separately when the mix matters) and **cache-blind** (it ignores the
lever where the Claude-vs-cheap delta narrows; report a separate cache-adjusted
figure for cache-heavy operations). The baseline is anchored to Haiku 4.5 — a
stable Anthropic row — rather than the most volatile cheap model, so re-pricing
one cheap row doesn't shift every reported multiplier.

### 4.5 Benchmark integration

- `TokenAccumulator` in `benchmarks/longmemeval/run.py`. In the per-question loop,
  it sums the `usage.totals` echoed by each `client.ingest()` and `client.query()`
  call into per-operation, per-model buckets across the whole run. It is pure
  in-memory, so it survives `/api/reset` between questions.
- **Judge usage** (Sonnet, the `claude -p` subprocess in
  `benchmarks/_common/judge.py`) is not a platform call, and the current judge
  invocation has **no cost envelope** — it runs `claude -p --model ... --effort low
  --no-session-persistence` and regex-extracts the model's `{score, reasoning}`
  from plain stdout (`judge.py:84-93, 111-143`). To capture judge cost, `judge.py`
  MUST add `--output-format json`, and `_parse_verdict` splits into an
  envelope-parse (`result` + `cost`, as `ClaudeCodeProvider` does at
  `llm.py:164-170, 287/294`) then a verdict-parse of the `{score,reasoning}` now
  inside `envelope.result`. Verify the dated CLI on the runner returns a `cost`
  field at `--effort low`.
- **trace_id wire path.** The benchmark runner and platform are separate processes
  over HTTP, and `client.ingest()` / `client.query()` send no run id
  (`client.py:65-72,84`), so `llm_usage.trace_id` cannot carry a benchmark-run id
  as-is. Either (a) have the benchmark client send an `X-Mnemo-Trace-Id` header on
  every `/ingest` and `/api/reason/query`, plumbed into the insert; or (b) scope
  `trace_id` to platform-internal ingest-batch correlation only and state that
  benchmark-run correlation lives in the in-memory accumulator and the
  `RunEnvelope`, not the table. Pick one explicitly (see open questions).
- `RunEnvelope` (`benchmarks/_common/results.py`) gains three fields before
  `notes` (default-valued, so older run JSONs still deserialize):

  ```python
  token_usage: dict[str, Any] = field(default_factory=dict)
  # shape: {operation: {model: {input, output, cache_read, cache_write_5m, cache_write_1h, calls, tool_calls}}}
  estimated_cost_usd: float   = 0.0
  pricing_version: str        = ""
  ```

  `write_run()` gains matching optional parameters.

### 4.6 Reporting and projection

The table plus the envelope answer:

- **Realised cost** per run, per operation, per resolved model, per provider, over
  time (SQL group-bys on `llm_usage`; per-run figures from the envelope). Every
  rollup also reports the **share of calls/tokens that are unpriced or estimated**
  (`cost_status != 'priced'` or `token_source = 'estimated'`) so an unrouted model
  or estimated embedding count never silently deflates a total.
- **Blended multipliers** versus the baseline model (generated from `PRICING`,
  with the token-mix and cache caveats above), to decide which model to route each
  agent to.
- **Provider split** — double duty: cost, and ZDR/privacy auditing (how many
  tokens each provider saw). This supports the planned ZDR routing architecture.
- **Gateway reconciliation (LiteLLM future).** LiteLLM computes authoritative
  per-call cost and exposes it inline (`x-litellm-response-cost`, `x-litellm-call-id`,
  `response_cost` in callbacks) plus a `SpendLogs` ledger keyed by request id;
  OpenRouter returns `usage.cost` inline. Store `gateway_request_id` and
  `gateway_reported_usd`, treat gateway cost as authoritative when present, keep
  `PRICING` as the fallback pricer and historical re-pricing tool, and register the
  same rates in LiteLLM config (with `base_model` mapping where the routed id
  differs from the response id) so custom pricing actually applies. Add a
  reconciliation check: summed `gateway_reported_usd` for a trace equals the
  SpendLogs spend. To make per-operation attribution work at the gateway, each
  provider call forwards the taxonomy as metadata
  (`extra_body.metadata = {tags:[operation, trace_id], spend_logs_metadata:{...}}`);
  consider per-agent virtual keys so tags and budgets attach automatically.
- **Scale projection.** Measured per-operation token *profiles* (from benchmark
  envelopes) multiplied by usage assumptions (daily active users, windows per day,
  books per year) give $/user/year and $/N-users/month. This is the empirical
  replacement for hand-estimated economics. The illustrative tables below are
  **ILLUSTRATIVE — NOT FOR BUDGETING.**
- (Optional, not built) a usage panel in the existing viz dashboard.

#### Per-agent model allocation (target routing, from the analysis — illustrative)

| Agent / task | Loop size | Candidate model |
|---|---|---|
| Graph extraction (the live extract path) | ~45 calls | MiMo V2.5 Pro / DeepSeek V4 Pro |
| Reasoning / query (hardest) | 40-100 calls | Gemini 3.5 Flash / GPT-5.4 mini, escalate to Sonnet |
| Reconciliation | ~50 calls | MiMo V2.5 Pro / DeepSeek V4 Pro |
| Gardener (background) | ~80 calls | DeepSeek V4 Flash / Qwen (off-peak) |
| Drift (scoped) | ~8-30 calls | DeepSeek V4 Flash |
| Embeddings | per chunk | self-hosted (privacy) or Google text-embedding |
| Judge (benchmark only) | single-shot | Claude Sonnet 4.6 |

#### Cost-per-user-year, book-a-year workload — ILLUSTRATIVE, NOT FOR BUDGETING

Assumes ~500k billed tokens/user/year (~70% input, ~30% output). Directional only;
the tracker exists to replace these with measured profiles, and at least two seed
rows in the candidate set were wrong in the first draft.

| Architecture | $/user/yr (illustrative) | vs Haiku baseline |
|---|---|---|
| Claude Sonnet 4.6 only | ~$3.30 | 3.0x |
| Claude Haiku 4.5 (current baseline) | ~$1.10 | 1.0x |
| Multi-model routed (target) | ~$0.29 | 0.26x |
| MiMo/DeepSeek cheap-heavy | ~$0.17 | 0.15x |

> These tables are reproduced from a mid-2026 market analysis and are **not for
> budgeting**. Once the tracker is live, per-operation token profiles from real
> benchmark runs replace the assumed token counts, and the pricing map replaces the
> assumed rates.

### 4.7 Operation taxonomy

`operation` is a closed vocabulary so reports group cleanly. It is **defined once**
(an enum/const in `platform/src/config.ts`, imported by every call site) rather than
string literals scattered across handlers, so adding or renaming an operation is a
one-place edit. It is split into operations that **are currently invoked** (wire
capture into these) versus **reserved/future** (no capture until the call path is
live, so reports never show empty dimensions):

- **Active:** `graph_agent` (the live extraction path), `reasoning_agent` (query),
  `reconciliation_agent`, `gardener_agent`, `drift`, `judge` (benchmark only),
  `embed.document`, `embed.query`.
- **Reserved / future:** `extract.entities`, `extract.relationships`,
  `extract.facts` (the standalone `/extract-*` and `/chat` endpoints are test-only
  today), `summarize`, `classify`.

### 4.8 OpenTelemetry GenAI field mapping

Field names align 1:1 with the OpenTelemetry GenAI semantic conventions so a future
OTel exporter is a projection, not a migration. The operation taxonomy is a separate
Mnemo domain dimension layered on top.

| `llm_usage` / UsageRecord | OTel GenAI attribute |
|---|---|
| `requested_model` | `gen_ai.request.model` |
| `resolved_model` | `gen_ai.response.model` |
| `provider` | `gen_ai.provider.name` (replaced the deprecated `gen_ai.system`) |
| `request_id` / `gateway_request_id` | `gen_ai.response.id` |
| `input_tokens` | `gen_ai.usage.input_tokens` * |
| `output_tokens` | `gen_ai.usage.output_tokens` |
| `reasoning_output_tokens` | `gen_ai.usage.reasoning.output_tokens` |
| `cache_read_tokens` | `gen_ai.usage.cache_read.input_tokens` |
| `cache_write_5m_tokens` / `cache_write_1h_tokens` | `gen_ai.usage.cache_creation.input_tokens` (split by TTL) |
| `operation` | `gen_ai.operation.name` + a `mnemo.operation` sub-attribute |

\* **Inclusion-semantics decision:** OTel says `gen_ai.usage.input_tokens` SHOULD
*include* cached tokens (a superset). This design deliberately stores the **uncached
remainder** so the buckets sum to the billed total for cost (4.1). The mapping
therefore notes the convention difference explicitly: our `input_tokens` =
OTel `input_tokens - cache_read_tokens`. An exporter adds them back to emit
OTel-compliant values.

---

## 5. Implementation surface (build targets, not built this round)

Named here so a later implementation pass or beads epic is unambiguous:

- `ml-services/app/core/llm.py` — `UsageRecord` and per-provider adapters; fix
  `ZAIProvider` to read `response.usage` with the OpenAI remainder rule; the
  explicit per-request accumulator passed as an argument to each provider adapter
  (the pool is untouched).
- `ml-services/app/core/concurrency.py` — **no change.** `submit(fn, *args,
  **kwargs)` already forwards args/kwargs verbatim into the worker call, so the
  accumulator rides as a normal argument to the provider callable. Do not add
  usage-specific params to the pool; a passthrough test confirms the forward.
- `ml-services/app/main.py` and each router — a FastAPI dependency that creates the
  accumulator and attaches `usage` (read from the body) to every response.
- `platform/src/services/ml-client.ts` and the `agentFetch` wrapper in
  `causal-agent.ts` — read `response.usage`, compute cost, batch-insert rows
  fire-and-forget.
- `platform/src/services/usage.ts` (new) — batch insert helper and cost
  computation.
- `platform/src/config.ts` — the `PRICING` map, `ModelRate`, multiplier helpers, and
  the single `operation` enum (no new `config/` directory). This is the **only** place
  cost is priced; ml-services never prices.
- `platform/src/db/schema.ts` and `platform/src/db/migrations/040_llm_usage.sql`.
- `platform/src/pipeline.ts` and the query handler — sum usage into `IngestResult`
  and the query response (the echo benchmarks consume), fire-and-forget the rows.
- `benchmarks/_common/results.py` — `RunEnvelope` fields + `write_run()` params.
- `benchmarks/_common/judge.py` — add `--output-format json`; split
  `_parse_verdict` into envelope-parse then verdict-parse.
- `benchmarks/_common/client.py` and `benchmarks/longmemeval/run.py` — the
  `TokenAccumulator`, and the `X-Mnemo-Trace-Id` header if we choose option (a) for
  trace correlation.

## 6. Cost controls (separate layer over capture)

A single runaway agent loop (reasoning 40-100 calls, gardener ~80) can burn budget
with no ceiling. The per-request accumulator already knows running cost mid-request —
but **enforcement is kept separate from capture**: the accumulator stays pure capture
(it appends `UsageRecord`s and exposes a running total; it never raises), so a capture
bug can only ever lose a metric, never abort a production agent loop.

- A **per-trace USD ceiling** is a thin, optional guard that *reads* the accumulator's
  running total after each call and aborts the loop when exceeded (config-driven; off
  by default in dev). It lives outside the capture write-path, carried on the
  per-request accumulator the handler constructs — **not** threaded through
  `ResourcePool.submit()` (the pool stays usage-agnostic, see 4.1).
- **Budgets and alerting** on the `llm_usage` rollups (per provider, per operation,
  per day) are fire-and-forget and advisory — they never block an insert or a response.
- Capture (4.1-4.3) must work with enforcement absent or disabled; the ceiling and
  budgets land as their own bead after capture is proven, not before.

## 7. Known limitations

- **Ollama embeddings expose no real token usage.** Recorded with
  `token_source = 'estimated'` and `cost_status = 'local_zero'`, at zero cost. The
  estimate uses the nomic tokenizer where available (characters/4 is a fallback and
  is off by ~2x for code/transcripts/CJK); reports exclude estimated tokens from
  billable totals.
- **Non-Claude seed prices are volatile** and vendor- or aggregator-reported,
  marked `verified: 'estimated'` with `asOf`/`sourceUrl`. Re-pricing is a config
  edit plus a `PRICING_VERSION` bump; history re-prices from the stored token
  buckets.
- **Cache-token semantics differ per provider.** The normalisation contract (4.1)
  defines `input_tokens` as the uncached remainder for both Anthropic- and
  OpenAI-shaped providers; per-adapter tests enforce it.
- **Infrastructure cost is out of scope.** At low per-user volume the vector DB,
  graph storage, and serving compute dominate the bill; this design tracks only LLM
  tokens.

## 8. Verification (once built)

- **Unit:** the per-bucket cost formula (incl. 5m/1h cache split) and the
  blended-multiplier math; each provider adapter parses a captured sample response
  correctly; the OpenAI-shaped adapter asserts `input_tokens + cache_read_tokens ==
  prompt_tokens`; a streamed-response case reads usage/cost from the final SSE chunk.
- **Concurrency:** fire N parallel `/graph-agent` requests and assert each
  response's `usage.calls` contains only its own calls (no cross-request bleed).
- **Integration:** one `/ingest` and one `/api/reason/query` against a running ML
  service produce rows in `llm_usage` with non-zero tokens and `estimated_usd`; the
  summed rows equal the echoed `usage.totals`.
- **Benchmark:** a **multi-question** `run.py` (reset enabled) produces an envelope
  carrying `token_usage`, `estimated_cost_usd`, and `pricing_version`; on a
  single-question run with reset disabled, cross-check the accumulator against
  `llm_usage`.
- **Gateway (when LiteLLM lands):** summed `gateway_reported_usd` for a trace
  reconciles against the LiteLLM `SpendLogs` spend for the same request ids.

## 9. Open questions (resolve before implementation)

These supersede the first draft's open questions; the two blocking items gate code.

1. **Capture mechanism (blocking).** Confirm the explicit per-request accumulator
   threaded through `ResourcePool.submit()` (vs `copy_context()` in `submit()`),
   and land the concurrency test first.
2. **Token-normalisation contract (blocking).** Confirm `input_tokens` = uncached
   remainder everywhere, with the OpenAI-shaped conversion
   (`input = prompt_tokens - cached_tokens`) and its per-adapter test.
3. **Gateway authority/reconciliation.** Confirm `gateway_reported_usd` is
   authoritative with `PRICING` as fallback, and the `gateway_request_id` ->
   `SpendLogs` join.
4. **trace_id wire path.** `X-Mnemo-Trace-Id` header from the benchmark client, or
   scope `trace_id` to platform-internal batches with run correlation in the
   envelope only?
5. **Cache-write TTL + batch mode.** Keep the 5m/1h split (done here); decide
   whether to add a `pricing_mode` (standard/batch) dimension given the judge and
   background agents are batchable at ~50% off.
6. **Retention/partitioning.** Concrete policy for `llm_usage` growth (it is never
   pruned by `/api/reset`).
7. **Cost ceilings.** Final per-trace USD ceiling values and where alerting lands.
