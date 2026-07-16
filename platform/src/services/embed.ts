/**
 * Embedding helpers with an explicit write-vs-query failure contract (bead nmemo-avd
 * / PC8-1).
 *
 * The footgun this fixes: several mint paths embedded text with a private helper that
 * caught ANY ML/Ollama failure and returned `[]`, then guarded the write with
 * `if (vec.length > 0)`. On a 503 the row committed with a NULL embedding, and
 * pgvector recall over that row silently returns nothing — permanent, invisible recall
 * degradation. `corpus-ingest.ts` already established the fix for its own path (throw
 * loud); this module makes that the shared, canonical behaviour for every write path.
 *
 * The split is deliberate:
 * - WRITE/mint paths MUST use {@link embedForWrite}: a missing vector throws, so a
 *   NULL embedding can never be persisted silently. The failure surfaces to the
 *   caller (and to the epoch backpressure/retry layer) instead of corrupting state.
 * - READ/query paths (similarity search, mention resolution) use {@link embedForQuery}:
 *   a failure returns `[]` so the caller degrades to no-results / a name-match
 *   fallback. A failed query embedding does not corrupt state, so it stays lenient.
 */

import { ml } from './ml-client.js';

/**
 * Raised when the ML service cannot produce an embedding for text that MUST be
 * embedded (any mint/write path). Callers on a write path must NOT catch-and-continue
 * — swallowing this reintroduces the PC8-1 silent-NULL defect (nmemo-avd).
 */
export class EmbeddingUnavailableError extends Error {
  constructor(text: string, options?: { cause?: unknown }) {
    super(`embedding unavailable for text "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
    this.name = 'EmbeddingUnavailableError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Embed text for a WRITE/mint path. Throws {@link EmbeddingUnavailableError} if the
 * ML service errors OR returns an empty vector — it NEVER returns `[]`, so a caller
 * cannot silently persist a NULL embedding (nmemo-avd / PC8-1). Compute the vector
 * BEFORE inserting the row (as all current mint paths do) so a throw aborts before any
 * write and leaves no NULL-embedding row behind.
 */
export async function embedForWrite(text: string): Promise<number[]> {
  let vector: number[] | undefined;
  try {
    ({ vector } = await ml.embed(text));
  } catch (err) {
    throw new EmbeddingUnavailableError(text, { cause: err });
  }
  if (!vector || vector.length === 0) {
    throw new EmbeddingUnavailableError(text);
  }
  return vector;
}

/**
 * Embed text for a READ/query path (similarity search, mention resolution). Returns
 * `[]` on failure so the caller can degrade gracefully — a failed query embedding
 * yields no results / a name-match fallback rather than an exception. Never use this
 * on a write path (use {@link embedForWrite}).
 */
export async function embedForQuery(text: string): Promise<number[]> {
  try {
    const { vector } = await ml.embed(text);
    return vector ?? [];
  } catch {
    return [];
  }
}
