/**
 * Bead nmemo-2yv.115 — unit tests for src/services/ml-client.ts.
 *
 * Covers the bug surface that was only happy-path exercised transitively
 * through end-to-end pipeline tests:
 *   - 3-attempt retry on {502, 503, 504} with [500, 1000]ms backoff
 *   - No retry on non-retryable status codes (e.g. 400)
 *   - AbortError → MlClientError(0, 'Request timed out'); no retry
 *   - Network error → retry, then MlClientError(0, message) on exhaustion
 *   - generateJson markdown-fence stripping + JSON parse
 *   - extractEntities conditional spread (omitted optional args stay omitted)
 *   - health() swallows fetch rejections
 *
 * Strategy:
 *   - vi.spyOn(global, 'fetch') for cases needing precise per-attempt control.
 *   - vi.useFakeTimers() to advance through the backoff sleeps without real
 *     waits — tests run in ms instead of seconds.
 *   - Hermetic: no ML_SERVICES_URL dependency; the spy intercepts all fetches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ml, MlClientError } from '../../services/ml-client.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a Response-like mock with the minimum surface mlFetch reads. */
function mockResponse(opts: { ok: boolean; status: number; body?: unknown; text?: string; headers?: Record<string, string> }): Response {
  const headerMap = new Map<string, string>(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: opts.ok,
    status: opts.status,
    statusText: opts.text ?? 'mock',
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    async json() { return opts.body; },
    async text() { return opts.text ?? JSON.stringify(opts.body ?? ''); },
  } as unknown as Response;
}

/** Drive any pending retry sleeps without a real wait. */
async function flushRetries() {
  // Advance through both backoff steps + microtask queue.
  await vi.advanceTimersByTimeAsync(2_000);
}

