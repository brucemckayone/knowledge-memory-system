/**
 * retrieval-eval — the one orchestrator.
 *
 * `runEval(config)` runs any registered set of arms over any corpus set, scoring
 * every arm under BOTH oracles (strict = 1-based target rank; condensed = only
 * non-relevant entities ranked above the target count), and returns an EvalResult
 * exposing the per-arm hit vectors, the three cluster bootstraps (by pair, by
 * entity, by document), and — optionally — the per-pair base rankings so a thin
 * experiment config can compute its own extras (e0's shift/sensitivity, pool's
 * ceilings, hybrid's component overlap, fact/arxiv complementarity) with the SAME
 * shared primitives. It performs the kill-condition checks inline: the strict
 * regression gate, the fact integrity/normalisation guard, the underpowered
 * guard, and the arm-identity degeneracy check.
 *
 * This is the fold of e0-oracle/pool-rerank/hybrid-names/fact-level/arxiv-fusion:
 * the bootstrap, oracle, RRF, pair-building, relevance-set, fact-loading, and
 * reporting scaffolding exist here exactly once.
 *
 * bead nmemo-u8j.2
 */
import {
  clusteredBootstrap, mean, dot, rankByScore, strictRankOf, condensedRankOf,
  buildBm25, bm25Scores, type Bm25Index, type TriResult,
} from './core.js';
import { entityEmbedTextFor } from '../../../services/embed-text.js';
import { VectorStore } from './vector-store.js';
import {
  loadPairsAndEntities, loadFactStates, RelevanceModel,
  type Substrate, type SubstratePaths, type FactState,
} from './data.js';
import { resolveArm, type Derived, type ArmDef, type Signal } from './arms.js';

export interface EvalConfig {
  label: string;
  corpora: readonly string[];
  paths: SubstratePaths;
  frozenCachePath: string;
  writableCachePath?: string;
  arms: string[];
  /** primary condensed-oracle Tier-B filter (default name length >= 3, no multi-token requirement) */
  relMinLen?: number;
  relMultiOnly?: boolean;
  ensureEmbedEntityNames?: boolean;
  ensureEmbedQueryDocs?: boolean;
  /** strict R@10 regression gate: exact (tol 1e-9) per arm, plus optional n */
  regression?: { targets: Record<string, number>; n?: number };
  /** report top-10 == NAME top-10 overlap for this arm; warn if > 0.95 */
  degeneracyArm?: string;
  /** exit(0) if fewer than this many query pairs */
  underpoweredMin?: number;
  /** VOID (not just warn) when the mean raw fact norm is ~1 (arxiv discipline) */
  factNormStrict?: boolean;
  /** keep per-pair base rankings for config-level extras */
  keepBaseRankings?: boolean;
}

export interface EvalResult {
  n: number;
  arms: string[];
  strictRank: Record<string, number[]>;
  condRank: Record<string, number[]>;
  corpusOf: string[];
  entityOf: string[];
  docOf: string[];
  pairKeys: string[];
  targetIdx: number[];
  baseRankings?: { rName: number[][]; rDesc?: number[][]; rBm25?: number[][]; rFactMax?: number[][]; rFactMean?: number[][] };
  targetFactCount?: number[];
  pairsWithExclusion?: number;
  noEligibleFact?: number;
  degeneracyOverlap?: number;
  sub: Substrate;
  rel: RelevanceModel;
  store: VectorStore;
  factStateByCorpus?: Map<string, FactState>;
  hitStrict(arm: string, k: number): number[];
  hitCond(arm: string, k: number): number[];
  tri(a: number[], b: number[]): TriResult;
  armStrictR(k: number): Record<string, number>;
  armCondR(k: number): Record<string, number>;
}

/** Aggregate a query's per-fact cosines to per-entity max + mean, excluding
 *  facts sourced from the query document (held-out guard). Returns eligible
 *  fact count for the target too. */
