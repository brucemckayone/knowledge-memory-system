/**
 * Rebuild the doc-20 exhibits/addresses bridge graph from the COMMITTED artifact.
 *
 * Why this exists: running concept-extraction.test.ts deleted every bridge targeting the
 * global `_concepts` corpus (its cleanup was unscoped — now fixed), destroying doc-20's
 * 97 exhibits + 51 addresses edges, which are doc-33's substrate. The measurement itself
 * survived (committed artifacts), and the graph is deterministically reconstructible:
 * `cj-extracted.json` records, per element, the exact concept entity ids it was linked to.
 *
 * FAITHFUL for structure, NOT byte-identical: the artifact stores concept LABELS but not the
 * model's per-link `reason`, so `reasoning` is synthesised with the same fallback string
 * extractAndLinkConcepts itself uses when the model supplies none. doc-33's metric reads only
 * the JOIN structure (which element↔concept pairs exist), so the rebuild is exact for it.
 * Any future run that depends on the original reasoning text must re-extract instead.
 *
 * Run: cd platform && DATABASE_URL=...cognitive_test NODE_ENV=test \
 *   npx tsx src/test/tools/rebuild-doc20-bridges.ts
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '../../../../docs/architecture/cross-corpus-audit');
const CODE_CORPUS = 'cj-code';
const RULE_CORPUS = 'cj-rules';
const CONCEPT_CORPUS = '_concepts';

interface Side { labels: string[]; conceptIds: string[]; linked: number }
interface Extracted {
  codeIds: Record<string, string>;
  ruleIds: Record<string, string>;
  codeConcepts: Record<string, Side>;
  ruleConcepts: Record<string, Side>;
}

function rows(r: unknown): Array<Record<string, unknown>> {
  return r as unknown as Array<Record<string, unknown>>;
}

async function count(relation: string): Promise<number> {
  const r = rows(await db.execute(
    sql`SELECT count(*)::int AS n FROM public.bridge_edges WHERE relation = ${relation} AND expired_at IS NULL`,
  ));
  return r[0]!.n as number;
}

async function main(): Promise<void> {
  const ex: Extracted = JSON.parse(readFileSync(join(DOCS, 'concept-join-artifacts/cj-extracted.json'), 'utf8'));

  const before = { exhibits: await count('exhibits'), addresses: await count('addresses') };
  console.log(`before: ${before.exhibits} exhibits, ${before.addresses} addresses`);

  // Every concept id referenced by the artifact must still exist, or the rebuild is not
  // faithful and we must NOT silently write a partial graph.
  const referenced = new Set<string>();
  for (const s of [...Object.values(ex.codeConcepts), ...Object.values(ex.ruleConcepts)]) {
    for (const id of s.conceptIds) referenced.add(id);
  }
  const present = new Set(
    rows(await db.execute(sql`SELECT id::text AS id FROM public.entities WHERE corpus_id = ${CONCEPT_CORPUS}`))
      .map((r) => r.id as string),
  );
  // The artifact records PRE-merge concept ids. resolveConcepts merged 5 pairs (doc-20 §13),
  // so 5 of the 109 referenced ids are merged-away losers (109 - 5 = the 104 surviving nodes).
  // entity_merges holds source→target, so re-point through it — which is precisely what
  // mergeEntities did to these bridges originally. Followed transitively in case of chains.
  const merges = new Map(
    rows(await db.execute(sql`SELECT source_entity_id::text AS s, target_entity_id::text AS t FROM public.entity_merges`))
      .map((r) => [r.s as string, r.t as string]),
  );
  const survivor = (id: string): string => {
    let cur = id;
    for (let hops = 0; hops < 10 && !present.has(cur); hops++) {
      const next = merges.get(cur);
      if (!next) break;
      cur = next;
    }
    return cur;
  };

  const unresolved = [...referenced].filter((id) => !present.has(survivor(id)));
  if (unresolved.length > 0) {
    throw new Error(
      `${unresolved.length}/${referenced.size} concept node(s) cannot be resolved even through ` +
        `entity_merges — a faithful rebuild is impossible; re-extraction is required. ` +
        `First: ${unresolved.slice(0, 3).join(', ')}`,
    );
  }
  const remapped = [...referenced].filter((id) => !present.has(id)).length;
  console.log(`all ${referenced.size} referenced concepts resolvable (${remapped} re-pointed via entity_merges)`);

  let written = 0;
  for (const [which, ids, concepts, corpus, relation] of [
    ['code', ex.codeIds, ex.codeConcepts, CODE_CORPUS, 'exhibits'],
    ['rule', ex.ruleIds, ex.ruleConcepts, RULE_CORPUS, 'addresses'],
  ] as const) {
    for (const [key, side] of Object.entries(concepts)) {
      const elementId = ids[key];
      if (!elementId) throw new Error(`no entity id for ${which} ${key}`);
      for (let i = 0; i < side.conceptIds.length; i++) {
        const conceptId = survivor(side.conceptIds[i]!);
        const label = side.labels[i] ?? '(label unrecorded)';
        // Same fallback string extractAndLinkConcepts uses when the model gives no reason.
        const reasoning = `${relation} concept "${label}"`;
        const srcRefs = JSON.stringify([{ type: 'entity', id: elementId }]);
        await db.execute(sql`
          INSERT INTO public.bridge_edges
            (a_kind, a_ref, b_kind, b_ref, source_corpus_id, target_corpus_id, relation, reasoning, source_references)
          VALUES ('entity', ${elementId}::uuid, 'entity', ${conceptId}::uuid,
                  ${corpus}, ${CONCEPT_CORPUS}, ${relation}, ${reasoning}, ${sql.raw(`'${srcRefs.replace(/'/g, "''")}'::jsonb`)})
          ON CONFLICT DO NOTHING
        `);
        written += 1;
      }
    }
  }

  const after = { exhibits: await count('exhibits'), addresses: await count('addresses') };
  console.log(`attempted ${written} inserts`);
  console.log(`after: ${after.exhibits} exhibits, ${after.addresses} addresses`);
  const ok = after.exhibits === 97 && after.addresses === 51;
  console.log(ok ? 'MATCH doc-20 §13 (97 / 51) — substrate restored' : 'MISMATCH vs doc-20 §13 (expected 97 / 51)');
  if (!ok) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
