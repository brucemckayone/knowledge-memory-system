/**
 * Deterministic RFC-4122 v5 point ids for the ingest / lineage substrate.
 *
 * Extracted to a leaf module (its only dependency is node:crypto) so BOTH the
 * writer (pipeline.ts store()/recordFragments) and the epoch canonical writer
 * (promotion.ts) can derive the SAME window id without a pipeline<->promotion
 * import cycle (promotion.ts must not import pipeline.ts). See doc 35 §2/§4.
 *
 * The ids are pure functions of their inputs: store() persists the window under
 * windowPointId(sourceId, chunkIndex) and each unit under unitPointId(memoryId,
 * i); extract()/promote() recompute the identical ids with zero Qdrant reads.
 */
import { createHash } from 'node:crypto';

// RFC-4122 v5 URL namespace — fixed base for unit satellite point ids. Any stable
// UUID works; per-window uniqueness comes from feeding the memoryId into the name.
const UNIT_ID_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
// Distinct fixed namespace for window point ids, so a window id can never collide
// with a unit id derived from the same name string.
const WINDOW_ID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
// Distinct fixed namespace for source_document ids (mig 059), so a document id can
// never collide with a window/unit point id derived from the same name string.
const DOC_ID_NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

/**
 * Hand-rolled RFC-4122 v5 (SHA-1 of namespace||name) — no dependency, since the
 * `uuid` package is not installed and CLAUDE.md sanctions `crypto`. Output is a
 * canonical lowercase UUID string.
 */
export function uuidV5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  const bytes = hash.subarray(0, 16);
  // Set version (5) and RFC-4122 variant bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Deterministic unit satellite point id (nmemo-yxj.6): uuidv5(memoryId, unitIndex).
 * store() writes the unit payload under this id; extract() recomputes it from the
 * window text + splitIntoUnits index with ZERO Qdrant reads.
 */
export function unitPointId(memoryId: string, unitIndex: number): string {
  return uuidV5(UNIT_ID_NAMESPACE, `${memoryId}:${unitIndex}`);
}

/**
 * Deterministic memory (window) point id for batched ingest. When a chunk carries
 * a stable (sourceId, chunkIndex) — true for every batch arm — the memoryId is a
 * pure function of them, so a re-store UPSERTs the same parent + unit points, and
 * the epoch promote() can reconstruct the fact's window id from the staged
 * (source_id, chunk_index). Single ingest (no sourceId) keeps randomUUID().
 */
export function windowPointId(sourceId: string, chunkIndex: number): string {
  return uuidV5(WINDOW_ID_NAMESPACE, `${sourceId}:${chunkIndex}`);
}

/**
 * Deterministic source_document id (mig 059). Keyed by (corpusId, sourceKey): the
 * batch source_id when present, else the single-ingest window id. uuidv5 so a
 * re-store of the same source UPSERTs the same document row (idempotent).
 */
export function sourceDocumentId(corpusId: string, sourceKey: string): string {
  return uuidV5(DOC_ID_NAMESPACE, `${corpusId}:${sourceKey}`);
}