function factSignals(
  fs: FactState, qv: number[], docId: string, U: number,
): { factMax: number[]; factMean: number[]; entCnt: number[]; excluded: number } {
  const factScore = fs.vecs.map((v) => dot(qv, v));
  const factMax = new Array<number>(U).fill(-Infinity);
  const entSum = new Array<number>(U).fill(0);
  const entCnt = new Array<number>(U).fill(0);
  let excluded = 0;
  for (const [ei, fis] of fs.entFacts) for (const fi of fis) {
    if (fs.paper[fi] === docId) { excluded += 1; continue; } // held-out: exclude facts from the query doc
    const sc = factScore[fi]!;
    if (sc > factMax[ei]!) factMax[ei] = sc;
    entSum[ei] = entSum[ei]! + sc; entCnt[ei] = entCnt[ei]! + 1;
  }
  const factMean = factMax.map((_, i) => (entCnt[i]! > 0 ? entSum[i]! / entCnt[i]! : -Infinity));
  return { factMax, factMean, entCnt, excluded };
}

export async function runEval(cfg: EvalConfig): Promise<EvalResult> {
  const armDefs = new Map<string, ArmDef>(cfg.arms.map((a) => [a, resolveArm(a)]));
  const needed = new Set<Signal>();
  for (const def of armDefs.values()) for (const s of def.needs) needed.add(s);
  const useDesc = needed.has('desc');
  const useBm25 = needed.has('bm25');
  const useFacts = needed.has('facts');
  const relMinLen = cfg.relMinLen ?? 3;
  const relMultiOnly = cfg.relMultiOnly ?? false;

  const store = VectorStore.load(cfg.frozenCachePath, cfg.writableCachePath);
  console.log(`frozen cache: ${store.frozenSize} vectors; writable cache: ${store.writableSize}`);

  const sub = await loadPairsAndEntities(cfg.corpora, cfg.paths);
  console.log(`query pairs: ${sub.pairs.length}`);
  if (cfg.underpoweredMin !== undefined && sub.pairs.length < cfg.underpoweredMin) {
    console.log(`=== UNDERPOWERED: n=${sub.pairs.length} < ${cfg.underpoweredMin} ===`);
    process.exit(0);
  }

  if (cfg.ensureEmbedEntityNames) {
    const names = new Set<string>();
    for (const c of cfg.corpora) for (const e of sub.entsByCorpus.get(c)!) names.add(entityEmbedTextFor(e.name, e.description, 'name'));
    await store.ensureEmbedded(names, true); // entity reads are writable-first
  }
  if (cfg.ensureEmbedQueryDocs) {
    const q = new Set<string>();
    for (const p of sub.pairs) { const d = sub.docsById.get(p.docId)!; q.add(`${d.title} ${d.abstract}`); }
    await store.ensureEmbedded(q, false); // query reads are frozen-first
  }

  const rel = new RelevanceModel(cfg.corpora, sub);
  console.log(`Tier-B/doc mean ${rel.meanTierBPerDoc.toFixed(1)}; mean |relevant|/|corpus| ${(rel.meanRelevantFrac * 100).toFixed(1)}%`);

  let factStateByCorpus: Map<string, FactState> | undefined;
  if (useFacts) {
    const fr = await loadFactStates(cfg.corpora, sub.entsByCorpus, sub.factToPaperByCorpus);
    factStateByCorpus = fr.factStateByCorpus;
    console.log('');
    console.log(`fact integrity: dim/finite violations ${fr.dimViol}; mean RAW norm ${fr.meanRawNorm.toFixed(3)} (expect != 1); self-dot violations ${fr.selfDotViol}`);
    if (fr.dimViol > 0) { console.log('=== VOID: fact vector integrity failed ==='); process.exit(1); }
    if (fr.selfDotViol > 0) { console.log('=== VOID: normalisation failed self-dot ==='); process.exit(1); }
    if (Math.abs(fr.meanRawNorm - 1) < 0.05) {
      if (cfg.factNormStrict) { console.log('=== VOID: raw fact norms ~1, normalisation is a no-op ==='); process.exit(1); }
      console.log('=== WARNING: raw fact norms ~1, normalisation may be a no-op ===');
    }
  }

  // per-arm rank arrays
  const strictRank: Record<string, number[]> = {};
  const condRank: Record<string, number[]> = {};
  for (const a of cfg.arms) { strictRank[a] = []; condRank[a] = []; }
  const corpusOf: string[] = []; const entityOf: string[] = []; const docOf: string[] = []; const targetIdx: number[] = [];
  const keepBR = cfg.keepBaseRankings === true;
  const brName: number[][] = []; const brDesc: number[][] = []; const brBm25: number[][] = []; const brFactMax: number[][] = []; const brFactMean: number[][] = [];
  const targetFactCount: number[] = []; let pairsWithExclusion = 0; let noEligibleFact = 0;
  const degenEq: number[] = [];
  const degArmDef = cfg.degeneracyArm ? armDefs.get(cfg.degeneracyArm) : undefined;
  if (cfg.degeneracyArm && !degArmDef) throw new Error(`degeneracyArm ${cfg.degeneracyArm} not in arms`);

  for (const c of cfg.corpora) {
    const ents = sub.entsByCorpus.get(c)!;
    const U = ents.length;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const vName = ents.map((e) => store.getEntity(entityEmbedTextFor(e.name, e.description, 'name')));
    const vDesc = useDesc ? ents.map((e) => store.getEntity(entityEmbedTextFor(e.name, e.description, 'name_description'))) : undefined;
    const bmN: Bm25Index | undefined = useBm25 ? buildBm25(ents.map((e) => e.name)) : undefined;
    const fs = useFacts ? factStateByCorpus!.get(c)! : undefined;

    for (const p of sub.pairs) {
      if (p.corpusId !== c) continue;
      const t = idxOf.get(p.entityId);
      if (t === undefined) continue;
      const d = sub.docsById.get(p.docId)!;
      const qtext = `${d.title} ${d.abstract}`;
      const qv = store.getQuery(qtext);
      const r = rel.relevant(`${c}#${p.docId}`, relMinLen, relMultiOnly);

      const nameScore = vName.map((v) => dot(qv, v));
      const descScore = vDesc?.map((v) => dot(qv, v));
      const bm25Score = bmN ? bm25Scores(bmN, qtext) : undefined;
      let factMax: number[] | undefined; let factMean: number[] | undefined;
      if (fs) {
        const fsig = factSignals(fs, qv, p.docId, U);
        factMax = fsig.factMax; factMean = fsig.factMean;
        if (fsig.excluded > 0) pairsWithExclusion += 1;
        if (fsig.entCnt[t]! === 0) noEligibleFact += 1;
        targetFactCount.push(fsig.entCnt[t]!);
      }

      const d0: Derived = {
        U, nameScore, descScore, bm25Score, factMax, factMean,
        rName: rankByScore(nameScore),
        rDesc: descScore ? rankByScore(descScore) : undefined,
        rBm25: bm25Score ? rankByScore(bm25Score, 0) : undefined,
        rFactMax: factMax ? rankByScore(factMax, -Infinity) : undefined,
        rFactMean: factMean ? rankByScore(factMean, -Infinity) : undefined,
      };

      for (const a of cfg.arms) {
        const ranking = armDefs.get(a)!.fn(d0);
        strictRank[a]!.push(strictRankOf(ranking, t));
        condRank[a]!.push(condensedRankOf(ranking, t, r));
        if (degArmDef && a === cfg.degeneracyArm) {
          const aTop = new Set(ranking.slice(0, 10));
          const nTop = new Set(d0.rName.slice(0, 10));
          let same = aTop.size === nTop.size;
          if (same) for (const x of aTop) if (!nTop.has(x)) { same = false; break; }
          degenEq.push(same ? 1 : 0);
        }
      }

      if (keepBR) {
        brName.push(d0.rName);
        if (d0.rDesc) brDesc.push(d0.rDesc);
        if (d0.rBm25) brBm25.push(d0.rBm25);
        if (d0.rFactMax) brFactMax.push(d0.rFactMax);
        if (d0.rFactMean) brFactMean.push(d0.rFactMean);
      }
      corpusOf.push(c); entityOf.push(p.entityId); docOf.push(p.docId); targetIdx.push(t);
    }
  }

  const n = strictRank[cfg.arms[0]!]!.length;
  if (n !== sub.pairs.length) {
    console.log(`=== WARNING: ${sub.pairs.length - n} of ${sub.pairs.length} pairs skipped (target entity absent from entities table); all metrics + bootstraps cover the ${n} scored pairs ===`);
  }
  // cluster keys align to the n SCORED pairs (not sub.pairs), so byPair never
  // indexes past the hit vectors even when a target entity is missing.
  const pairKeys = corpusOf.map((_, i) => String(i));
  const hitStrict = (arm: string, k: number): number[] => strictRank[arm]!.map((rk) => (rk <= k ? 1 : 0));
  const hitCond = (arm: string, k: number): number[] => condRank[arm]!.map((rk) => (rk <= k ? 1 : 0));
  const tri = (a: number[], b: number[]): TriResult => ({
    byPair: clusteredBootstrap(a, b, pairKeys),
    byEntity: clusteredBootstrap(a, b, entityOf),
    byDocument: clusteredBootstrap(a, b, docOf),
  });
  const armStrictR = (k: number): Record<string, number> => Object.fromEntries(cfg.arms.map((a) => [a, mean(hitStrict(a, k))]));
  const armCondR = (k: number): Record<string, number> => Object.fromEntries(cfg.arms.map((a) => [a, mean(hitCond(a, k))]));

  // ---- arm table ----
  console.log('');
  console.log('| arm | strict R@10 | condensed R@10 |');
  console.log('|-----|-------------|----------------|');
  for (const a of cfg.arms) console.log(`| ${a.padEnd(8)} | ${mean(hitStrict(a, 10)).toFixed(4)} | ${mean(hitCond(a, 10)).toFixed(4)} |`);

  // ---- strict regression gate ----
  if (cfg.regression) {
    console.log('');
    console.log('=== STRICT REGRESSION GATE ===');
    const fails: string[] = [];
    for (const [arm, target] of Object.entries(cfg.regression.targets)) {
      const v = mean(hitStrict(arm, 10));
      console.log(`  ${arm} strict R@10 = ${v}  (target ${target})`);
      if (Math.abs(v - target) >= 1e-9) fails.push(`${arm} strict R@10 mismatch`);
    }
    if (cfg.regression.n !== undefined) {
      console.log(`  n = ${n}  (target ${cfg.regression.n})`);
      if (n !== cfg.regression.n) fails.push(`n=${n} != ${cfg.regression.n}`);
    }
    if (fails.length) { console.log('=== VOID: regression gate failed ==='); for (const f of fails) console.log(`  ${f}`); process.exit(1); }
    console.log('  GATE PASSED.');
  }

  // ---- degeneracy guard ----
  let degeneracyOverlap: number | undefined;
  if (cfg.degeneracyArm) {
    degeneracyOverlap = mean(degenEq);
    console.log('');
    console.log(`arm-identity degeneracy: ${cfg.degeneracyArm} top-10 == NAME top-10 for ${(degeneracyOverlap * 100).toFixed(1)}% of pairs` +
      (degeneracyOverlap > 0.95 ? '  >>> DEGENERATE' : ''));
  }

  // ---- non-trivial guard (arm R@10 strictly in (0,1)) ----
  for (const a of cfg.arms) { const v = mean(hitStrict(a, 10)); if (v <= 0 || v >= 1) console.log(`=== SUSPECT: ${a} strict R@10 = ${v} (0/1) — verify ===`); }

  const result: EvalResult = {
    n, arms: [...cfg.arms], strictRank, condRank, corpusOf, entityOf, docOf, pairKeys, targetIdx,
    sub, rel, store, factStateByCorpus,
    hitStrict, hitCond, tri, armStrictR, armCondR,
    degeneracyOverlap,
  };
  if (keepBR) {
    result.baseRankings = {
      rName: brName,
      ...(useDesc ? { rDesc: brDesc } : {}),
      ...(useBm25 ? { rBm25: brBm25 } : {}),
      ...(useFacts ? { rFactMax: brFactMax, rFactMean: brFactMean } : {}),
    };
  }
  if (useFacts) { result.targetFactCount = targetFactCount; result.pairsWithExclusion = pairsWithExclusion; result.noEligibleFact = noEligibleFact; }
  return result;
}
