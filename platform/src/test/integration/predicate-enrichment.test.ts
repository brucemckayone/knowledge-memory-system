/**
 * Predicate enrichment (PC2, nmemo-213.2) — migration 045 + embedding backfill.
 *
 * Two blocks:
 *  - "schema + static backfill" needs only the DB (migration 045 runs in global
 *    setup): asserts the embedding/type-pair columns + HNSW index exist and the
 *    canonical type pairs / inverse predicates are populated.
 *  - "embedding NN retrieval" needs ml-services (Ollama nomic): backfills the
 *    canonical embeddings, then asserts a pgvector nearest-neighbour search
 *    surfaces the expected canonical for a known alias (doc 42 §4 retrieval step).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { testDb, skipCtx, isMLServiceAvailable, hasVectorExtension } from '../setup.js';
import { backfillPredicateEmbeddings, enrichedPredicateText, embedPredicateText } from '../../services/predicate-embeddings.js';

describe('PC2 — migration 045 schema + static backfill', () => {
  beforeAll(async (ctx) => {
    try {
      await testDb`SELECT subject_type, object_type FROM fact_predicates LIMIT 1`;
    } catch {
      skipCtx(ctx);
    }
  });

  it('adds embedding, subject_type, object_type columns', async () => {
    const cols = await testDb<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'fact_predicates'
        AND column_name IN ('embedding', 'subject_type', 'object_type')
    `;
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual(['embedding', 'object_type', 'subject_type']);
  });

  it('creates the HNSW vector index', async () => {
    const idx = await testDb<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'fact_predicates' AND indexname = 'idx_fact_predicates_embedding'
    `;
    expect(idx.length).toBe(1);
  });

  it('populates type pairs and inverse predicates for the canonicals', async () => {
    const rows = await testDb<{ predicate: string; subject_type: string; object_type: string; inverse_predicate: string | null }[]>`
      SELECT predicate, subject_type, object_type, inverse_predicate
      FROM fact_predicates
      WHERE predicate IN ('works_at', 'lives_in', 'parent_of', 'headquartered_in', 'manages')
      ORDER BY predicate
    `;
    const byPred = Object.fromEntries(rows.map((r) => [r.predicate, r]));

    expect(byPred['works_at']).toMatchObject({ subject_type: 'person', object_type: 'company', inverse_predicate: 'employs' });
    expect(byPred['lives_in']).toMatchObject({ subject_type: 'person', object_type: 'place' });
    expect(byPred['parent_of']).toMatchObject({ subject_type: 'person', object_type: 'person', inverse_predicate: 'child_of' });
    expect(byPred['headquartered_in']).toMatchObject({ subject_type: 'company', object_type: 'place' });
    expect(byPred['manages']).toMatchObject({ inverse_predicate: 'reports_to' });
  });
});

describe('PC2 — enriched embedding backfill + NN retrieval', () => {
  beforeAll(async (ctx) => {
    const ml = await isMLServiceAvailable();
    if (!hasVectorExtension || !ml) {
      skipCtx(ctx);
      return;
    }
    try {
      await testDb`SELECT embedding FROM fact_predicates LIMIT 1`;
    } catch {
      skipCtx(ctx);
    }
  });

  it('builds the benchmark-format enriched text', () => {
    expect(enrichedPredicateText('works_at', 'Employment relationship between person and organization'))
      .toBe("clustering: The relationship 'works_at' describes employment relationship between person and organization");
    // No description → de-underscored label stands in.
    expect(enrichedPredicateText('employed_at')).toBe("clustering: The relationship 'employed_at' describes employed at");
  });

  it('backfills embeddings for the canonical predicates', async () => {
    const res = await backfillPredicateEmbeddings({ force: true });
    expect(res.embedded).toBeGreaterThanOrEqual(27);

    const withEmb = await testDb<{ n: number }[]>`
      SELECT count(*)::int AS n FROM fact_predicates WHERE is_canonical = true AND embedding IS NOT NULL
    `;
    expect(withEmb[0]!.n).toBeGreaterThanOrEqual(27);
  });

  // NN cosine retrieval surfaces the canonical as a top candidate (the multi-signal
  // fold in PC3/PC4 then scores the candidates — retrieval need not be top-1).
  const aliasCases: Array<[string, string]> = [
    ['employed_at', 'works_at'],
    ['supervises', 'manages'],
    ['resides_in', 'lives_in'],
    ['spouse_of', 'married_to'],
  ];

  it.each(aliasCases)('NN search for alias %s surfaces canonical %s in the top 3', async (alias, expected) => {
    const vec = await embedPredicateText(alias);
    const lit = `[${vec.join(',')}]`;
    const results = await testDb.unsafe<{ predicate: string; similarity: number }[]>(
      `SELECT predicate, 1 - (embedding <=> $1::vector) AS similarity
       FROM fact_predicates
       WHERE is_canonical = true AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 3`,
      [lit],
    );
    const top = results.map((r) => r.predicate);
    expect(top, `top-3 for "${alias}" was ${JSON.stringify(results)}`).toContain(expected);
  });
});
