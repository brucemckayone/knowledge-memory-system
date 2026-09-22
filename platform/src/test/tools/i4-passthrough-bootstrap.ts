/**
 * Clustered bootstrap over the doc-44 pass-through per-edge ranks.
 *
 * Clustering is by EFFECT FACT (doc 44 §5) because one effect can carry several
 * causal edges; treating those as independent would understate the CI.
 *
 * The PRIMARY outcome (bar missed) needs no CI — it is missed by ~0.28 absolute.
 * This exists for the SECONDARY, EXPLORATORY comparison that the run surfaced
 * and that doc 44 did NOT pre-register as a hypothesis: BM25 vs DENSE.
 * Labelled exploratory in the write-up for exactly that reason.
 */

import postgres from 'postgres';
import { readFileSync } from 'node:fs';

type Rec = {
  edge_id: string; corpus_id: string; stratum: 'S' | 'D';
  dense_opt: number; bm25_opt: number | null; rrf_opt: number | null;
};

const B = 10000;
const SEED = 20260917;

// mulberry32 — deterministic, seeded
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

const hit = (r: number | null, k: number): number => (r !== null && r <= k ? 1 : 0);

function clusteredBootstrap(
  clusters: Rec[][],
  stat: (rs: Rec[]) => number,
): { point: number; lo: number; hi: number } {
  const flat = clusters.flat();
  const point = stat(flat);
  const rand = rng(SEED);
  const n = clusters.length;
  const samples = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    const draw: Rec[] = [];
    for (let i = 0; i < n; i++) draw.push(...clusters[Math.floor(rand() * n)]!);
    samples[b] = stat(draw);
  }
  const s = Array.from(samples).sort((a, b) => a - b);
  return { point, lo: s[Math.floor(0.025 * B)]!, hi: s[Math.floor(0.975 * B)]! };
}

async function main(): Promise<void> {
  const json = JSON.parse(
    readFileSync('../docs/architecture/single-graph/prereg-artifacts/i4-passthrough-results.json', 'utf8'),
  ) as { per_edge: Rec[] };
  const recs = json.per_edge;

  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
  const map = await sql<{ edge_id: string; effect_fact: string }[]>`
    SELECT e.id::text AS edge_id, ee.fact_id::text AS effect_fact
    FROM causal_edges e JOIN causal_events ee ON ee.id = e.effect_event_id`;
  const effectOf = new Map(map.map((r) => [r.edge_id, r.effect_fact]));
  await sql.end();

  const groupByEffect = (subset: Rec[]): Rec[][] => {
    const g = new Map<string, Rec[]>();
    for (const r of subset) {
      const key = effectOf.get(r.edge_id) ?? r.edge_id;
      (g.get(key) ?? g.set(key, []).get(key)!).push(r);
    }
    return [...g.values()];
  };

  const fmt = (x: { point: number; lo: number; hi: number }): string =>
    `${x.point >= 0 ? ' ' : ''}${x.point.toFixed(4)} [${x.lo.toFixed(4)}, ${x.hi.toFixed(4)}]`;

  for (const scope of ['dal-cv', 'dal-nlp', 'ALL'] as const) {
    for (const stratum of ['D', 'S'] as const) {
      const subset = recs.filter(
        (r) => r.stratum === stratum && (scope === 'ALL' || r.corpus_id === scope),
      );
      if (subset.length < 30) continue;
      const cl = groupByEffect(subset);
      const dense = clusteredBootstrap(cl, (rs) => rs.reduce((s, r) => s + hit(r.dense_opt, 10), 0) / rs.length);
      const bm25 = clusteredBootstrap(cl, (rs) => rs.reduce((s, r) => s + hit(r.bm25_opt, 10), 0) / rs.length);
      const rrf = clusteredBootstrap(cl, (rs) => rs.reduce((s, r) => s + hit(r.rrf_opt, 10), 0) / rs.length);
      const dBm = clusteredBootstrap(cl, (rs) =>
        rs.reduce((s, r) => s + hit(r.bm25_opt, 10) - hit(r.dense_opt, 10), 0) / rs.length);
      const dRrf = clusteredBootstrap(cl, (rs) =>
        rs.reduce((s, r) => s + hit(r.rrf_opt, 10) - hit(r.dense_opt, 10), 0) / rs.length);
      console.log(`\n--- ${scope} / stratum ${stratum}  (n=${subset.length} edges, ${cl.length} effect-clusters) ---`);
      console.log(`  DENSE r@10        ${fmt(dense)}`);
      console.log(`  BM25  r@10        ${fmt(bm25)}`);
      console.log(`  RRF   r@10        ${fmt(rrf)}`);
      console.log(`  BM25 - DENSE      ${fmt(dBm)}   ${dBm.lo > 0 ? 'ABOVE 0' : dBm.hi < 0 ? 'BELOW 0' : 'SPANS 0'}`);
      console.log(`  RRF  - DENSE      ${fmt(dRrf)}   ${dRrf.lo > 0 ? 'ABOVE 0' : dRrf.hi < 0 ? 'BELOW 0' : 'SPANS 0'}`);
      console.log(`  bar 0.70 vs best  best=${Math.max(dense.point, rrf.point).toFixed(4)} -> ${Math.max(dense.hi, rrf.hi) >= 0.70 ? 'CI TOUCHES BAR' : 'CI ENTIRELY BELOW BAR'}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
