/**
 * Candidate-breadth sufficiency for the shipped top-N fusion read path.
 * FROZEN pre-registration: docs/architecture/single-graph/17-prereg-candidate-breadth.md
 *
 * The shipped recallEntitiesFused (nmemo-u8j.1) fuses HNSW top-N candidate lists;
 * R4 measured FULL rankings. This sweeps (Kc, Kf) — name-candidate depth and
 * fact-candidate depth — with everything else identical to the frozen FACTNAME arm
 * (held-out, cached vectors, exact cosine, retrieved-set RRF-60 via the SHIPPED
 * services/fusion.reciprocalRankFusion). (full,full) must reproduce FACTNAME.
 *
 * Run (per substrate; arxiv is primary):
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/candidate-breadth.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dot, rankByScore, strictRankOf, condensedRankOf, clusteredBootstrap, ciStr, mean, type TriResult } from './retrieval-eval/core.js';
import { reciprocalRankFusion } from '../../services/fusion.js';
import { VectorStore } from './retrieval-eval/vector-store.js';
import { loadPairsAndEntities, loadFactStates, RelevanceModel } from './retrieval-eval/data.js';
import { entityEmbedTextFor } from '../../services/embed-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const DOC_FILE = { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json', 'arxiv-nlp': 'corpus-A.json', 'arxiv-cv': 'corpus-B.json' } as const;

// (Kc, Kf); Infinity = full ranking. (full,full) is the FACTNAME integrity anchor.
const GRID: Array<[number, number]> = [[25, 100], [50, 200], [100, 500], [200, 1000], [Infinity, Infinity]];
const label = (kc: number, kf: number): string => (kc === Infinity ? 'FULL' : `LTD_${kc}_${kf}`);
const byIndex = (a: number, b: number): number => a - b;

interface SubstrateCfg { name: string; corpora: readonly string[]; writableCache?: string; ensureEmbed?: boolean }

async function runSubstrate(cfg: SubstrateCfg): Promise<Record<string, unknown>> {
  console.log(`\n================ ${cfg.name} (${cfg.corpora.join(', ')}) ================`);
  const store = VectorStore.load(join(OUT, 'embed-cache.json'), cfg.writableCache ? join(OUT, cfg.writableCache) : undefined);
  const sub = await loadPairsAndEntities(cfg.corpora, { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: DOC_FILE });
  console.log(`query pairs: ${sub.pairs.length}`);
  if (cfg.ensureEmbed) {
    const names = new Set<string>();
    for (const c of cfg.corpora) for (const e of sub.entsByCorpus.get(c)!) names.add(entityEmbedTextFor(e.name, e.description, 'name'));
    await store.ensureEmbedded(names, true);
    const q = new Set<string>();
    for (const p of sub.pairs) { const d = sub.docsById.get(p.docId)!; q.add(`${d.title} ${d.abstract}`); }
    await store.ensureEmbedded(q, false);
  }
  const rel = new RelevanceModel(cfg.corpora, sub);
  const { factStateByCorpus } = await loadFactStates(cfg.corpora, sub.entsByCorpus, sub.factToPaperByCorpus);

  const ARMS = ['NAME', ...GRID.map(([kc, kf]) => label(kc, kf))];
  const strict: Record<string, number[]> = {}; const cond: Record<string, number[]> = {};
  for (const a of ARMS) { strict[a] = []; cond[a] = []; }
  const entityOf: string[] = []; const docOf: string[] = []; const pairKeys: string[] = [];
  const degenEq: number[] = []; // LTD_50_200 top10 == NAME top10

  for (const c of cfg.corpora) {
    const ents = sub.entsByCorpus.get(c)!;
    const U = ents.length;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const vName = ents.map((e) => store.getEntity(entityEmbedTextFor(e.name, e.description, 'name')));
    const fs = factStateByCorpus.get(c)!;
    // invert entFacts: fact index -> its endpoint entity indices (subject + object)
    const factEndpoints = new Map<number, number[]>();
    for (const [ei, fis] of fs.entFacts) for (const fi of fis) { const l = factEndpoints.get(fi) ?? []; l.push(ei); factEndpoints.set(fi, l); }

    for (const p of sub.pairs) {
      if (p.corpusId !== c) continue;
      const t = idxOf.get(p.entityId);
      if (t === undefined) continue;
      const d = sub.docsById.get(p.docId)!;
      const qv = store.getQuery(`${d.title} ${d.abstract}`);
      const r = rel.relevant(`${c}#${p.docId}`, 3, false);
      const rName = rankByScore(vName.map((v) => dot(qv, v)));

      // held-out eligible facts, scored + ranked once per query (score desc, fact index asc)
      const eligible: Array<{ fi: number; score: number }> = [];
      for (let fi = 0; fi < fs.vecs.length; fi++) {
        if (fs.paper[fi] === p.docId) continue;
        eligible.push({ fi, score: dot(qv, fs.vecs[fi]!) });
      }
      eligible.sort((a, b) => (b.score - a.score) || (a.fi - b.fi));

      strict['NAME']!.push(strictRankOf(rName, t)); cond['NAME']!.push(condensedRankOf(rName, t, r));
      for (const [kc, kf] of GRID) {
        // fact candidate ranking: aggregate endpoints by MAX over ONLY the top-Kf eligible facts
        const entMax = new Array<number>(U).fill(-Infinity);
        const topKf = kf === Infinity ? eligible.length : Math.min(kf, eligible.length);
        for (let j = 0; j < topKf; j++) {
          const { fi, score } = eligible[j]!;
          for (const ei of factEndpoints.get(fi) ?? []) if (score > entMax[ei]!) entMax[ei] = score;
        }
        const rFact = rankByScore(entMax, -Infinity);
        const nameTop = kc === Infinity ? rName : rName.slice(0, kc);
        const fused = reciprocalRankFusion([nameTop, rFact], { k: 60, tieBreak: byIndex });
        const lab = label(kc, kf);
        strict[lab]!.push(strictRankOf(fused, t)); cond[lab]!.push(condensedRankOf(fused, t, r));
        if (kc === 50 && kf === 200) {
          const aTop = new Set(fused.slice(0, 10)); const nTop = new Set(rName.slice(0, 10));
          let same = aTop.size === nTop.size; if (same) for (const x of aTop) if (!nTop.has(x)) { same = false; break; }
          degenEq.push(same ? 1 : 0);
        }
      }
      entityOf.push(p.entityId); docOf.push(p.docId); pairKeys.push(String(pairKeys.length));
    }
  }

  const n = strict['NAME']!.length;
  const hitS = (a: string, k: number): number[] => strict[a]!.map((x) => (x <= k ? 1 : 0));
  const hitC = (a: string, k: number): number[] => cond[a]!.map((x) => (x <= k ? 1 : 0));
  const tri = (a: number[], b: number[]): TriResult => ({
    byPair: clusteredBootstrap(a, b, pairKeys), byEntity: clusteredBootstrap(a, b, entityOf), byDocument: clusteredBootstrap(a, b, docOf),
  });

  console.log(`n=${n}   LTD_50_200 top10==NAME top10: ${(mean(degenEq) * 100).toFixed(1)}%`);
  console.log('| (Kc,Kf) | strict R@10 | cond R@10 | Δcond vs NAME (byPair) | Δcond vs FULL (byPair) |');
  console.log('|---------|-------------|-----------|------------------------|------------------------|');
  const report: Record<string, unknown> = { substrate: cfg.name, corpora: [...cfg.corpora], n, degenLTD50: mean(degenEq), grid: {} };
  const gridOut = report.grid as Record<string, unknown>;
  const full = 'FULL';
  console.log(`| NAME    | ${mean(hitS('NAME', 10)).toFixed(4)}     | ${mean(hitC('NAME', 10)).toFixed(4)}   | (baseline)             |                        |`);
  for (const [kc, kf] of GRID) {
    const lab = label(kc, kf);
    const dNameC = tri(hitC(lab, 10), hitC('NAME', 10));
    const dNameS = tri(hitS(lab, 10), hitS('NAME', 10));
    const dFullC = lab === full ? null : tri(hitC(lab, 10), hitC(full, 10));
    console.log(`| ${(kc === Infinity ? 'full' : `${kc},${kf}`).padEnd(7)} | ${mean(hitS(lab, 10)).toFixed(4)}     | ${mean(hitC(lab, 10)).toFixed(4)}   | ${ciStr(dNameC.byPair)} | ${dFullC ? ciStr(dFullC.byPair) : '(is full)'} |`);
    gridOut[lab] = {
      kc: kc === Infinity ? 'full' : kc, kf: kf === Infinity ? 'full' : kf,
      strictR10: mean(hitS(lab, 10)), condR10: mean(hitC(lab, 10)),
      deltaCondVsName: dNameC, deltaStrictVsName: dNameS, deltaCondVsFull: dFullC,
    };
  }
  return report;
}

async function main(): Promise<void> {
  const reports: Record<string, unknown>[] = [];
  reports.push(await runSubstrate({ name: 'arxiv', corpora: ['arxiv-nlp', 'arxiv-cv'], writableCache: 'arxiv-embed-cache.json', ensureEmbed: true }));
  reports.push(await runSubstrate({ name: 'dal', corpora: ['dal-nlp', 'dal-cv'] }));

  // Integrity anchor: FULL must reproduce the frozen FACTNAME arm on arxiv.
  console.log('\n=== INTEGRITY ANCHOR (arxiv FULL vs frozen FACTNAME) ===');
  const frozen = JSON.parse(readFileSync(join(OUT, 'arxiv-fusion-results.json'), 'utf8'));
  const arxiv = reports[0] as any;
  const gotFullStrict = arxiv.grid.FULL.strictR10; const gotFullCond = arxiv.grid.FULL.condR10;
  const wantStrict = frozen.armsStrictR10.FACTNAME; const wantCond = frozen.armsCondR10.FACTNAME;
  const okS = Math.abs(gotFullStrict - wantStrict) < 1e-12; const okC = Math.abs(gotFullCond - wantCond) < 1e-12;
  console.log(`  FULL strict R@10 ${gotFullStrict} vs frozen FACTNAME ${wantStrict}  ${okS ? 'MATCH' : 'MISMATCH'}`);
  console.log(`  FULL cond   R@10 ${gotFullCond} vs frozen FACTNAME ${wantCond}  ${okC ? 'MATCH' : 'MISMATCH'}`);
  const wantPrimaryStrict = frozen.primaryStrict.byPair.delta;
  const gotPrimaryStrict = arxiv.grid.FULL.deltaStrictVsName.byPair.delta;
  const okP = Math.abs(gotPrimaryStrict - wantPrimaryStrict) < 1e-12;
  console.log(`  FULL−NAME strict byPair ${gotPrimaryStrict} vs frozen ${wantPrimaryStrict}  ${okP ? 'MATCH' : 'MISMATCH'}`);
  if (!okS || !okC || !okP) { console.log('=== VOID: integrity anchor failed — LTD arm is mis-wired ==='); process.exit(1); }
  console.log('  ANCHOR OK — LTD(full,full) reproduces frozen FACTNAME.');

  writeFileSync(join(OUT, 'candidate-breadth-results.json'), JSON.stringify(reports, null, 2));
  console.log(`\nartifact: ${join(OUT, 'candidate-breadth-results.json')}`);
  process.exit(0);
}
main();
