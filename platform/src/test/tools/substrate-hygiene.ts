/**
 * Substrate hygiene — duplicate-name tie-break sensitivity + read-path dedup.
 * FROZEN pre-registration: docs/architecture/single-graph/19-prereg-substrate-hygiene.md
 *
 * Duplicate canonical_names (14-18% of entities share a name) embed to an
 * IDENTICAL name vector and tie exactly under name-vector cosine; rankByScore
 * breaks the tie by entity-id order (index asc). This measures:
 *   (1) whether the confirmed R4 fusion delta (FACTNAME - NAME) is robust to the
 *       tie-break {asc, desc, rand} -- the load-bearing keep-list claim, and
 *   (2) a read-path DEDUP transform (collapse the ranked list to one
 *       representative per canonical_name, group-aware oracle) and its impact.
 * Everything else identical to the frozen R4 / candidate-breadth arm (held-out,
 * cached vectors, exact cosine, the SHIPPED services/fusion.reciprocalRankFusion).
 * asc NAME/FACTNAME must reproduce the frozen R4 numbers bit-for-bit.
 *
 * Run (per substrate; arxiv is primary):
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/substrate-hygiene.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dot, strictRankOf, condensedRankOf, clusteredBootstrap, ciStr, mean, mulberry32, type TriResult } from './retrieval-eval/core.js';
import { reciprocalRankFusion } from '../../services/fusion.js';
import { VectorStore } from './retrieval-eval/vector-store.js';
import { loadPairsAndEntities, loadFactStates, RelevanceModel } from './retrieval-eval/data.js';
import { entityEmbedTextFor } from '../../services/embed-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const DOC_FILE = { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json', 'arxiv-nlp': 'corpus-A.json', 'arxiv-cv': 'corpus-B.json' } as const;

type Cmp = (a: number, b: number) => number;
const TBS: Record<string, Cmp> = { asc: (a, b) => a - b, desc: (a, b) => b - a }; // rand built per-corpus (needs U)

/** rankByScore with an injectable tie-break. asc reproduces core.rankByScore bit-for-bit. */
function rankTB(scores: number[], cmp: Cmp, minScore = -Infinity): number[] {
  const idx = scores.map((_, i) => i).filter((i) => scores[i]! > minScore);
  idx.sort((a, b) => (scores[b]! - scores[a]!) || cmp(a, b));
  return idx;
}

