/**
 * Predicate-signature populator (Phase 4 prep — doc 25 §2.2 W4 role-similarity input).
 *
 * Migration 014 declared `entity_topology.predicate_signature VECTOR(25)` with
 * comment "compute path is owned by a Phase 2 child (TBD) or Phase 4 prep" —
 * Phase 4 owns it. Doc 25 §2.2 specifies an L2-normalised sparse vector over
 * the canonical predicate vocabulary in `predicates.ts`, where each component
 * is the count of an entity's outgoing facts with that canonical predicate.
 *
 * The signature is the input to `role_similarity(a, b) = cosine(sig_a, sig_b)`
 * inside the cross-cluster generator (w4 = 0.20, second-largest weight after
 * the embedding-cluster signal). Without it, role_similarity collapses to 0
 * and Phase 4 loses 20% of its scoring vector.
 *
 * Design notes:
 * - The vocabulary order must be stable across runs. We snapshot
 *   `Object.keys(CANONICAL_ONTOLOGY)` once at module load (insertion-order is
 *   stable in JS for string keys) and freeze it. If the ontology grows, the
 *   migration's VECTOR(N) must grow in lock-step.
 * - Non-canonical predicates (an alias or an unknown predicate) get
 *   normalised via `normalizePredicate`. Aliases land on their canonical bin;
 *   genuinely-unknown predicates contribute zero. An entity whose outgoing
 *   facts are all unknown produces a zero-norm signature; we leave the
 *   column NULL rather than writing a zero vector (cosine of zero vector is
 *   undefined and would corrupt role_similarity downstream).
 * - Only ACTIVE outgoing facts count (`expired_at IS NULL`). Drift detection
 *   already keys on the live entity state; the role signature should match.
 */

import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { CANONICAL_ONTOLOGY, normalizePredicate } from './predicates.js';

const PREDICATE_ORDER: readonly string[] = Object.freeze(Object.keys(CANONICAL_ONTOLOGY));
const PREDICATE_INDEX: ReadonlyMap<string, number> = new Map(
  PREDICATE_ORDER.map((p, i) => [p, i] as const),
);
const SIGNATURE_DIM = PREDICATE_ORDER.length;

/**
 * Returns the deterministic canonical-predicate ordering used to index the
 * signature vector. Position i in the vector corresponds to the count of
 * outgoing facts whose canonical predicate is `getPredicateOrder()[i]`.
 */
export function getPredicateOrder(): readonly string[] {
  return PREDICATE_ORDER;
}

/**
 * Compute the L2-normalised predicate signature from a flat list of predicates.
 * Returns `null` when the resulting vector has zero norm (no canonical
 * predicates landed in any bin) — caller leaves the column NULL.
 */
export function computePredicateSignature(predicates: readonly string[]): number[] | null {
  const counts = new Array(SIGNATURE_DIM).fill(0) as number[];
  for (const raw of predicates) {
    const canonical = normalizePredicate(raw);
    const idx = PREDICATE_INDEX.get(canonical);
    if (idx !== undefined) counts[idx]! += 1;
  }
  let normSq = 0;
  for (const v of counts) normSq += v * v;
  if (normSq === 0) return null;
  const norm = Math.sqrt(normSq);
  for (let i = 0; i < SIGNATURE_DIM; i++) counts[i]! /= norm;
  return counts;
}

/**
 * Cosine similarity between two predicate signatures. Inputs are assumed
 * already L2-normalised (which `computePredicateSignature` guarantees), so
 * this is just a dot product. Returns 0 when either is null/empty.
 */
export function cosineSignatureSimilarity(
  a: readonly number[] | null,
  b: readonly number[] | null,
): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export interface PopulateResult {
  /** Entities for whom a non-null signature was upserted. */
  entitiesProcessed: number;
  /** Entities whose only outgoing predicates were non-canonical or who had no
   *  active outgoing facts — signature left NULL on those rows. */
  entitiesSkipped: number;
}

/**
 * Recompute predicate_signature for every entity that has at least one active
 * outgoing fact. Upsert-only on entity_topology — we don't touch the other
 * columns (component_id, k_core, pagerank, etc), so this is safe to call
 * before or after the Phase 2 ml-services topology compute.
 *
 * Pass `entityIds` to scope the recompute to a known set; otherwise the
 * helper rebuilds the whole table from `facts`.
 *
 * Implementation aggregates outgoing predicates per subject via a single
 * GROUP BY query so we don't N+1 the DB on every entity. For an entity with
 * only non-canonical predicates the resulting count vector is zero and we
 * skip the upsert (leaving NULL — see §2.2 W4 contract).
 */
export async function populatePredicateSignatures(
  entityIds?: readonly string[],
): Promise<PopulateResult> {
  // Pull (entity_id, predicate, count) for active outgoing facts, scoped if
  // entityIds is provided.
  const rows = entityIds && entityIds.length > 0
    ? (await db.execute(sql`
        SELECT subject_entity_id::text AS entity_id, predicate, COUNT(*)::int AS cnt
        FROM public.facts
        WHERE expired_at IS NULL
          AND subject_entity_id = ANY(${sql.raw(`ARRAY[${entityIds.map((id) => `'${id}'::uuid`).join(',')}]`)})
        GROUP BY subject_entity_id, predicate
      `)) as unknown as Array<{ entity_id: string; predicate: string; cnt: number }>
    : (await db.execute(sql`
        SELECT subject_entity_id::text AS entity_id, predicate, COUNT(*)::int AS cnt
        FROM public.facts
        WHERE expired_at IS NULL AND subject_entity_id IS NOT NULL
        GROUP BY subject_entity_id, predicate
      `)) as unknown as Array<{ entity_id: string; predicate: string; cnt: number }>;

  // Bucket by entity_id → map<canonicalIdx, count>.
  const perEntity = new Map<string, number[]>();
  for (const r of rows) {
    let bins = perEntity.get(r.entity_id);
    if (!bins) {
      bins = new Array(SIGNATURE_DIM).fill(0) as number[];
      perEntity.set(r.entity_id, bins);
    }
    const canonical = normalizePredicate(r.predicate);
    const idx = PREDICATE_INDEX.get(canonical);
    if (idx !== undefined) bins[idx]! += r.cnt;
  }

  let processed = 0;
  let skipped = 0;
  for (const [entityId, bins] of perEntity) {
    let normSq = 0;
    for (const v of bins) normSq += v * v;
    if (normSq === 0) {
      skipped++;
      continue;
    }
    const norm = Math.sqrt(normSq);
    for (let i = 0; i < SIGNATURE_DIM; i++) bins[i]! /= norm;
    const sigLit = `[${bins.join(',')}]`;
    await db.execute(sql`
      INSERT INTO public.entity_topology (entity_id, predicate_signature, computed_at)
      VALUES (${entityId}::uuid, ${sql.raw(`'${sigLit}'::vector`)}, NOW())
      ON CONFLICT (entity_id) DO UPDATE SET
        predicate_signature = EXCLUDED.predicate_signature,
        computed_at = NOW()
    `);
    processed++;
  }
  return { entitiesProcessed: processed, entitiesSkipped: skipped };
}
