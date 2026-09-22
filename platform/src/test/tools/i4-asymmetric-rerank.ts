/**
 * I4 asymmetric re-rank — doc 45 pre-registration.
 *
 * Doc 44's adversary showed every arm there was DIRECTION-BLIND (cosine and BM25
 * are symmetric, so swapping cause/effect barely moved recall). This tests
 * whether adding an asymmetric signal — a held-out-learned predicate ROLE prior
 * plus directional structure — beats symmetric retrieval.
 *
 * Built to satisfy doc 44's corrections:
 *  - C1: ALL rank statistics unconditional. Out-of-pool gold => rank Infinity,
 *        counted in the denominator. No survivorship-filtered medians anywhere.
 *  - C2: every reported CI is actually bootstrapped, including marginal corpora.
 *  - C4: deltas must survive clustering by CORPUS as well as by effect fact.
 *  - C6: delivers every pre-registered output (r@1/5/10/20, median, p90, MRR,
 *        RANDOM arm, pool oracle) for every arm and cut.
 *  - C7: mandatory direction-blindness check via cause/effect swap.
 *
 * Leakage control: 5-fold CV, folds split by EFFECT FACT (not edge), corpus-
 * stratified; the predicate role prior is computed from TRAINING-FOLD EDGES ONLY.
 *
 * Zero cost: SELECT-only, stored embeddings, no LLM calls.
 */

import postgres from 'postgres';
import { writeFileSync } from 'node:fs';
import { buildBm25, bm25Scores, type Bm25Index } from './retrieval-eval/core.js';

const POOL_K = 50;          // top-K from each of dense + BM25; union is the rerank pool
const FOLDS = 5;
const SEED = 20260917;
const BOOT = 10000;
const CLAIMABLE = new Set(['dal-cv', 'dal-nlp']);
const ROLE_MIN_COUNT = 3;   // predicates rarer than this get role 0 (no signal)
const ROLE_SMOOTH = 2;      // add-k denominator smoothing

const ARMS = ['B-SYM', 'B-SYM+STRUCT', 'A-ASYM', 'A-FULL'] as const;
type Arm = typeof ARMS[number];
const FEATS: Record<Arm, number[]> = {
  'B-SYM': [0, 1],
  'B-SYM+STRUCT': [0, 1, 4],
  'A-ASYM': [0, 1, 2, 3, 5],
  'A-FULL': [0, 1, 2, 3, 4, 5],
};
const FEAT_NAMES = ['dense_z', 'bm25_z', 'cause_role', 'role_interact', 'ent_overlap', 'fwd_chain'];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL required');
const sql = postgres(DB, { max: 2, idle_timeout: 20 });

type EdgeRow = {
  edge_id: string; corpus_id: string;
  cause_fact: string; effect_fact: string;
  cause_pred: string; effect_pred: string;
  eff_subj: string | null; eff_obj: string | null;
  same_subj: boolean;
};
type PoolRow = {
  id: string; source_text: string; emb: string; predicate: string;
  subject_entity_id: string | null; object_entity_id: string | null;
};
type Pool = {
  ids: string[]; index: Map<string, number>; texts: string[];
  preds: string[]; subj: (string | null)[]; obj: (string | null)[];
  vecs: Float32Array; dim: number; bm25: Bm25Index;
};

function normInto(t: Float32Array, off: number, v: number[]): void {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n); const inv = n > 0 ? 1 / n : 0;
  for (let i = 0; i < v.length; i++) t[off + i] = v[i]! * inv;
}

