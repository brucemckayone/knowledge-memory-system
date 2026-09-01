/**
 * Two-signal fusion retrieval — the production read path (bead nmemo-u8j.1).
 *
 * The single-graph loop (docs 14/16, R4) settled that no single retrieval
 * substrate beats name-only, but FUSING dense-over-names with dense-over-facts by
 * retrieved-set RRF-60 does (+0.0724 strict R@10, above 0 on all three bootstraps,
 * adversary-verified). This ships that as a read path:
 *
 *   1. embed the query ONCE (both signals share the vector);
 *   2. dense-over-names   = findSimilarEntities (entity name-vector cosine);
 *   3. dense-over-facts   = recallEntitiesByFactSimilarity (rank facts by
 *      fact_embedding cosine, aggregate to endpoint entities by MAX) — the first
 *      real caller of searchFactsByVector / facts.fact_embedding;
 *   4. fuse the two rankings with reciprocalRankFusion — the SAME primitive the
 *      eval harness measures, so the shipped fusion is exactly the algorithm R4
 *      confirmed (+0.0724).
 *
 * APPROXIMATION vs the eval: R4 measured full-corpus rankings (every entity, every
 * fact-bearing entity). A read path cannot rank the whole corpus, so both signals
 * are HNSW top-N candidate lists (candidateLimit / factLimit). Those bounds are the
 * recall/latency knob: too tight and a fact-surfaced target ranked past the cut is
 * dropped before fusion can lift it (the exact win R4 relied on), so they default
 * generously. The confirmed lift is a property of the fusion; realising it in
 * production depends on the candidate lists being wide enough — measure per corpus.
 *
 * Corpus-scoped throughout, including the final hydration. Both signals are
 * POST-filtered HNSW scans, so correct results depend on `hnsw.iterative_scan =
 * strict_order` (migration 058).
 */
import { db } from '../db/index.js';
import { entities, type Entity } from '../db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { embedForQuery } from './embed.js';
import { findSimilarEntities } from './entities.js';
import { searchFactsByVector } from './facts.js';
import { reciprocalRankFusion, RRF_K_DEFAULT } from './fusion.js';

export interface FusedEntity extends Entity {
  /** cosine of the query to this entity's name vector, or null if the fact signal alone surfaced it */
  nameSimilarity: number | null;
  /** best cosine of the query to any of this entity's fact vectors, or null if names alone surfaced it */
  factSimilarity: number | null;
}

export interface FusedRecallOptions {
  corpusId?: string;
  /** entities to return after fusion */
  limit?: number;
  /** entities pulled from the name signal before fusion */
  candidateLimit?: number;
  /** facts pulled from the fact signal before aggregation to entities */
  factLimit?: number;
  /** cosine floor for both signals; 0 keeps the full candidate lists (RRF only rewards the head) */
  threshold?: number;
  /** RRF constant (defaults to the k R4 was confirmed at) */
  k?: number;
}

/**
 * dense-over-facts: rank entities by the MAX cosine of the query to any of their
 * fact embeddings. Aggregating by max (not mean) matched the confirmed R4 arm —
 * one strongly-matching fact should surface its endpoints. Returns entity ids
 * best-first with that max score.
 */
export async function recallEntitiesByFactSimilarity(
  embedding: number[],
  options: { corpusId?: string | null; factLimit?: number; threshold?: number } = {},
): Promise<Array<{ entityId: string; similarity: number }>> {
  const hits = await searchFactsByVector(embedding, {
    corpusId: options.corpusId,
    limit: options.factLimit ?? 200,
    threshold: options.threshold ?? 0,
  });
  const best = new Map<string, number>();
  for (const { fact, similarity } of hits) {
    for (const eid of [fact.subjectEntityId, fact.objectEntityId]) {
      if (!eid) continue;
      const cur = best.get(eid);
      if (cur === undefined || similarity > cur) best.set(eid, similarity);
    }
  }
  return [...best.entries()]
    .map(([entityId, similarity]) => ({ entityId, similarity }))
    // deterministic: max-fact-similarity desc, then entity id asc, so ties feed RRF
    // in a stable order run-to-run (searchFactsByVector's ORDER BY is also stable).
    .sort((a, b) => (b.similarity - a.similarity) || (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
}

/**
 * Two-signal fusion recall: RRF-60(dense-over-names, dense-over-facts), corpus-scoped.
 * Returns entities best-first (array order IS the fused rank), each carrying its
 * component similarities so a caller can see which signal(s) surfaced it.
 */
export async function recallEntitiesFused(
  query: string,
  options: FusedRecallOptions = {},
): Promise<FusedEntity[]> {
  const corpusId = options.corpusId ?? 'default';
  const limit = options.limit ?? 10;
  const candidateLimit = options.candidateLimit ?? 50;
  const factLimit = options.factLimit ?? 200;
  const threshold = options.threshold ?? 0;
  const k = options.k ?? RRF_K_DEFAULT;

  // Guard: embedForQuery degrades to [] on ML failure. A silent [] here would look
  // like "no matches" rather than "the embedder is down", so log it loud (do NOT
  // swallow) before returning empty — the read-path convention is degrade, not throw.
  const embedding = await embedForQuery(query);
  if (!embedding || embedding.length === 0) {
    console.warn(`[recallEntitiesFused] query embedding failed (ML down?); returning no results for: ${query.slice(0, 80)}`);
    return [];
  }

  const [nameHits, factRanked] = await Promise.all([
    findSimilarEntities(embedding, { corpusId, limit: candidateLimit, threshold }),
    recallEntitiesByFactSimilarity(embedding, { corpusId, factLimit, threshold }),
  ]);

  const nameSimById = new Map(nameHits.map((e) => [e.id, e.similarity]));
  const factSimById = new Map(factRanked.map((f) => [f.entityId, f.similarity]));
  const fusedIds = reciprocalRankFusion([nameHits.map((e) => e.id), factRanked.map((f) => f.entityId)], { k });
  if (fusedIds.length === 0) return [];

  // Hydrate the fused ids WITH the corpus filter (fact endpoints can reference an
  // entity in another corpus — the object endpoint especially — and an unfiltered
  // hydrate would leak it into a corpus-scoped result). Walk fused order and take
  // the first `limit` that hydrate in-corpus, so a fused id with no live in-corpus
  // row does not cost a slot to a lower-ranked valid entity.
  const rows = await db.select().from(entities)
    .where(and(inArray(entities.id, fusedIds), eq(entities.corpusId, corpusId)));
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const out: FusedEntity[] = [];
  for (const id of fusedIds) {
    const row = rowById.get(id);
    if (!row) continue; // absent, deleted, or out-of-corpus — drop, do not emit a leak or a partial
    out.push({ ...row, nameSimilarity: nameSimById.get(id) ?? null, factSimilarity: factSimById.get(id) ?? null });
    if (out.length === limit) break;
  }
  return out;
}