describe('ml-client mlFetch retry/timeout/error (nmemo-2yv.115)', () => {
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

  it('embed happy path: returns {vector, model, dimensions} and POSTs JSON body to /embed', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({
      ok: true,
      status: 200,
      body: { vector: [0.1, 0.2], model: 'nomic-embed-text', dimensions: 768 },
    }));
    const result = await ml.embed('hello', 'nomic-embed-text');
    expect(result).toEqual({ vector: [0.1, 0.2], model: 'nomic-embed-text', dimensions: 768 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/embed$/);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: 'hello', model: 'nomic-embed-text' });
  });

  it('retries once on 502 then succeeds (fetch called twice)', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 502, text: 'Bad Gateway' }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: { vector: [1], model: 'm', dimensions: 1 } }));
    const promise = ml.embed('x');
    await flushRetries();
    const result = await promise;
    expect(result.vector).toEqual([1]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 three times then throws MlClientError(503)', async () => {
    fetchSpy.mockResolvedValue(mockResponse({ ok: false, status: 503, text: 'Service Unavailable' }));
    const promise = ml.embed('x').catch(e => e);
    await flushRetries();
    const err = await promise;
    expect(err).toBeInstanceOf(MlClientError);
    expect((err as MlClientError).status).toBe(503);
    expect((err as MlClientError).endpoint).toBe('/embed');
    expect((err as MlClientError).detail).toContain('Service Unavailable');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on 400 — throws MlClientError(400) after a single call', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: false, status: 400, text: 'Bad Request: missing text' }));
    const err = await ml.embed('x').catch(e => e);
    expect(err).toBeInstanceOf(MlClientError);
    expect((err as MlClientError).status).toBe(400);
    expect((err as MlClientError).detail).toContain('Bad Request');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on AbortError — throws MlClientError(0, "Request timed out")', async () => {
    // fetch throws AbortError when the controller signal aborts.
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    fetchSpy.mockRejectedValueOnce(abortErr);
    const err = await ml.embed('x').catch(e => e);
    expect(err).toBeInstanceOf(MlClientError);
    expect((err as MlClientError).status).toBe(0);
    expect((err as MlClientError).detail).toBe('Request timed out');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 with Retry-After: 2 and sleeps ~2000ms before the next attempt (nmemo-2yv.119)', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({
        ok: false, status: 429, text: 'Too Many Requests',
        headers: { 'Retry-After': '2' },
      }))
      .mockResolvedValueOnce(mockResponse({
        ok: true, status: 200,
        body: { vector: [9], model: 'm', dimensions: 1 },
      }));
    const promise = ml.embed('x');
    // Less than 2000ms — second attempt should NOT have fired yet.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Cross the 2000ms boundary — second attempt fires.
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;
    expect(result.vector).toEqual([9]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 with no Retry-After and uses the default backoff schedule (nmemo-2yv.119)', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 429, text: 'Too Many Requests' }))
      .mockResolvedValueOnce(mockResponse({
        ok: true, status: 200,
        body: { vector: [7], model: 'm', dimensions: 1 },
      }));
    const promise = ml.embed('x');
    // Default BACKOFF_MS[0] = 500ms; before that the second attempt is pending.
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;
    expect(result.vector).toEqual([7]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries on network error (fetch rejection) and throws MlClientError after exhaustion', async () => {
    const netErr = new TypeError('fetch failed: ECONNREFUSED');
    fetchSpy.mockRejectedValue(netErr);
    const promise = ml.embed('x').catch(e => e);
    await flushRetries();
    const err = await promise;
    expect(err).toBeInstanceOf(MlClientError);
    expect((err as MlClientError).status).toBe(0);
    expect((err as MlClientError).detail).toContain('ECONNREFUSED');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe('ml-client extractEntities conditional spread (nmemo-2yv.115)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchSpy = vi.spyOn(global, 'fetch') as any;
    fetchSpy.mockResolvedValue(mockResponse({
      ok: true,
      status: 200,
      body: { entities: [], text_length: 0 },
    }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('extractEntities(text) sends only {text} — no valid_types, known_entities, context_snippets', async () => {
    await ml.extractEntities('hello world');
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ text: 'hello world' });
    expect(body).not.toHaveProperty('valid_types');
    expect(body).not.toHaveProperty('known_entities');
    expect(body).not.toHaveProperty('context_snippets');
  });

  it('extractEntities(text, validTypes, knownEntities, contextSnippets) sends all four keys with snake_case names', async () => {
    await ml.extractEntities(
      'text',
      ['Person', 'Place'],
      [{ name: 'Alice', type: 'Person' }],
      ['surrounding context'],
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({
      text: 'text',
      valid_types: ['Person', 'Place'],
      known_entities: [{ name: 'Alice', type: 'Person' }],
      context_snippets: ['surrounding context'],
    });
  });
});

describe('ml-client generateJson fence stripping (nmemo-2yv.115)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchSpy = vi.spyOn(global, 'fetch') as any;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('strips ```json\\n...\\n``` fence wrapping and parses the JSON', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({
      ok: true,
      status: 200,
      body: { response: '```json\n{"name": "alpha", "score": 0.9}\n```' },
    }));
    const result = await ml.generateJson<{ name: string; score: number }>('prompt');
    expect(result).toEqual({ name: 'alpha', score: 0.9 });
  });

  it('strips bare ```\\n...\\n``` (no language tag) and parses the JSON', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({
      ok: true,
      status: 200,
      body: { response: '```\n{"hello": "world"}\n```' },
    }));
    const result = await ml.generateJson<{ hello: string }>('prompt');
    expect(result).toEqual({ hello: 'world' });
  });

  it('throws MlClientError(422) on unparseable JSON output (bead nmemo-2yv.120)', async () => {
    // generateJson now wraps JSON.parse failure as MlClientError(422) so
    // callers can pattern-match on the unified error class instead of
    // distinguishing SyntaxError from network errors.
    fetchSpy.mockResolvedValueOnce(mockResponse({
      ok: true,
      status: 200,
      body: { response: 'not even close to JSON' },
    }));
    let captured: unknown;
    try {
      await ml.generateJson('prompt');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(MlClientError);
    expect(captured).toMatchObject({
      status: 422,
      detail: expect.stringContaining('not valid JSON'),
    });
  });
});

describe('ml-client health() (nmemo-2yv.115)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchSpy = vi.spyOn(global, 'fetch') as any;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns true when /health responds 200', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));
    expect(await ml.health()).toBe(true);
  });

  it('returns false when /health rejects (caught — does not throw)', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('ECONNREFUSED'));
    expect(await ml.health()).toBe(false);
  });

  it('returns false when /health returns non-OK status', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }));
    expect(await ml.health()).toBe(false);
  });
});
