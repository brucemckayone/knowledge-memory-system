/**
 * B8 (nmemo-6do.8): the echoed usage is surfaced UP to callers.
 *
 * agentFetch parses response.usage, fires the B7 fire-and-forget insert, AND
 * returns the parsed body (which now carries `usage`) — so invokeGraphAgent /
 * invokeReasoningAgent results, and in turn ExtractResult and the query
 * response, carry usage.totals for in-memory benchmark rollups (survives
 * /api/reset). Pure unit test: fetch + db.insert are mocked; no infra.
 *
 * The end-to-end shape (a real /ingest and /api/reason/query response carrying
 * usage.totals, and the benchmark accumulator) is exercised in B9/B11 against a
 * running stack.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

let causal: typeof import('../services/causal-agent.js');
let dbmod: typeof import('../db/index.js');

beforeAll(async () => {
  dbmod = await import('../db/index.js');
  causal = await import('../services/causal-agent.js');
});

afterEach(() => vi.restoreAllMocks());

const ECHO = {
  calls: [{
    requested_model: 'haiku', resolved_model: 'claude-haiku-4-5',
    provider: 'anthropic', input_tokens: 100, output_tokens: 50,
  }],
  totals: { input: 100, output: 50, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, calls: 1 },
};

function mockFetchReturning(body: unknown) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => body } as any);
}

describe('B8: agentFetch surfaces echoed usage to callers', () => {
  it('returns the response usage alongside result', async () => {
    vi.spyOn(dbmod.db, 'insert').mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) } as any);
    mockFetchReturning({ result: 'ok', usage: ECHO });

    const res = await causal.agentFetch<{ result: string; usage?: typeof ECHO }>({
      agent: 'graph_agent',
      url: 'http://test/graph-agent',
      body: {},
      timeoutMs: 1000,
    });
    expect(res.result).toBe('ok');
    expect(res.usage).toBeDefined();
    expect(res.usage!.totals.calls).toBe(1);
    expect(res.usage!.totals.input).toBe(100);
  });

  it('also fires the fire-and-forget usage insert (B7) on the same path', async () => {
    const valuesSpy = vi.fn().mockResolvedValue(undefined);
    const insertSpy = vi.spyOn(dbmod.db, 'insert').mockReturnValue({ values: valuesSpy } as any);
    mockFetchReturning({ result: 'ok', usage: ECHO });

    await causal.agentFetch({ agent: 'reasoning_agent', url: 'http://test/x', body: {}, timeoutMs: 1000 });
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(valuesSpy.mock.calls[0]![0]).toHaveLength(1);
  });

  it('a response without usage surfaces undefined (no crash, no insert)', async () => {
    const insertSpy = vi.spyOn(dbmod.db, 'insert');
    mockFetchReturning({ result: 'no usage' });

    const res = await causal.agentFetch<{ result: string; usage?: typeof ECHO }>({
      agent: 'gardener_agent',
      url: 'http://test/x',
      body: {},
      timeoutMs: 1000,
    });
    expect(res.result).toBe('no usage');
    expect(res.usage).toBeUndefined();
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
