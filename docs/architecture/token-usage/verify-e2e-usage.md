# Token-usage verification (design §8) — what's automated vs. what needs the live stack

Status as of the nmemo-6do epic close (B11). Maps each §8 verification item to the
test that covers it, and spells out the real-LLM end-to-end checks that require a
running platform.

## Automated (run in CI / locally, no live LLM)

| §8 item | Covered by |
|---|---|
| Per-bucket cost formula incl. 5m/1h cache split | `platform/src/test/config.unit.test.ts` (B6) |
| Blended-multiplier math + drift guard (regenerated from shipped PRICING) | `platform/src/test/multiplier-drift.unit.test.ts` (B11) |
| Each provider adapter parses a captured sample correctly | `ml-services/tests/test_usage_parsing.py` (B1) |
| OpenAI-shaped `input_tokens + cache_read_tokens == prompt_tokens` | `test_usage_parsing.py::test_zai_usage_parsing` (B1) |
| Anthropic cache TTL split (5m/1h) incl. flat-fallback | `test_usage_parsing.py` (B1 + review-#1 fix) |
| Concurrency: N parallel `/graph-agent`, no cross-request usage bleed | `ml-services/tests/test_usage_concurrency.py` (B3) |
| HTTP echo `usage{calls,totals}` on a live agent response | `ml-services/tests/test_usage_echo.py` (B4) |
| `llm_usage` schema ⇄ Drizzle drift guard (live columns == Drizzle) | `platform/src/test/harness/llm-usage-schema.test.ts` (B5) |
| Cost write-path: one batched insert, unknown_model → NULL costs | `platform/src/test/usage.unit.test.ts` (B7) |
| Usage surfaced to callers (agentFetch → ExtractResult / query response) | `platform/src/test/usage-pipeline.unit.test.ts` (B8) |
| Reporting group-bys reconcile (cost per dimension, token-mix, unpriced share) | `platform/src/test/usage-report.test.ts` (B11, DB-backed) |
| Cost ceiling detection + daily budget alerting | `platform/src/test/usage-controls.unit.test.ts` (B10) |
| Benchmark RunEnvelope fields, TokenAccumulator, judge JSON cost | `benchmarks/test_token_usage_b9.py` (B9) |

Run them:
- ml-services: `cd ml-services && PYTHONPATH=. ./.venv/Scripts/python.exe -m pytest tests/test_usage_*.py -q`
- platform unit: `cd platform && npx vitest run --config vitest.unit.config.ts src/test/*.unit.test.ts`
- platform DB-backed: `cd platform && npx vitest run src/test/usage-report.test.ts src/test/harness/llm-usage-schema.test.ts`
- benchmarks: `cd benchmarks && uv run pytest test_token_usage_b9.py -q`

## Requires the LIVE stack (real-LLM E2E — not run unattended)

These need the platform server (`:3000`), ml-services (`:8000`), Ollama
(`:11434`), Postgres (`:5433`), and the `claude` CLI authenticated. They were NOT
run during the epic (platform `:3000` was down; an agentic `/ingest` also costs
real tokens + minutes). Run them manually before trusting production cost numbers:

1. **Single ingest → rows reconcile to the echo.** `POST /ingest` with a small
   text. Then: `SELECT operation, COUNT(*), SUM(estimated_usd) FROM llm_usage
   WHERE operation='graph_agent' AND created_at > now() - interval '5 min';`
   Assert the row(s) are non-zero and the summed `estimated_usd` equals the
   `usage.totals`-derived cost the response echoed (price the echoed totals with
   `config.ts computeCost`). Expect `cost_status='priced'` for a known model.
2. **Single query.** `POST /api/reason/query`. Confirm the response carries
   `usage.totals` and a `reasoning_agent` row lands in `llm_usage`.
3. **Multi-question benchmark (reset enabled).** `cd benchmarks && uv run python
   -m longmemeval.run --sample 5`. Assert the written `RunEnvelope` JSON has
   `token_usage` populated (`{operation:{model:{...}}}`), and that
   `estimated_cost_usd` / `pricing_version` are present (default 0.0 / "" until a
   reporting step prices the token buckets via `config.ts` PRICING).
4. **Reset-disabled cross-check.** `--sample 1` with reset disabled: the in-memory
   `TokenAccumulator` totals match the summed `llm_usage` columns for that run
   (filter by `operation`, since `trace_id` is platform-internal — §4.5 option b).

## Known follow-ups (flagged during the epic, not in scope here)

- Capture for `arbiter_agent` (E5) and `causal_agent` (E6) — live LLM endpoints
  added after the §4.7 taxonomy; add them to `OPERATION_VALUES` + wire their echo.
- `embed.document` / `embed.query` — Ollama returns no token usage; needs a
  tokenizer/chars-4 estimate (B1 deferral) before the echo is meaningful.
- `notify.phrase` — reserved; `routes/notifications.ts` makes no LLM call today.
- True mid-flight USD cost-ceiling enforcement — deferred to the per-call LiteLLM
  gateway future (today each agent endpoint is one opaque subprocess; B10 ships a
  post-call advisory ceiling + daily budget alerts instead).
