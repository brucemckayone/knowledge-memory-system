/**
 * nmemo-uhp.24 — dump the concept-JOIN graph (post-resolution) for visualization.
 * Reads the live cognitive_test DB and writes a self-contained graph JSON:
 * code elements, rule elements, concept nodes, and the live exhibits/addresses
 * bridges — plus derived shared-concept pivots and the true-rule oracle.
 *
 * Run:
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/concept-join-dump.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { unwrapRows } from '../../services/audit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/concept-join-artifacts');

async function main(): Promise<void> {
  const code = unwrapRows<{ id: string; name: string; trueGuideline: string }>(await db.execute(sql`
    SELECT id::text AS id, canonical_name AS name, properties->>'trueGuideline' AS "trueGuideline"
    FROM public.entities WHERE corpus_id = 'cj-code' ORDER BY canonical_name
  `));
  const rulesN = unwrapRows<{ id: string; name: string }>(await db.execute(sql`
    SELECT id::text AS id, canonical_name AS name FROM public.entities WHERE corpus_id = 'cj-rules' ORDER BY canonical_name
  `));
  const bridges = unwrapRows<{ a: string; b: string; relation: string }>(await db.execute(sql`
    SELECT a_ref::text AS a, b_ref::text AS b, relation FROM public.bridge_edges
    WHERE relation IN ('exhibits','addresses') AND expired_at IS NULL
      AND (source_corpus_id = 'cj-code' OR source_corpus_id = 'cj-rules')
  `));
  // concept nodes actually referenced by this run's bridges
  const conceptIds = [...new Set(bridges.map((x) => x.b))];
  const concepts = conceptIds.length ? unwrapRows<{ id: string; name: string }>(await db.execute(sql`
    SELECT id::text AS id, canonical_name AS name FROM public.entities
    WHERE id = ANY(${sql.raw(`ARRAY[${conceptIds.map((c) => `'${c}'`).join(',')}]::uuid[]`)})
  `)) : [];

  // derived: which concepts are touched by BOTH a code (exhibits) and a rule (addresses) edge
  const exhibitedBy = new Map<string, string[]>(); // conceptId -> code entity ids
  const addressedBy = new Map<string, string[]>(); // conceptId -> rule entity ids
  for (const e of bridges) {
    const m = e.relation === 'exhibits' ? exhibitedBy : addressedBy;
    const arr = m.get(e.b) ?? []; arr.push(e.a); m.set(e.b, arr);
  }
  const shared = concepts.filter((c) => exhibitedBy.has(c.id) && addressedBy.has(c.id)).map((c) => c.id);

  const dump = {
    generated: 'nmemo-uhp.24 concept-join-dump',
    code, rules: rulesN, concepts, bridges,
    sharedConceptIds: shared,
    stats: { code: code.length, rules: rulesN.length, concepts: concepts.length, bridges: bridges.length, sharedConcepts: shared.length },
  };
  writeFileSync(join(OUT, 'cj-graph.json'), JSON.stringify(dump, null, 2));
  console.log('cj-graph.json:', JSON.stringify(dump.stats));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
