/**
 * prereg-26 (nmemo-u8j.4) STAGE 3 — score the cross-encoder rerank against the fusion baseline.
 * FROZEN pre-registration: docs/architecture/single-graph/26-prereg-cross-encoder-rerank.md
 *
 * Reads rerank-pool-<substrate>.json (stage 1) + rerank-scores-<substrate>.json (stage 2), reorders each
 * K-pool by cross-encoder score (stable tie-break = original fusion order), and computes strict + condensed
 * R@10 for FACTNAME (baseline) and RERANK, with the same 3 cluster bootstraps R4 used (core.ts, seed
 * 20260831). PRIMARY = RERANK - FACTNAME strict R@10, all-3-bootstraps > 0. Reports the pool-recall ceiling.
 *
 * Run:
 *   cd platform && npx tsx src/test/tools/rerank-eval.ts --substrate=arxiv
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clusteredBootstrap, ciStr, triStr, mean, type TriResult } from './retrieval-eval/core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const BIG = 1e9;

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

interface PoolPair {
  pairIdx: number; corpus: string; docId: string; targetEntityId: string; targetInPool: boolean;
  factnameStrictRank: number; factnameCondRank: number;
  pool: Array<{ entityId: string; text: string }>; poolRelevant: string[];
}

/** RERANK ranks: reorder pool by score desc (stable = original pool order), then strict + condensed rank
 *  of the target. Target absent from pool ⇒ BIG (rerank cannot surface it). */
function rerankRanks(p: PoolPair, scores: Record<string, number>): { strict: number; cond: number } {
  const order = p.pool.map((c, i) => ({ eid: c.entityId, i, s: scores[c.entityId] ?? -Infinity }));
  order.sort((a, b) => (b.s - a.s) || (a.i - b.i)); // desc by score, stable tie-break = fusion order
  const relevant = new Set(p.poolRelevant);
  const pos = order.findIndex((o) => o.eid === p.targetEntityId);
  if (pos < 0) return { strict: BIG, cond: BIG };
  let above = 0;
  for (let r = 0; r < pos; r++) {
    const eid = order[r]!.eid;
    if (eid === p.targetEntityId) continue;
    if (relevant.has(eid)) continue;
    above += 1;
  }
  return { strict: pos + 1, cond: above + 1 };
}

function main(): void {
  const substrate = arg('substrate', 'arxiv');
  const pool = JSON.parse(readFileSync(join(OUT, `rerank-pool-${substrate}.json`), 'utf8')) as { meta: Record<string, unknown>; pairs: PoolPair[] };
  const sc = JSON.parse(readFileSync(join(OUT, `rerank-scores-${substrate}.json`), 'utf8')) as { meta: Record<string, unknown>; scores: Record<string, Record<string, number>> };
  const pairs = pool.pairs;
  const n = pairs.length;

  const fnStrict: number[] = []; const fnCond: number[] = [];
  const rrStrict: number[] = []; const rrCond: number[] = [];
  const pairKeys: string[] = []; const entKeys: string[] = []; const docKeys: string[] = [];
  let degenerate = 0;
  for (const p of pairs) {
    const scores = sc.scores[String(p.pairIdx)] ?? {};
    if (Object.keys(scores).length === 0) degenerate += 1;
    const rr = rerankRanks(p, scores);
    fnStrict.push(p.factnameStrictRank); fnCond.push(p.factnameCondRank);
    rrStrict.push(rr.strict); rrCond.push(rr.cond);
    pairKeys.push(String(p.pairIdx)); entKeys.push(p.targetEntityId); docKeys.push(p.docId);
  }

  const hit = (ranks: number[], k: number): number[] => ranks.map((r) => (r <= k ? 1 : 0));
  const tri = (a: number[], b: number[]): TriResult => ({
    byPair: clusteredBootstrap(a, b, pairKeys),
    byEntity: clusteredBootstrap(a, b, entKeys),
    byDocument: clusteredBootstrap(a, b, docKeys),
  });

  const ceiling = pairs.filter((p) => p.targetInPool).length / n;

  console.log(`\n=== prereg-26 rerank eval: ${substrate} ===`);
  console.log(`n=${n}  model=${sc.meta.model}  scored=${sc.meta.n_scored}  ${sc.meta.ms_per_query} ms/query`);
  if (degenerate > 0) console.log(`=== WARNING: ${degenerate} pairs had NO cross-encoder scores (degenerate) ===`);
  console.log(`pool-recall ceiling (FACTNAME R@${(pool.meta as { K: number }).K} = target-in-pool) = ${(ceiling * 100).toFixed(1)}%  <- RERANK R@10 cannot exceed this`);

  console.log('\n| arm | strict R@10 | condensed R@10 |');
  console.log('|-----|-------------|----------------|');
  console.log(`| FACTNAME | ${mean(hit(fnStrict, 10)).toFixed(4)} | ${mean(hit(fnCond, 10)).toFixed(4)} |`);
  console.log(`| RERANK   | ${mean(hit(rrStrict, 10)).toFixed(4)} | ${mean(hit(rrCond, 10)).toFixed(4)} |`);

  console.log('\n=== PRIMARY (strict): RERANK R@10 - FACTNAME R@10 ===');
  const primaryStrict = tri(hit(rrStrict, 10), hit(fnStrict, 10));
  console.log(`  ${triStr(primaryStrict)}`);
  console.log('\n=== CO-PRIMARY (condensed): RERANK R@10 - FACTNAME R@10 ===');
  const primaryCond = tri(hit(rrCond, 10), hit(fnCond, 10));
  console.log(`  ${triStr(primaryCond)}`);

  const fnHits = hit(fnStrict, 10).reduce((s, x) => s + x, 0);
  const rrHits = hit(rrStrict, 10).reduce((s, x) => s + x, 0);
  console.log(`\nstrict hits @10: FACTNAME ${fnHits}  RERANK ${rrHits}  (delta ${rrHits - fnHits}/${n})`);

  const perK: Record<string, unknown> = {};
  console.log('\n=== k-ladder (strict / condensed) ===');
  for (const k of [1, 5, 10, 20]) {
    perK[k] = { factnameStrict: mean(hit(fnStrict, k)), rerankStrict: mean(hit(rrStrict, k)), factnameCond: mean(hit(fnCond, k)), rerankCond: mean(hit(rrCond, k)) };
    console.log(`  R@${String(k).padEnd(3)} FACTNAME ${mean(hit(fnStrict, k)).toFixed(3)}/${mean(hit(fnCond, k)).toFixed(3)}  RERANK ${mean(hit(rrStrict, k)).toFixed(3)}/${mean(hit(rrCond, k)).toFixed(3)}`);
  }

  const report = {
    substrate, n, model: sc.meta.model, msPerQuery: sc.meta.ms_per_query, poolK: (pool.meta as { K: number }).K,
    ceiling, degenerate,
    armsStrictR10: { FACTNAME: mean(hit(fnStrict, 10)), RERANK: mean(hit(rrStrict, 10)) },
    armsCondR10: { FACTNAME: mean(hit(fnCond, 10)), RERANK: mean(hit(rrCond, 10)) },
    primaryStrict, primaryCondensed: primaryCond,
    hits: { factname: fnHits, rerank: rrHits }, perK,
  };
  writeFileSync(join(OUT, `rerank-results-${substrate}.json`), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, `rerank-results-${substrate}.json`)}`);
  process.exit(0);
}
main();
