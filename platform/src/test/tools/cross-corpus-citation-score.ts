/**
 * doc-30 — build the co-citation oracle, calibrate k (frozen rule), run void/independence checks,
 * then RE-SCORE the frozen doc-29 rankings (mechanical JOIN/EMB full-corpus; agent STRUCT/TEXT pool; free-nav)
 * against the co-citation oracle. 0 new LLM calls.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const SPLIT = new Set(['C204321447', 'C31972630']);
const load = <T,>(n: string): T => JSON.parse(readFileSync(join(OUT, n), 'utf8')) as T;
function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }

interface Doc { id: string; title: string; concepts: Array<{ id: string; level: number; score: number }>; }
const oracleAt = (d: Doc, L: number) => new Set(d.concepts.filter((c) => c.level >= Math.max(2, L) && c.score >= 0.3 && !SPLIT.has(c.id)).map((c) => c.id));

function main(): void {
  const A = load<Doc[]>('corpus-A.json'), B = load<Doc[]>('corpus-B.json');
  const cite = load<Record<string, string[]>>('cc-cociters.json');
  const seeded = load<Record<string, string[]>>('cc-seeded.json'), demb = load<Record<string, number[]>>('cc-docemb.json');
  const citersA = A.map((d) => new Set(cite[d.id] ?? [])), citersB = B.map((d) => new Set(cite[d.id] ?? []));
  const coCite = (i: number, j: number) => { let n = 0; const [s, l] = citersA[i]!.size < citersB[j]!.size ? [citersA[i]!, citersB[j]!] : [citersB[j]!, citersA[i]!]; for (const x of s) if (l.has(x)) n++; return n; };

  // ---- calibrate k on oracle distribution (frozen rule) ----
  const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
  let K = 0;
  const sweep: any[] = [];
  for (const k of [1, 2, 3]) {
    const counts = A.map((_, i) => B.filter((_, j) => coCite(i, j) >= k).length);
    const withRel = counts.filter((c) => c > 0).length;
    sweep.push({ k, medianRelated: median(counts), meanRelated: +(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1), queriesWithRel: `${withRel}/${A.length}`, pct: +(100 * withRel / A.length).toFixed(0) });
    if (!K && median(counts) >= 2 && withRel / A.length >= 0.5) K = k;
  }
  if (!K) K = 1; // fallback: sparsest usable
  const related = (i: number, j: number) => coCite(i, j) >= K;

  // ---- void check: overlap with topical L2 oracle ----
  const topRel = new Set<string>(), citeRel = new Set<string>();
  const oB2 = B.map((d) => oracleAt(d, 2)), oA2 = A.map((d) => oracleAt(d, 2));
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
    let t = false; for (const c of oA2[i]!) if (oB2[j]!.has(c)) { t = true; break; }
    if (t) topRel.add(`${i}:${j}`);
    if (related(i, j)) citeRel.add(`${i}:${j}`);
  }
  const inter = [...citeRel].filter((x) => topRel.has(x)).length;
  const jac = inter / (citeRel.size + topRel.size - inter);

  // ---- embedding-independence: mean cosine of co-cited pairs vs random ----
  const eA = A.map((d) => demb[`A:${d.id}`]!), eB = B.map((d) => demb[`B:${d.id}`]!);
  const coPairs = [...citeRel].map((x) => x.split(':').map(Number) as [number, number]);
  const meanCosCo = coPairs.length ? coPairs.reduce((s, [i, j]) => s + cosine(eA[i]!, eB[j]!), 0) / coPairs.length : 0;
  let sMean = 12345, rnd = () => { sMean = (sMean * 1103515245 + 12345) & 0x7fffffff; return sMean / 0x7fffffff; };
  let sc = 0; for (let n = 0; n < 2000; n++) sc += cosine(eA[Math.floor(rnd() * A.length)]!, eB[Math.floor(rnd() * B.length)]!);
  const meanCosRand = sc / 2000;

  // ---- score arms against co-citation oracle ----
  const nB = B.map((d) => new Set(seeded[`B:${d.id}`] ?? [])), nA = A.map((d) => new Set(seeded[`A:${d.id}`] ?? []));
  const df = new Map<string, number>(); [...nA, ...nB].forEach((cs) => cs.forEach((c) => df.set(c, (df.get(c) ?? 0) + 1)));
  const idf = (c: string) => Math.log((A.length + B.length) / (df.get(c) ?? 1));
  const joinScore = (i: number, j: number) => { let s = 0; for (const c of nA[i]!) if (nB[j]!.has(c)) s += idf(c); return s; };
  const recallK = (rk: number[], rel: Set<number>, k: number) => { if (!rel.size) return NaN; let h = 0; for (let i = 0; i < Math.min(k, rk.length); i++) if (rel.has(rk[i]!)) h++; return h / rel.size; };
  const precK = (rk: number[], rel: Set<number>, k: number) => { let h = 0; for (let i = 0; i < Math.min(k, rk.length); i++) if (rel.has(rk[i]!)) h++; return h / k; };
  const mrr = (rk: number[], rel: Set<number>) => { for (let i = 0; i < rk.length; i++) if (rel.has(rk[i]!)) return 1 / (i + 1); return 0; };
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  function bootCI(x: number[], y: number[]): [number, number] { const n = x.length; if (!n) return [0, 0]; const d: number[] = []; let s = 30000 + n; const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; for (let b = 0; b < 10000; b++) { let a = 0; for (let i = 0; i < n; i++) { const k = Math.floor(r() * n); a += x[k]! - y[k]!; } d.push(a / n); } d.sort((a, c) => a - c); return [d[250]!, d[9750]!]; }

  // PRIMARY: mechanical full-corpus JOIN vs EMB, all A-queries with >=1 co-related
  const qFull = A.map((_, i) => i).filter((i) => B.some((_, j) => related(i, j)));
  const relOf = (i: number) => new Set(B.map((_, j) => j).filter((j) => related(i, j)));
  const rankJoin = (i: number) => [...B.keys()].sort((x, y) => joinScore(i, y) - joinScore(i, x));
  const rankEmb = (i: number) => [...B.keys()].sort((x, y) => cosine(eA[i]!, eB[y]!) - cosine(eA[i]!, eB[x]!));
  const pj = qFull.map((i) => precK(rankJoin(i), relOf(i), 5)), pe = qFull.map((i) => precK(rankEmb(i), relOf(i), 5));
  const primary = {
    queries: qFull.length,
    precision5: { join: +mean(pj).toFixed(4), emb: +mean(pe).toFixed(4) },
    recall10: { join: +mean(qFull.map((i) => recallK(rankJoin(i), relOf(i), 10))).toFixed(4), emb: +mean(qFull.map((i) => recallK(rankEmb(i), relOf(i), 10))).toFixed(4) },
    mrr: { join: +mean(qFull.map((i) => mrr(rankJoin(i), relOf(i)))).toFixed(4), emb: +mean(qFull.map((i) => mrr(rankEmb(i), relOf(i)))).toFixed(4) },
    ci_p5_join_minus_emb: bootCI(pj, pe).map((v) => +v.toFixed(4)),
  };

  // SECONDARY: agent arms re-scored (their frozen rankings) on co-citation oracle
  const agent = load<Record<string, string[]>>('cc-agent-cache.json');
  const freenav = load<Record<string, { ranked: number[] }>>('cc-freenav-cache.json');
  const agentQ = [...new Set(Object.keys(agent).map((k) => Number(k.match(/^q(\d+):/)?.[1])))].filter((q) => B.some((_, j) => related(q, j)));
  const embPoolRank = (i: number) => rankEmb(i); // full-corpus emb ref restricted below where needed
  const structP5 = agentQ.map((q) => precK((agent[`q${q}:struct`] ?? []).map(Number), relOf(q), 5));
  const textP5 = agentQ.map((q) => precK((agent[`q${q}:text`] ?? []).map(Number), relOf(q), 5));
  const embForAgentP5 = agentQ.map((q) => precK(rankEmb(q), relOf(q), 5));
  const fnQ = Object.keys(freenav).map((k) => Number(k.slice(1))).filter((q) => B.some((_, j) => related(q, j)));
  const fnP5 = fnQ.map((q) => precK(freenav[`q${q}`]!.ranked, relOf(q), 5));
  const embForFnP5 = fnQ.map((q) => precK(rankEmb(q), relOf(q), 5));

  const result = {
    prereg: 'doc-30', cap: 200, K,
    kSweep: sweep,
    baseRate: +(citeRel.size / (A.length * B.length)).toFixed(4),
    voidCheck: { citeRelatedPairs: citeRel.size, topicalRelatedPairs: topRel.size, jaccardOverlap: +jac.toFixed(3), note: jac > 0.6 ? 'VOID: oracles too similar' : 'oracles distinct — test valid' },
    embeddingIndependence: { meanCosCoCited: +meanCosCo.toFixed(3), meanCosRandom: +meanCosRand.toFixed(3), note: 'co-cited pairs vs random; near-equal => oracle embedding-independent' },
    PRIMARY_mechanical_fullcorpus: primary,
    SECONDARY_agent: {
      queries: agentQ.length, struct_p5: +mean(structP5).toFixed(4), text_p5: +mean(textP5).toFixed(4), emb_p5: +mean(embForAgentP5).toFixed(4),
      ci_p5_struct_minus_emb: bootCI(structP5, embForAgentP5).map((v) => +v.toFixed(4)),
    },
    SECONDARY_freenav: {
      queries: fnQ.length, freenav_p5: +mean(fnP5).toFixed(4), emb_p5: +mean(embForFnP5).toFixed(4),
      ci_p5_freenav_minus_emb: bootCI(fnP5, embForFnP5).map((v) => +v.toFixed(4)),
    },
  };
  writeFileSync(join(OUT, 'cc-citation-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
main();
