/**
 * prereg-27 (nmemo-u8j.4) diagnostic — is the name-only rerank win a NAME-IN-QUERY lexical artifact?
 * Reproduces the blind adversary's load-bearing checks in the frozen engine (do not trust a deleted script):
 *   (a) name-in-query rate: fraction of query pairs whose TARGET canonical_name appears verbatim (normalized
 *       substring) in the query title+abstract;
 *   (b) LEX-substring reranker: reorder the SAME K=50 fusion pool by `query.includes(candidate name)` (1/0,
 *       fusion-order tie-break) and score strict R@10 vs FACTNAME — if this trivial reranker matches/beats the
 *       cross-encoder, the cross-encoder is not the lever;
 *   (c) not-in-query subgroup: RERANK − FACTNAME restricted to pairs whose target name is NOT in the query
 *       (the only within-experiment proxy for real, non-document-query retrieval).
 *
 * Reads the name-only pool + cross-encoder scores; queries the DB only for target canonical_names.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     NODE_ENV=test npx tsx src/test/tools/rerank-lexcheck.ts --substrate=arxiv-name
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { rawQuery } from '../../db/raw.js';
import { clusteredBootstrap, ciStr, mean } from './retrieval-eval/core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const BIG = 1e9;

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

interface PoolPair {
  pairIdx: number; corpus: string; docId: string; queryText: string; targetEntityId: string; targetInPool: boolean;
  factnameStrictRank: number; pool: Array<{ entityId: string; text: string }>; poolRelevant: string[];
}

async function main(): Promise<void> {
  const tag = arg('substrate', 'arxiv-name');
  const pool = JSON.parse(readFileSync(join(OUT, `rerank-pool-${tag}.json`), 'utf8')) as { pairs: PoolPair[] };
  const sc = JSON.parse(readFileSync(join(OUT, `rerank-scores-${tag}.json`), 'utf8')) as { scores: Record<string, Record<string, number>> };
  const pairs = pool.pairs;
  const n = pairs.length;

  // target canonical_names from the DB (pool text is name-only, but out-of-pool targets aren't in the pool).
  // Load id->name per corpus (single string param avoids the array-cast footgun in postgres.js).
  const corpora = [...new Set(pairs.map((p) => p.corpus))];
  const nameOf = new Map<string, string>();
  for (const c of corpora) {
    const rows = await rawQuery<{ id: string; nm: string }>(sql`
      SELECT id::text AS "id", canonical_name AS "nm" FROM public.entities WHERE corpus_id = ${c}`);
    for (const r of rows) nameOf.set(r.id, r.nm);
  }

  // strict rank of target under: FACTNAME (given), RERANK (cross-encoder scores), LEX (query-contains-name).
  const rankBy = (p: PoolPair, key: (eid: string, text: string) => number): number => {
    const order = p.pool.map((c, i) => ({ eid: c.entityId, i, s: key(c.entityId, c.text) }));
    order.sort((a, b) => (b.s - a.s) || (a.i - b.i));
    const pos = order.findIndex((o) => o.eid === p.targetEntityId);
    return pos < 0 ? BIG : pos + 1;
  };

  const fnHit: number[] = []; const rrHit: number[] = []; const lexHit: number[] = [];
  const keys: string[] = []; const nameInQuery: boolean[] = [];
  let nameInQueryCount = 0;
  for (const p of pairs) {
    const q = norm(p.queryText);
    const tname = nameOf.get(p.targetEntityId) ?? '';
    const inQ = tname.length >= 3 && q.includes(norm(tname));
    nameInQuery.push(inQ); if (inQ) nameInQueryCount += 1;
    const scores = sc.scores[String(p.pairIdx)] ?? {};
    fnHit.push(p.factnameStrictRank <= 10 ? 1 : 0);
    rrHit.push(rankBy(p, (eid) => scores[eid] ?? -Infinity) <= 10 ? 1 : 0);
    lexHit.push(rankBy(p, (_eid, text) => (q.includes(norm(text)) ? 1 : 0)) <= 10 ? 1 : 0);
    keys.push(String(p.pairIdx));
  }

  console.log(`\n=== prereg-27 lexcheck: ${tag}  n=${n} ===`);
  console.log(`(a) name-in-query rate: target canonical_name verbatim in query = ${nameInQueryCount}/${n} = ${(100 * nameInQueryCount / n).toFixed(1)}%`);
  const fnR = mean(fnHit), rrR = mean(rrHit), lexR = mean(lexHit);
  console.log(`\n(b) strict R@10 (same K=50 fusion pool, fusion tie-break):`);
  console.log(`    FACTNAME (fusion)            ${fnR.toFixed(4)}  (${fnHit.reduce((a, b) => a + b, 0)} hits)`);
  console.log(`    RERANK   (bge cross-encoder) ${rrR.toFixed(4)}  (${rrHit.reduce((a, b) => a + b, 0)} hits)   Δ vs fusion ${ciStr(clusteredBootstrap(rrHit, fnHit, keys)).split('  ')[0]}`);
  console.log(`    LEX      (query-contains-name) ${lexR.toFixed(4)}  (${lexHit.reduce((a, b) => a + b, 0)} hits)   Δ vs fusion ${ciStr(clusteredBootstrap(lexHit, fnHit, keys)).split('  ')[0]}`);
  const rrGain = rrHit.reduce((a, b) => a + b, 0) - fnHit.reduce((a, b) => a + b, 0);
  const lexGain = lexHit.reduce((a, b) => a + b, 0) - fnHit.reduce((a, b) => a + b, 0);
  console.log(`    => LEX captures ${lexGain}/${rrGain} = ${(100 * lexGain / Math.max(1, rrGain)).toFixed(0)}% of the cross-encoder's strict gain`);

  // (c) not-in-query subgroup
  const idxOut = pairs.map((_, i) => i).filter((i) => !nameInQuery[i]);
  const rrOut = idxOut.reduce((a, i) => a + (rrHit[i]! - fnHit[i]!), 0);
  const lexOut = idxOut.reduce((a, i) => a + (lexHit[i]! - fnHit[i]!), 0);
  console.log(`\n(c) NOT-in-query subgroup (n=${idxOut.length}): RERANK − FACTNAME = ${rrOut >= 0 ? '+' : ''}${rrOut}/${idxOut.length} hits;  LEX − FACTNAME = ${lexOut >= 0 ? '+' : ''}${lexOut}/${idxOut.length}`);
  process.exit(0);
}
main();
