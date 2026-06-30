# UsageRecord — the per-provider normalisation contract

Status: **implemented** (B1 / `nmemo-6do.1`). This is the reference spec for the
normalised token-usage record and the per-provider adapter rules. It expands
[`00-token-usage-and-cost-tracking.md`](./00-token-usage-and-cost-tracking.md)
§4.1 (core abstraction) and §9.2 (the blocking token-normalisation gate) in
plain language, and points at the code that implements it.

The canonical definition lives in code, not here:
`ml-services/app/core/llm.py` — the `UsageRecord` pydantic model plus the three
adapter methods (`ClaudeCodeProvider._parse_usage_record`,
`ZAIProvider._parse_openai_usage`, `PiBridgeProvider._parse_pi_usage`) and the
shared `_anthropic_cache_buckets` helper. The adapter tests are in
`ml-services/tests/test_usage_parsing.py`.

## What it is

One provider-agnostic shape that every LLM call produces, so capture,
persistence, pricing, and reporting all speak one vocabulary — and so adding a
model or swapping to a LiteLLM gateway is a config change, not new plumbing.

The 16 fields (design §4.1):

| Field | Meaning |
|---|---|
| `requested_model` | model id we asked for (alias/group ok) |
| `resolved_model` | model that actually served (== requested for non-gateway providers) |
| `model_group` | routing alias, when a gateway resolves one |
| `provider` | `anthropic` \| `zai` \| `ollama` \| `litellm` \| … |
| `input_tokens` | **uncached remainder** (see the contract below) |
| `output_tokens` | completion tokens |
| `reasoning_output_tokens` | subset of output; reasoning models only |
| `cache_read_tokens` | tokens served from cache |
| `cache_write_5m_tokens` | Anthropic 5-minute-TTL cache writes |
| `cache_write_1h_tokens` | Anthropic 1-hour-TTL cache writes |
| `tool_calls` | agent loop length; agents only |
| `turns` | agentic turns |
| `latency_ms` | wall-clock latency |
| `request_id` | upstream provider request id, if exposed |
| `gateway_request_id` | LiteLLM call id, for SpendLogs reconciliation |
| `gateway_reported_usd` | authoritative cost, only when a gateway returns one |

## The normalisation contract (the part that is easy to get wrong)

**The token buckets must sum to the billed total.** That single rule forces one
decision: `input_tokens` is always the **uncached remainder** — the prompt
tokens that were *not* served from cache — never the whole prompt. If you store
the full prompt in `input_tokens` *and* the cached tokens in `cache_read_tokens`,
you have counted (and will price) the cached tokens twice.

Providers report this two different ways, so each adapter normalises differently:

- **Anthropic-shaped** (Claude CLI, Pi bridge). The provider already reports
  `input_tokens` as the uncached remainder, with `cache_read` and
  `cache_creation` as separate fields. Map straight through. Split
  `cache_creation` into the two TTL buckets — `ephemeral_5m_input_tokens` →
  `cache_write_5m_tokens`, `ephemeral_1h_input_tokens` → `cache_write_1h_tokens`
  (the 1-hour write is priced ~2× base input, so the split matters). A flat
  `cache_creation_input_tokens` spelling is attributed to the 5-minute TTL.

- **OpenAI-shaped** (ZAI today; LiteLLM / OpenRouter tomorrow). The provider's
  `prompt_tokens` is the **total** prompt, and `prompt_tokens_details.cached_tokens`
  is a **subset** of it, not an addend. The adapter MUST compute:

  ```
  input_tokens      = prompt_tokens - cached_tokens
  cache_read_tokens = cached_tokens
  ```

  Worked example: a response with `prompt_tokens = 100` and `cached_tokens = 30`
  normalises to `input_tokens = 70`, `cache_read_tokens = 30`. The invariant
  `input_tokens + cache_read_tokens == prompt_tokens` (70 + 30 == 100) is
  asserted by `test_zai_usage_parsing`. A naive adapter that maps both fields
  and sums all buckets double-counts cache — corrupting exactly the cheap-model
  tier the routing analysis exists to prove cheaper.

Usage is always read from the response **body** (for streams, the final SSE
chunk's `usage` object), never from an HTTP header.

## No pricing here

ml-services never prices. These adapters emit token counts only. The single
source of truth for cost is TypeScript (`platform/src/config.ts` `PRICING` +
`computeCost`, design §4.4). The Claude CLI's own `estimated_usd` is
deliberately **not** carried into the record — `gateway_reported_usd` is
populated solely when a real gateway (LiteLLM) returns an authoritative cost.

## Scope of B1

B1 defines the record and the three pure parse methods, with adapter tests. It
does **not** thread a per-request accumulator (B2), echo usage over HTTP (B4),
create the `llm_usage` table (B5), or compute cost (B6). Ollama embedding token
estimation is deferred (design §4.1, §7).
