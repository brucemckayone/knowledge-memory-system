/**
 * doc-31 — text-dissimilar (low-cosine) co-citation test. 0 new LLM calls (re-score).
 * Isolates: among co-cited pairs that are textually DISSIMILAR (cosine < tau), does the concept signal
 * find them better than embedding (residual within-band cosine) AND random? + hybrid payoff on full oracle.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const load = <T,>(n: string): T => JSON.parse(readFileSync(join(OUT, n), 'utf8')) as T;
function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

function main(): void {
  const A = load<Array<{ id: string }>>('corpus-A.json'), B = load<Array<{ id: string }>>('corpus-B.json');
  const cite = load<Record<string, string[]>>('cc-cociters.json');
  const seeded = load<Record<string, string[]>>('cc-seeded.json'), demb = load<Record<string, number[]>>('cc-docemb.json');
  const citersA = A.map((d) => new Set(cite[d.id] ?? [])), citersB = B.map((d) => new Set(cite[d.id] ?? []));
  const coCited = (i: number, j: number) => { const [s, l] = citersA[i]!.size < citersB[j]!.size ? [citersA[i]!, citersB[j]!] : [citersB[j]!, citersA[i]!]; for (const x of s) if (l.has(x)) return true; return false; };
  const nB = B.map((d) => new Set(seeded[`B:${d.id}`] ?? [])), nA = A.map((d) => new Set(seeded[`A:${d.id}`] ?? []));
  const eA = A.map((d) => demb[`A:${d.id}`]!), eB = B.map((d) => demb[`B:${d.id}`]!);
  const df = new Map<string, number>(); [...nA, ...nB].forEach((cs) => cs.forEach((c) => df.set(c, (df.get(c) ?? 0) + 1)));
  const idf = (c: string) => Math.log((A.length + B.length) / (df.get(c) ?? 1));
  const joinScore = (i: number, j: number) => { let s = 0; for (const c of nA[i]!) if (nB[j]!.has(c)) s += idf(c); return s; };
  const cos = (i: number, j: number) => cosine(eA[i]!, eB[j]!);

  const recallK = (rk: number[], rel: Set<number>, k: number) => { if (!rel.size) return NaN; let h = 0; for (let i = 0; i < Math.min(k, rk.length); i++) if (rel.has(rk[i]!)) h++; return h / rel.size; };
  const precK = (rk: number[], rel: Set<number>, k: number) => { let h = 0; for (let i = 0; i < Math.min(k, rk.length); i++) if (rel.has(rk[i]!)) h++; return h / k; };
  const mrr = (rk: number[], rel: Set<number>) => { for (let i = 0; i < rk.length; i++) if (rel.has(rk[i]!)) return 1 / (i + 1); return 0; };
  function bootCI(x: number[], y: number[]): [number, number] { const n = x.length; if (n < 2) return [0, 0]; const d: number[] = []; let s = 31000 + n; const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; for (let b = 0; b < 10000; b++) { let a = 0; for (let i = 0; i < n; i++) { const k = Math.floor(r() * n); a += x[k]! - y[k]!; } d.push(a / n); } d.sort((a, c) => a - c); return [d[250]!, d[9750]!]; }
  let rs = 777; const rrand = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };

  const out: any = { prereg: 'doc-31', K: 1, results: {} };
  for (const tau of [0.615, 0.60, 0.65]) {
    // coverage ceiling: low-cosine co-cited pairs sharing >=1 node
    let lcCo = 0, lcCoShared = 0;
    for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) if (cos(i, j) < tau && coCited(i, j)) { lcCo++; let sh = false; for (const c of nA[i]!) if (nB[j]!.has(c)) { sh = true; break; } if (sh) lcCoShared++; }
    // per-query band universe + arms
    const qs: number[] = [];
    const jP5: number[] = [], eP5: number[] = [], rP5: number[] = [], jR10: number[] = [], eR10: number[] = [], jMrr: number[] = [], eMrr: number[] = [], rMrr: number[] = [];
    for (let i = 0; i < A.length; i++) {
      const uni = [...B.keys()].filter((j) => cos(i, j) < tau);
      const pos = new Set(uni.filter((j) => coCited(i, j)));
      if (pos.size < 3) continue;
      qs.push(i);
      const rJoin = [...uni].sort((x, y) => joinScore(i, y) - joinScore(i, x));
      const rEmb = [...uni].sort((x, y) => cos(i, y) - cos(i, x)); // residual within-band cosine
      const rRand = [...uni].map((j) => [j, rrand()] as const).sort((a, b) => a[1] - b[1]).map((z) => z[0]);
      jP5.push(precK(rJoin, pos, 5)); eP5.push(precK(rEmb, pos, 5)); rP5.push(precK(rRand, pos, 5));
      jR10.push(recallK(rJoin, pos, 10)); eR10.push(recallK(rEmb, pos, 10));
      jMrr.push(mrr(rJoin, pos)); eMrr.push(mrr(rEmb, pos)); rMrr.push(mrr(rRand, pos));
    }
    out.results[`tau=${tau}`] = {
      queries: qs.length,
      coverageCeiling: { lowCosCoCitedPairs: lcCo, shareGE1Node: lcCoShared, ceiling: +(lcCoShared / lcCo).toFixed(3) },
      precision5: { join: +mean(jP5).toFixed(4), emb: +mean(eP5).toFixed(4), random: +mean(rP5).toFixed(4) },
      recall10: { join: +mean(jR10).toFixed(4), emb: +mean(eR10).toFixed(4) },
      mrr: { join: +mean(jMrr).toFixed(4), emb: +mean(eMrr).toFixed(4), random: +mean(rMrr).toFixed(4) },
      ci_p5_join_minus_emb: bootCI(jP5, eP5).map((v) => +v.toFixed(4)),
      ci_p5_join_minus_random: bootCI(jP5, rP5).map((v) => +v.toFixed(4)),
    };
  }

  // H2 hybrid payoff: full corpus, full co-citation oracle, RRF(emb,join) vs emb-alone recall@10
  const RRF_K = 60;
  const relFull = (i: number) => new Set(B.map((_, j) => j).filter((j) => coCited(i, j)));
  const qFull = A.map((_, i) => i).filter((i) => relFull(i).size > 0);
  const embRank = (i: number) => [...B.keys()].sort((x, y) => cos(i, y) - cos(i, x));
  const joinRank = (i: number) => [...B.keys()].sort((x, y) => joinScore(i, y) - joinScore(i, x));
  const rrf = (i: number) => { const e = embRank(i), j = joinRank(i); const s = new Array(B.length).fill(0); e.forEach((c, r) => s[c] += 1 / (RRF_K + r + 1)); j.forEach((c, r) => s[c] += 1 / (RRF_K + r + 1)); return [...B.keys()].sort((x, y) => s[y] - s[x]); };
  const embR10 = qFull.map((i) => recallK(embRank(i), relFull(i), 10));
  const rrfR10 = qFull.map((i) => recallK(rrf(i), relFull(i), 10));
  out.H2_hybrid_fullOracle = { queries: qFull.length, emb_recall10: +mean(embR10).toFixed(4), rrf_recall10: +mean(rrfR10).toFixed(4), ci_rrf_minus_emb: bootCI(rrfR10, embR10).map((v) => +v.toFixed(4)) };

  // agent recall of low-cosine co-cited targets (tau=0.615)
  const agent = load<Record<string, string[]>>('cc-agent-cache.json');
  const freenav = load<Record<string, { ranked: number[] }>>('cc-freenav-cache.json');
  const posLC = (i: number) => new Set(B.map((_, j) => j).filter((j) => cos(i, j) < 0.615 && coCited(i, j)));
  const aQ = [...new Set(Object.keys(agent).map((k) => Number(k.match(/^q(\d+):/)?.[1])))].filter((q) => posLC(q).size >= 1);
  const fnQ = Object.keys(freenav).map((k) => Number(k.slice(1))).filter((q) => posLC(q).size >= 1);
  out.agent_lowcos = {
    struct_queries: aQ.length,
    struct_recall_lc: aQ.length ? +mean(aQ.map((q) => recallK((agent[`q${q}:struct`] ?? []).map(Number), posLC(q), 10))).toFixed(4) : null,
    emb_recall_lc_sameQ: aQ.length ? +mean(aQ.map((q) => recallK(embRank(q), posLC(q), 10))).toFixed(4) : null,
    freenav_queries: fnQ.length,
    freenav_recall_lc: fnQ.length ? +mean(fnQ.map((q) => recallK(freenav[`q${q}`]!.ranked, posLC(q), 10))).toFixed(4) : null,
    emb_recall_lc_fnQ: fnQ.length ? +mean(fnQ.map((q) => recallK(embRank(q), posLC(q), 10))).toFixed(4) : null,
  };

  writeFileSync(join(OUT, 'cc-lowcos-result.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main();
