/**
 * B11 (nmemo-6do.11): usage reporting — DB-backed against the real llm_usage
 * table (Postgres on 5433, migration 050 applied). Inserts marker rows, runs the
 * reporting group-bys, asserts grouping + cost reconciliation + unpriced-share,
 * then cleans up its own rows. Runs under the default vitest config (globalSetup).
 *
 * This proves the reporting layer end-to-end against real Postgres WITHOUT the
 * live LLM. The real-LLM E2E (a genuine /ingest + /api/reason/query producing
 * llm_usage rows whose summed cost == the echoed usage.totals) additionally needs
 * the platform server (:3000), ml-services (:8000), Ollama, and the claude CLI —
 * see verify-e2e-usage.md for that manual checklist.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { llmUsage } from '../db/schema.js';
import { costByDimension, tokenMixByModel, unpricedShare } from '../services/usage-report.js';

const MARKER = 'b11-report-test-model'; // unique resolved_model so we can isolate + clean up

describe('B11: usage reporting (DB-backed, real llm_usage)', () => {
  beforeAll(async () => {
    await db.insert(llmUsage).values([
      {
        operation: 'graph_agent', requestedModel: 'haiku', resolvedModel: MARKER, provider: 'anthropic',
        inputTokens: 1000, outputTokens: 500, totalTokens: 1500, estimatedUsd: 0.003,
        costStatus: 'priced', tokenSource: 'provider', costSource: 'local', pricingVersion: 'test',
      },
      {
        operation: 'graph_agent', requestedModel: 'haiku', resolvedModel: MARKER, provider: 'anthropic',
        inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, estimatedUsd: 0.006,
        costStatus: 'priced', tokenSource: 'provider', costSource: 'local', pricingVersion: 'test',
      },
      {
        operation: 'reasoning_agent', requestedModel: 'x', resolvedModel: MARKER, provider: 'zai',
        inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedUsd: null,
        costStatus: 'unknown_model', tokenSource: 'provider', costSource: 'local', pricingVersion: 'test',
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(llmUsage).where(eq(llmUsage.resolvedModel, MARKER));
  });

  it('costByDimension groups and reconciles summed cost per dimension', async () => {
    const mine = (await costByDimension()).filter((r) => r.resolvedModel === MARKER);
    const graph = mine.find((r) => r.operation === 'graph_agent');
    expect(graph).toBeDefined();
    expect(graph!.rowCount).toBe(2);
    expect(graph!.totalTokens).toBe(4500);            // 1500 + 3000
    expect(graph!.estimatedUsd).toBeCloseTo(0.009, 9); // reconciliation: 0.003 + 0.006

    const reason = mine.find((r) => r.operation === 'reasoning_agent');
    expect(reason!.costStatus).toBe('unknown_model');
    expect(reason!.estimatedUsd).toBe(0);              // null cost sums to 0 but stays visible via cost_status
  });

  it('tokenMixByModel sums token buckets for the marker model', async () => {
    const mix = (await tokenMixByModel()).find((r) => r.resolvedModel === MARKER);
    expect(mix).toBeDefined();
    expect(mix!.inputTokens).toBe(3100);  // 1000 + 2000 + 100
    expect(mix!.outputTokens).toBe(1550); // 500 + 1000 + 50
  });

  it('unpricedShare counts the unknown_model row in the unpriced share', async () => {
    const share = await unpricedShare();
    expect(share.totalRows).toBeGreaterThanOrEqual(3);
    expect(share.unpricedRows).toBeGreaterThanOrEqual(1); // at least our unknown_model row
    expect(share.unpricedSharePct).toBeGreaterThan(0);
  });
});
