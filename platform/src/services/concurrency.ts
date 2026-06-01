/**
 * Bounded-concurrency + retry helpers (doc 38 — parallel ingestion).
 *
 * Pure (no app I/O of its own) so the fan-out + backoff logic is unit-testable.
 * Used by the epoch (A) and optimistic (B) batch runners to fan agent
 * extractions out in parallel while respecting the ML service's resource-pool
 * backpressure (it returns HTTP 503 when its queue is full — core/concurrency.py).
 */

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the result array. A shared cursor hands each worker the next
 * index (safe — Node is single-threaded).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

export interface RetryOptions {
  /** Max retries AFTER the first attempt. */
  retries: number;
  /** Whether a thrown error should be retried (e.g. 503 backpressure). */
  isRetryable: (err: unknown) => boolean;
  /** Base backoff; delay is baseDelayMs * 2**attempt. */
  baseDelayMs: number;
  /** Injectable sleep (tests pass a no-op to avoid real delays). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry `fn` with exponential backoff while it throws a retryable error.
 * Non-retryable errors propagate immediately; the last error is rethrown once
 * `retries` is exhausted.
 */
export async function withRetry<R>(fn: () => Promise<R>, opts: RetryOptions): Promise<R> {
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.retries || !opts.isRetryable(err)) throw err;
      await sleep(opts.baseDelayMs * 2 ** attempt);
      attempt++;
    }
  }
}

/**
 * The ML service's resource pool returns HTTP 503 (QueueFullError) when its
 * in-flight + queued agent invocations exceed capacity — the signal to back off
 * and retry, not to fail the chunk.
 */
export function isQueueFull(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b503\b/.test(msg) || /queue ?full/i.test(msg);
}
