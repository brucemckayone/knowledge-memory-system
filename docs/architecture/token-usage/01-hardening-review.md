# Hardening Review — Token Usage & Cost Tracking

> Companion to [`00-token-usage-and-cost-tracking.md`](./00-token-usage-and-cost-tracking.md). Produced 2026-06-16 by a multi-agent fleet review (11 agents: 5 grounding over the repo, 3 web research, 2 adversarial critics, 1 synthesis) against the live nmemo codebase and primary vendor/standard docs. The original design doc is intentionally left **unchanged** — corrections below are proposals, not applied edits.
>
> Run caveats (honesty): the `pricing-internal` grounding agent failed on a provider error, but its lens — the cost-formula bucket-summing trap — was independently caught by the correctness critic and appears in §1. The `observability-sota` research agent stalled once and was retried. Phase 1 landed 7/8 reports, 67 raw findings; after de-dup: 9 corrections, 8 strengthenings, 7 risks, 12 open questions.

This is a companion hardening review of `docs/architecture/token-usage/00-token-usage-and-cost-tracking.md` (status: design, no code). It folds six grounding/research agents and two adversarial critics, checked against the live nmemo codebase and primary vendor/standard docs (OpenTelemetry GenAI semconv, LiteLLM, Langfuse, Anthropic/OpenAI pricing). The artifact is unusually well-grounded for a pre-code doc — its current-state loss claims (usage read and discarded, lost at the HTTP boundary, no `llm_usage` table, RunEnvelope lacks cost fields) all verify precisely. But three findings are confidently wrong against the runtime and one against the cost formula, and several forward-compat gaps would bite the LiteLLM future the doc explicitly targets. After de-dup, **9 corrections, 8 strengthenings, 7 new risks, and a revised open-questions list** survived. Overall verdict: architecture is sound and should proceed; the capture mechanism (contextvar) and the judge-capture claim must be reworked before any code, and the OTel/cache normalisation decisions are near-free to make now and expensive later.

## 1. Corrections — claims grounding showed wrong or imprecise

### Request-scoped contextvar accumulator cannot capture usage as described
- **Severity: blocking**
- The doc (4.1) says a FastAPI dependency initialises a per-request accumulator and each provider call appends to "the request's accumulator." This silently assumes the provider runs in the request handler's `contextvars.Context`. It does not. Every LLM call dispatches through `ResourcePool.submit(...)`, whose long-lived worker tasks are created once at pool startup via `asyncio.create_task(self._worker(i))` and run providers via `await asyncio.to_thread(fn, ...)`. A task created with `create_task` copies the context at creation time (pool startup), and `to_thread` runs the callable in the *worker's* context — so a ContextVar set in the request dependency is invisible at the capture point. Worse, 6 shared workers (`ML_LLM_WORKERS=6`) servicing concurrent requests would interleave usage across unrelated in-flight requests.
- **Recommendation:** Drop the bare contextvar premise. Either capture `contextvars.copy_context()` in `submit()` and run `fn` under it, with the dependency setting a per-request token whose value is a mutable list captured by reference; or thread an explicit per-request accumulator object through `submit()` into `generate()`. Add a concurrency test: fire N concurrent `/graph-agent` requests and assert each `response.usage.calls` contains only its own calls.
- **Evidence:** `ml-services/app/core/concurrency.py:66` (`asyncio.create_task(self._worker(i))`), `:73-79` (`await asyncio.to_thread(fn, ...)`), `:26` (`ML_LLM_WORKERS` default 6); call sites `chat.py:34`, `graph_agent.py:824`, `reasoning_agent.py:446`. Target doc 4.1 lines 162-166.

### Judge usage capture is not "read the same output" — the judge has no cost envelope
- **Severity: major**
- Section 4.5 claims judge cost capture "only requires reading the cost fields from the same output" because the judge already parses its verdict from JSON. This conflates two unrelated JSON objects. `judge.py` runs `claude -p --model ... --effort low --no-session-persistence` with **no** `--output-format json`, so the CLI returns plain text; the "JSON" it parses is the model's `{score, reasoning}` verdict object regex-extracted from stdout, not a CLI cost envelope. `ClaudeCodeProvider` gets cost only because it passes `--output-format json` and then `json.loads(stdout).get('cost')`.
- **Recommendation:** Rewrite the 4.5 judge bullet: `judge.py` MUST add `--output-format json`, and `_parse_verdict` must split into envelope-parse (`result` + `cost`) then verdict-parse (the `{score,reasoning}` now living inside `envelope.result`). Verify the dated CLI on this machine returns a cost field at `--effort low`.
- **Evidence:** `benchmarks/_common/judge.py:84-93` (command, no json flag), `:111-117` and `:120-143` (parse raw stdout). Contrast `ml-services/app/core/llm.py:164-170` (cmd includes `--output-format json`), `:287/294` (`json.loads(stdout).get('cost')`).

