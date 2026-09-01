/**
 * Embedding upgrade A/B — bge-m3 vs nomic-embed-text, on arxiv only.
 * FROZEN pre-registration: docs/architecture/single-graph/23-prereg-embedding-upgrade.md
 *
 * Re-embeds three arxiv text sets (entity names, query docs, fact source-texts)
 * with bge-m3 via Ollama /api/embed into a SEPARATE cache (bge-m3-embed-cache.json;
 * the frozen embed-cache.json / arxiv-embed-cache.json are NEVER written), then
 * scores NAME and RRF-60(NAME,FACT) under each embedder on the identical task,
 * held-out guard, oracle, RRF, and tie-break. The nomic arm reproduces the frozen
 * R4 numbers bit-for-bit (integrity anchor). The ONLY thing that varies is the
 * embedder.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/embedding-upgrade.ts
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { rawQuery } from '../../db/raw.js';
import { dot, norm, normalise, rankByScore, strictRankOf, condensedRankOf, clusteredBootstrap, ciStr, mean, type TriResult } from './retrieval-eval/core.js';
import { reciprocalRankFusion } from '../../services/fusion.js';
import { VectorStore } from './retrieval-eval/vector-store.js';
import { loadPairsAndEntities, loadFactStates, RelevanceModel } from './retrieval-eval/data.js';
import { entityEmbedTextFor, factEmbedTextFor } from '../../services/embed-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const DOC_FILE = { 'arxiv-nlp': 'corpus-A.json', 'arxiv-cv': 'corpus-B.json' } as const;
const CORPORA = ['arxiv-nlp', 'arxiv-cv'] as const;
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const BGE_CACHE = join(OUT, 'bge-m3-embed-cache.json');
const byIndex = (a: number, b: number): number => a - b;

// ---- bge-m3 embedding (Ollama, separate cache, L2-normalised) --------------
class BgeCache {
  private readonly c: Record<string, number[]>;
  private embedded = 0;
  constructor() { this.c = existsSync(BGE_CACHE) ? JSON.parse(readFileSync(BGE_CACHE, 'utf8')) : {}; }
  get size(): number { return Object.keys(this.c).length; }
  get newlyEmbedded(): number { return this.embedded; }
  get(text: string): number[] { const v = this.c[text]; if (!v) throw new Error(`bge miss: ${text.slice(0, 80)}`); return v; }
  private flush(): void { writeFileSync(BGE_CACHE, JSON.stringify(this.c)); }
  async ensure(texts: Iterable<string>): Promise<void> {
    const missing = [...new Set(texts)].filter((t) => this.c[t] === undefined);
    if (missing.length === 0) return;
    console.log(`bge-m3: embedding ${missing.length} texts via ${OLLAMA} -> ${BGE_CACHE}`);
    const BATCH = 16;
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const res = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'bge-m3', input: batch }) });
      if (!res.ok) throw new Error(`ollama /api/embed ${res.status}: ${await res.text()}`);
      const j = await res.json() as { embeddings: number[][] };
      if (!j.embeddings || j.embeddings.length !== batch.length) throw new Error(`bge returned ${j.embeddings?.length} for ${batch.length}`);
      for (let k = 0; k < batch.length; k++) {
        const raw = j.embeddings[k]!;
        if (raw.length !== 1024 || raw.some((x) => !Number.isFinite(x))) throw new Error(`bge bad vector dim=${raw.length}`);
        this.c[batch[k]!] = normalise(raw);
        this.embedded++;
      }
      if ((i / BATCH) % 20 === 0) { this.flush(); console.log(`   ${Math.min(i + BATCH, missing.length)}/${missing.length}`); }
    }
    this.flush();
  }
}

interface FactState { vecs: number[][]; paper: string[]; entFacts: Map<number, number[]> }
interface FactRow { id: string; subj: string; obj: string; sourceText: string | null; predicate: string; objectValue: string | null }

async function main(): Promise<void> {
  // guard: snapshot the frozen caches to prove non-contamination
  const frozenPaths = [join(OUT, 'embed-cache.json'), join(OUT, 'arxiv-embed-cache.json')];
  const frozenBefore = frozenPaths.map((p) => (existsSync(p) ? statSync(p) : null)).map((s) => (s ? `${s.size}@${s.mtimeMs}` : 'absent'));

  const store = VectorStore.load(join(OUT, 'embed-cache.json'), join(OUT, 'arxiv-embed-cache.json'));
  const sub = await loadPairsAndEntities(CORPORA, { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: DOC_FILE });
  console.log(`query pairs: ${sub.pairs.length}`);
  // nomic entity/query vectors already in the caches (from R4); ensure present without writing frozen? they exist.
  const rel = new RelevanceModel(CORPORA, sub);
  const { factStateByCorpus } = await loadFactStates(CORPORA, sub.entsByCorpus, sub.factToPaperByCorpus);

  // ---- bge-m3 re-embed: names, queries, fact source-texts ----
  const bge = new BgeCache();
  const nameTexts = new Set<string>();
  for (const c of CORPORA) for (const e of sub.entsByCorpus.get(c)!) nameTexts.add(entityEmbedTextFor(e.name, e.description, 'name'));
  const queryTexts = new Set<string>();
  for (const p of sub.pairs) { const d = sub.docsById.get(p.docId)!; queryTexts.add(`${d.title} ${d.abstract}`); }
  // fact rows (same held-out-eligible filter as loadFactStates) + their bge fact texts
  const rowsByCorpus = new Map<string, FactRow[]>();
  const factTextByCorpus = new Map<string, string[]>();
  for (const c of CORPORA) {
    const rows = await rawQuery<FactRow>(sql`
      SELECT id::text AS id, subject_entity_id::text AS subj, object_entity_id::text AS obj,
             source_text AS "sourceText", predicate, object_value AS "objectValue"
      FROM public.facts WHERE corpus_id = ${c} AND expired_at IS NULL AND invalid_at IS NULL AND fact_embedding IS NOT NULL`);
    rowsByCorpus.set(c, rows);
    factTextByCorpus.set(c, rows.map((r) => factEmbedTextFor(r.sourceText, r.predicate, r.objectValue)));
  }
  const allFactTexts = new Set<string>();
  for (const c of CORPORA) for (const t of factTextByCorpus.get(c)!) allFactTexts.add(t);

  await bge.ensure([...nameTexts, ...queryTexts, ...allFactTexts]);
  console.log(`bge cache size ${bge.size} (newly embedded ${bge.newlyEmbedded})`);

  // build bge fact states (vecs from bge of fact text; paper + endpoints identical to nomic set)
  const bgeFactByCorpus = new Map<string, FactState>();
  const bgeFactSizeMatch: Record<string, boolean> = {};
  for (const c of CORPORA) {
    const ents = sub.entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const rows = rowsByCorpus.get(c)!;
    const f2p = sub.factToPaperByCorpus.get(c)!;
    const vecs: number[][] = []; const paper: string[] = []; const entFacts = new Map<number, number[]>();
    const texts = factTextByCorpus.get(c)!;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const fi = vecs.length; vecs.push(bge.get(texts[i]!)); paper.push(f2p[row.id] ?? '');
      for (const eid of [row.subj, row.obj]) { const ei = idxOf.get(eid); if (ei !== undefined) { const l = entFacts.get(ei) ?? []; l.push(fi); entFacts.set(ei, l); } }
    }
    bgeFactByCorpus.set(c, { vecs, paper, entFacts });
    bgeFactSizeMatch[c] = vecs.length === factStateByCorpus.get(c)!.vecs.length;
  }

  const ARMS = ['NAME_nomic', 'FACTNAME_nomic', 'NAME_bge', 'FACTNAME_bge'];
  const S: Record<string, number[]> = {}; const C: Record<string, number[]> = {};
  for (const a of ARMS) { S[a] = []; C[a] = []; }
  const entityOf: string[] = []; const docOf: string[] = []; const pairKeys: string[] = [];

  for (const c of CORPORA) {
    const ents = sub.entsByCorpus.get(c)!;
    const U = ents.length;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const vNameNomic = ents.map((e) => store.getEntity(entityEmbedTextFor(e.name, e.description, 'name')));
    const vNameBge = ents.map((e) => bge.get(entityEmbedTextFor(e.name, e.description, 'name')));
    const fsN = factStateByCorpus.get(c)!; const fsB = bgeFactByCorpus.get(c)!;
    const endpointsN = new Map<number, number[]>(); for (const [ei, fis] of fsN.entFacts) for (const fi of fis) { const l = endpointsN.get(fi) ?? []; l.push(ei); endpointsN.set(fi, l); }
    const endpointsB = new Map<number, number[]>(); for (const [ei, fis] of fsB.entFacts) for (const fi of fis) { const l = endpointsB.get(fi) ?? []; l.push(ei); endpointsB.set(fi, l); }

    for (const p of sub.pairs) {
      if (p.corpusId !== c) continue;
      const t = idxOf.get(p.entityId); if (t === undefined) continue;
      const d = sub.docsById.get(p.docId)!;
      const qtext = `${d.title} ${d.abstract}`;
      const qvN = store.getQuery(qtext); const qvB = bge.get(qtext);
      const r = rel.relevant(`${c}#${p.docId}`, 3, false);

      const rNameN = rankByScore(vNameNomic.map((v) => dot(qvN, v)));
      const rNameB = rankByScore(vNameBge.map((v) => dot(qvB, v)));

      const factMax = (fs: FactState, endpoints: Map<number, number[]>, qv: number[]): number[] => {
        const m = new Array<number>(U).fill(-Infinity);
        for (let fi = 0; fi < fs.vecs.length; fi++) { if (fs.paper[fi] === p.docId) continue; const scv = dot(qv, fs.vecs[fi]!); for (const ei of endpoints.get(fi) ?? []) if (scv > m[ei]!) m[ei] = scv; }
        return m;
      };
      const rFactN = rankByScore(factMax(fsN, endpointsN, qvN), -Infinity);
      const rFactB = rankByScore(factMax(fsB, endpointsB, qvB), -Infinity);
      const fusedN = reciprocalRankFusion([rNameN, rFactN], { k: 60, tieBreak: byIndex });
      const fusedB = reciprocalRankFusion([rNameB, rFactB], { k: 60, tieBreak: byIndex });

      S['NAME_nomic']!.push(strictRankOf(rNameN, t)); C['NAME_nomic']!.push(condensedRankOf(rNameN, t, r));
      S['FACTNAME_nomic']!.push(strictRankOf(fusedN, t)); C['FACTNAME_nomic']!.push(condensedRankOf(fusedN, t, r));
      S['NAME_bge']!.push(strictRankOf(rNameB, t)); C['NAME_bge']!.push(condensedRankOf(rNameB, t, r));
      S['FACTNAME_bge']!.push(strictRankOf(fusedB, t)); C['FACTNAME_bge']!.push(condensedRankOf(fusedB, t, r));
      entityOf.push(p.entityId); docOf.push(p.docId); pairKeys.push(String(pairKeys.length));
    }
  }

  const n = pairKeys.length;
  const hitS = (a: string): number[] => S[a]!.map((x) => (x <= 10 ? 1 : 0));
  const hitC = (a: string): number[] => C[a]!.map((x) => (x <= 10 ? 1 : 0));
  const tri = (a: number[], b: number[]): TriResult => ({ byPair: clusteredBootstrap(a, b, pairKeys), byEntity: clusteredBootstrap(a, b, entityOf), byDocument: clusteredBootstrap(a, b, docOf) });
  const absS = (a: string): number => mean(hitS(a)); const absC = (a: string): number => mean(hitC(a));

  console.log(`\nn=${n}  (bge fact-set size matches nomic: ${JSON.stringify(bgeFactSizeMatch)})`);
  console.log('arm            strictR10  condR10');
  for (const a of ARMS) console.log(`  ${a.padEnd(14)} ${absS(a).toFixed(4)}   ${absC(a).toFixed(4)}`);

  const dNameC = tri(hitC('NAME_bge'), hitC('NAME_nomic'));
  const dNameS = tri(hitS('NAME_bge'), hitS('NAME_nomic'));
  const dFusC = tri(hitC('FACTNAME_bge'), hitC('FACTNAME_nomic'));
  const dFusS = tri(hitS('FACTNAME_bge'), hitS('FACTNAME_nomic'));
  const dLeverBgeC = tri(hitC('FACTNAME_bge'), hitC('NAME_bge'));
  console.log('\n-- deltas (condensed byPair) --');
  console.log(`  PRIMARY  FACTNAME_bge - FACTNAME_nomic: ${ciStr(dFusC.byPair)}  | strict ${ciStr(dFusS.byPair)}`);
  console.log(`  SEC name NAME_bge - NAME_nomic:         ${ciStr(dNameC.byPair)}  | strict ${ciStr(dNameS.byPair)}`);
  console.log(`  SEC lever FACTNAME_bge - NAME_bge:      ${ciStr(dLeverBgeC.byPair)}`);

  // integrity anchor + guards
  console.log('\n=== INTEGRITY ANCHOR (nomic vs frozen R4) ===');
  const frozen = JSON.parse(readFileSync(join(OUT, 'arxiv-fusion-results.json'), 'utf8'));
  const checks: Array<[string, number, number]> = [
    ['NAME strict', absS('NAME_nomic'), frozen.armsStrictR10.NAME], ['NAME cond', absC('NAME_nomic'), frozen.armsCondR10.NAME],
    ['FACTNAME strict', absS('FACTNAME_nomic'), frozen.armsStrictR10.FACTNAME], ['FACTNAME cond', absC('FACTNAME_nomic'), frozen.armsCondR10.FACTNAME],
  ];
  let void_ = false;
  for (const [lab, got, want] of checks) { const ok = Math.abs(got - want) < 1e-12; console.log(`  ${lab}: ${got} vs ${want}  ${ok ? 'MATCH' : 'MISMATCH'}`); if (!ok) void_ = true; }
  const gotFnNameS = absS('FACTNAME_nomic') - absS('NAME_nomic');
  console.log(`  FACTNAME-NAME strict (point): ${gotFnNameS} vs ${frozen.primaryStrict.byPair.delta}  ${Math.abs(gotFnNameS - frozen.primaryStrict.byPair.delta) < 1e-12 ? 'MATCH' : 'MISMATCH'}`);
  if (Math.abs(gotFnNameS - frozen.primaryStrict.byPair.delta) >= 1e-12) void_ = true;
  for (const c of CORPORA) if (!bgeFactSizeMatch[c]) { console.log(`  VOID: bge fact-set size != nomic on ${c}`); void_ = true; }
  const frozenAfter = frozenPaths.map((p) => (existsSync(p) ? statSync(p) : null)).map((s) => (s ? `${s.size}@${s.mtimeMs}` : 'absent'));
  for (let i = 0; i < frozenPaths.length; i++) if (frozenBefore[i] !== frozenAfter[i]) { console.log(`  VOID: frozen cache contaminated: ${frozenPaths[i]}`); void_ = true; }
  console.log(`  frozen caches unchanged: ${JSON.stringify(frozenBefore) === JSON.stringify(frozenAfter)}`);
  // bge unit-norm spot check
  let normBad = 0; for (const c of CORPORA) { const fs = bgeFactByCorpus.get(c)!; for (let i = 0; i < Math.min(50, fs.vecs.length); i++) if (Math.abs(norm(fs.vecs[i]!) - 1) > 1e-6) normBad++; }
  if (normBad > 0) { console.log(`  VOID: ${normBad} bge vectors not unit-norm`); void_ = true; }
  if (void_) { console.log('=== VOID ==='); process.exit(1); }
  console.log('  ANCHOR OK — nomic reproduces R4; frozen caches untouched; bge 1024-dim unit-norm.');

  const report = {
    substrate: 'arxiv', corpora: [...CORPORA], n,
    bgeNewlyEmbedded: bge.newlyEmbedded, bgeCacheSize: bge.size, bgeFactSizeMatch,
    abs: Object.fromEntries(ARMS.map((a) => [a, { strictR10: absS(a), condR10: absC(a) }])),
    deltas: { primary_FACTNAME_bge_vs_nomic_cond: dFusC, primary_FACTNAME_bge_vs_nomic_strict: dFusS, name_bge_vs_nomic_cond: dNameC, name_bge_vs_nomic_strict: dNameS, lever_FACTNAME_bge_minus_NAME_bge_cond: dLeverBgeC },
  };
  writeFileSync(join(OUT, 'embedding-upgrade-results.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'embedding-upgrade-results.json')}`);
  process.exit(0);
}
main();
