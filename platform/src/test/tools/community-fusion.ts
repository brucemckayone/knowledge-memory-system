/**
 * prereg-29 (nmemo-u8j.8) — community-structure retrieval, deterministic (NO Claude, NO LLM summaries).
 * FROZEN pre-registration: docs/architecture/single-graph/29-prereg-community-retrieval.md
 *
 * Community = frozen Louvain assignment (seed 20260831, prereg-artifacts/communities-<corpus>.json).
 * Community centroid = L2-normalise(mean of member entity NAME vectors) — the SAME cached nomic name vectors
 * NAME/FACTNAME use. Arms: NAME, FACTNAME (=RRF-60(names,facts), the head), COMM (rank by community-centroid
 * cosine; within-community tie-break by the entity's own name cosine), COMMFUSE (=RRF-60(FACTNAME, COMM)).
 * PRIMARY = COMMFUSE − FACTNAME strict R@10, all 3 bootstraps > 0; CO-PRIMARY condensed. All scored by the
 * shared retrieval-eval engine's oracle + bootstrap.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/community-fusion.ts --substrate=arxiv
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clusteredBootstrap, ciStr, triStr, mean, dot, normalise, strictRankOf, condensedRankOf, type TriResult,
} from './retrieval-eval/core.js';
import { runEval } from './retrieval-eval/harness.js';
import { entityEmbedTextFor } from '../../services/embed-text.js';
import { reciprocalRankFusion } from '../../services/fusion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const byIndex = (a: number, b: number): number => a - b;

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

async function main(): Promise<void> {
  const substrate = arg('substrate', 'arxiv');
  const CFG: Record<string, { corpora: string[]; docFileFor: Record<string, string>; writable: string }> = {
    arxiv: { corpora: ['arxiv-nlp', 'arxiv-cv'], docFileFor: { 'arxiv-nlp': 'corpus-A.json', 'arxiv-cv': 'corpus-B.json' }, writable: 'arxiv-embed-cache.json' },
    qbio: { corpora: ['qbio'], docFileFor: { qbio: 'corpus-C.json' }, writable: 'qbio-embed-cache.json' },
  };
  const cfg = CFG[substrate];
  if (!cfg) throw new Error(`--substrate must be arxiv or qbio`);

  const r = await runEval({
    label: `community-${substrate}`,
    corpora: cfg.corpora,
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: cfg.docFileFor },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    writableCachePath: join(OUT, cfg.writable),
    arms: ['NAME', 'FACTMAX', 'FACTNAME'],
    ensureEmbedEntityNames: true, ensureEmbedQueryDocs: true, factNormStrict: true, keepBaseRankings: true,
  });
  const { sub, rel, store, baseRankings, corpusOf, docOf, entityOf, targetIdx, strictRank, condRank } = r;
  const rName = baseRankings!.rName; const rFactMax = baseRankings!.rFactMax!;

  // Per corpus: entity name vectors + community assignment + community centroids.
  const vNameOf = new Map<string, number[][]>();
  const commIdOf = new Map<string, string[]>();          // entity index -> community id
  const centroidByComm = new Map<string, Map<string, number[]>>();
  for (const c of cfg.corpora) {
    const ents = sub.entsByCorpus.get(c)!;
    const vName = ents.map((e) => store.getEntity(entityEmbedTextFor(e.name, e.description, 'name')));
    vNameOf.set(c, vName);
    const assign = JSON.parse(readFileSync(join(OUT, `communities-${c}.json`), 'utf8')) as Record<string, string>;
    const commId = ents.map((e) => assign[e.id] ?? `${c}#singleton#${e.id}`); // edgeless -> own singleton
    commIdOf.set(c, commId);
    // centroid = normalise(mean of member name vectors)
    const members = new Map<string, number[]>(); const counts = new Map<string, number>();
    const dim = vName[0]!.length;
    for (let i = 0; i < ents.length; i++) {
      const k = commId[i]!; const acc = members.get(k) ?? new Array<number>(dim).fill(0);
      const v = vName[i]!; for (let d = 0; d < dim; d++) acc[d]! += v[d]!;
      members.set(k, acc); counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const cent = new Map<string, number[]>();
    for (const [k, acc] of members) cent.set(k, normalise(acc.map((x) => x / counts.get(k)!)));
    centroidByComm.set(c, cent);
    const sizes = [...counts.values()].sort((a, b) => b - a);
    console.log(`${c}: ${cent.size} communities (top sizes ${sizes.slice(0, 5).join(',')}; singletons ${sizes.filter((s) => s === 1).length})`);
  }

  const n = corpusOf.length;
  const commStrict: number[] = []; const commCond: number[] = [];
  const fuseStrict: number[] = []; const fuseCond: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = corpusOf[i]!; const t = targetIdx[i]!;
    const ents = sub.entsByCorpus.get(c)!; const U = ents.length;
    const vName = vNameOf.get(c)!; const commId = commIdOf.get(c)!; const cent = centroidByComm.get(c)!;
    const d = sub.docsById.get(docOf[i]!)!;
    const qv = store.getQuery(`${d.title} ${d.abstract}`);
    const commScoreCache = new Map<string, number>();
    const commScoreOf = (k: string): number => {
      let s = commScoreCache.get(k); if (s === undefined) { s = dot(qv, cent.get(k)!); commScoreCache.set(k, s); } return s;
    };
    const nameScore = vName.map((v) => dot(qv, v));
    const idx = Array.from({ length: U }, (_, j) => j);
    // COMM ranking: community-centroid cosine desc, tie-break the entity's own name cosine desc, then index.
    const commRanking = idx.slice().sort((a, b) => (commScoreOf(commId[b]!) - commScoreOf(commId[a]!)) || (nameScore[b]! - nameScore[a]!) || (a - b));
    const factnameRanking = reciprocalRankFusion([rName[i]!, rFactMax[i]!], { k: 60, tieBreak: byIndex });
    const fuseRanking = reciprocalRankFusion([factnameRanking, commRanking], { k: 60, tieBreak: byIndex });
    const relSet = rel.relevant(`${c}#${docOf[i]!}`);
    commStrict.push(strictRankOf(commRanking, t)); commCond.push(condensedRankOf(commRanking, t, relSet));
    fuseStrict.push(strictRankOf(fuseRanking, t)); fuseCond.push(condensedRankOf(fuseRanking, t, relSet));
  }

  const pairKeys = corpusOf.map((_, i) => String(i));
  const hit = (ranks: number[], k: number): number[] => ranks.map((x) => (x <= k ? 1 : 0));
  const tri = (a: number[], b: number[]): TriResult => ({
    byPair: clusteredBootstrap(a, b, pairKeys), byEntity: clusteredBootstrap(a, b, entityOf), byDocument: clusteredBootstrap(a, b, docOf),
  });
  const fnS = strictRank['FACTNAME']!.map((x) => (x <= 10 ? 1 : 0));
  const fnC = condRank['FACTNAME']!.map((x) => (x <= 10 ? 1 : 0));
  const nmS = strictRank['NAME']!.map((x) => (x <= 10 ? 1 : 0));

  console.log(`\n=== prereg-29 community retrieval: ${substrate}  n=${n} ===`);
  console.log('| arm | strict R@10 | condensed R@10 |');
  console.log('|-----|-------------|----------------|');
  console.log(`| NAME     | ${mean(nmS).toFixed(4)} | ${mean(condRank['NAME']!.map((x) => (x <= 10 ? 1 : 0))).toFixed(4)} |`);
  console.log(`| FACTNAME | ${mean(fnS).toFixed(4)} | ${mean(fnC).toFixed(4)} |`);
  console.log(`| COMM     | ${mean(hit(commStrict, 10)).toFixed(4)} | ${mean(hit(commCond, 10)).toFixed(4)} |`);
  console.log(`| COMMFUSE | ${mean(hit(fuseStrict, 10)).toFixed(4)} | ${mean(hit(fuseCond, 10)).toFixed(4)} |`);

  console.log('\n=== PRIMARY (strict): COMMFUSE − FACTNAME ===');
  const pStrict = tri(hit(fuseStrict, 10), fnS); console.log(`  ${triStr(pStrict)}`);
  console.log('\n=== CO-PRIMARY (condensed): COMMFUSE − FACTNAME ===');
  const pCond = tri(hit(fuseCond, 10), fnC); console.log(`  ${triStr(pCond)}`);
  console.log('\n=== SECONDARY (strict): COMM − NAME ===');
  console.log(`  ${ciStr(clusteredBootstrap(hit(commStrict, 10), nmS, pairKeys))} (pair)`);

  const report = {
    substrate, n,
    armsStrictR10: { NAME: mean(nmS), FACTNAME: mean(fnS), COMM: mean(hit(commStrict, 10)), COMMFUSE: mean(hit(fuseStrict, 10)) },
    armsCondR10: { FACTNAME: mean(fnC), COMM: mean(hit(commCond, 10)), COMMFUSE: mean(hit(fuseCond, 10)) },
    primaryStrict: pStrict, primaryCondensed: pCond,
    commHits: hit(commStrict, 10).filter((x) => x === 1).length, fuseHits: hit(fuseStrict, 10).filter((x) => x === 1).length,
    factnameHits: fnS.filter((x) => x === 1).length,
  };
  writeFileSync(join(OUT, `community-results-${substrate}.json`), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, `community-results-${substrate}.json`)}`);
  process.exit(0);
}
main();
