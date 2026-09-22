/**
 * I4 "causal pass-through" — doc 44 pre-registration.
 *
 * Question: on Graph C's OWN asserted cause->effect pairs, does deterministic
 * retrieval already surface the cause when given the effect?
 *
 * ONE-DIRECTIONAL (doc 44 §6): a high recall CLOSES I4-as-retrieval; a low
 * recall is UNRESOLVED and must NOT be read as validating the causal layer.
 *
 * Arms: A1 dense-fact (cosine over stored fact_embedding), A2 BM25 over
 * source_text, A3 RRF-60(A1,A2), A4 random. Pool = all embedded+texted facts in
 * the same corpus_id, effect fact excluded from its own pool.
 *
 * Zero cost: no LLM calls, no new embeddings. SELECT-only.
 *
 * Uses postgres.js DIRECTLY rather than db/raw.ts::rawQuery, because rawQuery
 * rewrites snake_case keys to camelCase and would silently empty fields
 * (doc 44 §8 item 7).
 */

import postgres from 'postgres';
import { writeFileSync } from 'node:fs';
import { buildBm25, bm25Scores, type Bm25Index } from './retrieval-eval/core.js';
import { reciprocalRankFusion } from '../../services/fusion.js';

const RRF_K = 60;
const CLAIMABLE = new Set(['dal-cv', 'dal-nlp']);
const BAR = 0.70;

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL required');
const sql = postgres(DB, { max: 2, idle_timeout: 20 });

type EdgeRow = {
  edge_id: string; corpus_id: string;
  cause_fact: string; effect_fact: string; same_subj: boolean;
};
type PoolRow = { id: string; source_text: string; emb: string };

type Pool = {
  ids: string[];
  index: Map<string, number>;
  texts: string[];
  vecs: Float32Array;      // flat, n * dim, L2-normalised
  dim: number;
  bm25: Bm25Index;
};

function parseVec(s: string): number[] {
  // pgvector text form: "[0.1,-0.2,...]"
  const v = JSON.parse(s) as number[];
  return v;
}

function normaliseInto(target: Float32Array, offset: number, v: number[]): void {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n);
  const inv = n > 0 ? 1 / n : 0;
  for (let i = 0; i < v.length; i++) target[offset + i] = v[i]! * inv;
}

/** Rank of `gold` in a score array, descending. Returns [optimistic, pessimistic].
 *  optimistic = 1 + #{strictly better};  pessimistic = #{better or equal}. */
function rankFromScores(scores: Float64Array, gold: number, skip: number): [number, number] {
  const g = scores[gold]!;
  let better = 0, equal = 0;
  for (let i = 0; i < scores.length; i++) {
    if (i === skip || i === gold) continue;
    const s = scores[i]!;
    if (s > g) better++;
    else if (s === g) equal++;
  }
  return [better + 1, better + equal + 1];
}

/** Descending ranking of indices with score > 0, tie-break by ascending index
 *  (the frozen house order — see retrieval-eval/core.ts rankByScore). */
function retrievedSet(scores: Float64Array | number[], skip: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (i === skip) continue;
    if ((scores[i] as number) > 0) out.push(i);
  }
  out.sort((a, b) => ((scores[b] as number) - (scores[a] as number)) || (a - b));
  return out;
}

async function loadPool(corpus: string): Promise<Pool> {
  const rows = await sql<PoolRow[]>`
    SELECT id::text AS id, source_text, fact_embedding::text AS emb
    FROM facts
    WHERE corpus_id = ${corpus}
      AND fact_embedding IS NOT NULL
      AND source_text IS NOT NULL AND btrim(source_text) <> ''
    ORDER BY id`;
  if (rows.length === 0) throw new Error(`empty pool for ${corpus}`);
  const first = parseVec(rows[0]!.emb);
  const dim = first.length;
  const vecs = new Float32Array(rows.length * dim);
  const ids: string[] = [];
  const texts: string[] = [];
  const index = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const v = parseVec(r.emb);
    if (v.length !== dim) throw new Error(`dim mismatch in ${corpus}: ${v.length} vs ${dim}`);
    normaliseInto(vecs, i * dim, v);
    ids.push(r.id);
    texts.push(r.source_text);
    index.set(r.id, i);
  }
  return { ids, index, texts, vecs, dim, bm25: buildBm25(texts) };
}

