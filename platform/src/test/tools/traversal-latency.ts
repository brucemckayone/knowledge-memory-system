/**
 * Traversal latency benchmark (bead nmemo-5co.1, the measurable half).
 *
 * The Tier 0 / 1 / 2 query architecture is motivated entirely by latency and
 * none of it was ever quantified (single-graph keep list §2.2). This measures the
 * part that is deterministic and does not need an LLM: `expandFromAnchors`, the
 * graph-anchored retrieval path, across anchor counts and hop depths, with a
 * per-component breakdown.
 *
 * WHAT THIS DOES NOT MEASURE, stated so the result is not read as the whole bead:
 * the agent loop. `POST /api/reason/query` spawns a Claude Code subprocess and
 * runs a multi-turn MCP loop; subprocess spawn, per-iteration MCP round-trip and
 * synthesis time are NOT captured here. Those need LLM invocations.
 *
 * Component split. `expandFromAnchors` does three things per anchor:
 *   (1) traverse to neighbours within the hop budget  -> traverseFromEntities
 *   (2) pull facts for every reachable entity          -> getEntityFacts, in a loop
 *   (3) resolve surviving facts to units and fetch text from Qdrant
 * (1) is now a single query per anchor. (2) is still O(anchors x reachable)
 * sequential round-trips, and is the remaining round-trip storm. This harness
 * times (1) and (2) separately against the same anchors, so the split is visible
 * rather than argued.
 *
 * Run (against the shared test DB; NODE_ENV=test SKIPS dotenv, so the URLs must
 * be explicit or they fall back to :6333/:8000 and Qdrant refuses):
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     QDRANT_URL=http://localhost:6335 ML_SERVICES_URL=http://localhost:8000 \
 *     NODE_ENV=test npx tsx src/test/tools/traversal-latency.ts --corpus=arxiv-nlp --reps=5
 */
import { sql } from 'drizzle-orm';
import { rawQuery } from '../../db/raw.js';
import { traverseFromEntities } from '../../services/graph.js';
import { getEntityFacts } from '../../services/facts.js';
import { expandFromAnchors } from '../../services/graph-fallback.js';

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

/** Median rather than mean: one slow outlier (a cold page, a background write)
 *  should not define the number. */
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

async function main(): Promise<void> {
  const corpusId = arg('corpus', 'arxiv-nlp');
  const reps = Math.max(1, Number(arg('reps', '5')));

  // Deterministic anchor sample: the highest-degree entities in the corpus,
  // ordered by degree then id. Highest-degree is the WORST case for a traversal
  // and the honest one to quote for a latency budget; ordering by id breaks ties
  // reproducibly so re-runs use the same anchors.
  const anchorRows = await rawQuery<{ id: string; degree: number }>(sql`
    SELECT e.id::text AS id, count(f.id) AS degree
    FROM public.entities e
    JOIN public.facts f ON (f.subject_entity_id = e.id OR f.object_entity_id = e.id)
    WHERE e.corpus_id = ${corpusId}
      AND f.expired_at IS NULL
      AND (f.invalid_at IS NULL OR f.invalid_at > NOW())
    GROUP BY e.id
    ORDER BY count(f.id) DESC, e.id
    LIMIT 10
  `);
  if (anchorRows.length === 0) {
    console.error(`no anchors: corpus '${corpusId}' has no entities with active facts`);
    process.exit(1);
  }
  const anchors = anchorRows.map((r) => r.id);

  const stats = await rawQuery<{ entities: number; facts: number }>(sql`
    SELECT (SELECT count(*) FROM public.entities WHERE corpus_id = ${corpusId}) AS entities,
           (SELECT count(*) FROM public.facts WHERE corpus_id = ${corpusId} AND expired_at IS NULL) AS facts
  `);
  const unitRows = await rawQuery<{ n: number }>(sql`SELECT count(*) AS n FROM public.fact_units`);

  console.log(`corpus=${corpusId} entities=${stats[0]!.entities} activeFacts=${stats[0]!.facts} reps=${reps}`);
  console.log(`anchor degrees (top 10): ${anchorRows.map((r) => r.degree).join(', ')}`);
  console.log(`fact_units rows in DB: ${unitRows[0]!.n}`);
  if (Number(unitRows[0]!.n) === 0) {
    console.log(
      'NOTE: fact_units is EMPTY, so component (3) — fact->unit->Qdrant text fetch —\n' +
      '      does no work and its cost is NOT measured here. That is keep-list blocker 4:\n' +
      '      the epoch path never writes fact_units. Verified separately that\n' +
      '      facts.source_memory_id is NULL on every fact in every corpus, so the unit\n' +
      '      mapper could not run even if it were called.',
    );
  }
  console.log('');
  console.log('| anchors | hops | traverse ms | getEntityFacts ms | fact queries | expandFromAnchors ms | evidence |');
  console.log('|---------|------|-------------|-------------------|--------------|----------------------|----------|');

  for (const anchorCount of [1, 5, 10]) {
    if (anchorCount > anchors.length) continue;
    const slice = anchors.slice(0, anchorCount);
    for (const maxHops of [1, 2]) {
      const tTraverse: number[] = [];
      const tFacts: number[] = [];
      const tExpand: number[] = [];
      let factQueries = 0;
      let evidence = 0;

      for (let rep = 0; rep < reps; rep++) {
        // (1) traversal only — one query per anchor
        let t0 = Date.now();
        const reachableByAnchor: string[][] = [];
        for (const a of slice) {
          const n = await traverseFromEntities([a], { maxHops });
          reachableByAnchor.push([a, ...n.map((x) => x.entityId)]);
        }
        tTraverse.push(Date.now() - t0);

        // (2) the getEntityFacts loop — one query per reachable entity per anchor
        t0 = Date.now();
        let q = 0;
        for (const reachable of reachableByAnchor) {
          for (const id of reachable) {
            await getEntityFacts(id);
            q += 1;
          }
        }
        tFacts.push(Date.now() - t0);
        factQueries = q;

        // (3) the real thing, end to end
        t0 = Date.now();
        const ev = await expandFromAnchors(slice, { maxHops });
        tExpand.push(Date.now() - t0);
        evidence = ev.length;
      }

      console.log(
        `| ${anchorCount} | ${maxHops} | ${median(tTraverse)} | ${median(tFacts)} | ${factQueries} | ${median(tExpand)} | ${evidence} |`,
      );
    }
  }
  process.exit(0);
}

main();
