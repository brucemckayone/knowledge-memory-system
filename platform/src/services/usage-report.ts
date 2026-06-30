/**
 * LLM usage reporting (token-usage & cost-tracking epic — nmemo-6do, B11).
 *
 * Read-only group-bys over llm_usage for cost attribution + auditing (design
 * §4.6). The reporting grain is one row per LLM call; these roll up by
 * operation / resolved_model / provider. Every rollup also surfaces the SHARE of
 * calls that are unpriced (cost_status != 'priced') or estimated
 * (token_source = 'estimated'), so an unrouted model or an estimated embedding
 * count never silently deflates a total.
 *
 * postgres.js returns SUM()/COUNT() aggregates as strings; each function
 * Number()-coerces so callers get numbers.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { llmUsage } from '../db/schema.js';

export interface CostByDimensionRow {
  operation: string;
  resolvedModel: string;
  provider: string;
  costSource: string;
  costStatus: string;
  rowCount: number;
  totalTokens: number;
  estimatedUsd: number;
}

/** Realised cost grouped by operation / resolved_model / provider / cost_source /
 *  cost_status. One row per dimension combo, ordered by spend desc. */
export async function costByDimension(): Promise<CostByDimensionRow[]> {
  const rows = await db
    .select({
      operation: llmUsage.operation,
      resolvedModel: llmUsage.resolvedModel,
      provider: llmUsage.provider,
      costSource: llmUsage.costSource,
      costStatus: llmUsage.costStatus,
      rowCount: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${llmUsage.totalTokens}), 0)`,
      estimatedUsd: sql<number>`COALESCE(SUM(${llmUsage.estimatedUsd}), 0)`,
    })
    .from(llmUsage)
    .groupBy(
      llmUsage.operation, llmUsage.resolvedModel, llmUsage.provider,
      llmUsage.costSource, llmUsage.costStatus,
    )
    .orderBy(sql`COALESCE(SUM(${llmUsage.estimatedUsd}), 0) DESC`);
  return rows.map((r) => ({
    operation: r.operation,
    resolvedModel: r.resolvedModel,
    provider: r.provider,
    costSource: r.costSource,
    costStatus: r.costStatus,
    rowCount: Number(r.rowCount),
    totalTokens: Number(r.totalTokens),
    estimatedUsd: Number(r.estimatedUsd),
  }));
}

export interface TokenMixRow {
  resolvedModel: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

/** Token-bucket mix per resolved_model (input vs output vs cache). */
export async function tokenMixByModel(): Promise<TokenMixRow[]> {
  const rows = await db
    .select({
      resolvedModel: llmUsage.resolvedModel,
      inputTokens: sql<number>`COALESCE(SUM(${llmUsage.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${llmUsage.outputTokens}), 0)`,
      cacheReadTokens: sql<number>`COALESCE(SUM(${llmUsage.cacheReadTokens}), 0)`,
      cacheWrite5mTokens: sql<number>`COALESCE(SUM(${llmUsage.cacheWrite5mTokens}), 0)`,
      cacheWrite1hTokens: sql<number>`COALESCE(SUM(${llmUsage.cacheWrite1hTokens}), 0)`,
    })
    .from(llmUsage)
    .groupBy(llmUsage.resolvedModel);
  return rows.map((r) => ({
    resolvedModel: r.resolvedModel,
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cacheReadTokens: Number(r.cacheReadTokens),
    cacheWrite5mTokens: Number(r.cacheWrite5mTokens),
    cacheWrite1hTokens: Number(r.cacheWrite1hTokens),
  }));
}

export interface UnpricedShare {
  totalRows: number;
  unpricedRows: number;        // cost_status != 'priced'
  estimatedTokenRows: number;  // token_source = 'estimated'
  unpricedSharePct: number;
  estimatedSharePct: number;
}

/** Share of rows that are unpriced or estimated — surfaced on every report so a
 *  zero/inflated total never hides incomplete data (design §4.6, §2.3). */
export async function unpricedShare(): Promise<UnpricedShare> {
  const [row] = await db
    .select({
      totalRows: sql<number>`COUNT(*)`,
      unpricedRows: sql<number>`COUNT(*) FILTER (WHERE ${llmUsage.costStatus} <> 'priced')`,
      estimatedTokenRows: sql<number>`COUNT(*) FILTER (WHERE ${llmUsage.tokenSource} = 'estimated')`,
    })
    .from(llmUsage);
  const total = Number(row?.totalRows ?? 0);
  const unpriced = Number(row?.unpricedRows ?? 0);
  const estimated = Number(row?.estimatedTokenRows ?? 0);
  return {
    totalRows: total,
    unpricedRows: unpriced,
    estimatedTokenRows: estimated,
    unpricedSharePct: total ? (unpriced / total) * 100 : 0,
    estimatedSharePct: total ? (estimated / total) * 100 : 0,
  };
}
