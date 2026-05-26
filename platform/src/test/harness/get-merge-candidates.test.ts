/**
 * Integration tests: getMergeCandidates filter + paginate (bead nmemo-2yv.45)
 *
 * The function previously had no WHERE clause and no LIMIT — every caller
 * downstream filtered resolved rows in memory. This test pins the new contract:
 *
 *   - Default returns at most DEFAULT_MERGE_CANDIDATES_LIMIT (50) unresolved rows,
 *     ordered by combined_score DESC.
 *   - Explicit statuses=['resolved'] returns resolved-only rows.
 *   - includeResolved: true returns every status.
 *   - LIMIT is honoured.
 *   - OFFSET paginates with stable ordering.
 *   - EXPLAIN on the default query confirms idx_merge_candidates_score is used
 *     (partial index over status != 'resolved').
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  deleteFromTables,
} from '../setup.js';
import {
  getMergeCandidates,
  DEFAULT_MERGE_CANDIDATES_LIMIT,
} from '../../services/graph-meta.js';

async function cleanSlate(): Promise<void> {
  // merge_candidates is NOT in deleteFromTables's orderedTables whitelist
  // — wipe explicitly before entities so the FK doesn't block (cf. memory
  // 'deletefromtables-in-src-test-setup-ts-silently-filters').
  await testDb`DELETE FROM public.merge_candidates`;
  await deleteFromTables({
    tables: ['fact_history', 'memory_entities', 'facts', 'entities'],
    acknowledgeGlobal: true,
  });
}

/**
 * Seed N candidate rows with controlled status + combined_score.
 * Returns the inserted IDs in insertion order.
 *
 * Each row needs a distinct (entity_a_id, entity_b_id) pair under the
 * canonical-order constraint `entity_a_id < entity_b_id`. We create 2N
 * entities up front and pair them off in sorted order.
 */
async function seedCandidates(
  rows: Array<{ status: string; combinedScore: number }>,
): Promise<string[]> {
  const entityIds: string[] = [];
  for (let i = 0; i < rows.length * 2; i++) {
    const e = await createTestEntity({
      canonicalName: `Cand-${i}`,
      entityType: 'thing',
    });
    entityIds.push(e.id);
  }
  // Sort all entity ids so we can deterministically pair them as (lo, hi).
  entityIds.sort();

  const ids: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const aId = entityIds[i * 2]!;
    const bId = entityIds[i * 2 + 1]!;
    const sorted = [aId, bId].sort();
    const lo = sorted[0]!;
    const hi = sorted[1]!;
    const { status, combinedScore } = rows[i]!;
    const inserted = await testDb<Array<{ id: string }>>`
      INSERT INTO public.merge_candidates
        (entity_a_id, entity_b_id, combined_score, status)
      VALUES (${lo}::uuid, ${hi}::uuid, ${combinedScore}, ${status})
      RETURNING id
    `;
    ids.push(inserted[0]!.id);
  }
  return ids;
}