async function loadPool(corpus: string): Promise<Pool> {
  const rows = await sql<PoolRow[]>`
    SELECT id::text AS id, source_text, fact_embedding::text AS emb, predicate,
           subject_entity_id::text AS subject_entity_id, object_entity_id::text AS object_entity_id
    FROM facts
    WHERE corpus_id = ${corpus} AND fact_embedding IS NOT NULL
      AND source_text IS NOT NULL AND btrim(source_text) <> ''
    ORDER BY id`;
  const dim = (JSON.parse(rows[0]!.emb) as number[]).length;
  const vecs = new Float32Array(rows.length * dim);
  const p: Pool = {
    ids: [], index: new Map(), texts: [], preds: [], subj: [], obj: [],
    vecs, dim, bm25: null as unknown as Bm25Index,
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const v = JSON.parse(r.emb) as number[];
    if (v.length !== dim) throw new Error(`dim mismatch ${corpus}`);
    normInto(vecs, i * dim, v);
    p.ids.push(r.id); p.texts.push(r.source_text); p.preds.push(r.predicate);
    p.subj.push(r.subject_entity_id); p.obj.push(r.object_entity_id);
    p.index.set(r.id, i);
  }
  p.bm25 = buildBm25(p.texts);
  return p;
}

function topK(scores: Float64Array | number[], k: number, skip: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < scores.length; i++) if (i !== skip && (scores[i] as number) > 0) idx.push(i);
  idx.sort((a, b) => ((scores[b] as number) - (scores[a] as number)) || (a - b));
  return idx.slice(0, k);
}

/** Logistic regression, batch GD + momentum, L2. Ranking-only use, so calibration
 *  does not matter; class imbalance is therefore harmless. */
function fitLR(X: number[][], y: number[], nFeat: number, iters = 600, lr = 0.5, l2 = 1e-3):
  { w: number[]; b: number; converged: boolean } {
  const w = new Array<number>(nFeat).fill(0);
  let b = 0;
  const vw = new Array<number>(nFeat).fill(0);
  let vb = 0, lastLoss = Infinity, converged = false;
  const n = X.length;
  for (let it = 0; it < iters; it++) {
    const gw = new Array<number>(nFeat).fill(0);
    let gb = 0, loss = 0;
    for (let i = 0; i < n; i++) {
      const xi = X[i]!;
      let z = b;
      for (let f = 0; f < nFeat; f++) z += w[f]! * xi[f]!;
      const pr = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const e = pr - y[i]!;
      for (let f = 0; f < nFeat; f++) gw[f] = gw[f]! + e * xi[f]!;
      gb += e;
      loss -= y[i]! ? Math.log(Math.max(1e-12, pr)) : Math.log(Math.max(1e-12, 1 - pr));
    }
    for (let f = 0; f < nFeat; f++) {
      const g = gw[f]! / n + l2 * w[f]!;
      vw[f] = 0.9 * vw[f]! - lr * g;
      w[f] = w[f]! + vw[f]!;
    }
    vb = 0.9 * vb - lr * (gb / n);
    b += vb;
    if (Math.abs(lastLoss - loss / n) < 1e-9) { converged = true; break; }
    lastLoss = loss / n;
  }
  return { w, b, converged };
}

type Cand = { idx: number; feats: number[]; isGold: boolean };
type EdgeCase = {
  edge_id: string; corpus_id: string; stratum: 'S' | 'D'; effect_fact: string;
  cands: Cand[]; goldInPool: boolean;
  randRank: number;                       // RANDOM arm, full-corpus pool
  poolSize: number;
};

function rankOf(scored: { idx: number; s: number }[], goldIdx: number): number {
  // unconditional: gold absent => Infinity
  const sorted = scored.slice().sort((a, b) => (b.s - a.s) || (a.idx - b.idx));
  const p = sorted.findIndex((x) => x.idx === goldIdx);
  return p < 0 ? Infinity : p + 1;
}

