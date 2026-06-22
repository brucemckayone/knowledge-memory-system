/**
 * Predicate embeddings — enriched-embedding helpers for the living predicate
 * ontology (doc 42 §4–§5, PC2).
 *
 * Builds the "clustering:"-prefixed enriched text (label + description) that the
 * 2026-06-01 ontology benchmark validated, embeds it via ml-services (Ollama
 * nomic, 768-dim), and backfills `fact_predicates.embedding` for the canonical
 * predicates so the multi-signal fold (PC3/PC4) can retrieve them by nearest
 * neighbour.
 *
 * Stored vectors are RAW enriched (uncentered). Mean-centering is vocabulary-
 * relative, so it is applied at query time over a fixed registry snapshot, not
 * baked into the stored vector (doc 42 §5, §12-R1-N3) — otherwise a vector
 * centered at backfill time is incomparable with one centered against a later,
 * larger vocabulary.
 */

import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { sql } from 'drizzle-orm';
import { ml } from './ml-client.js';

/**
 * The enriched embedding text. Mirrors ml-services
 * `benchmark_ontology_embeddings.py::embed_enriched`:
 *   `clustering: The relationship '{label}' describes {description}`
 * The description is lowercased to match the benchmark. When no description is
 * available (the PC3 query path on a raw predicate), the de-underscored label
 * stands in so the prompt is still well-formed.
 */
export function enrichedPredicateText(label: string, description?: string | null): string {
  const desc = (description ?? '').trim();
  const body = desc.length > 0 ? desc.toLowerCase() : label.replace(/_/g, ' ');
  return `clustering: The relationship '${label}' describes ${body}`;
}

/** Embed a predicate's enriched text. Returns the raw (uncentered) 768-dim vector. */
export async function embedPredicateText(label: string, description?: string | null): Promise<number[]> {
  const { vector } = await ml.embed(enrichedPredicateText(label, description));
  return vector;
}

/** pgvector literal for a number[] — matches the entities/facts write idiom. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

export interface BackfillResult {
  /** Number of canonical predicates embedded and written. */
  embedded: number;
}

/**
 * Embed every canonical predicate and write the vector to
 * `fact_predicates.embedding`. Idempotent: rows that already carry an embedding
 * are skipped unless `force` is set. Requires ml-services to be reachable
 * (Ollama nomic); callers gate on availability.
 *
 * Reused by PC3/PC4 to embed a newly-minted staging predicate at promote-time.
 */
export async function backfillPredicateEmbeddings(opts: { force?: boolean } = {}): Promise<BackfillResult> {
  const rows = await rawQuery<{ predicate: string; description: string | null }>(sql`
    SELECT predicate, description
    FROM public.fact_predicates
    WHERE is_canonical = true
      ${opts.force ? sql`` : sql`AND embedding IS NULL`}
    ORDER BY predicate
  `);

  for (const row of rows) {
    const vec = await embedPredicateText(row.predicate, row.description);
    await db.execute(sql`
      UPDATE public.fact_predicates
      SET embedding = ${sql.raw(`'${toVectorLiteral(vec)}'::vector`)}
      WHERE predicate = ${row.predicate}
    `);
  }

  return { embedded: rows.length };
}
