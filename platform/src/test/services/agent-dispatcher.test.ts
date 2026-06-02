/**
 * Bead nmemo-8w5 — regression tests for the per-request undici dispatcher on
 * agentFetch.
 *
 * Before the fix: agentFetch relied on Node's global fetch (undici), whose
 * DEFAULT headersTimeout (~300s / 5min) fires INDEPENDENTLY of the
 * AbortController. The /graph-agent endpoint runs the whole Haiku tool-use
 * agent synchronously before emitting response headers, so a large chunk
 * (~6000 chars) could take >5min and the fetch died with
 * UND_ERR_HEADERS_TIMEOUT long before the app's 600s AbortController fired.
 *
 * The fix passes a per-request undici Agent dispatcher whose
 * headersTimeout/bodyTimeout cover opts.timeoutMs, so the call is bounded only
 * by the AbortController, not undici's default 5-min headersTimeout.
 *
 * Hermetic — no DB, no ml-services, no real network. The dispatcher helper is
 * pure; the agentFetch assertion uses a fetch spy to capture the options.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Agent } from 'undici';
import { makeAgentDispatcher, agentFetch } from '../../services/causal-agent.js';
import { config } from '../../config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('makeAgentDispatcher', () => {
  it('returns an undici Agent whose header/body timeouts cover the requested budget', () => {
    const timeoutMs = config.GRAPH_AGENT_TIMEOUT_MS;
    const dispatcher = makeAgentDispatcher(timeoutMs);

    expect(dispatcher).toBeInstanceOf(Agent);

    // Inspect the options undici stored on the Agent. undici keeps the
    // resolved client options under an internal Symbol; assert the configured
    // timeouts are >= the requested budget (or disabled = 0).
    const optsSym = Object.getOwnPropertySymbols(dispatcher).find(
      (s) => s.description === 'options',
    );
    expect(optsSym).toBeDefined();
    const opts = (dispatcher as unknown as Record<symbol, Record<string, unknown>>)[optsSym!]!;

    const headersTimeout = opts.headersTimeout as number;
    const bodyTimeout = opts.bodyTimeout as number;

    expect(headersTimeout === 0 || headersTimeout >= timeoutMs).toBe(true);
    expect(bodyTimeout === 0 || bodyTimeout >= timeoutMs).toBe(true);
    expect(headersTimeout).toBe(timeoutMs);
    expect(bodyTimeout).toBe(timeoutMs);
  });

  it('memoizes the dispatcher per timeoutMs (same budget -> same Agent)', () => {
    const a = makeAgentDispatcher(123456);
    const b = makeAgentDispatcher(123456);
    const c = makeAgentDispatcher(654321);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('agentFetch passes a per-request dispatcher', () => {
  it('supplies a dispatcher Agent whose timeouts >= opts.timeoutMs', async () => {
    const timeoutMs = 600_000;
    let captured: (RequestInit & { dispatcher?: Agent }) | undefined;

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        captured = init as RequestInit & { dispatcher?: Agent };
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

    await agentFetch<{ ok: boolean }>({
      agent: 'graph_agent',
      url: 'http://localhost:8000/graph-agent',
      body: { hello: 'world' },
      timeoutMs,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    const dispatcher = captured!.dispatcher;
    expect(dispatcher).toBeInstanceOf(Agent);

    const optsSym = Object.getOwnPropertySymbols(dispatcher!).find(
      (s) => s.description === 'options',
    );
    const opts = (dispatcher as unknown as Record<symbol, Record<string, unknown>>)[optsSym!]!;
    expect(opts.headersTimeout).toBe(timeoutMs);
    expect(opts.bodyTimeout).toBe(timeoutMs);
  });
});