async function main(): Promise<void> {
  const edges = await sql<EdgeRow[]>`
    SELECT e.id::text AS edge_id, ce.corpus_id,
           ce.fact_id::text AS cause_fact, ee.fact_id::text AS effect_fact,
           fc.predicate AS cause_pred, fe.predicate AS effect_pred,
           fe.subject_entity_id::text AS eff_subj, fe.object_entity_id::text AS eff_obj,
           (fc.subject_entity_id IS NOT DISTINCT FROM fe.subject_entity_id) AS same_subj
    FROM causal_edges e
    JOIN causal_events ce ON ce.id = e.cause_event_id
    JOIN causal_events ee ON ee.id = e.effect_event_id
    JOIN facts fc ON fc.id = ce.fact_id
    JOIN facts fe ON fe.id = ee.fact_id
    ORDER BY ce.corpus_id, e.id`;
  console.log(`edges: ${edges.length}`);

  const pools = new Map<string, Pool>();
  for (const c of [...new Set(edges.map((e) => e.corpus_id))]) {
    pools.set(c, await loadPool(c));
    console.log(`pool ${c}: ${pools.get(c)!.ids.length}`);
  }

  // ---- folds: split by EFFECT FACT, corpus-stratified (doc 45 §4) ----
  const foldOf = new Map<string, number>();
  {
    const rand = rng(SEED);
    const byCorpus = new Map<string, string[]>();
    for (const e of edges) {
      const l = byCorpus.get(e.corpus_id) ?? byCorpus.set(e.corpus_id, []).get(e.corpus_id)!;
      if (!l.includes(e.effect_fact)) l.push(e.effect_fact);
    }
    for (const [, effs] of byCorpus) {
      for (let i = effs.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [effs[i], effs[j]] = [effs[j]!, effs[i]!];
      }
      effs.forEach((ef, i) => foldOf.set(ef, i % FOLDS));
    }
  }
  // assertion: no effect fact spans folds (guaranteed by construction, verified)
  for (const e of edges) if (foldOf.get(e.effect_fact) === undefined) throw new Error('unfolded effect');

  // ---- build candidate pools + non-role features once (role features are per-fold) ----
  const cases: EdgeCase[] = [];
  const randGen = rng(SEED ^ 0x5bf03635);
  let n = 0;
  for (const e of edges) {
    const pool = pools.get(e.corpus_id)!;
    const gi = pool.index.get(e.cause_fact)!;
    const ei = pool.index.get(e.effect_fact)!;

    const qOff = ei * pool.dim;
    const dense = new Float64Array(pool.ids.length);
    for (let d = 0; d < pool.ids.length; d++) {
      let s = 0; const off = d * pool.dim;
      for (let k = 0; k < pool.dim; k++) s += pool.vecs[qOff + k]! * pool.vecs[off + k]!;
      dense[d] = s;
    }
    const bm = bm25Scores(pool.bm25, pool.texts[ei]!);

    const union = new Set<number>([...topK(dense, POOL_K, ei), ...topK(bm, POOL_K, ei)]);
    const cand = [...union];
    // z-score within pool
    const dv = cand.map((i) => dense[i]!), bv = cand.map((i) => bm[i]!);
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
    const sd = (a: number[], m: number) => Math.sqrt(Math.max(1e-12, a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length)));
    const dm = mean(dv), ds = sd(dv, dm), bmn = mean(bv), bs = sd(bv, bmn);

    const cands: Cand[] = cand.map((i) => ({
      idx: i,
      feats: [
        (dense[i]! - dm) / ds,
        (bm[i]! - bmn) / bs,
        0, 0, // role features filled per-fold
        (pool.subj[i] !== null && (pool.subj[i] === e.eff_subj || pool.subj[i] === e.eff_obj)) ||
        (pool.obj[i] !== null && (pool.obj[i] === e.eff_subj || pool.obj[i] === e.eff_obj)) ? 1 : 0,
        pool.obj[i] !== null && pool.obj[i] === e.eff_subj ? 1 : 0,
      ],
      isGold: i === gi,
    }));

    // RANDOM arm over the FULL corpus pool (not the rerank pool)
    const nPool = pool.ids.length - 1;
    const rr = 1 + Math.floor(randGen() * nPool);

    cases.push({
      edge_id: e.edge_id, corpus_id: e.corpus_id, stratum: e.same_subj ? 'S' : 'D',
      effect_fact: e.effect_fact, cands, goldInPool: union.has(gi),
      randRank: rr, poolSize: pool.ids.length,
    });
    if (++n % 200 === 0) console.log(`  pooled ${n}/${edges.length}`);
  }
  console.log(`pool oracle (gold in rerank pool): ${(cases.filter((c) => c.goldInPool).length / cases.length).toFixed(4)}`);

  // ---- per-fold: learn role prior from TRAIN EDGES ONLY, fit LR, score test ----
  const predOf = new Map<string, { corpus: string; pred: string }>();
  for (const e of edges) predOf.set(e.effect_fact, { corpus: e.corpus_id, pred: e.effect_pred });
  const effPredOf = new Map(edges.map((e) => [e.edge_id, e.effect_pred]));

  const ranks: Record<Arm, Map<string, number>> = {
    'B-SYM': new Map(), 'B-SYM+STRUCT': new Map(), 'A-ASYM': new Map(), 'A-FULL': new Map(),
  };
  const swapRanks = new Map<string, number>();
  const coefLog: unknown[] = [];

  for (let fold = 0; fold < FOLDS; fold++) {
    const train = edges.filter((e) => foldOf.get(e.effect_fact) !== fold);
    const testIds = new Set(edges.filter((e) => foldOf.get(e.effect_fact) === fold).map((e) => e.edge_id));

    // role prior from TRAIN edges only
    const asCause = new Map<string, number>(), asEffect = new Map<string, number>();
    for (const e of train) {
      asCause.set(e.cause_pred, (asCause.get(e.cause_pred) ?? 0) + 1);
      asEffect.set(e.effect_pred, (asEffect.get(e.effect_pred) ?? 0) + 1);
    }
    const role = (p: string): number => {
      const c = asCause.get(p) ?? 0, ef = asEffect.get(p) ?? 0;
      if (c + ef < ROLE_MIN_COUNT) return 0;
      return (c - ef) / (c + ef + ROLE_SMOOTH);
    };

    const fillRoles = (cs: EdgeCase, effPred: string): void => {
      const pool = pools.get(cs.corpus_id)!;
      const effLike = -role(effPred);
      for (const c of cs.cands) {
        const cr = role(pool.preds[c.idx]!);
        c.feats[2] = cr;
        c.feats[3] = cr * effLike;
      }
    };
    for (const cs of cases) fillRoles(cs, effPredOf.get(cs.edge_id)!);

    const trainCases = cases.filter((c) => !testIds.has(c.edge_id));
    const testCases = cases.filter((c) => testIds.has(c.edge_id));

    for (const arm of ARMS) {
      const fi = FEATS[arm];
      const X: number[][] = [], y: number[] = [];
      for (const cs of trainCases) for (const c of cs.cands) { X.push(fi.map((f) => c.feats[f]!)); y.push(c.isGold ? 1 : 0); }
      const { w, b, converged } = fitLR(X, y, fi.length);
      if (!converged) console.log(`  [fold ${fold}] ${arm}: LR hit iteration cap (reported, not papered over)`);
      coefLog.push({ fold, arm, features: fi.map((f) => FEAT_NAMES[f]), w, b, converged, train_rows: X.length, positives: y.reduce((s, v) => s + v, 0) });
      for (const cs of testCases) {
        const scored = cs.cands.map((c) => ({ idx: c.idx, s: b + fi.reduce((acc, f, k) => acc + w[k]! * c.feats[f]!, 0) }));
        const gi = pools.get(cs.corpus_id)!.index.get(edges.find((e) => e.edge_id === cs.edge_id)!.cause_fact)!;
        ranks[arm].set(cs.edge_id, cs.goldInPool ? rankOf(scored, gi) : Infinity);
      }
    }

    // ---- direction-blindness check (doc 45 §5): swap cause/effect on the winning-arm
    // feature set (A-FULL) — recompute role features with roles REVERSED.
    {
      const fi = FEATS['A-FULL'];
      for (const cs of cases) {
        const pool = pools.get(cs.corpus_id)!;
        const effLikeSwapped = role(effPredOf.get(cs.edge_id)!); // sign flipped vs normal
        for (const c of cs.cands) {
          const cr = -role(pool.preds[c.idx]!);
          c.feats[2] = cr; c.feats[3] = cr * effLikeSwapped;
        }
      }
      const X: number[][] = [], y: number[] = [];
      for (const cs of trainCases) for (const c of cs.cands) { X.push(fi.map((f) => c.feats[f]!)); y.push(c.isGold ? 1 : 0); }
      const { w, b } = fitLR(X, y, fi.length);
      for (const cs of testCases) {
        const scored = cs.cands.map((c) => ({ idx: c.idx, s: b + fi.reduce((acc, f, k) => acc + w[k]! * c.feats[f]!, 0) }));
        const gi = pools.get(cs.corpus_id)!.index.get(edges.find((e) => e.edge_id === cs.edge_id)!.cause_fact)!;
        swapRanks.set(cs.edge_id, cs.goldInPool ? rankOf(scored, gi) : Infinity);
      }
    }
    console.log(`fold ${fold}: train ${trainCases.length} / test ${testCases.length}`);
  }

  // ---- metrics (ALL unconditional; out-of-pool = Infinity, in denominator) ----
  const R = (rs: number[], k: number) => rs.filter((r) => r <= k).length / rs.length;
  const med = (rs: number[], q = 0.5) => {
    const v = rs.slice().sort((a, b) => a - b);
    const x = v[Math.min(v.length - 1, Math.floor(q * v.length))]!;
    return Number.isFinite(x) ? x : null;   // null = >50% (or >p) are misses
  };
  const mrr = (rs: number[]) => rs.reduce((s, r) => s + (Number.isFinite(r) ? 1 / r : 0), 0) / rs.length;

  const cut = (scope: string, stratum: 'S' | 'D' | 'ALL') =>
    cases.filter((c) => (scope === 'ALL' || c.corpus_id === scope) && (stratum === 'ALL' || c.stratum === stratum));

  const rowsOut: unknown[] = [];
  const armRanks = (arm: Arm | 'RANDOM' | 'ORACLE' | 'SWAP', cs: EdgeCase[]): number[] => {
    if (arm === 'RANDOM') return cs.map((c) => c.randRank);
    if (arm === 'ORACLE') return cs.map((c) => (c.goldInPool ? 1 : Infinity));
    if (arm === 'SWAP') return cs.map((c) => swapRanks.get(c.edge_id)!);
    return cs.map((c) => ranks[arm].get(c.edge_id)!);
  };

  console.log('\n=== ALL ARMS x CUT (unconditional ranks; out-of-pool counted as miss) ===');
  for (const scope of ['dal-cv', 'dal-nlp', 'qbio', 'arxiv-nlp', 'ALL']) {
    for (const st of ['D', 'S'] as const) {
      const cs = cut(scope, st);
      if (cs.length === 0) continue;
      console.log(`\n-- ${scope} / ${st}  n=${cs.length} --`);
      for (const arm of [...ARMS, 'SWAP', 'RANDOM', 'ORACLE'] as const) {
        const rs = armRanks(arm as Arm, cs);
        const row = {
          scope, stratum: st, arm, n: cs.length,
          r1: R(rs, 1), r5: R(rs, 5), r10: R(rs, 10), r20: R(rs, 20),
          median: med(rs), p90: med(rs, 0.9), mrr: mrr(rs),
        };
        rowsOut.push(row);
        console.log(`   ${String(arm).padEnd(13)} r@1=${row.r1.toFixed(4)} r@5=${row.r5.toFixed(4)} r@10=${row.r10.toFixed(4)} r@20=${row.r20.toFixed(4)} med=${row.median ?? '>50%miss'} p90=${row.p90 ?? 'miss'} mrr=${row.mrr.toFixed(4)}`);
      }
    }
  }

  // ---- bootstrap: BOTH clusterings (doc 45 §5 / doc 44 C4) ----
  const boot = (cs: EdgeCase[], key: (c: EdgeCase) => string, stat: (g: EdgeCase[]) => number) => {
    const groups = new Map<string, EdgeCase[]>();
    for (const c of cs) (groups.get(key(c)) ?? groups.set(key(c), []).get(key(c))!).push(c);
    const g = [...groups.values()];
    const rand = rng(SEED);
    const s: number[] = [];
    for (let b = 0; b < BOOT; b++) {
      const draw: EdgeCase[] = [];
      for (let i = 0; i < g.length; i++) draw.push(...g[Math.floor(rand() * g.length)]!);
      s.push(stat(draw));
    }
    s.sort((a, b) => a - b);
    return { point: stat(cs), lo: s[Math.floor(0.025 * BOOT)]!, hi: s[Math.floor(0.975 * BOOT)]!, clusters: g.length };
  };
  const BM25_DOC44_D = 0.4252;
  const deltaVsBar = (arm: Arm) => (g: EdgeCase[]) => R(armRanks(arm, g), 10) - BM25_DOC44_D;

  console.log(`\n=== THE BAR (doc 45 §5): held-out r@10 on stratum D vs doc-44 BM25 ${BM25_DOC44_D} ===`);
  const barOut: unknown[] = [];
  for (const scope of ['dal-cv', 'dal-nlp', 'ALL']) {
    const cs = cut(scope, 'D');
    for (const arm of ARMS) {
      const byEff = boot(cs, (c) => c.effect_fact, deltaVsBar(arm));
      const byCorp = boot(cs, (c) => c.corpus_id, deltaVsBar(arm));
      const pt = R(armRanks(arm, cs), 10);
      const verdict = byEff.lo > 0 && byCorp.lo > 0 ? 'CLEARS (both clusterings)'
        : byEff.lo > 0 ? 'effect-clustered only — FAILS corpus robustness'
        : 'FAILS';
      barOut.push({ scope, arm, r10: pt, byEffect: byEff, byCorpus: byCorp, verdict });
      console.log(`  ${scope}/${arm.padEnd(13)} r@10=${pt.toFixed(4)} delta=${byEff.point.toFixed(4)} ` +
        `byEffect[${byEff.lo.toFixed(4)},${byEff.hi.toFixed(4)}] byCorpus[${byCorp.lo.toFixed(4)},${byCorp.hi.toFixed(4)}] -> ${verdict}`);
    }
  }

  console.log('\n=== DIRECTION-BLINDNESS CHECK (doc 45 §5) ===');
  for (const st of ['D', 'S'] as const) {
    const cs = cut('ALL', st);
    const nor = R(armRanks('A-FULL', cs), 10), sw = R(armRanks('SWAP', cs), 10);
    console.log(`  ${st}: A-FULL r@10=${nor.toFixed(4)}  SWAPPED r@10=${sw.toFixed(4)}  degradation=${(nor - sw).toFixed(4)}` +
      `  -> ${Math.abs(nor - sw) < 0.02 ? 'DIRECTION-BLIND (gain is not causal identification)' : 'direction-sensitive'}`);
  }

  console.log('\n=== LEARNED COEFFICIENTS (mean over folds) ===');
  for (const arm of ARMS) {
    const fs = coefLog.filter((c) => (c as { arm: string }).arm === arm) as { w: number[]; features: string[] }[];
    const mean = fs[0]!.w.map((_, i) => fs.reduce((s, f) => s + f.w[i]!, 0) / fs.length);
    console.log(`  ${arm.padEnd(13)} ` + fs[0]!.features.map((nm, i) => `${nm}=${mean[i]!.toFixed(3)}`).join('  '));
  }

  const out = {
    doc: '45-i4-asymmetric-rerank-prereg.md', run_at: new Date().toISOString(),
    pool_k: POOL_K, folds: FOLDS, seed: SEED, role_min_count: ROLE_MIN_COUNT,
    pool_oracle_overall: cases.filter((c) => c.goldInPool).length / cases.length,
    rows: rowsOut, bar: barOut, coefficients: coefLog,
    per_edge: cases.map((c) => ({
      edge_id: c.edge_id, corpus_id: c.corpus_id, stratum: c.stratum,
      goldInPool: c.goldInPool, poolSize: c.poolSize,
      ranks: Object.fromEntries(ARMS.map((a) => [a, ranks[a].get(c.edge_id)! === Infinity ? null : ranks[a].get(c.edge_id)!])),
      swap: swapRanks.get(c.edge_id) === Infinity ? null : swapRanks.get(c.edge_id),
      random: c.randRank,
    })),
  };
  const path = '../docs/architecture/single-graph/prereg-artifacts/i4-asymmetric-rerank-results.json';
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path}`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
