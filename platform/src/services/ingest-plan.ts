/**
 * Pure sub-batch partitioning + corpus fingerprinting for resumable batch
 * ingest. Kept DB-free (no ./db import) so it unit-tests without infra — the
 * stateful ledger (ingest-ledger.ts) re-exports these and layers Postgres CRUD
 * on top.
 */

import { createHash } from 'node:crypto';

export interface PlannedSubBatch {
  seq: number;
  /** Inclusive start index into the corpus. */
  chunkStart: number;
  /** Exclusive end index into the corpus. */
  chunkEnd: number;
}

/**
 * Split `totalChunks` items into contiguous sub-batches of at most
 * `subBatchSize`, numbered 0..N-1 in order. The last sub-batch holds the
 * remainder; a corpus at or below one sub-batch yields a single sub-batch; an
 * empty corpus yields none.
 */
export function planSubBatches(totalChunks: number, subBatchSize: number): PlannedSubBatch[] {
  if (!Number.isInteger(subBatchSize) || subBatchSize <= 0) {
    throw new Error(`planSubBatches: subBatchSize must be a positive integer (got ${subBatchSize})`);
  }
  const out: PlannedSubBatch[] = [];
  let seq = 0;
  for (let start = 0; start < totalChunks; start += subBatchSize) {
    out.push({ seq, chunkStart: start, chunkEnd: Math.min(start + subBatchSize, totalChunks) });
    seq++;
  }
  return out;
}

/**
 * Stable fingerprint of the corpus contents + order. Used to refuse resuming a
 * job under a name whose corpus has since changed (a silent resume against a
 * different corpus would corrupt the checkpoint semantics).
 */
export function corpusHash(chunks: string[]): string {
  return createHash('sha256').update(JSON.stringify(chunks)).digest('hex');
}