/** Collapse an entity-index ranking to first-seen canonical-name group ids. */
function dedupToGroups(ranking: number[], groupOf: Int32Array): number[] {
  const out: number[] = []; const seen = new Set<number>();
  for (const e of ranking) { const g = groupOf[e]!; if (!seen.has(g)) { seen.add(g); out.push(g); } }
  return out;
}

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

  const TB_NAMES = ['asc', 'desc', 'rand'] as const;
  // metric accumulators: [oracle][arm][tb] -> per-pair rank arrays. Arms: NAME, FACTNAME (+ *_dedup for asc/desc)
  const S: Record<string, number[]> = {}; const C: Record<string, number[]> = {};
  const key = (arm: string, tb: string): string => `${arm}@${tb}`;
  const ARMS_TB: string[] = [];
  for (const arm of ['NAME', 'FACTNAME']) for (const tb of TB_NAMES) ARMS_TB.push(key(arm, tb));
  for (const arm of ['NAMEded', 'FACTNAMEded']) for (const tb of ['asc', 'desc']) ARMS_TB.push(key(arm, tb));
  for (const a of ARMS_TB) { S[a] = []; C[a] = []; }
  const entityOf: string[] = []; const docOf: string[] = []; const pairKeys: string[] = [];

  // substrate-wide descriptive counters
  let distinctNamesTotal = 0; let tiePairs = 0; let dedupVoid = 0;
  const perCorpusGroups: Record<string, number> = {};

  for (const c of cfg.corpora) {
    const ents = sub.entsByCorpus.get(c)!;
    const U = ents.length;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const vName = ents.map((e) => store.getEntity(entityEmbedTextFor(e.name, e.description, 'name')));
    // canonical-name group ids (per corpus)
    const gId = new Map<string, number>(); const groupOf = new Int32Array(U);
    for (let i = 0; i < U; i++) { const nm = ents[i]!.name; let g = gId.get(nm); if (g === undefined) { g = gId.size; gId.set(nm, g); } groupOf[i] = g; }
    perCorpusGroups[c] = gId.size; distinctNamesTotal += gId.size;
    const groupSize = new Int32Array(gId.size); for (let i = 0; i < U; i++) groupSize[groupOf[i]!]!++;
    // seeded random tie-break key per entity
    const rnd = mulberry32(20260831); const randKey = new Float64Array(U); for (let i = 0; i < U; i++) randKey[i] = rnd();
    const cmpRand: Cmp = (a, b) => randKey[a]! - randKey[b]!;
    const cmpOf = (tb: string): Cmp => (tb === 'rand' ? cmpRand : TBS[tb]!);

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

      // held-out fact-max over ALL eligible facts (Kf = full) -> entMax
      const entMax = new Array<number>(U).fill(-Infinity);
      for (let fi = 0; fi < fs.vecs.length; fi++) {
        if (fs.paper[fi] === p.docId) continue;
        const sc = dot(qv, fs.vecs[fi]!);
        for (const ei of factEndpoints.get(fi) ?? []) if (sc > entMax[ei]!) entMax[ei] = sc;
      }

      // descriptive: does the target tie exactly with >=1 other entity on name cosine?
      const st = nameDots[t]!; let ties = 0; for (let i = 0; i < U; i++) if (i !== t && nameDots[i] === st) ties++;
      if (ties > 0) tiePairs++;

      const relGroups = new Set<number>(); for (const i of r) relGroups.add(groupOf[i]!);
      const tGroup = groupOf[t]!;

      for (const tb of TB_NAMES) {
        const cmp = cmpOf(tb);
        const rName = rankTB(nameDots, cmp);
        const rFact = rankTB(entMax, cmp, -Infinity);
        const fused = reciprocalRankFusion([rName, rFact], { k: 60, tieBreak: cmp });
        S[key('NAME', tb)]!.push(strictRankOf(rName, t)); C[key('NAME', tb)]!.push(condensedRankOf(rName, t, r));
        S[key('FACTNAME', tb)]!.push(strictRankOf(fused, t)); C[key('FACTNAME', tb)]!.push(condensedRankOf(fused, t, r));
        if (tb === 'asc' || tb === 'desc') {
          const gName = dedupToGroups(rName, groupOf);
          const gFused = dedupToGroups(fused, groupOf);
          if (gName.indexOf(tGroup) < 0) dedupVoid++; // target group must always survive dedup
          S[key('NAMEded', tb)]!.push(strictRankOf(gName, tGroup)); C[key('NAMEded', tb)]!.push(condensedRankOf(gName, tGroup, relGroups));
          S[key('FACTNAMEded', tb)]!.push(strictRankOf(gFused, tGroup)); C[key('FACTNAMEded', tb)]!.push(condensedRankOf(gFused, tGroup, relGroups));
        }
      }
      entityOf.push(p.entityId); docOf.push(p.docId); pairKeys.push(String(pairKeys.length));
    }
  }

  const n = pairKeys.length;
  const hitS = (a: string, k: number): number[] => S[a]!.map((x) => (x <= k ? 1 : 0));
  const hitC = (a: string, k: number): number[] => C[a]!.map((x) => (x <= k ? 1 : 0));
  const tri = (a: number[], b: number[]): TriResult => ({
    byPair: clusteredBootstrap(a, b, pairKeys), byEntity: clusteredBootstrap(a, b, entityOf), byDocument: clusteredBootstrap(a, b, docOf),
  });
  const absS = (a: string): number => mean(hitS(a, 10));
  const absC = (a: string): number => mean(hitC(a, 10));

  console.log(`n=${n}  distinctNames=${distinctNamesTotal}  tiePairs=${tiePairs}/${n}  dedupVoid=${dedupVoid}`);
  console.log(`groups/corpus: ${JSON.stringify(perCorpusGroups)}`);

  // BAR 1: FACTNAME - NAME within each tie-break (both oracles)
  console.log('\n-- BAR 1: FACTNAME - NAME per tie-break (condensed byPair) --');
  const bar1: Record<string, unknown> = {};
  for (const tb of TB_NAMES) {
    const dC = tri(hitC(key('FACTNAME', tb), 10), hitC(key('NAME', tb), 10));
    const dS = tri(hitS(key('FACTNAME', tb), 10), hitS(key('NAME', tb), 10));
    console.log(`  ${tb}: cond ${ciStr(dC.byPair)} | strict ${ciStr(dS.byPair)}`);
    bar1[tb] = { deltaCond: dC, deltaStrict: dS, absNameC: absC(key('NAME', tb)), absFactnameC: absC(key('FACTNAME', tb)), absNameS: absS(key('NAME', tb)), absFactnameS: absS(key('FACTNAME', tb)) };
  }

  // BAR 2: NAME absolute level swing across tie-breaks
  const nameAbsS = TB_NAMES.map((tb) => absS(key('NAME', tb)));
  const nameAbsC = TB_NAMES.map((tb) => absC(key('NAME', tb)));
  const swing = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
  console.log(`\n-- BAR 2: NAME level swing across {asc,desc,rand} --`);
  console.log(`  strict: ${nameAbsS.map((x) => x.toFixed(4)).join(' / ')}  swing=${swing(nameAbsS).toFixed(4)}`);
  console.log(`  cond:   ${nameAbsC.map((x) => x.toFixed(4)).join(' / ')}  swing=${swing(nameAbsC).toFixed(4)}`);

  // DECISION: dedup preserves lever? + reduces swing?
  console.log(`\n-- DECISION: dedup --`);
  const leverDedupAsc = tri(hitC(key('FACTNAMEded', 'asc'), 10), hitC(key('NAMEded', 'asc'), 10));
  const leverDedupDesc = tri(hitC(key('FACTNAMEded', 'desc'), 10), hitC(key('NAMEded', 'desc'), 10));
  const dedupImpactC = tri(hitC(key('FACTNAMEded', 'asc'), 10), hitC(key('FACTNAME', 'asc'), 10));
  const nameSwingAscDesc = Math.abs(absS(key('NAME', 'asc')) - absS(key('NAME', 'desc')));
  const nameDedSwingAscDesc = Math.abs(absS(key('NAMEded', 'asc')) - absS(key('NAMEded', 'desc')));
  const nameSwingAscDescC = Math.abs(absC(key('NAME', 'asc')) - absC(key('NAME', 'desc')));
  const nameDedSwingAscDescC = Math.abs(absC(key('NAMEded', 'asc')) - absC(key('NAMEded', 'desc')));
  console.log(`  lever preserved (FACTNAMEded-NAMEded, cond byPair): asc ${ciStr(leverDedupAsc.byPair)} | desc ${ciStr(leverDedupDesc.byPair)}`);
  console.log(`  dedup impact (FACTNAMEded-FACTNAME, cond byPair): ${ciStr(dedupImpactC.byPair)}`);
  console.log(`  NAME asc-vs-desc swing strict: ${nameSwingAscDesc.toFixed(4)} -> dedup ${nameDedSwingAscDesc.toFixed(4)}  (< half? ${nameDedSwingAscDesc < nameSwingAscDesc / 2})`);
  console.log(`  NAME asc-vs-desc swing cond:   ${nameSwingAscDescC.toFixed(4)} -> dedup ${nameDedSwingAscDescC.toFixed(4)}  (< half? ${nameDedSwingAscDescC < nameSwingAscDescC / 2})`);
  console.log(`  dedup abs (cond) NAMEded asc/desc: ${absC(key('NAMEded', 'asc')).toFixed(4)}/${absC(key('NAMEded', 'desc')).toFixed(4)}  FACTNAMEded asc/desc: ${absC(key('FACTNAMEded', 'asc')).toFixed(4)}/${absC(key('FACTNAMEded', 'desc')).toFixed(4)}`);

  return {
    substrate: cfg.name, corpora: [...cfg.corpora], n, distinctNames: distinctNamesTotal, groupsPerCorpus: perCorpusGroups,
    tiePairs, dedupVoid,
    abs: Object.fromEntries(ARMS_TB.map((a) => [a, { strictR10: absS(a), condR10: absC(a) }])),
    bar1, nameLevelSwing: { strict: swing(nameAbsS), cond: swing(nameAbsC), strictByTb: nameAbsS, condByTb: nameAbsC },
    decision: {
      leverDedupAsc, leverDedupDesc, dedupImpactCond: dedupImpactC,
      nameSwingAscDescStrict: nameSwingAscDesc, nameDedupSwingAscDescStrict: nameDedSwingAscDesc,
      nameSwingAscDescCond: nameSwingAscDescC, nameDedupSwingAscDescCond: nameDedSwingAscDescC,
    },
  };
}

