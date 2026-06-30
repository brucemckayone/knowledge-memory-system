/**
 * B10 (nmemo-6do.10): cost controls — per-request ceiling detection + daily
 * budget alerting. Advisory layer (design §6): both are post-/fire-and-forget,
 * never block. Pure unit test (no DB): db.select + console are mocked.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

let usage: typeof import('../services/usage.js');
let dbmod: typeof import('../db/index.js');
let cfg: typeof import('../config.js');

beforeAll(async () => {
  dbmod = await import('../db/index.js');
  usage = await import('../services/usage.js');
  cfg = await import('../config.js');
});

afterEach(() => vi.restoreAllMocks());

function rows(estimatedUsd: number[]) {
  return estimatedUsd.map((e) => ({ estimatedUsd: e })) as any;
}

describe('B10: cost controls', () => {
  it('config exports the ceiling (disabled by default) + empty budgets', () => {
    expect(cfg.COST_CEILING_USD_PER_REQUEST).toBeNull();
    expect(cfg.OPERATION_DAILY_BUDGETS).toEqual({});
  });

  it('checkRequestCeiling warns when the summed cost exceeds the ceiling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    usage.checkRequestCeiling(rows([0.4, 0.3]), 'reasoning_agent', 0.5); // 0.7 > 0.5
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('COST_CEILING_EXCEEDED');
  });

  it('checkRequestCeiling is silent under the ceiling and when disabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    usage.checkRequestCeiling(rows([0.1, 0.1]), 'reasoning_agent', 0.5); // 0.2 < 0.5
    usage.checkRequestCeiling(rows([99]), 'reasoning_agent', null);      // ceiling disabled
    expect(warn).not.toHaveBeenCalled();
  });

  it('checkDailyBudgets errors when a day rollup exceeds the budget', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(dbmod.db, 'select').mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ spent: 5.0, calls: 100 }]) }),
    } as any);
    usage.checkDailyBudgets('graph_agent', { graph_agent: { maxUsd: 1.0, maxCalls: 10 } });
    await new Promise((r) => setTimeout(r, 10)); // let the fire-and-forget settle
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]![0]).toContain('DAILY_BUDGET_EXCEEDED');
  });

  it('checkDailyBudgets is silent under budget and skips the query when none configured', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sel = vi.spyOn(dbmod.db, 'select').mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ spent: 0.1, calls: 1 }]) }),
    } as any);
    usage.checkDailyBudgets('graph_agent', { graph_agent: { maxUsd: 1.0, maxCalls: 10 } }); // under -> queries
    usage.checkDailyBudgets('graph_agent', {});                                             // no budget -> no query
    await new Promise((r) => setTimeout(r, 10));
    expect(err).not.toHaveBeenCalled();
    expect(sel).toHaveBeenCalledTimes(1);
  });
});