describe('getMergeCandidates filter + paginate (nmemo-2yv.45)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('default: returns unresolved only, ordered by combined_score DESC', async () => {
    await seedCandidates([
      { status: 'candidate', combinedScore: 0.9 },
      { status: 'resolved', combinedScore: 0.95 }, // higher score but resolved — must be filtered
      { status: 'staging', combinedScore: 0.5 },
      { status: 'provisional', combinedScore: 0.7 },
      { status: 'resolved', combinedScore: 0.8 },  // resolved — must be filtered
    ]);

    const results = await getMergeCandidates();

    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.status).not.toBe('resolved');
    }
    // Strictly descending by combined_score
    expect(results[0]!.combinedScore).toBe(0.9);
    expect(results[1]!.combinedScore).toBe(0.7);
    expect(results[2]!.combinedScore).toBe(0.5);
  });

  it('statuses=["resolved"] returns resolved-only rows', async () => {
    await seedCandidates([
      { status: 'candidate', combinedScore: 0.9 },
      { status: 'resolved', combinedScore: 0.85 },
      { status: 'staging', combinedScore: 0.5 },
      { status: 'resolved', combinedScore: 0.75 },
    ]);

    const results = await getMergeCandidates({ statuses: ['resolved'] });

    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.status).toBe('resolved');
    }
    expect(results.map(r => r.combinedScore)).toEqual([0.85, 0.75]);
  });

  it('includeResolved=true returns every status', async () => {
    await seedCandidates([
      { status: 'candidate', combinedScore: 0.9 },
      { status: 'resolved', combinedScore: 0.85 },
      { status: 'staging', combinedScore: 0.5 },
    ]);

    const results = await getMergeCandidates({ includeResolved: true });

    expect(results.length).toBe(3);
    const statuses = results.map(r => r.status).sort();
    expect(statuses).toEqual(['candidate', 'resolved', 'staging']);
  });

  it('default LIMIT honoured: 60 unresolved rows in table, returns 50', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      status: 'candidate',
      // descending scores from 0.99 to 0.40
      combinedScore: 0.99 - i * 0.01,
    }));
    await seedCandidates(rows);

    const results = await getMergeCandidates();

    expect(results.length).toBe(DEFAULT_MERGE_CANDIDATES_LIMIT);
    expect(results.length).toBe(50);
    // The top 50 by score should be returned (highest-first).
    expect(results[0]!.combinedScore).toBeCloseTo(0.99, 6);
    expect(results[49]!.combinedScore).toBeCloseTo(0.50, 6);
  });

  it('offset paginates correctly with stable ordering', async () => {
    // 5 rows, all status='candidate', distinct scores so order is deterministic.
    await seedCandidates([
      { status: 'candidate', combinedScore: 0.9 },
      { status: 'candidate', combinedScore: 0.8 },
      { status: 'candidate', combinedScore: 0.7 },
      { status: 'candidate', combinedScore: 0.6 },
      { status: 'candidate', combinedScore: 0.5 },
    ]);

    const page1 = await getMergeCandidates({ limit: 2, offset: 0 });
    const page2 = await getMergeCandidates({ limit: 2, offset: 2 });
    const page3 = await getMergeCandidates({ limit: 2, offset: 4 });

    expect(page1.map(r => r.combinedScore)).toEqual([0.9, 0.8]);
    expect(page2.map(r => r.combinedScore)).toEqual([0.7, 0.6]);
    expect(page3.map(r => r.combinedScore)).toEqual([0.5]);

    // No row appears across pages — pagination is non-overlapping.
    const ids = new Set([...page1, ...page2, ...page3].map(r => r.id));
    expect(ids.size).toBe(5);
  });

  it('stable ordering when combined_score ties (secondary sort on id)', async () => {
    // 6 rows, all same score — the LIMIT/OFFSET pagination needs a tiebreak
    // to be deterministic. Without `ORDER BY ... mc.id ASC` page boundaries
    // would be undefined.
    const rows = Array.from({ length: 6 }, () => ({
      status: 'candidate',
      combinedScore: 0.5,
    }));
    await seedCandidates(rows);

    const page1 = await getMergeCandidates({ limit: 3, offset: 0 });
    const page2 = await getMergeCandidates({ limit: 3, offset: 3 });
    const all = await getMergeCandidates({ limit: 6, offset: 0 });

    expect(page1.length).toBe(3);
    expect(page2.length).toBe(3);
    expect(all.length).toBe(6);

    // Concatenation of pages must equal the full list, in order.
    const concatIds = [...page1, ...page2].map(r => r.id);
    const allIds = all.map(r => r.id);
    expect(concatIds).toEqual(allIds);
  });

  it('EXPLAIN shows idx_merge_candidates_score is USABLE on the default query', async () => {
    // Bead nmemo-2yv.45 acceptance: "Verify EXPLAIN shows
    // idx_merge_candidates_score being used on the default query."
    //
    // At small row counts the cost-based planner often picks a Seq Scan over
    // the partial index — that's a planner-heuristic outcome, not a
    // query-shape problem. The bug we're guarding against is "the WHERE
    // predicate doesn't match the partial index, so the planner CANNOT use
    // the index even at scale". We pin that by disabling seqscan and
    // re-EXPLAINing: if `idx_merge_candidates_score` still doesn't appear,
    // the query is incompatible with the partial index.
    const rows = Array.from({ length: 60 }, (_, i) => ({
      status: i % 5 === 0 ? 'resolved' : 'candidate',
      combinedScore: 0.99 - i * 0.01,
    }));
    await seedCandidates(rows);

    // ANALYZE so the planner has up-to-date stats.
    await testDb`ANALYZE public.merge_candidates`;

    // Force the planner to consider non-seqscan paths. This is the
    // test-only equivalent of "what would the planner do at scale, when
    // seqscan is no longer cheaper than the index?".
    const plan = await testDb<Array<{ 'QUERY PLAN': string }>>`
      EXPLAIN
        (
          SET LOCAL enable_seqscan = off
        )
        SELECT mc.id, mc.combined_score, mc.status
        FROM public.merge_candidates mc
        WHERE mc.status = ANY(ARRAY['staging','candidate','provisional']::text[])
        ORDER BY mc.combined_score DESC, mc.id ASC
        LIMIT 50
    `.catch(async () => {
      // EXPLAIN doesn't accept SET LOCAL inline in this postgres version —
      // fall back to a session-scoped toggle inside a tx.
      await testDb`SET enable_seqscan = off`;
      try {
        return await testDb<Array<{ 'QUERY PLAN': string }>>`
          EXPLAIN
          SELECT mc.id, mc.combined_score, mc.status
          FROM public.merge_candidates mc
          WHERE mc.status = ANY(ARRAY['staging','candidate','provisional']::text[])
          ORDER BY mc.combined_score DESC, mc.id ASC
          LIMIT 50
        `;
      } finally {
        await testDb`RESET enable_seqscan`;
      }
    });

    const planText = plan.map(r => r['QUERY PLAN']).join('\n');
    // The partial index `idx_merge_candidates_score` (WHERE status != 'resolved')
    // must cover the unresolved status set the default query emits. If the
    // planner refuses to use it even with enable_seqscan=off, the predicate
    // doesn't match the index.
    expect(planText).toMatch(/idx_merge_candidates_score/);
  });
});