async function main(): Promise<void> {
  const reports: Record<string, unknown>[] = [];
  reports.push(await runSubstrate({ name: 'arxiv', corpora: ['arxiv-nlp', 'arxiv-cv'], writableCache: 'arxiv-embed-cache.json', ensureEmbed: true }));
  reports.push(await runSubstrate({ name: 'dal', corpora: ['dal-nlp', 'dal-cv'] }));

  // Integrity anchor: asc NAME/FACTNAME must reproduce the frozen R4 arm on arxiv, bit-for-bit.
  console.log('\n=== INTEGRITY ANCHOR (arxiv asc vs frozen R4) ===');
  const frozen = JSON.parse(readFileSync(join(OUT, 'arxiv-fusion-results.json'), 'utf8'));
  const a = reports[0] as any;
  const gotNameS = a.abs['NAME@asc'].strictR10; const gotNameC = a.abs['NAME@asc'].condR10;
  const gotFnS = a.abs['FACTNAME@asc'].strictR10; const gotFnC = a.abs['FACTNAME@asc'].condR10;
  const gotPS = a.bar1.asc.deltaStrict.byPair.delta; const gotPC = a.bar1.asc.deltaCond.byPair.delta;
  const checks: Array<[string, number, number]> = [
    ['NAME strict', gotNameS, frozen.armsStrictR10.NAME], ['NAME cond', gotNameC, frozen.armsCondR10.NAME],
    ['FACTNAME strict', gotFnS, frozen.armsStrictR10.FACTNAME], ['FACTNAME cond', gotFnC, frozen.armsCondR10.FACTNAME],
    ['FACTNAME-NAME strict byPair', gotPS, frozen.primaryStrict.byPair.delta], ['FACTNAME-NAME cond byPair', gotPC, frozen.primaryCondensed.byPair.delta],
  ];
  let void_ = false;
  for (const [lab, got, want] of checks) { const ok = Math.abs(got - want) < 1e-12; console.log(`  ${lab}: ${got} vs frozen ${want}  ${ok ? 'MATCH' : 'MISMATCH'}`); if (!ok) void_ = true; }
  // group-collapse VOID: groups per corpus == distinct canonical_names (SQL: 1070/1169/1001/1157); dedupVoid == 0
  const wantGroups: Record<string, number> = { 'arxiv-nlp': 1070, 'arxiv-cv': 1169, 'dal-nlp': 1001, 'dal-cv': 1157 };
  for (const r of reports) for (const [c, g] of Object.entries((r as any).groupsPerCorpus)) {
    const ok = wantGroups[c] === undefined || wantGroups[c] === g; console.log(`  groups[${c}]=${g}${wantGroups[c] !== undefined ? ` vs SQL ${wantGroups[c]} ${ok ? 'MATCH' : 'MISMATCH'}` : ''}`); if (!ok) void_ = true;
    if ((r as any).dedupVoid > 0) { console.log(`  VOID: dedupVoid=${(r as any).dedupVoid} on ${(r as any).substrate}`); void_ = true; }
  }
  if (void_) { console.log('=== VOID: integrity anchor / group-collapse failed ==='); process.exit(1); }
  console.log('  ANCHOR OK — asc reproduces frozen R4; dedup collapses exactly by canonical_name.');

  writeFileSync(join(OUT, 'substrate-hygiene-results.json'), JSON.stringify(reports, null, 2));
  console.log(`\nartifact: ${join(OUT, 'substrate-hygiene-results.json')}`);
  process.exit(0);
}
main();