### Cost formula double-counts cache tokens for the OpenAI-shaped ZAI / LiteLLM path
- **Severity: blocking**
- 4.4 sums all four buckets and 4.1 hard-codes `input_tokens` as "UNCACHED input remainder (Anthropic semantics)." Correct for the Claude path. But `ZAIProvider` is OpenAI-compatible, and the planned LiteLLM/OpenRouter future is OpenAI-shaped — where `prompt_tokens` is the **total** prompt and the cached portion is a **subset** in `prompt_tokens_details.cached_tokens`, not an addend. A naive adapter that maps `prompt_tokens -> input_tokens` and `cached_tokens -> cache_read_tokens`, then sums all four, double-counts and double-prices cached tokens — corrupting exactly the cheap-model tier the routing analysis wants to prove cheaper. The record holds two incompatible accounting models with no per-provider normalisation rule written down.
- **Recommendation:** Add an explicit per-provider normalisation contract to 4.1: define `UsageRecord.input_tokens` as the uncached remainder, and require OpenAI-shaped adapters to compute `input_tokens = prompt_tokens - cached_tokens`, `cache_read_tokens = cached_tokens`. Add a per-adapter unit test asserting `input + cache_read` equals the provider's reported `prompt_tokens` total on a captured sample.
- **Evidence:** Target 4.4 lines 327-335, 4.1 line 138; `ml-services/app/core/llm.py:396-401,409`. OTel: `gen_ai.usage.input_tokens` "SHOULD include all types of input tokens, including cached tokens" (https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/); OpenRouter usage accounting (https://openrouter.ai/docs/use-cases/usage-accounting).

### Call graph (section 3) describes an extraction pipeline that no longer runs
- **Severity: major**
- Section 3 shows `extract(memoryId)` calling `invokeGraphAgent()` **and** `extractEntities() -> /extract-entities` **and** `extractRelationships() -> /extract-relationships` **and** `(fact extraction) -> /chat`. The live `extract()` calls only `invokeGraphAgent() -> /graph-agent` (the unified ORIENT/EXTRACT/RELATE/CAUSE/VERIFY agent). `/extract-entities` and `/extract-relationships` exist in ml-services but are invoked only from test code; there is no separate fact-extraction `/chat` call in the extract path. The taxonomy and per-operation reporting hang off this call graph, so listing `extract.entities`/`extract.relationships`/`extract.facts` as live operations implies row volume and report dimensions that will be empty, and risks wiring capture into dead endpoints.
- **Recommendation:** Correct section 3 to show `extract -> invokeGraphAgent -> POST /graph-agent` as the sole extraction LLM path; mark `/extract-entities`, `/extract-relationships`, `/chat` as legacy/test-only.
- **Evidence:** `platform/src/pipeline.ts:500` (`invokeGraphAgent()`); `ml.extractEntities`/`extractRelationships` only in `platform/src/test/services/ml-client.test.ts:190,199`. Target 3 lines 104-106.

### `mimo-v2-5` seed rate is wrong by ~3-7x
- **Severity: major**
- Line 310 seeds `mimo-v2-5: { input: 0.40, output: 2.00 }`. Published standard MiMo V2.5 is $0.14 input / $0.28 output per MTok (identical to DeepSeek V4 Flash, the likely source of confusion) — overstating input 2.9x and output 7.1x. This is in the cheap tier the doc wants to route high-volume extraction to, so a 7x output error makes the cheap tier look far less attractive than reality.
- **Recommendation:** Change to `input: 0.14, output: 0.28`. Re-verify `mimo-v2-5-pro`: the $0.435/$0.87 promo framing expired 2026-05-31; confirm the permanent rate and stamp the row's source/date.
- **Evidence:** https://openrouter.ai/xiaomi/mimo-v2.5 ("$0.14 input, $0.28 output"); https://apidog.com/blog/xiaomi-mimo-v2-5-api-cost/. Target line 310.

### `kimi-k2-6` seed rate is stale (mixes K2.6 name with K2.5 input price)
- **Severity: minor**
- Line 313 seeds `kimi-k2-6: { input: 0.60, output: 2.50 }`. Published Kimi K2.6 is ~$0.95 input / $4.00 output; $0.60 input matches the previous-generation K2.5 ($0.60/$3.00). The row mixes K2.6's name with K2.5's input price and a third output number matching neither, and omits Kimi's automatic context-cache rate (~$0.16/M), so cache-heavy usage would be over-costed.
- **Recommendation:** Set `kimi-k2-6` to `input: 0.95, output: 4.00, cacheRead: ~0.16`; or if K2.5 is what you'll actually route to, rename the row to `kimi-k2-5` at `0.60/3.00 + cacheRead 0.10`. Pick the SKU you will call.
- **Evidence:** https://www.requesty.ai/models/fireworks/kimi-k2.6. Target line 313.

### Blended-multiplier prose can drift from the shipped rates; baseline is fragile
- **Severity: major**
- The `(input + 2*output)/3` formula reconciles with the prose multipliers (Haiku 15.7x, Sonnet 47.1x, Opus 78.6x verify from the shipped Anthropic rates against the DeepSeek-Flash baseline), so the table is *currently* internally consistent. Two problems remain. (1) Anchoring every multiplier to the single cheapest, most volatile model (DeepSeek Flash, repeatedly re-priced) means every reported multiplier shifts when that one row is re-priced. (2) The output-2x weighting contradicts section 4.6's own 70% input / 30% output workload assumption — the multiplier table and the $/user table rest on opposite token mixes — and the scalar is cache-blind, ignoring the lever where the Claude-vs-cheap delta actually narrows.
- **Recommendation:** Compute the illustrative multiplier table programmatically from `PRICING` at the documented version so prose can never drift (regression-test in CI). State the multiplier is token-mix-blended and cache-blind, and report a separate cache-adjusted figure for cache-heavy operations. Consider anchoring `BASELINE` to a more stable reference (e.g. Haiku 4.5, the doc's own baseline elsewhere). Reconcile the 1:2 weighting with the 70/30 assumption or report input/output/cache multipliers separately.
- **Evidence:** Target lines 290, 346-355, 414-415. DeepSeek price volatility: https://www.cloudzero.com/blog/deepseek-pricing/.

### `pricing.ts` file path does not match the repo layout
- **Severity: minor**
- The doc proposes `platform/src/config/pricing.ts` (lines 283, 452), but no `platform/src/config/` directory exists — config lives at top-level `platform/src/config.ts` (singular).
- **Recommendation:** Add the pricing export to existing `config.ts`, or explicitly create a new `config/` subdirectory. Pick one and write it down.
- **Evidence:** Only `platform/src/config.ts` exists; no `platform/src/config/` directory. Target lines 283, 452-453.

### ZAIProvider line-range citation is slightly loose
- **Severity: minor**
- The doc cites ZAIProvider discarding usage "around `llm.py:409-425`." The method span is `llm.py:403-430`; the discarding return is at `:425`. The range captures the behavior but is loose.
- **Recommendation:** Tighten to `llm.py:408-425` (method body) or `:425` (the discarding return). Cosmetic.
- **Evidence:** `ml-services/app/core/llm.py:403-430`.

## 2. Strengthenings — SOTA-backed improvements

### Adopt OpenTelemetry GenAI field names (and inclusion semantics) before code exists
- **Severity: major**
- The doc invents field names (`input_tokens`, `provider`, `operation`, `model`, `request_id`) that map almost 1:1 to the published, vendor-neutral OTel GenAI vocabulary — the lingua franca LiteLLM, Langfuse, Helicone, Portkey, and Datadog all emit or consume. Aligning names now (or documenting a 1:1 mapping) makes a future OTel exporter a projection, not a migration, and makes Goal 6 ("adding a model is a config change") literally true at the wire level. Map `operation -> gen_ai.operation.name` (+ a mnemo sub-attribute), `provider -> gen_ai.provider.name` (which replaced the deprecated `gen_ai.system`), `model -> gen_ai.request.model`, `request_id -> gen_ai.response.id`, tokens -> `gen_ai.usage.input_tokens`/`output_tokens`/`cache_read.input_tokens`/`cache_creation.input_tokens`. Note the inclusion conflict from the cache-double-count correction: OTel says `input_tokens` *includes* cached tokens as a superset, the opposite of the doc's remainder model — decide and document the convention explicitly now.
- **Recommendation:** Add a "field mapping" subsection to 4.1 pinning each `UsageRecord`/`llm_usage` field to its OTel attribute; keep the operation taxonomy as a separate domain dimension layered on top. State which inclusion convention you follow and why.
- **Evidence:** OTel GenAI registry (https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/); Datadog native OTel support (https://www.datadoghq.com/blog/llm-otel-semantic-convention/).

### Plan a gateway-reconciliation path and treat gateway cost as authoritative-when-present
- **Severity: major**
- The entire "Why now" motivation is a LiteLLM gateway, which already computes authoritative per-call cost and returns it inline: `x-litellm-response-cost` header, `x-litellm-call-id`, `kwargs['response_cost']` in callbacks, and a `SpendLogs` ledger keyed by request_id. OpenRouter returns `usage.cost`/`usage.cost_details.upstream_inference_cost` inline. If Mnemo always re-prices from its local map, it will silently diverge from the ledger finance/routing actually bills against, risk double- or mis-pricing against provider discounts the local map can't see, and — without the gateway call id stored — be unable to join `llm_usage` to `SpendLogs` to verify totals, which is the exact reconciliation that proves the routing savings the project exists to prove.
- **Recommendation:** Add `gateway_request_id` and `gateway_reported_usd` columns plus a `cost_source` flag (`gateway|local|estimate`). Precedence rule: `estimated_usd = gateway_reported_usd` when present, else compute locally. Add a section-7 reconciliation check (sum `gateway_reported_usd` for a trace == SpendLogs spend). Keep `PRICING.ts` as the fallback pricer and historical re-pricing tool; register the same rates in LiteLLM config (with `base_model` mapping where routed id differs from response id) to avoid the silent custom-pricing-not-applied failure.
- **Evidence:** LiteLLM response headers / cost tracking / custom pricing (https://docs.litellm.ai/docs/proxy/response_headers, https://docs.litellm.ai/docs/proxy/cost_tracking, https://docs.litellm.ai/docs/proxy/custom_pricing); OpenRouter (https://openrouter.ai/docs/use-cases/usage-accounting).

### Capture the resolved model version, not just the requested family
- **Severity: major**
- `UsageRecord` and `llm_usage` store a single `model` string. Under LiteLLM routing across aliases, fallbacks, and deployments, the requested model and the model that *served* the call routinely differ — and pricing keys off the served model. LiteLLM's `StandardLoggingPayload` carries both `model` (requested), `model_id` (deployment that served), and `model_group` (routing alias); OTel separates `gen_ai.request.model` from `gen_ai.response.model`. With one string you cannot audit fallbacks or price correctly. Pricing should also key on a dated/versioned model id (rates differ across snapshots; Langfuse uses regex `match_pattern` for this).
- **Recommendation:** Split into `requested_model` + `resolved_model` (+ optional `model_group`) in `UsageRecord`; add a `resolved_model` column; price off `resolved_model` (resolved == requested for non-gateway providers).
- **Evidence:** LiteLLM logging spec (https://docs.litellm.ai/docs/proxy/logging_spec); OTel registry (https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/); Langfuse (https://langfuse.com/docs/observability/features/token-and-cost-tracking).

### Propagate operation/trace_id as gateway metadata tags; consider per-agent virtual keys
- **Severity: major**
- Stamping `operation`/`trace_id` at the TS call site works today, but once calls route through LiteLLM the gateway attributes cost only by metadata you inject per request (`metadata.tags`/`x-litellm-tags`; Cloudflare `cf-aig-metadata`, 5-key limit; Portkey metadata, 128-char). The doc's operation taxonomy is the perfect tag set but never says adapters will forward it. Without that, the gateway ledger shows only model-level spend and the reconciliation above is impossible.
- **Recommendation:** Add a forward-compat note: when LiteLLM lands, each provider call passes `extra_body.metadata = {tags:[operation, trace_id], spend_logs_metadata:{memory_id,...}}`. Recommend the per-agent virtual-key pattern so tags + budgets attach automatically.
- **Evidence:** LiteLLM (https://docs.litellm.ai/docs/proxy/cost_tracking, https://docs.litellm.ai/docs/proxy/virtual_keys); Cloudflare (https://developers.cloudflare.com/ai-gateway/observability/logging/); Portkey (https://portkey.ai/docs/product/observability/metadata).

### Persist a per-bucket cost breakdown, not just one `estimated_usd` scalar
- **Severity: minor**
- `llm_usage` stores one `estimated_usd`. LiteLLM (`CostBreakdown`: `input_cost`, `output_cost`, `tool_usage_cost`, `total_cost`, plus `saved_cache_cost`) and Langfuse (`cost_details` per usage type) persist a structured breakdown so you can audit which bucket drove spend and surface cache ROI — a core routing lever. You already have four token columns; adding three-to-four cost columns is cheap.
- **Recommendation:** Add `input_cost_usd`, `output_cost_usd`, `cache_cost_usd` (optional `tool_cost_usd`) alongside `estimated_usd` as the total; optionally `saved_cache_cost` to quantify cache ROI.
- **Evidence:** LiteLLM logging spec (https://docs.litellm.ai/docs/proxy/logging_spec); Langfuse (https://langfuse.com/docs/observability/features/token-and-cost-tracking).

### Generalize `ModelRate` toward named usage-type rates (reasoning/audio/image)
- **Severity: minor**
- `ModelRate` is a fixed `{input, output, cacheRead, cacheWrite}`. The industry has moved past four buckets — OpenAI/OTel surface `reasoning.output_tokens` (a subset of output) and audio/image input tokens; Langfuse uses an open map of usage types each with its own price. Your candidate routing list includes reasoning-style models. A fixed struct needs a schema change the first time you route to a reasoning/multimodal model; an open `Record<usageType, rate>` is the same effort now.
- **Recommendation:** Make `ModelRate` an open map keyed by usage type (keep `input`/`output`/`cacheRead`/`cacheWrite` as standard keys); have the cost formula iterate buckets x rates. Reserve a `reasoning_output_tokens` bucket now so reasoning-model routing stays config-only.
- **Evidence:** Langfuse usage types (https://langfuse.com/docs/observability/features/token-and-cost-tracking); OTel `gen_ai.usage.reasoning.output_tokens` (https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/).

### Add per-row pricing provenance (`source_url`, `as_of`, `verified` flag)
- **Severity: minor**
- A single global `PRICING_VERSION` cannot express that Anthropic rows are stable while DeepSeek/MiMo re-priced within ~6 weeks. Every aggregator surveyed carries per-rate provenance, which also makes the re-pricing audit trail concrete.
- **Recommendation:** Extend `ModelRate` with optional `sourceUrl`, `asOf` (ISO date), and `verified: 'confirmed'|'estimated'`. Keep `PRICING_VERSION` as the map-level stamp; let reporting surface which models are estimates.
- **Evidence:** https://www.aipricing.guru/pricing/, https://costgoat.com/pricing/deepseek-api (per-model "updated" dates).

### Report billable tokens; flag embedding estimates distinctly (OTel-backed)
- **Severity: enhancement**
- The `total_tokens` column and the Ollama chars/4 estimate align with the OTel rule: when both used and billable tokens exist, instrumentation MUST report billable tokens; and if counts can't be efficiently obtained, offline estimation is the disciplined fallback. If a metrics surface is ever added, name it `gen_ai.client.token.usage` with `gen_ai.token.type`.
- **Recommendation:** Keep the estimated/zero-cost embeddings treatment but tag those rows distinctly (see the `cost_status`/`token_source` risk below) so dashboards never blend estimated counts into billable totals or scale projections.
- **Evidence:** OTel GenAI metrics (https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/, https://opentelemetry.io/blog/2026/genai-observability/).

## 3. New risks — weaknesses the critics surfaced

### `trace_id` benchmark-correlation path does not exist on the wire
- **Severity: major**
- `llm_usage.trace_id` is described as "benchmark run / ingest batch correlation," but the benchmark runner and platform are separate processes talking only over HTTP, and `client.ingest()`/`client.query()` send no run id (ingest body is `{text, source?, contentType?, stream_id?}`, query is `{question}`). The platform insert call site has no benchmark-run id either, so for benchmark correlation `trace_id` can only ever be NULL. The in-memory rollup doesn't need it, which masks the gap.
- **Recommendation:** Either add an `X-Mnemo-Trace-Id` header/body field the benchmark client sends on every `/ingest` and `/api/reason/query`, plumbed into the insert; or explicitly scope `trace_id` to platform-internal ingest-batch correlation only and state benchmark-run correlation lives in the accumulator/RunEnvelope, not the table.
- **Evidence:** `benchmarks/_common/client.py:65-72,84`; `benchmarks/longmemeval/run.py:329-334,353`. Target 4.3 line 225.

### Synchronous per-call inserts on the hot ingest path; unbounded growth; unstated grain
- **Severity: major**
- 4.3 inserts one row per call: ~45 calls/window x ~80 windows ~= ~3600 synchronous inserts per question, holding connections from the agent-loop pool — while the adjacent extraction-report insert is deliberately fire-and-forget. The table is never pruned and `/api/reset` never clears it, so it grows unbounded. The grain is unstated: the accumulator sums echoes while reports group-by the table, so the two can drift, and section 7 verifies only a single ingest.
- **Recommendation:** Batch into one INSERT per response, fire-and-forget; add retention/partitioning; declare the canonical grain; extend section-7 verification to a multi-question loop.
- **Evidence:** Target 4.3 lines 273-279, 198; `benchmarks/longmemeval/run.py:323`; `platform/src/pipeline.ts:516` (fire-and-forget precedent); section 7 lines 481-490.

### Possible-PII free-form text in a never-wiped table; no cost ceilings or runaway-loop guards
- **Severity: major**
- `llm_usage` adds a free-form caller-supplied `source` (line 228) and a `memory_id` link to raw memory; `/api/reset` never clears the table, so possibly-PII text is durably retained — undercutting the stated ZDR goal. There are also no cost controls: reasoning loops run 40-100 calls, gardener ~80, with no ceiling; the accumulator knows running cost mid-request but is read only at the end.
- **Recommendation:** Drop free-form `source` or constrain to an enum; keep `memory_id` non-content with a retention policy; forbid prompt/PII text in the table. Add a per-trace USD ceiling in the accumulator that can abort the loop, plus budgets and alerting.
- **Evidence:** Target lines 227-228, 198, 389-390; `platform/src/pipeline.ts:503`; `benchmarks/longmemeval/run.py:331`; target lines 404, 406, 166.

### Cache `cacheWrite` collapses Anthropic's 5-min vs 1-hour write tiers
- **Severity: major**
- The `UsageRecord`, the table (`cache_write_tokens`), the Drizzle schema, and the pricing map (single `cacheWrite`) all model cache writes as one bucket priced at the 5-min 1.25x rate. Anthropic's 1-hour TTL write is 2x base input (and is in active production use, including Claude Code). Any 1-hour breakpoint is under-costed by ~60% on write tokens — and cache strategy is exactly the first-order lever the routing analysis depends on. The API already reports `cache_creation.ephemeral_5m_input_tokens`/`ephemeral_1h_input_tokens`.
- **Recommendation:** Split into `cache_write_5m_tokens`/`cache_write_1h_tokens` (and `cacheWrite5m`/`cacheWrite1h` rates, default 1h = 2x base input for Anthropic) in the record, table, schema, and map; have adapters read the per-TTL fields. If a single column must ship for v1, document loudly that it assumes 5-min and undercounts 1-hour.
- **Evidence:** Anthropic prompt caching (https://www.anthropic.com/news/prompt-caching, https://www.cloudzero.com/blog/claude-api-pricing/). Target lines 218, 251, 292-304, 472-474.

### Illustrative dollar/multiplier tables will be cited as authoritative on already-wrong rates
- **Severity: major**
- 4.6 ships clean $/user-year and multiplier tables marked illustrative only in prose, so readers will copy them into routing and budgets — built partly on rates this review proves wrong (mimo, kimi). The "illustrative" caveat is a sentence away from numbers that look authoritative.
- **Recommendation:** Replace numeric tables with TBD plus a formula example; or, if kept, put "ILLUSTRATIVE — NOT FOR BUDGETING" in each caption and fix/delete the wrong rows first.
- **Evidence:** Target lines 399-429; pricing corrections above.

### Unknown-model NULL cost is unenforceable and silently summable as zero
- **Severity: minor**
- The unknown-model -> NULL-cost rule is good in spirit, but `estimated_usd` is a plain `DOUBLE PRECISION` with no `cost_status` column, so a NULL is indistinguishable from "local zero" (Ollama, stored as 0), "provider returned no usage," and "unknown model." SQL `SUM()` ignores NULLs, so realised-cost rollups silently under-report whenever an unrouted model appears. The "never silently free" guarantee holds only for the single log line, not for aggregates. Embedding rows have the same problem: chars/4 is a fabricated token count (off by 2x for code/transcripts/CJK) flowing into `total_tokens` and scale projections with no flag column despite section 6 calling it "flagged."
- **Recommendation:** Add a `cost_status`/`token_source` enum (`priced | local_zero | unknown_model | no_usage_reported | estimated`) to the 040 schema and Drizzle block; set it on insert. Make 4.6 reports surface "N% of calls/tokens unpriced/estimated" beside every rollup. Prefer the nomic tokenizer over chars/4 and state an error band.
- **Evidence:** Target 4.4 lines 340-341, 4.1 lines 156-158, schema lines 209-229, section 6 lines 466-468. LiteLLM `response_cost_failure_debug_info` (https://docs.litellm.ai/docs/proxy/logging_spec).

### Streaming responses drop the gateway cost header
- **Severity: minor**
- The HTTP echo and `TokenAccumulator` assume usage is reliably available per call. LiteLLM does not return the `x-litellm-response-cost` header when streaming; OpenRouter returns usage/cost only in the final SSE message, never in headers. Mnemo's reasoning/graph agents may stream — the most expensive, highest-loop operations — so an adapter scraping cost from headers gets zero for streamed calls, biasing the routing analysis toward looking cheaper than reality.
- **Recommendation:** State in 4.1 that adapters read usage/cost from the response **body** (final SSE chunk for streams; usage object for non-streams), never headers. For the LiteLLM future, prefer the `success_callback`/`SpendLogs` over header scraping. Add a streaming case to section-7 adapter tests.
- **Evidence:** LiteLLM streaming issue (https://github.com/BerriAI/litellm/issues/12689); OpenRouter (https://openrouter.ai/docs/use-cases/usage-accounting).

## 4. Revised open questions — supersedes the artifact's own

1. **Capture mechanism (blocking).** What exact context-propagation approach replaces the broken request-scoped contextvar — `copy_context()` in `ResourcePool.submit()` with a per-request mutable list, or an explicit accumulator argument threaded through `submit()`? Decide and write the concurrency test before any code.
2. **Token-normalisation contract (blocking).** Does the normalised layer use Anthropic remainder semantics or OTel inclusion semantics for `input_tokens`? Whichever you pick, what is the documented per-adapter conversion rule (especially `input = prompt_tokens - cached_tokens` for OpenAI-shaped providers), and the per-adapter test that proves it?
3. **Gateway authority and reconciliation.** When LiteLLM lands, is `gateway_reported_usd` authoritative with `PRICING.ts` as fallback, and how are `llm_usage` rows joined to `SpendLogs` (which columns: `gateway_request_id`, `cost_source`)?
4. **Field naming.** Do we adopt OTel GenAI attribute names now (or a documented 1:1 mapping) so the eventual exporter is a projection, not a migration?
5. **Model identity under routing.** Do we split `requested_model` vs `resolved_model` and price off the resolved id?
6. **trace_id wire path.** Does the benchmark client send a run id over HTTP, or is `trace_id` scoped to platform-internal ingest batches only (with benchmark correlation living solely in the RunEnvelope)?
7. **Write-path shape.** One batched fire-and-forget INSERT per response or per-call inserts? What is the canonical reporting grain, the retention/partitioning policy, and does `/api/reset` really never prune?
8. **Cost-status and estimate flags.** Add a `cost_status`/`token_source` enum so NULL costs and chars/4 embedding estimates are auditable and excluded from billable rollups?
9. **Cache-write TTL and batch mode.** Split `cache_write` into 5m/1h buckets with separate rates? Add a `pricing_mode` (standard/batch) dimension, given the judge and background agents are batchable at a flat 50% discount?
10. **Judge capture.** Confirm `judge.py` will switch to `--output-format json` and that the dated CLI returns a cost envelope at `--effort low`; split `_parse_verdict` into envelope-parse then verdict-parse.
11. **Cost controls.** Is there a per-trace USD ceiling in the accumulator that can abort runaway agent loops, plus budgets/alerting?
12. **Operation taxonomy scope.** Split 4.7 into "active (currently invoked)" vs "reserved/future" so capture is wired only into live call sites and reports don't show empty dimensions.