function cosineAll(pool: Pool, qIdx: number): Float64Array {
  const { vecs, dim, ids } = pool;
  const out = new Float64Array(ids.length);
  const qOff = qIdx * dim;
  for (let d = 0; d < ids.length; d++) {
    const off = d * dim;
    let s = 0;
    for (let k = 0; k < dim; k++) s += vecs[qOff + k]! * vecs[off + k]!;
    out[d] = s;
  }
  return out;
}

type Rec = {
  edge_id: string; corpus_id: string; stratum: 'S' | 'D';
  dense_opt: number; dense_pess: number;
  bm25_opt: number | null;          // null = gold not in BM25 retrieved set
  rrf_opt: number | null;
  pool_n: number;
};

async function main(): Promise<void> {
  const edges = await sql<EdgeRow[]>`
    SELECT e.id::text AS edge_id, ce.corpus_id,
           ce.fact_id::text AS cause_fact, ee.fact_id::text AS effect_fact,
           (fc.subject_entity_id IS NOT DISTINCT FROM fe.subject_entity_id) AS same_subj
    FROM causal_edges e
    JOIN causal_events ce ON ce.id = e.cause_event_id
    JOIN causal_events ee ON ee.id = e.effect_event_id
    JOIN facts fc ON fc.id = ce.fact_id
    JOIN facts fe ON fe.id = ee.fact_id
    ORDER BY ce.corpus_id, e.id`;
  console.log(`edges: ${edges.length}`);

  const corpora = [...new Set(edges.map((e) => e.corpus_id))];
  const pools = new Map<string, Pool>();
  for (const c of corpora) {
    const p = await loadPool(c);
    pools.set(c, p);
    console.log(`pool ${c}: ${p.ids.length} facts, dim ${p.dim}`);
  }

  const recs: Rec[] = [];
  let done = 0;
  for (const e of edges) {
    const pool = pools.get(e.corpus_id)!;
    const gi = pool.index.get(e.cause_fact);
    const ei = pool.index.get(e.effect_fact);
    if (gi === undefined) throw new Error(`gold cause ${e.cause_fact} not in pool (§8.1)`);
    if (ei === undefined) throw new Error(`effect ${e.effect_fact} not in pool`);
    if (gi === ei) throw new Error(`cause === effect fact on edge ${e.edge_id} (§8.4)`);

    const dense = cosineAll(pool, ei);
    const [dOpt, dPess] = rankFromScores(dense, gi, ei);

    const bScores = bm25Scores(pool.bm25, pool.texts[ei]!);
    const bSet = retrievedSet(bScores, ei);
    const bPos = bSet.indexOf(gi);
    const bOpt = bPos >= 0 ? bPos + 1 : null;

    // A3: retrieved-set RRF-60 over the dense full ranking and the BM25
    // retrieved set. Dense gets the full pool (most generous to fusion).
    const dSet = retrievedSet(dense, ei);
    const fused = reciprocalRankFusion([dSet, bSet], { k: RRF_K, tieBreak: (a, b) => a - b });
    const fPos = fused.indexOf(gi);
    const fOpt = fPos >= 0 ? fPos + 1 : null;

    recs.push({
      edge_id: e.edge_id, corpus_id: e.corpus_id,
      stratum: e.same_subj ? 'S' : 'D',
      dense_opt: dOpt, dense_pess: dPess,
      bm25_opt: bOpt, rrf_opt: fOpt,
      pool_n: pool.ids.length,
    });
    if (++done % 200 === 0) console.log(`  scored ${done}/${edges.length}`);
  }

  const recallAt = (rs: (number | null)[], k: number): number =>
    rs.filter((r) => r !== null && r <= k).length / rs.length;
  const median = (rs: (number | null)[]): number | null => {
    const v = rs.filter((r): r is number => r !== null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)]! : null;
  };

  const report = (label: string, subset: Rec[]) => {
    if (subset.length === 0) return null;
    const d = subset.map((r) => r.dense_opt);
    const dp = subset.map((r) => r.dense_pess);
    const b = subset.map((r) => r.bm25_opt);
    const f = subset.map((r) => r.rrf_opt);
    const row = {
      label, n: subset.length,
      dense: { r1: recallAt(d, 1), r5: recallAt(d, 5), r10: recallAt(d, 10), r20: recallAt(d, 20), r10_pess: recallAt(dp, 10), med: median(d) },
      bm25: { r10: recallAt(b, 10), r20: recallAt(b, 20), med: median(b), retrieved: b.filter((x) => x !== null).length },
      rrf: { r1: recallAt(f, 1), r5: recallAt(f, 5), r10: recallAt(f, 10), r20: recallAt(f, 20), med: median(f) },
    };
    console.log(
      `${label.padEnd(18)} n=${String(row.n).padStart(4)}  ` +
      `DENSE r@10=${row.dense.r10.toFixed(4)} (med ${row.dense.med})  ` +
      `BM25 r@10=${row.bm25.r10.toFixed(4)} (med ${row.bm25.med})  ` +
      `RRF r@10=${row.rrf.r10.toFixed(4)} (med ${row.rrf.med})`,
    );
    return row;
  };

  console.log('\n=== BY CORPUS x STRATUM ===');
  const rows: unknown[] = [];
  for (const c of corpora) {
    for (const s of ['D', 'S'] as const) {
      rows.push(report(`${c}/${s}`, recs.filter((r) => r.corpus_id === c && r.stratum === s)));
    }
  }
  console.log('\n=== POOLED BY STRATUM ===');
  for (const s of ['D', 'S'] as const) rows.push(report(`ALL/${s}`, recs.filter((r) => r.stratum === s)));

  console.log(`\n=== THE BAR (doc 44 §6): stratum D, best of DENSE/RRF vs ${BAR} ===`);
  const verdicts: Record<string, { n: number; dense: number; rrf: number; best: number; clears: boolean }> = {};
  for (const c of corpora) {
    if (!CLAIMABLE.has(c)) continue;
    const sub = recs.filter((r) => r.corpus_id === c && r.stratum === 'D');
    const dr = recallAt(sub.map((r) => r.dense_opt), 10);
    const fr = recallAt(sub.map((r) => r.rrf_opt), 10);
    const best = Math.max(dr, fr);
    verdicts[c] = { n: sub.length, dense: dr, rrf: fr, best, clears: best >= BAR };
    console.log(`  ${c}: n=${sub.length} dense=${dr.toFixed(4)} rrf=${fr.toFixed(4)} best=${best.toFixed(4)} -> ${best >= BAR ? 'CLEARS' : 'BELOW'} ${BAR}`);
  }
  const allClear = Object.values(verdicts).every((v) => v.clears) && Object.keys(verdicts).length === 2;
  console.log(`\nOUTCOME: ${allClear ? 'CLOSE (I4-as-retrieval retired)' : 'UNRESOLVED (NOT a positive — doc 44 §6 forbidden inference applies)'}`);

  const out = {
    doc: '44-i4-causal-passthrough-prereg.md',
    run_at: new Date().toISOString(),
    bar: BAR, rrf_k: RRF_K,
    edges: edges.length,
    pools: Object.fromEntries([...pools].map(([k, v]) => [k, v.ids.length])),
    rows: rows.filter(Boolean),
    verdicts, outcome: allClear ? 'CLOSE' : 'UNRESOLVED',
    per_edge: recs,
  };
  const path = '../docs/architecture/single-graph/prereg-artifacts/i4-passthrough-results.json';
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path}`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
