/**
 * LLM usage write-path (token-usage & cost-tracking epic — nmemo-6do, B7).
 *
 * Reads the per-call usage echoed by ml-services (response.usage.calls), prices
 * each call via config.ts PRICING (computeCost, keyed off resolved_model), and
 * persists the whole response's rows as ONE batched fire-and-forget insert into
 * llm_usage — mirroring the extraction-report precedent at pipeline.ts:569.
 *
 * Cost is computed HERE: TypeScript is the single pricing source of truth;
 * ml-services emits token counts only. An unknown resolved_model yields
 * cost_status='unknown_model' with NULL costs (computeCost logs it once). The
 * insert is fire-and-forget and never throws on the hot path.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { llmUsage, type NewLlmUsage } from '../db/schema.js';
import {
  computeCost, PRICING_VERSION, COST_CEILING_USD_PER_REQUEST,
  OPERATION_DAILY_BUDGETS, type Operation, type OperationBudget,
} from '../config.js';

/** One UsageRecord echoed by a ml-services response (snake_case wire shape, §4.2). */
export interface EchoedUsageCall {
  requested_model: string;
  resolved_model: string;
  model_group?: string | null;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number | null;
  cache_read_tokens?: number;
  cache_write_5m_tokens?: number;
  cache_write_1h_tokens?: number;
  tool_calls?: number | null;
  turns?: number | null;
  latency_ms?: number | null;
  request_id?: string | null;
  gateway_request_id?: string | null;
  gateway_reported_usd?: number | null;
}

/** Summed usage buckets — the §4.2 echo `totals` shape (matches UsageAccumulator.totals()). */
export interface UsageTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  calls: number;
}

/** The `usage` object echoed on every live ml-services response (§4.2). */
export interface UsageEcho {
  calls: EchoedUsageCall[];
  totals: UsageTotals;
}

export interface InsertUsageOptions {
  traceId?: string | null;     // platform-internal ingest-batch correlation (§4.5 option b)
  memoryId?: string | null;    // non-content id only
  source?: string | null;      // structured non-content identifier
}

/**
 * Pure: map echoed calls to priced llm_usage rows (no DB). Exported for tests.
 * `total_tokens` is the billed total (input + output + both cache buckets;
 * reasoning is a subset of output and is NOT added again). cost_source is
 * 'gateway' when the call carried an authoritative gateway cost, else 'local'.
 */
export function buildUsageRows(
  calls: EchoedUsageCall[],
  operation: Operation | string,
  opts: InsertUsageOptions = {},
): NewLlmUsage[] {
  return calls.map((c) => {
    const gateway = c.gateway_reported_usd ?? null;
    const cost = computeCost(c, c.resolved_model, { gatewayReportedUsd: gateway });
    const input = c.input_tokens ?? 0;
    const output = c.output_tokens ?? 0;
    const cacheRead = c.cache_read_tokens ?? 0;
    const cw5 = c.cache_write_5m_tokens ?? 0;
    const cw1 = c.cache_write_1h_tokens ?? 0;
    return {
      operation,
      requestedModel: c.requested_model,
      resolvedModel: c.resolved_model,
      modelGroup: c.model_group ?? null,
      provider: c.provider ?? 'unknown',
      inputTokens: input,
      outputTokens: output,
      reasoningOutputTokens: c.reasoning_output_tokens ?? null,
      cacheReadTokens: cacheRead,
      cacheWrite5mTokens: cw5,
      cacheWrite1hTokens: cw1,
      totalTokens: input + output + cacheRead + cw5 + cw1,
      toolCalls: c.tool_calls ?? null,
      turns: c.turns ?? null,
      latencyMs: c.latency_ms ?? null,
      inputCostUsd: cost.input_cost_usd,
      outputCostUsd: cost.output_cost_usd,
      cacheCostUsd: cost.cache_cost_usd,
      savedCacheCostUsd: cost.saved_cache_cost_usd,
      estimatedUsd: cost.estimated_usd,
      gatewayReportedUsd: gateway,
      costSource: gateway != null ? 'gateway' : 'local',
      costStatus: cost.cost_status,
      tokenSource: 'provider',
      pricingVersion: PRICING_VERSION,
      traceId: opts.traceId ?? null,
      gatewayRequestId: c.gateway_request_id ?? null,
      requestId: c.request_id ?? null,
      memoryId: opts.memoryId ?? null,
      source: opts.source ?? null,
    } satisfies NewLlmUsage;
  });
}

