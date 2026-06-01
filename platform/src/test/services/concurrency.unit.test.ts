/**
 * Unit tests for the bounded-concurrency + retry helpers (doc 38). Pure — no infra.
 */

import { describe, it, expect } from 'vitest';
import { mapWithConcurrency, withRetry, isQueueFull } from '../../services/concurrency.js';

const noSleep = (): Promise<void> => Promise.resolve();

describe('mapWithConcurrency', () => {
  it('preserves input order in results', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('handles empty input', async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });
});

describe('withRetry', () => {
  it('returns on first success', async () => {
    let calls = 0;
    const r = await withRetry(async () => { calls++; return 'ok'; }, { retries: 3, isRetryable: () => true, baseDelayMs: 1, sleep: noSleep });
    expect(r).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a retryable error then succeeds', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('boom 503 busy');
      return 'ok';
    }, { retries: 5, isRetryable: isQueueFull, baseDelayMs: 1, sleep: noSleep });
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a non-retryable error', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error('fatal 400'); }, { retries: 5, isRetryable: isQueueFull, baseDelayMs: 1, sleep: noSleep }),
    ).rejects.toThrow('fatal 400');
    expect(calls).toBe(1);
  });

  it('rethrows after exhausting retries', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error('always 503'); }, { retries: 2, isRetryable: isQueueFull, baseDelayMs: 1, sleep: noSleep }),
    ).rejects.toThrow('always 503');
    expect(calls).toBe(3); // first attempt + 2 retries
  });
});

describe('isQueueFull', () => {
  it('detects 503 / queue-full messages', () => {
    expect(isQueueFull(new Error('Agentic extraction failed (503): busy'))).toBe(true);
    expect(isQueueFull(new Error('QueueFull: buffer full'))).toBe(true);
    expect(isQueueFull(new Error('timeout after 600s'))).toBe(false);
    expect(isQueueFull('plain 503 string')).toBe(true);
  });
});
