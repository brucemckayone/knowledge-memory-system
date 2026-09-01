/**
 * Traversal-augmented retrieval — vector recall -> traverse public.facts -> re-score.
 * FROZEN pre-registration: docs/architecture/single-graph/21-prereg-traversal-augmented.md
 *
 * Third signal on top of the confirmed R4 fusion: seeds = top-Ks entities by
 * name-vector cosine; spreading-activation over held-out public.facts adjacency
 * (the in-process form of traverseFromEntities), score w_s * decay^hop (decay 0.5),
 * max over paths, up to H hops; rank -> TRAV. Fuse RRF-60(NAME, FACT, TRAV) and
 * ask whether it beats RRF-60(NAME, FACT) (= FACTNAME, the frozen R4 arm, which
 * must reproduce bit-for-bit). Held-out guard: no query-doc fact is ever traversed.
 *
 * Run (per substrate; arxiv is primary):
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/traversal-augmented.ts
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

const KS = [10, 25, 50];
const HOPS = [1, 2];
const DECAY = 0.5;
const PRIMARY = { ks: 25, h: 1 };
const byIndex = (a: number, b: number): number => a - b;
const travLabel = (ks: number, h: number): string => `${ks}_${h}`;

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

  const FIXED = ['NAME', 'FACT', 'FACTNAME'];
  const gridArms: string[] = [];
  for (const ks of KS) for (const h of HOPS) { const l = travLabel(ks, h); gridArms.push(`TRAV_${l}`, `NAMETRAV_${l}`, `FACTNAMETRAV_${l}`); }
  const ARMS = [...FIXED, ...gridArms];
  const S: Record<string, number[]> = {}; const C: Record<string, number[]> = {};
  for (const a of ARMS) { S[a] = []; C[a] = []; }
  const entityOf: string[] = []; const docOf: string[] = []; const pairKeys: string[] = [];

  // mechanism accumulators for the PRIMARY (Ks,H)
  const reachedFrac: number[] = []; const targetReached: number[] = [];
  let heldOutSkipped = 0; let U_total = 0; let corpora_n = 0;
  // per-query condensed hit at 10 for FACTNAME and PRIMARY FACTNAMETRAV, plus seed membership of target
  const fnHitC: number[] = []; const ftHitC: number[] = []; const targetInSeeds: number[] = [];

  for (const c of cfg.corpora) {
    const ents = sub.entsByCorpus.get(c)!;
    const U = ents.length; U_total += U; corpora_n++;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const vName = ents.map((e) => store.getEntity(entityEmbedTextFor(e.name, e.description, 'name')));
    const fs = factStateByCorpus.get(c)!;
    const factEndpoints = new Map<number, number[]>();
    for (const [ei, fis] of fs.entFacts) for (const fi of fis) { const l = factEndpoints.get(fi) ?? []; l.push(ei); factEndpoints.set(fi, l); }

    for (const p of sub.pairs) {
      if (p.corpusId !== c) continue;
      const t = idxOf.get(p.entityId);
      if (t === undefined) continue;
      const d = sub.docsById.get(p.docId)!;
      const qv = store.getQuery(`${d.title} ${d.abstract}`);
      const r = rel.relevant(`${c}#${p.docId}`, 3, false);
      const nameDots = vName.map((v) => dot(qv, v));
      const rName = rankByScore(nameDots);

      // FACT: fact-max over ALL held-out facts
      const entMax = new Array<number>(U).fill(-Infinity);
      for (let fi = 0; fi < fs.vecs.length; fi++) {
        if (fs.paper[fi] === p.docId) continue;
        const sc = dot(qv, fs.vecs[fi]!);
        for (const ei of factEndpoints.get(fi) ?? []) if (sc > entMax[ei]!) entMax[ei] = sc;
      }
      const rFact = rankByScore(entMax, -Infinity);
      const fusedFN = reciprocalRankFusion([rName, rFact], { k: 60, tieBreak: byIndex });

      S['NAME']!.push(strictRankOf(rName, t)); C['NAME']!.push(condensedRankOf(rName, t, r));
      S['FACT']!.push(strictRankOf(rFact, t)); C['FACT']!.push(condensedRankOf(rFact, t, r));
      S['FACTNAME']!.push(strictRankOf(fusedFN, t)); C['FACTNAME']!.push(condensedRankOf(fusedFN, t, r));

      for (const ks of KS) {
        const seeds = rName.slice(0, ks);
        for (const h of HOPS) {
          // spreading-activation BFS over held-out facts: best[n] = max over paths of w_seed * decay^hop
          const best = new Float64Array(U).fill(-Infinity);
          for (const s of seeds) best[s] = nameDots[s]!;
          let frontier = seeds.slice();
          for (let hop = 1; hop <= h; hop++) {
            const next = new Set<number>();
            for (const m of frontier) {
              const cand = best[m]! * DECAY;
              for (const fi of fs.entFacts.get(m) ?? []) {
                if (fs.paper[fi] === p.docId) { if (ks === PRIMARY.ks && h === PRIMARY.h && hop === 1) heldOutSkipped++; continue; }
                for (const n of factEndpoints.get(fi) ?? []) {
                  if (n === m) continue;
                  if (cand > best[n]!) { best[n] = cand; next.add(n); }
                }
              }
            }
            frontier = [...next];
          }
          const rTrav = rankByScore(Array.from(best), -Infinity);
          const l = travLabel(ks, h);
          const nameTrav = reciprocalRankFusion([rName, rTrav], { k: 60, tieBreak: byIndex });
          const factNameTrav = reciprocalRankFusion([rName, rFact, rTrav], { k: 60, tieBreak: byIndex });
          S[`TRAV_${l}`]!.push(strictRankOf(rTrav, t)); C[`TRAV_${l}`]!.push(condensedRankOf(rTrav, t, r));
          S[`NAMETRAV_${l}`]!.push(strictRankOf(nameTrav, t)); C[`NAMETRAV_${l}`]!.push(condensedRankOf(nameTrav, t, r));
          S[`FACTNAMETRAV_${l}`]!.push(strictRankOf(factNameTrav, t)); C[`FACTNAMETRAV_${l}`]!.push(condensedRankOf(factNameTrav, t, r));

          if (ks === PRIMARY.ks && h === PRIMARY.h) {
            let reached = 0; for (let i = 0; i < U; i++) if (best[i]! > -Infinity) reached++;
            reachedFrac.push(reached / U);
            targetReached.push(best[t]! > -Infinity ? 1 : 0);
            targetInSeeds.push(seeds.includes(t) ? 1 : 0);
            fnHitC.push(condensedRankOf(fusedFN, t, r) <= 10 ? 1 : 0);
            ftHitC.push(condensedRankOf(factNameTrav, t, r) <= 10 ? 1 : 0);
          }
        }
      }
      entityOf.push(p.entityId); docOf.push(p.docId); pairKeys.push(String(pairKeys.length));
    }
  }

  const n = pairKeys.length;
  const hitS = (a: string): number[] => S[a]!.map((x) => (x <= 10 ? 1 : 0));
  const hitC = (a: string): number[] => C[a]!.map((x) => (x <= 10 ? 1 : 0));
  const tri = (a: number[], b: number[]): TriResult => ({
    byPair: clusteredBootstrap(a, b, pairKeys), byEntity: clusteredBootstrap(a, b, entityOf), byDocument: clusteredBootstrap(a, b, docOf),
  });
  const absS = (a: string): number => mean(hitS(a)); const absC = (a: string): number => mean(hitC(a));

  // mechanism: added / displaced hits at PRIMARY (condensed)
  let added = 0; let displaced = 0; let addedNonSeed = 0;
  for (let i = 0; i < n; i++) {
    if (ftHitC[i] === 1 && fnHitC[i] === 0) { added++; if (targetInSeeds[i] === 0) addedNonSeed++; }
    if (ftHitC[i] === 0 && fnHitC[i] === 1) displaced++;
  }

  console.log(`n=${n}  NAME ${absS('NAME').toFixed(4)}/${absC('NAME').toFixed(4)}  FACT ${absS('FACT').toFixed(4)}/${absC('FACT').toFixed(4)}  FACTNAME ${absS('FACTNAME').toFixed(4)}/${absC('FACTNAME').toFixed(4)} (strict/cond)`);
  console.log(`PRIMARY(${PRIMARY.ks},${PRIMARY.h}) mechanism: reachedFrac=${mean(reachedFrac).toFixed(3)} targetReached=${mean(targetReached).toFixed(3)} targetInSeeds=${mean(targetInSeeds).toFixed(3)} heldOutSkipped=${heldOutSkipped}`);
  console.log(`  cond added(FT hit,FN miss)=${added} (nonSeed=${addedNonSeed})  displaced(FT miss,FN hit)=${displaced}`);

  console.log('\n-- grid: FACTNAMETRAV - FACTNAME (cond byPair) | NAMETRAV - NAME (cond byPair) --');
  const grid: Record<string, unknown> = {};
  for (const ks of KS) for (const h of HOPS) {
    const l = travLabel(ks, h);
    const dFT = tri(hitC(`FACTNAMETRAV_${l}`), hitC('FACTNAME'));
    const dNT = tri(hitC(`NAMETRAV_${l}`), hitC('NAME'));
    const dFTs = tri(hitS(`FACTNAMETRAV_${l}`), hitS('FACTNAME'));
    const star = (ks === PRIMARY.ks && h === PRIMARY.h) ? ' <PRIMARY>' : '';
    console.log(`  (${ks},${h})${star}: FT-FN ${ciStr(dFT.byPair)} | NT-N ${ciStr(dNT.byPair)} | TRAV cond ${absC(`TRAV_${l}`).toFixed(4)}  FACTNAMETRAV cond ${absC(`FACTNAMETRAV_${l}`).toFixed(4)}`);
    grid[l] = {
      ks, h,
      travCondR10: absC(`TRAV_${l}`), travStrictR10: absS(`TRAV_${l}`),
      nametravCondR10: absC(`NAMETRAV_${l}`), factnametravCondR10: absC(`FACTNAMETRAV_${l}`), factnametravStrictR10: absS(`FACTNAMETRAV_${l}`),
      deltaFTvsFN_cond: dFT, deltaFTvsFN_strict: dFTs, deltaNTvsN_cond: dNT,
    };
  }

  const pl = travLabel(PRIMARY.ks, PRIMARY.h);
  return {
    substrate: cfg.name, corpora: [...cfg.corpora], n,
    abs: Object.fromEntries(ARMS.map((a) => [a, { strictR10: absS(a), condR10: absC(a) }])),
    primary: { ks: PRIMARY.ks, h: PRIMARY.h, deltaFTvsFN_cond: (grid[pl] as any).deltaFTvsFN_cond, deltaFTvsFN_strict: (grid[pl] as any).deltaFTvsFN_strict, deltaNTvsN_cond: (grid[pl] as any).deltaNTvsN_cond },
    mechanism: { reachedFrac: mean(reachedFrac), targetReached: mean(targetReached), targetInSeeds: mean(targetInSeeds), heldOutSkipped, addedCond: added, addedNonSeed, displacedCond: displaced, avgU: U_total / corpora_n },
    grid,
  };
}

async function main(): Promise<void> {
  const reports: Record<string, unknown>[] = [];
  reports.push(await runSubstrate({ name: 'arxiv', corpora: ['arxiv-nlp', 'arxiv-cv'], writableCache: 'arxiv-embed-cache.json', ensureEmbed: true }));
  reports.push(await runSubstrate({ name: 'dal', corpora: ['dal-nlp', 'dal-cv'] }));

  console.log('\n=== INTEGRITY ANCHOR (arxiv NAME/FACTNAME vs frozen R4) ===');
  const frozen = JSON.parse(readFileSync(join(OUT, 'arxiv-fusion-results.json'), 'utf8'));
  const a = reports[0] as any;
  const checks: Array<[string, number, number]> = [
    ['NAME strict', a.abs.NAME.strictR10, frozen.armsStrictR10.NAME], ['NAME cond', a.abs.NAME.condR10, frozen.armsCondR10.NAME],
    ['FACTNAME strict', a.abs.FACTNAME.strictR10, frozen.armsStrictR10.FACTNAME], ['FACTNAME cond', a.abs.FACTNAME.condR10, frozen.armsCondR10.FACTNAME],
  ];
  let void_ = false;
  for (const [lab, got, want] of checks) { const ok = Math.abs(got - want) < 1e-12; console.log(`  ${lab}: ${got} vs frozen ${want}  ${ok ? 'MATCH' : 'MISMATCH'}`); if (!ok) void_ = true; }
  // FACTNAME - NAME anchor
  const fnNameS = frozen.primaryStrict.byPair.delta; const gotFnNameS = a.abs.FACTNAME.strictR10 - a.abs.NAME.strictR10;
  console.log(`  FACTNAME-NAME strict (point): ${gotFnNameS} vs frozen ${fnNameS}  ${Math.abs(gotFnNameS - fnNameS) < 1e-12 ? 'MATCH' : 'MISMATCH'}`);
  if (Math.abs(gotFnNameS - fnNameS) >= 1e-12) void_ = true;
  // degeneracy guard
  for (const r of reports) { const m = (r as any).mechanism; if (m.reachedFrac > 0.8) { console.log(`  WARN degeneracy: ${(r as any).substrate} reachedFrac ${m.reachedFrac.toFixed(3)} > 0.8 (hub explosion)`); } if (m.targetReached < 0.05) { console.log(`  WARN degeneracy: ${(r as any).substrate} targetReached ${m.targetReached.toFixed(3)} < 0.05`); } }
  if (void_) { console.log('=== VOID: integrity anchor failed ==='); process.exit(1); }
  console.log('  ANCHOR OK — NAME/FACTNAME reproduce frozen R4.');

  writeFileSync(join(OUT, 'traversal-augmented-results.json'), JSON.stringify(reports, null, 2));
  console.log(`\nartifact: ${join(OUT, 'traversal-augmented-results.json')}`);
  process.exit(0);
}
main();