/**
 * Persist a response's echoed usage as ONE batched fire-and-forget insert,
 * tagged with the call-site operation. No-op when there are no calls. Never
 * throws and never blocks the response path (mirrors pipeline.ts:569). A bad
 * row-build or a failed insert is logged, not raised — a usage-write bug can
 * only ever lose a metric, never break a request.
 */
export function insertUsageRows(
  calls: EchoedUsageCall[] | undefined | null,
  operation: Operation | string,
  opts: InsertUsageOptions = {},
): void {
  if (!calls || calls.length === 0) return;
  let rows: NewLlmUsage[];
  try {
    rows = buildUsageRows(calls, operation, opts);
  } catch (err) {
    console.warn('[usage] failed to build rows (non-fatal):', err instanceof Error ? err.message : err);
    return;
  }
  void Promise.resolve(db.insert(llmUsage).values(rows)).catch((err) => {
    console.warn('[usage] failed to insert llm_usage rows (non-fatal):', err instanceof Error ? err.message : err);
  });

  // Cost controls (B10) — advisory, never block: a post-call per-request ceiling
  // detection + a fire-and-forget daily-budget rollup alert.
  checkRequestCeiling(rows, operation);
  checkDailyBudgets(operation);
}

/**
 * Post-call per-request cost-ceiling DETECTION (B10, advisory). Logs a warning
 * when a response's summed estimated_usd exceeds COST_CEILING_USD_PER_REQUEST.
 * This is NOT a mid-flight abort: each agent endpoint is one opaque subprocess
 * whose agentic loop is capped by max_turns, so the platform only sees a trace's
 * cost AFTER it completes. True mid-flight USD enforcement is deferred to the
 * per-call gateway future (design §6). No-op when the ceiling is unset.
 */
export function checkRequestCeiling(
  rows: NewLlmUsage[],
  operation: Operation | string,
  ceiling: number | null = COST_CEILING_USD_PER_REQUEST,
): void {
  if (ceiling == null) return;
  const total = rows.reduce((sum, r) => sum + (r.estimatedUsd ?? 0), 0);
  if (total > ceiling) {
    console.warn(
      `[usage] COST_CEILING_EXCEEDED operation=${operation} ` +
      `spent=$${total.toFixed(4)} ceiling=$${ceiling.toFixed(4)} calls=${rows.length}`,
    );
  }
}

/**
 * Fire-and-forget daily-budget alert on llm_usage rollups (B10, advisory). Sums
 * today's estimated_usd + call count for the operation and logs an error when
 * over budget. Never blocks the response path; a failed query is swallowed.
 */
export function checkDailyBudgets(
  operation: Operation | string,
  budgets: Partial<Record<Operation, OperationBudget>> = OPERATION_DAILY_BUDGETS,
): void {
  const budget = budgets[operation as Operation];
  if (!budget) return;
  void Promise.resolve(
    db
      .select({
        spent: sql<number>`COALESCE(SUM(${llmUsage.estimatedUsd}), 0)`,
        calls: sql<number>`COUNT(*)`,
      })
      .from(llmUsage)
      .where(sql`${llmUsage.operation} = ${operation} AND ${llmUsage.createdAt} >= CURRENT_DATE`),
  )
    .then((result) => {
      const row = (result as Array<{ spent: number; calls: number }>)[0];
      const spent = Number(row?.spent ?? 0);
      const calls = Number(row?.calls ?? 0);
      if (spent > budget.maxUsd || calls > budget.maxCalls) {
        console.error(
          `[usage] DAILY_BUDGET_EXCEEDED operation=${operation} ` +
          `spent=$${spent.toFixed(4)} calls=${calls} ` +
          `thresholds=$${budget.maxUsd}/${budget.maxCalls}`,
        );
      }
    })
    .catch((err) => {
      console.warn('[usage] daily budget check failed (non-fatal):', err instanceof Error ? err.message : err);
    });
}
