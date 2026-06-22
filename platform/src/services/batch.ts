/**
 * Batch ingestion primitives (doc 38 — parallel ingestion, S1).
 *
 * Pure module (no I/O / no DB) so the chunk-ordering logic is unit-testable
 * without infra. The orchestration (`ingestBatch` + per-mode runners) lives in
 * `pipeline.ts`; the live store/extract are exercised only at benchmark time.
 */

import type { ContentType } from './causal-agent.js';

/**
 * Ingestion pipeline arm under comparison:
 *   - `serial`     — control / baseline: store + extract each chunk in order.
 *   - `epoch`      — Approach A: parallel fan-out + barrier reconcile (Stage 3).
 *   - `optimistic` — Approach B: continuous optimistic concurrency (Stage 4).
 */
export type IngestMode = 'serial' | 'epoch' | 'optimistic';

/** One prepared chunk: text + shared batch `sourceId` + its narration-order index. */
export interface BatchItem {
  text: string;
  source?: string;
  /** Groups all chunks from one batched source. */
  sourceId: string;
  /** 0-based narration order within the source — the temporal-alignment key. */
  chunkIndex: number;
  contentType?: ContentType;
  /** Stream scope for speaker identity (one batch = one stream). Threaded into
   *  store() so extract()/propose() resolve the same per-stream speakers. */
  streamId?: string;
}

/**
 * Assign each chunk a 0-based `chunkIndex` (in array order) under one shared
 * `sourceId`. Pure and order-preserving: index N is always the Nth chunk,
 * regardless of how the chunks are later stored/extracted — which is what lets
 * the reconcile step re-establish narration order after out-of-order writes.
 */
export function prepareBatch(
  chunks: string[],
  opts: { source?: string; sourceId: string; contentType?: ContentType; streamId?: string },
): BatchItem[] {
  return chunks.map((text, i) => ({
    text,
    source: opts.source,
    sourceId: opts.sourceId,
    chunkIndex: i,
    contentType: opts.contentType,
    streamId: opts.streamId,
  }));
}
