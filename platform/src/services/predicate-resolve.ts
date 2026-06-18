/**
 * Promote-time predicate canonicalization fold (truth-graph doc 42 §4/§7, PC4 —
 * "the spine").
 *
 * For each staged fact, resolve its raw predicate to an existing canonical
 * (reuse) or mint a new candidate in the registry — at promote time, where it is
 * isolation-safe and dedupes across the epoch's isolated proposers. Mutates
 * `StagedFact.predicate` in place to the canonical string BEFORE planPromotion
 * runs, so tripleKey, the prior-canonical index, exclusive-group supersession,
 * and the written `facts.predicate` all key on the canonical predicate
 * automatically (no other change to the pure planner).
 *
 * Determinism + isolation: the fold is a pure map over the frozen staging
 * snapshot + the registry; the resolve endpoint is deterministic (no LLM).
 * ml-down resilience: if ml-services is unreachable, each fact keeps its raw
 * predicate (the doc §6 down-mode) — promotion never hard-fails on it.
 */

import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { sql } from 'drizzle-orm';
import { ml, type ResolvePredicateCandidate } from './ml-client.js';
import { embedPredicateText, toVectorLiteral } from './predicate-embeddings.js';
import type { StagedFact, StagedEntity } from './promotion-plan.js';

/** Load the candidate predicates (canonical + already-minted) that carry an
 * embedding. Minted staging predicates are included so the vocabulary reuses
 * within and across epochs. Rejected predicates are excluded. */
export async function loadPredicateCandidates(): Promise<ResolvePredicateCandidate[]> {
  const rows = await rawQuery<{
    predicate: string;
    description: string | null;
    subject_type: string | null;
    object_type: string | null;
    inverse_predicate: string | null;
    aliases: string[] | null;
    embedding: string | null;
  }>(sql`
    SELECT predicate, description, subject_type, object_type, inverse_predicate, aliases,
           embedding::text AS embedding
    FROM public.fact_predicates
    WHERE embedding IS NOT NULL AND status <> 'rejected'
  `);
  return rows.map((r) => ({
    predicate: r.predicate,
    description: r.description ?? '',
    embedding: JSON.parse(r.embedding as string) as number[],
    subjectType: r.subject_type,
    objectType: r.object_type,
    inversePredicate: r.inverse_predicate,
    aliases: r.aliases ?? [],
  }));
}

/** Mint a new candidate predicate: embed it and insert as a staging row. Returns
 * the candidate so the caller can reuse it within the same epoch without a
 * re-query. Idempotent (ON CONFLICT DO NOTHING). */
export async function mintPredicateCandidate(
  label: string,
  opts: { description?: string; subjectType?: string | null; objectType?: string | null } = {},
): Promise<ResolvePredicateCandidate> {
  const embedding = await embedPredicateText(label, opts.description);
  await db.execute(sql`
    INSERT INTO public.fact_predicates
      (predicate, description, subject_type, object_type, is_canonical, status, embedding)
    VALUES (${label}, ${opts.description ?? null}, ${opts.subjectType ?? null}, ${opts.objectType ?? null},
            false, 'staging', ${sql.raw(`'${toVectorLiteral(embedding)}'::vector`)})
    ON CONFLICT (predicate) DO NOTHING
  `);
  return {
    predicate: label,
    description: opts.description ?? '',
    embedding,
    subjectType: opts.subjectType ?? null,
    objectType: opts.objectType ?? null,
    inversePredicate: null,
    aliases: [],
  };
}

export interface CanonicalizeStats {
  reused: number;
  minted: number;
  deferred: number;
}

/**
 * Canonicalize the staged facts' predicates in place. Resolves each distinct
 * (predicate, subjectType, objectType) once (cached). Reuse → the canonical;
 * mint → a new staging candidate; deferred → kept raw (ml-down).
 */
export async function canonicalizeStagedPredicates(
  facts: StagedFact[],
  entities: StagedEntity[],
): Promise<CanonicalizeStats> {
  const stats: CanonicalizeStats = { reused: 0, minted: 0, deferred: 0 };
  if (facts.length === 0) return stats;

  // Uses the canonical embeddings already in the registry (backfilled by the PC2
  // setup step — `backfill-predicate-embeddings.ts` at deploy, or the harness/test
  // before a run). If none are present the fold is a graceful no-op (predicates
  // kept raw) rather than auto-embedding here — that keeps promote() free of an
  // ml-availability side effect on every call and keeps unrelated promote tests
  // unaffected on a fresh DB.
  const candidates = await loadPredicateCandidates();
  if (candidates.length === 0) {
    stats.deferred = facts.length;
    return stats;
  }

  const typeByHandle = new Map(entities.map((e) => [e.handle, e.type]));
  const cache = new Map<string, string | null>(); // key -> canonical (or null = keep raw)

  for (const f of facts) {
    const subjectType = typeByHandle.get(f.subjectHandle) ?? null;
    const objectType = f.objectHandle ? (typeByHandle.get(f.objectHandle) ?? null) : null;
    const key = `${f.predicate} ${subjectType ?? ''} ${objectType ?? ''}`;

    if (!cache.has(key)) {
      try {
        const res = await ml.resolvePredicate({ predicate: f.predicate, subjectType, objectType, candidates });
        if (res.decision === 'merge' && res.canonical) {
          cache.set(key, res.canonical);
          stats.reused++;
        } else {
          // distinct OR ambiguous → keep separate; mint the normalized base so
          // future facts with the same relation reuse it (bounds sprawl).
          const minted = await mintPredicateCandidate(res.base, { subjectType, objectType });
          candidates.push(minted);
          cache.set(key, res.base);
          stats.minted++;
        }
      } catch (err) {
        // Down-mode: keep the raw predicate, do not block promotion.
        console.warn(`[predicate-resolve] resolve failed for "${f.predicate}" — keeping raw: ${String(err)}`);
        cache.set(key, null);
        stats.deferred++;
      }
    }

    const canonical = cache.get(key);
    if (canonical) f.predicate = canonical;
  }

  return stats;
}
