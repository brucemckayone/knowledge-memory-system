/**
 * B7 (nmemo-6do.7): usage.ts write path — cost computation + batched insert.
 *
 * Pure unit test (no DB) under vitest.unit.config.ts. Importing usage.ts pulls in
 * db/index.js (which validates env via config.ts and constructs a lazy postgres
 * client — no connection until a query runs), so we set a dummy DATABASE_URL and
 * spy on db.insert; no row ever hits Postgres.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

let usage: typeof import('../services/usage.js');
let dbmod: typeof import('../db/index.js');

beforeAll(async () => {
  dbmod = await import('../db/index.js');
  usage = await import('../services/usage.js');
});

afterEach(() => vi.restoreAllMocks());

const HAIKU_CALL = {
  requested_model: 'haiku',
  resolved_model: 'claude-haiku-4-5',
  provider: 'anthropic',
  input_tokens: 1000,
  output_tokens: 1000,
  cache_read_tokens: 100,
  cache_write_5m_tokens: 50,
  cache_write_1h_tokens: 50,
};

describe('B7: usage.ts write path', () => {
  it('buildUsageRows prices a known model, reconciles, and totals tokens', () => {
    const row = usage.buildUsageRows([HAIKU_CALL], 'graph_agent')[0]!;
    expect(row.operation).toBe('graph_agent');
    expect(row.resolvedModel).toBe('claude-haiku-4-5');
    expect(row.costStatus).toBe('priced');
    expect(row.costSource).toBe('local');
    expect(row.tokenSource).toBe('provider');
    expect(row.pricingVersion).toBe('2026-06-16');
    expect(row.totalTokens).toBe(2200);                 // 1000+1000+100+50+50
    expect(row.inputCostUsd).toBeCloseTo(0.001, 9);
    expect(row.outputCostUsd).toBeCloseTo(0.005, 9);
    expect(row.cacheCostUsd).toBeCloseTo((100 * 0.1 + 50 * 1.25 + 50 * 2.0) / 1e6, 12);
    expect(row.estimatedUsd).toBeCloseTo(0.0061725, 9); // input + output + cache
  });

  it('buildUsageRows: unknown resolved_model -> unknown_model with NULL costs', () => {
    const row = usage.buildUsageRows([{ ...HAIKU_CALL, resolved_model: 'totally-unknown' }], 'graph_agent')[0]!;
    expect(row.costStatus).toBe('unknown_model');
    expect(row.inputCostUsd).toBeNull();
    expect(row.estimatedUsd).toBeNull();
  });

  it('buildUsageRows: gateway_reported_usd -> cost_source gateway + estimated override', () => {
    const row = usage.buildUsageRows([{ ...HAIKU_CALL, gateway_reported_usd: 0.05 }], 'graph_agent')[0]!;
    expect(row.costSource).toBe('gateway');
    expect(row.estimatedUsd).toBe(0.05);
    expect(row.gatewayReportedUsd).toBe(0.05);
  });

  it('buildUsageRows: N calls -> N rows', () => {
    expect(usage.buildUsageRows([HAIKU_CALL, HAIKU_CALL, HAIKU_CALL], 'graph_agent')).toHaveLength(3);
  });

  it('insertUsageRows: empty / missing calls -> no insert', () => {
    const insertSpy = vi.spyOn(dbmod.db, 'insert');
    usage.insertUsageRows([], 'graph_agent');
    usage.insertUsageRows(undefined, 'graph_agent');
    usage.insertUsageRows(null, 'graph_agent');
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('insertUsageRows: fires exactly ONE batched insert with all rows', () => {
    const valuesSpy = vi.fn().mockResolvedValue(undefined);
    const insertSpy = vi.spyOn(dbmod.db, 'insert').mockReturnValue({ values: valuesSpy } as any);
    usage.insertUsageRows([HAIKU_CALL, HAIKU_CALL], 'reasoning_agent');
    expect(insertSpy).toHaveBeenCalledTimes(1);   // one INSERT, not N
    expect(valuesSpy).toHaveBeenCalledTimes(1);
    const inserted = valuesSpy.mock.calls[0]![0] as Array<{ operation: string }>;
    expect(inserted).toHaveLength(2);
    expect(inserted[0]!.operation).toBe('reasoning_agent');
  });
});
