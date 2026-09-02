/**
 * prereg-26 (nmemo-u8j.4) STAGE 1 — dump the two-signal fusion pool for cross-encoder reranking.
 * FROZEN pre-registration: docs/architecture/single-graph/26-prereg-cross-encoder-rerank.md
 *
 * Runs the shared retrieval-eval engine (arms NAME/FACTMAX/FACTNAME, keepBaseRankings) to get, per query
 * pair: the FACTNAME=RRF-60(names,facts) ranking, the target's FACTNAME strict+condensed rank (the baseline
 * to beat), the relevant set (condensed oracle), and the top-K=50 pool. Builds each pool entity's
 * candidate_text = "name. " + up to 10 HELD-OUT fact source_texts (facts from the query doc excluded, the
 * same guard the fusion uses). Emits rerank-pool-<label>.json for the Python cross-encoder (stage 2).
 *
 * Metric computation stays in the frozen TS engine (stage 3, rerank-eval.ts) — this only dumps.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/rerank-dump.ts --substrate=arxiv
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { rawQuery } from '../../db/raw.js';
import { runEval } from './retrieval-eval/harness.js';
import { reciprocalRankFusion } from '../../services/fusion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');

const K = 50;                    // pool size (prereg §2)
const MAX_FACTS = 10;            // candidate_text: up to this many held-out fact sentences (prereg §2)
const BIG = 1e9;                 // JSON-safe stand-in for Infinity rank
const byIndex = (a: number, b: number): number => a - b;

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

interface FactRow { id: string; subj: string; obj: string; srcText: string }

async function main(): Promise<void> {
  const substrate = arg('substrate', 'arxiv');
  const CFG: Record<string, { corpora: string[]; docFileFor: Record<string, string>; writable: string }> = {
    arxiv: { corpora: ['arxiv-nlp', 'arxiv-cv'], docFileFor: { 'arxiv-nlp': 'corpus-A.json', 'arxiv-cv': 'corpus-B.json' }, writable: 'arxiv-embed-cache.json' },
    qbio: { corpora: ['qbio'], docFileFor: { qbio: 'corpus-C.json' }, writable: 'qbio-embed-cache.json' },
  };
  const cfg = CFG[substrate];
  if (!cfg) throw new Error(`--substrate must be arxiv or qbio, got ${substrate}`);

  const r = await runEval({
    label: `rerank-dump-${substrate}`,
    corpora: cfg.corpora,
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: cfg.docFileFor },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    writableCachePath: join(OUT, cfg.writable),
    arms: ['NAME', 'FACTMAX', 'FACTNAME'],
    ensureEmbedEntityNames: true,
    ensureEmbedQueryDocs: true,
    factNormStrict: true,
    keepBaseRankings: true,
  });

  const { sub, rel, baseRankings, corpusOf, docOf, entityOf, targetIdx, strictRank, condRank } = r;
  const rName = baseRankings!.rName; const rFactMax = baseRankings!.rFactMax!;

  // Per corpus: entity index maps + held-out fact source_texts per entity index.
  const entIdxOf = new Map<string, Map<string, number>>();
  const entName = new Map<string, string[]>();
  const factTextsByEnt = new Map<string, Map<number, Array<{ text: string; paper: string }>>>();
  for (const c of cfg.corpora) {
    const ents = sub.entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    entIdxOf.set(c, idxOf);
    entName.set(c, ents.map((e) => e.name));
    const f2p = sub.factToPaperByCorpus.get(c)!;
    const rows = await rawQuery<FactRow>(sql`
      SELECT id::text AS "id", subject_entity_id::text AS "subj", object_entity_id::text AS "obj",
             source_text AS "srcText"
      FROM public.facts
      WHERE corpus_id = ${c} AND expired_at IS NULL AND invalid_at IS NULL AND source_text IS NOT NULL`);
    const perEnt = new Map<number, Array<{ text: string; paper: string }>>();
    for (const row of rows) {
      const paper = f2p[row.id] ?? '';
      for (const eid of [row.subj, row.obj]) {
        const ei = idxOf.get(eid);
        if (ei === undefined) continue;
        const l = perEnt.get(ei) ?? []; l.push({ text: row.srcText, paper }); perEnt.set(ei, l);
      }
    }
    factTextsByEnt.set(c, perEnt);
  }

  const candidateText = (c: string, ei: number, docId: string): string => {
    const name = entName.get(c)![ei] ?? '';
    const facts = (factTextsByEnt.get(c)!.get(ei) ?? []).filter((f) => f.paper !== docId).slice(0, MAX_FACTS);
    return facts.length ? `${name}. ${facts.map((f) => f.text).join(' ')}` : name;
  };

  const pairs: unknown[] = [];
  const n = corpusOf.length;
  for (let i = 0; i < n; i++) {
    const c = corpusOf[i]!;
    const docId = docOf[i]!;
    const d = sub.docsById.get(docId)!;
    const t = targetIdx[i]!;
    const factnameRanking = reciprocalRankFusion([rName[i]!, rFactMax[i]!], { k: 60, tieBreak: byIndex });
    const poolIdx = factnameRanking.slice(0, K);
    const relSet = rel.relevant(`${c}#${docId}`);
    const ents = sub.entsByCorpus.get(c)!;
    const pool = poolIdx.map((ei) => ({ entityId: ents[ei]!.id, text: candidateText(c, ei, docId) }));
    const poolRelevant = poolIdx.filter((ei) => relSet.has(ei)).map((ei) => ents[ei]!.id);
    pairs.push({
      pairIdx: i,
      corpus: c,
      docId,
      queryText: `${d.title} ${d.abstract}`,
      targetEntityId: entityOf[i]!,
      targetInPool: poolIdx.includes(t),
      factnameStrictRank: Number.isFinite(strictRank['FACTNAME']![i]!) ? strictRank['FACTNAME']![i]! : BIG,
      factnameCondRank: Number.isFinite(condRank['FACTNAME']![i]!) ? condRank['FACTNAME']![i]! : BIG,
      pool,
      poolRelevant,
    });
  }

  const meta = { substrate, corpora: cfg.corpora, K, maxFacts: MAX_FACTS, n, factnameK: 60 };
  const outPath = join(OUT, `rerank-pool-${substrate}.json`);
  writeFileSync(outPath, JSON.stringify({ meta, pairs }, null, 2));
  const ceiling = pairs.filter((p) => (p as { targetInPool: boolean }).targetInPool).length / n;
  console.log(`dumped ${n} pairs (${substrate}); pool K=${K}; pool-recall ceiling (target in pool) = ${(ceiling * 100).toFixed(1)}%`);
  console.log(`artifact: ${outPath}`);
  process.exit(0);
}
main();
