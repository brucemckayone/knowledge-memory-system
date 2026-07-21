/**
 * nmemo-uhp.26 (doc-22) — HYBRID (RRF) recall gate.
 *
 * Deterministic fusion of two FROZEN arms: cosine (over cj-extracted.json embeddings)
 * and the reconciled concept-JOIN (doc-21 cr-relations.json). Reciprocal Rank Fusion
 * (k=60, frozen), re-scored against the external clang-tidy oracle. No LLM, no new data.
 *
 * Pre-registration: docs/architecture/cross-corpus-audit/22-hybrid-rrf-recall-prereg.md
 * NOTHING in the bar (§4/§5) may change after the first number — R1.
 *
 * Run: npx tsx src/test/tools/concept-hybrid-recall.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '../../../../docs/architecture/cross-corpus-audit/concept-join-artifacts');

const extracted = JSON.parse(readFileSync(join(ART, 'cj-extracted.json'), 'utf8')) as {
  codeConcepts: Record<string, { labels: string[] }>;
  ruleConcepts: Record<string, { labels: string[] }>;
  codeEmbeddings: Record<string, number[]>;
  ruleEmbeddings: Record<string, number[]>;
};
const results = JSON.parse(readFileSync(join(ART, 'cj-results.json'), 'utf8')) as {
  guidelines: string[]; oracleKey: Record<string, string>;
  perElement: Record<string, { cosRank: number }>;
};
const { relations } = JSON.parse(readFileSync(join(ART, 'cr-relations.json'), 'utf8')) as {
  relations: Array<{ a: string; b: string; type: string }>;
};

const codeEls = Object.keys(extracted.codeConcepts);
const ruleIds = Object.keys(extracted.ruleConcepts);
const oracle = results.oracleKey;
const guidelines = results.guidelines;
const codeLabelsOf = (e: string) => extracted.codeConcepts[e]!.labels;
const ruleLabelsOf = (r: string) => extracted.ruleConcepts[r]!.labels;

// ---- JOIN arm (doc-21 reconciled): baseline merges + frozen agent relations ----
const BASELINE_MERGES: Array<[string, string]> = [
  ['unsafe-cast', 'unsafe-casting'], ['nested-namespace', 'namespace-nesting'],
  ['const-reference-parameter', 'pass-by-const-reference'], ['const-member-variable', 'const-data-member'],
  ['constexpr-constant', 'constexpr-variable'],
];
const pairKey = (x: string, y: string) => (x < y ? `${x} ${y}` : `${y} ${x}`);
const bridges = new Set<string>();
for (const [x, y] of BASELINE_MERGES) bridges.add(pairKey(x, y));
for (const r of relations) bridges.add(pairKey(r.a, r.b));
function joinScore(el: string, rule: string): number {
  const cs = codeLabelsOf(el), rs = ruleLabelsOf(rule); let n = 0;
  for (const c of cs) for (const r of rs) if (c === r || bridges.has(pairKey(c, r))) n++;
  return n;
}

// ---- cosine arm ----
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// full ranking (1..27) with conservative tie-break: higher score better; among equals,
// true rule placed LAST, then ascending rule id. Returns Map<rule, rank>.
function fullRanks(el: string, scoreOf: (rule: string) => number): Map<string, number> {
  const trueRule = oracle[el]!;
  const ordered = ruleIds.slice().sort((x, y) => {
    const sx = scoreOf(x), sy = scoreOf(y);
    if (sy !== sx) return sy - sx;                    // score desc
    const tx = x === trueRule ? 1 : 0, ty = y === trueRule ? 1 : 0;
    if (tx !== ty) return tx - ty;                    // true rule later among equals
    return x < y ? -1 : 1;                            // ascending id
  });
  const m = new Map<string, number>();
  ordered.forEach((r, i) => m.set(r, i + 1));
  return m;
}

// ---- per-element ranks for all three arms ----
const RRF_K = 60;
const cosRankOf = new Map<string, Map<string, number>>();
const joinRankOf = new Map<string, Map<string, number>>();
const hybridTrueRank = new Map<string, number>();
const cosTrueRank = new Map<string, number>();
const joinTrueRank = new Map<string, number>();

function computeArms(k: number): Map<string, number> {
  // FULL-RANKING RRF (the doc-22 pre-registered variant): both arms rank all 27 rules 1..27.
  const out = new Map<string, number>();
  for (const el of codeEls) {
    const cr = cosRankOf.get(el)!, jr = joinRankOf.get(el)!;
    const rrf = (rule: string) => 1 / (k + cr.get(rule)!) + 1 / (k + jr.get(rule)!);
    const fused = fullRanks(el, rrf);
    out.set(el, fused.get(oracle[el]!)!);
  }
  return out;
}

// RETRIEVED-SET RRF (textbook Cormack 2009; adversary-surfaced as the canonical form for a SPARSE
// arm). JOIN contributes ONLY for rules it actually connects (shared-concept score > 0), ranked among
// those; cosine contributes for all. NOT pre-registered — recorded as an exploratory/confirmatory
// variant, NOT banked as the gate result. Blind (score>0 is oracle-free; tie-break stays conservative).
function computeRetrievedSet(k: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const el of codeEls) {
    const cr = cosRankOf.get(el)!;
    const trueRule = oracle[el]!;
    const connected = ruleIds.filter((r) => joinScore(el, r) > 0);
    const connOrdered = connected.slice().sort((x, y) => {
      const sx = joinScore(el, x), sy = joinScore(el, y);
      if (sy !== sx) return sy - sx;
      const tx = x === trueRule ? 1 : 0, ty = y === trueRule ? 1 : 0;
      if (tx !== ty) return tx - ty;
      return x < y ? -1 : 1;
    });
    const connRank = new Map<string, number>();
    connOrdered.forEach((r, i) => connRank.set(r, i + 1));
    const rrf = (rule: string) => 1 / (k + cr.get(rule)!) + (connRank.has(rule) ? 1 / (k + connRank.get(rule)!) : 0);
    const fused = fullRanks(el, rrf);
    out.set(el, fused.get(trueRule)!);
  }
  return out;
}

for (const el of codeEls) {
  const cr = fullRanks(el, (rule) => cosine(extracted.codeEmbeddings[el]!, extracted.ruleEmbeddings[rule]!));
  const jr = fullRanks(el, (rule) => joinScore(el, rule));
  cosRankOf.set(el, cr); joinRankOf.set(el, jr);
  cosTrueRank.set(el, cr.get(oracle[el]!)!);
  joinTrueRank.set(el, jr.get(oracle[el]!)!);
}
for (const [el, rank] of computeArms(RRF_K)) hybridTrueRank.set(el, rank);
const retrievedTrueRank = computeRetrievedSet(RRF_K);

// ---- metrics ----
function macroAtK(trueRankOf: Map<string, number>, k: number): number {
  const g = new Map<string, { hit: number; n: number }>();
  for (const el of codeEls) { const gd = oracle[el]!; const c = g.get(gd) ?? { hit: 0, n: 0 }; c.n++; if (trueRankOf.get(el)! <= k) c.hit++; g.set(gd, c); }
  let s = 0; for (const gd of guidelines) { const v = g.get(gd)!; s += v.hit / v.n; } return s / guidelines.length;
}
function guidelineVec(trueRankOf: Map<string, number>, k: number): Map<string, number> {
  const g = new Map<string, { hit: number; n: number }>();
  for (const el of codeEls) { const gd = oracle[el]!; const c = g.get(gd) ?? { hit: 0, n: 0 }; c.n++; if (trueRankOf.get(el)! <= k) c.hit++; g.set(gd, c); }
  const o = new Map<string, number>(); for (const gd of guidelines) { const v = g.get(gd)!; o.set(gd, v.hit / v.n); } return o;
}
function mulberry32(seed: number) { return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrapCI(aVec: Map<string, number>, bVec: Map<string, number>) {
  const gs = guidelines, N = gs.length, iters = 10000, rnd = mulberry32(20250721); const diffs: number[] = [];
  for (let it = 0; it < iters; it++) { let sa = 0, sb = 0; for (let i = 0; i < N; i++) { const g = gs[Math.floor(rnd() * N)]!; sa += aVec.get(g)!; sb += bVec.get(g)!; } diffs.push(sa / N - sb / N); }
  diffs.sort((x, y) => x - y);
  return { mean: diffs.reduce((a, b) => a + b, 0) / iters, lo: diffs[Math.floor(0.025 * iters)]!, hi: diffs[Math.floor(0.975 * iters)]! };
}

const ks = [1, 3, 5, 8];
const cosM: Record<number, number> = {}, joinM: Record<number, number> = {}, hybM: Record<number, number> = {}, retM: Record<number, number> = {};
for (const k of ks) { cosM[k] = macroAtK(cosTrueRank, k); joinM[k] = macroAtK(joinTrueRank, k); hybM[k] = macroAtK(hybridTrueRank, k); retM[k] = macroAtK(retrievedTrueRank, k); }

console.log('# doc-22 hybrid (RRF) recall gate\n');
// consistency (R40)
let cosReproduce = true;
for (const el of codeEls) if (cosTrueRank.get(el)! !== results.perElement[el]!.cosRank) cosReproduce = false;
console.log(`consistency: cosine true-ranks reproduce cj-results cosRank -> ${cosReproduce ? 'YES' : 'NO (investigate)'}`);
console.log(`consistency: JOIN macro@5 = ${joinM[5]!.toFixed(4)} vs doc-21 0.444 -> ${Math.abs(joinM[5]! - 0.444) < 0.01 ? 'REPRODUCED' : 'MISMATCH'}`);

console.log('\nmacro recall@k:');
console.log('| arm | @1 | @3 | @5 | @8 |');
console.log('|-----|----|----|----|----|');
const fmt = (o: Record<number, number>) => ks.map((k) => o[k]!.toFixed(3)).join(' | ');
console.log(`| cosine | ${fmt(cosM)} |`);
console.log(`| JOIN (reconciled) | ${fmt(joinM)} |`);
console.log(`| HYBRID full-ranking RRF k=60 (PRE-REGISTERED) | ${fmt(hybM)} |`);
console.log(`| HYBRID retrieved-set RRF k=60 (exploratory, NOT pre-reg) | ${fmt(retM)} |`);

// oracle-fusion ceiling
const ceil = (() => { let s = 0; const cv = guidelineVec(cosTrueRank, 5), jv = guidelineVec(joinTrueRank, 5); for (const g of guidelines) s += Math.max(cv.get(g)!, jv.get(g)!); return s / guidelines.length; })();
console.log(`\noracle-fusion ceiling @5 (max per guideline): ${ceil.toFixed(3)}`);

// bootstrap
const ciCos = bootstrapCI(guidelineVec(hybridTrueRank, 5), guidelineVec(cosTrueRank, 5));
const ciJoin = bootstrapCI(guidelineVec(hybridTrueRank, 5), guidelineVec(joinTrueRank, 5));
const ciRet = bootstrapCI(guidelineVec(retrievedTrueRank, 5), guidelineVec(cosTrueRank, 5));
console.log(`\nbootstrap (full-ranking hybrid - cosine) macro@5: mean ${ciCos.mean.toFixed(3)} 95% CI [${ciCos.lo.toFixed(3)}, ${ciCos.hi.toFixed(3)}]`);
console.log(`bootstrap (full-ranking hybrid - JOIN)   macro@5: mean ${ciJoin.mean.toFixed(3)} 95% CI [${ciJoin.lo.toFixed(3)}, ${ciJoin.hi.toFixed(3)}]`);
console.log(`bootstrap (retrieved-set hybrid - cosine) macro@5: mean ${ciRet.mean.toFixed(3)} 95% CI [${ciRet.lo.toFixed(3)}, ${ciRet.hi.toFixed(3)}]  [exploratory]`);

// k robustness (adversary check, NOT for picking a winner)
console.log('\nk-robustness hybrid macro@5 (k=60 is the frozen gate):');
for (const k of [10, 30, 60, 100]) { const h = computeArms(k); console.log(`  k=${k}: ${macroAtK(h, 5).toFixed(3)}`); }

// bar
const cond1 = hybM[5]! >= 0.567;
const at1Regress = hybM[1]! < cosM[1]!;
console.log('\n=== BAR (frozen §5) ===');
console.log(`primary: hybrid macro@5 (${hybM[5]!.toFixed(3)}) >= 0.567 -> ${cond1 ? 'PASS' : 'FAIL'}`);
console.log(`secondary: @1 regression? hybrid@1 ${hybM[1]!.toFixed(3)} vs cosine@1 ${cosM[1]!.toFixed(3)} -> ${at1Regress ? 'REGRESSED' : 'ok'}`);
console.log(`\n>>> GATE ${cond1 ? 'PASS' : 'FAIL'} <<<`);

// per-guideline
console.log('\nper-guideline @5 (cos / JOIN / hybrid):');
const cv = guidelineVec(cosTrueRank, 5), jv = guidelineVec(joinTrueRank, 5), hv = guidelineVec(hybridTrueRank, 5);
const perGuideline = guidelines.map((g) => ({ guideline: g, cos: +cv.get(g)!.toFixed(3), join: +jv.get(g)!.toFixed(3), hybrid: +hv.get(g)!.toFixed(3) }));
for (const p of perGuideline) console.log(`  ${p.guideline}: cos ${p.cos} / JOIN ${p.join} / HYB ${p.hybrid}`);

writeFileSync(join(ART, 'cr-hybrid-results.json'), JSON.stringify({
  prereg: 'doc-22', rrfK: RRF_K,
  macro: { cosine: cosM, join: joinM, hybridFullRanking: hybM, hybridRetrievedSet: retM }, oracleFusionCeiling5: ceil,
  bootstrap: { fullRankingVsCosine: ciCos, fullRankingVsJoin: ciJoin, retrievedSetVsCosine: ciRet },
  retrievedSetNote: 'retrieved-set RRF is NOT pre-registered; recorded as exploratory/confirmatory, not banked as the gate result',
  consistency: { cosineReproduced: cosReproduce, joinMacro5: joinM[5] },
  bar: { cond1, at1Regress, pass: cond1 }, perGuideline,
  perElement: Object.fromEntries(codeEls.map((el) => [el, { trueRule: oracle[el], cos: cosTrueRank.get(el), join: joinTrueRank.get(el), hybrid: hybridTrueRank.get(el) }])),
}, null, 2));
console.log('\nwrote cr-hybrid-results.json');
