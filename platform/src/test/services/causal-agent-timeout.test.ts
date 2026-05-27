/**
 * Bead nmemo-2yv.76 — regression tests for AbortController + setTimeout
 * timeout wrapping on the three Claude-Code-spawning agent invocations
 * (invokeReasoningAgent, invokeGraphAgent, invokeGardenerAgent) and the
 * /api/reason 504 response that surfaces a client-side timeout to the viz.
 *
 * Before the fix: bare fetch with no `signal`, no AbortController. A hung
 * ml-services subprocess (stuck LLM call, frozen MCP server) leaked the
 * fetch indefinitely — viz buttons spun forever, /api/reason produced no
 * response at all until the OS-level socket timeout (hours/days).
 *
 * Strategy mirrors src/test/services/ml-client.test.ts:
 *   - vi.spyOn(global, 'fetch') for precise per-attempt control.
 *   - vi.useFakeTimers() so the watchdog fires deterministically without
 *     real wall-clock waits. The mock fetch resolves only when the signal
 *     aborts; advancing the timer to the configured timeout drives the
 *     watchdog, the signal fires, and the mock fetch rejects with the
 *     same DOMException('AbortError') the platform sees from undici.
 *
 * Hermetic — no DB, no ml-services, no spawn. The spy intercepts every
 * outbound fetch and the agent code path runs end-to-end against the spy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  invokeReasoningAgent,
  invokeGraphAgent,
  invokeGardenerAgent,
  AgentInvocationTimeoutError,
} from '../../services/causal-agent.js';
import { config } from '../../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fetch mock that resolves only when the controller signal aborts.
 * Mirrors undici's behaviour: when the caller's AbortController.abort()
 * fires, fetch rejects with DOMException('The operation was aborted.',
 * 'AbortError'). The mock never resolves on its own — it depends entirely
 * on the watchdog firing.
 */
function fetchThatHangsUntilAborted(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        // Without a signal the request would hang forever — fail loudly so
        // the test surfaces a missing-signal regression instead of timing
        // out at the vitest hook level.
        throw new Error('fetchThatHangsUntilAborted: no AbortSignal on request — the agent invocation skipped the watchdog');
      }
      const onAbort = () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

/** Drive any pending watchdog without a real wait. */
async function advanceBeyond(ms: number) {
  await vi.advanceTimersByTimeAsync(ms + 1);
}

// ---------------------------------------------------------------------------
// invokeReasoningAgent — the primary fix site from the bead
// ---------------------------------------------------------------------------

describe('invokeReasoningAgent timeout (nmemo-2yv.76)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchSpy = vi.spyOn(global, 'fetch') as any;
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  it('passes an AbortSignal on the fetch request (regression guard for bare fetch)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      async json() { return { result: 'ok' }; },
      async text() { return ''; },
      statusText: 'OK',
    } as unknown as Response);

    await invokeReasoningAgent({ mode: 'query', question: 'why?' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts and throws AgentInvocationTimeoutError when ml-services hangs past REASONING_AGENT_TIMEOUT_MS', async () => {
    fetchSpy.mockImplementation(fetchThatHangsUntilAborted());

    const promise = invokeReasoningAgent({ mode: 'query', question: 'why?' }).catch(e => e);

    // Just before the deadline — watchdog has NOT fired yet.
    await vi.advanceTimersByTimeAsync(config.REASONING_AGENT_TIMEOUT_MS - 100);
    // Cross the deadline — watchdog fires, fetch rejects.
    await advanceBeyond(200);

    const err = await promise;
    expect(err).toBeInstanceOf(AgentInvocationTimeoutError);
    expect((err as AgentInvocationTimeoutError).agent).toBe('reasoning_agent');
    expect((err as AgentInvocationTimeoutError).timeoutMs).toBe(config.REASONING_AGENT_TIMEOUT_MS);
    expect((err as AgentInvocationTimeoutError).message).toContain('reasoning_agent');
    expect((err as AgentInvocationTimeoutError).message).toContain(String(config.REASONING_AGENT_TIMEOUT_MS));
  });

  it('non-OK responses still throw the generic Error path (not the timeout class)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      async json() { return {}; },
      async text() { return 'upstream boom'; },
      statusText: 'Internal Server Error',
    } as unknown as Response);

    const err = await invokeReasoningAgent({ mode: 'query', question: 'why?' }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AgentInvocationTimeoutError);
    expect((err as Error).message).toContain('reasoning_agent failed (500)');
    expect((err as Error).message).toContain('upstream boom');
  });
});

// ---------------------------------------------------------------------------
// invokeGraphAgent + invokeGardenerAgent — same shape, fix together
// ---------------------------------------------------------------------------

describe('invokeGraphAgent timeout (nmemo-2yv.76)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchSpy = vi.spyOn(global, 'fetch') as any;
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  it('aborts and throws AgentInvocationTimeoutError when ml-services hangs past GRAPH_AGENT_TIMEOUT_MS', async () => {
    fetchSpy.mockImplementation(fetchThatHangsUntilAborted());

    const promise = invokeGraphAgent({
      sourceText: 'whatever',
      memoryId: '00000000-0000-0000-0000-000000000000',
      source: 'test',
    }).catch(e => e);

    await vi.advanceTimersByTimeAsync(config.GRAPH_AGENT_TIMEOUT_MS - 100);
    await advanceBeyond(200);

    const err = await promise;
    expect(err).toBeInstanceOf(AgentInvocationTimeoutError);
    expect((err as AgentInvocationTimeoutError).agent).toBe('graph_agent');
    expect((err as AgentInvocationTimeoutError).timeoutMs).toBe(config.GRAPH_AGENT_TIMEOUT_MS);
  });
});

describe('invokeGardenerAgent timeout (nmemo-2yv.76)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchSpy = vi.spyOn(global, 'fetch') as any;
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  it('aborts and throws AgentInvocationTimeoutError when ml-services hangs past GARDENER_AGENT_TIMEOUT_MS', async () => {
    fetchSpy.mockImplementation(fetchThatHangsUntilAborted());

    const promise = invokeGardenerAgent({ trigger: 'manual' }).catch(e => e);

    await vi.advanceTimersByTimeAsync(config.GARDENER_AGENT_TIMEOUT_MS - 100);
    await advanceBeyond(200);

    const err = await promise;
    expect(err).toBeInstanceOf(AgentInvocationTimeoutError);
    expect((err as AgentInvocationTimeoutError).agent).toBe('gardener_agent');
    expect((err as AgentInvocationTimeoutError).timeoutMs).toBe(config.GARDENER_AGENT_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// AgentInvocationTimeoutError shape — load-bearing for the index.ts 504 mapping
// ---------------------------------------------------------------------------

describe('AgentInvocationTimeoutError (nmemo-2yv.76)', () => {
  it('carries agent + timeoutMs and is distinguishable from generic Error via instanceof', () => {
    const err = new AgentInvocationTimeoutError('reasoning_agent', 600_000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentInvocationTimeoutError);
    expect(err.name).toBe('AgentInvocationTimeoutError');
    expect(err.agent).toBe('reasoning_agent');
    expect(err.timeoutMs).toBe(600_000);
    expect(err.message).toBe('reasoning_agent timed out after 600000ms');
  });
});
