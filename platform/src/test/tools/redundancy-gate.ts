/**
 * doc-26 — Direct semantic-redundancy gate.
 * Measures the LLM-adjudicated duplicate rate of a built concept space.
 *
 * Procedure (frozen in docs/architecture/cross-corpus-audit/26-direct-redundancy-gate-prereg.md):
 *   1. base labels of a space (Arm R: 483 first-coined; free-form: distinct bare labels over base docs)
 *   2. candidate pairs = embedding cosine >= 0.70  UNION  lexical (substring | token-overlap>=0.6 & >=2 shared)
 *   3. Haiku 3-way judge (SAME | SIBLING | UNRELATED), conservative tie-break -> SAME, cached
 *   4. redundancy = (N - C)/N via connected components on SAME edges (strict) and SAME|SIBLING (lenient)
 *   5. prefilter-recall spot-check: 100 random pairs BELOW 0.70 (seeded), judged, report SAME-rate
 *
 * Run: ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/redundancy-gate.ts --space R
 *      (--space R  = Arm R relevance-window space;  --space FF = free-form baseline space)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ML = process.env.ML_SERVICES_URL ?? 'http://127.0.0.1:8000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const SPACE = (process.argv[process.argv.indexOf('--space') + 1] ?? 'R').toUpperCase(); // R | FF

const COS_THRESH = 0.70;
const SPOT_N = 100;
const SPOT_SEED = 26; // doc-26; deterministic sampling for adversary replay

// ---- io ----
function load<T>(name: string): T | null { const p = join(OUT, name); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as T : null; }
function save(name: string, obj: unknown): void { writeFileSync(join(OUT, name), JSON.stringify(obj, null, 2)); }
function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }
function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- Haiku 3-way judge (prompt frozen in pre-reg §3) ----
const JUDGE_SYS = 'You classify concept-label pairs for a knowledge graph. Respond with exactly one word.';
function judgePrompt(a: string, b: string): string {
  return [
    'You are judging whether two concept labels from a knowledge graph denote THE SAME concept',
    '(such that the graph should hold a single merged node), are SIBLINGS (distinct but related',
    'concepts that should stay as separate nodes), or are UNRELATED.',
    '', `Label A: "${a}"`, `Label B: "${b}"`, '',
    'Rules:',
    '- SAME = a knowledge graph modeling this domain would be wrong to keep both as separate nodes;',
    '  they are the same idea in different words (synonyms, trivial rewordings, acronym/expansion).',
    '- SIBLING = genuinely different concepts that share a parent or theme (e.g. two different',
    '  methods, a process vs its rate, a general concept vs a specific variant). Keep separate.',
    '- UNRELATED = different topics.',
    '- If you are genuinely unsure between SAME and SIBLING, answer SAME.',
    '', 'Answer with exactly one word: SAME, SIBLING, or UNRELATED.',
  ].join('\n');
}
type Verdict = 'SAME' | 'SIBLING' | 'UNRELATED';
async function judgeCall(a: string, b: string, ms: number): Promise<Verdict> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${ML}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: judgePrompt(a, b), system_prompt: JUDGE_SYS }), signal: ctrl.signal });
    if (!r.ok) throw new Error(`/chat ${r.status}`);
    const raw = (await r.json() as { response: string }).response.toUpperCase();
    if (raw.includes('UNRELATED')) return 'UNRELATED';
    if (raw.includes('SIBLING')) return 'SIBLING';
    if (raw.includes('SAME')) return 'SAME';
    return 'SAME'; // unparseable -> conservative tie-break (pre-reg §2)
  } finally { clearTimeout(timer); }
}
async function judgeOne(a: string, b: string): Promise<Verdict> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await judgeCall(a, b, 150_000); }
    catch { await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); }
  }
  return await judgeCall(a, b, 150_000); // final attempt; if it throws, let it surface (not silently SAME)
}
async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i]!, i); } }));
  return out;
}

// ---- base-label reconstruction ----
interface Corpus { base: Array<{ id: string; text: string }>; }
function baseLabels(): { labels: string[]; emb: Record<string, number[]> } {
  const corpus = load<Corpus>('corpus.json'); if (!corpus) throw new Error('corpus.json missing');
  const baseKeys = new Set(corpus.base.map((d) => d.id));
  if (SPACE === 'R') {
    const seeded = load<Record<string, string[]>>('seeded-extractions-R.json'); if (!seeded) throw new Error('seeded-extractions-R.json missing');
    const results = load<{ perDoc: Array<{ key: string; provenance: string }> }>('cv2-results-armR.json')!;
    const order = results.perDoc.filter((p) => p.provenance === 'base').map((p) => p.key);
    const seen = new Set<string>(); const labels: string[] = [];
    for (const k of order) for (const l of (seeded[k] ?? [])) if (!seen.has(l)) { seen.add(l); labels.push(l); }
    const emb = load<Record<string, number[]>>('label-embeddings-R.json')!;
    return { labels, emb };
  } else {
    // free-form: every distinct bare label over base docs (no conform => surface identity)
    // base doc keys are prefixed "base:" in the extraction cache — take them from the arm0 perDoc order
    const ex = load<Record<string, string[]>>('extractions.json'); if (!ex) throw new Error('extractions.json missing');
    const r0 = load<{ perDoc: Array<{ key: string; provenance: string }> }>('cv2-results-arm0.json')!;
    const order = r0.perDoc.filter((p) => p.provenance === 'base').map((p) => p.key);
    void baseKeys;
    const seen = new Set<string>(); const labels: string[] = [];
    for (const k of order) for (const raw of (ex[k] ?? [])) { const l = raw.toLowerCase().trim(); if (l && !seen.has(l)) { seen.add(l); labels.push(l); } }
    const emb = load<Record<string, number[]>>('label-embeddings.json')!;
    return { labels, emb };
  }
}

// ---- lexical candidate test ----
function lexPair(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split('-')), tb = new Set(b.split('-'));
  const inter = [...ta].filter((x) => tb.has(x)).length;
  const uni = new Set([...ta, ...tb]).size;
  return inter >= 2 && inter / uni >= 0.6;
}

function components(n: number, edges: Array<[number, number]>): number[] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
  for (const [u, v] of edges) { const ru = find(u), rv = find(v); if (ru !== rv) parent[ru] = rv; }
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) { const r = find(i); sizes.set(r, (sizes.get(r) ?? 0) + 1); }
  return [...sizes.values()];
}

async function main(): Promise<void> {
  const { labels, emb } = baseLabels();
  const n = labels.length;
  const missing = labels.filter((l) => !emb[l]);
  console.log(`space=${SPACE}  base labels=${n}  missing embeddings=${missing.length}`);
  if (missing.length) console.log('  MISSING (first 10):', missing.slice(0, 10).join(', '));
  const idx = new Map(labels.map((l, i) => [l, i] as const));
  const V = labels.map((l) => emb[l] ?? null);

  // candidate pairs: cosine>=0.70 UNION lexical
  const cand: Array<{ i: number; j: number; cos: number; lex: boolean }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = (V[i] && V[j]) ? cosine(V[i]!, V[j]!) : 0;
      const lx = lexPair(labels[i]!, labels[j]!);
      if (c >= COS_THRESH || lx) cand.push({ i, j, cos: c, lex: lx });
    }
  }
  console.log(`candidate pairs (cos>=${COS_THRESH} | lexical): ${cand.length}`);

  // judge (cached, incremental)
  const cacheName = `redundancy-judge-${SPACE}.json`;
  const cache = load<Record<string, Verdict>>(cacheName) ?? {};
  const key = (a: string, b: string) => [a, b].sort().join('|||');
  const todo = cand.filter((p) => !cache[key(labels[p.i]!, labels[p.j]!)]);
  console.log(`judging ${todo.length} uncached pairs (${cand.length - todo.length} cached)...`);
  let done = 0;
  await pool(todo, 6, async (p) => {
    const a = labels[p.i]!, b = labels[p.j]!;
    const v = await judgeOne(a, b);
    cache[key(a, b)] = v;
    if (++done % 25 === 0) { save(cacheName, cache); console.log(`  judged ${done}/${todo.length}`); }
  });
  save(cacheName, cache);

  // edges
  const sameEdges: Array<[number, number]> = [], sibEdges: Array<[number, number]> = [];
  let nSame = 0, nSib = 0, nUnrel = 0;
  for (const p of cand) {
    const v = cache[key(labels[p.i]!, labels[p.j]!)]!;
    if (v === 'SAME') { sameEdges.push([p.i, p.j]); nSame++; }
    else if (v === 'SIBLING') { sibEdges.push([p.i, p.j]); nSib++; }
    else nUnrel++;
  }
  const strictSizes = components(n, sameEdges).sort((a, b) => b - a);
  const lenientSizes = components(n, [...sameEdges, ...sibEdges]).sort((a, b) => b - a);
  const Cstrict = strictSizes.length, Clen = lenientSizes.length;
  const redStrict = (n - Cstrict) / n, redLen = (n - Clen) / n;

  // prefilter-recall spot-check: 100 random pairs BELOW threshold and not lexical
  const rng = mulberry32(SPOT_SEED);
  const below: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const c = (V[i] && V[j]) ? cosine(V[i]!, V[j]!) : 0;
    if (c < COS_THRESH && !lexPair(labels[i]!, labels[j]!)) below.push([i, j]);
  }
  // Fisher-Yates partial shuffle with seeded rng
  for (let i = below.length - 1; i > 0; i--) { const r = Math.floor(rng() * (i + 1)); [below[i], below[r]] = [below[r]!, below[i]!]; }
  const spot = below.slice(0, SPOT_N);
  const spotCacheName = `redundancy-spot-${SPACE}.json`;
  const spotCache = load<Record<string, Verdict>>(spotCacheName) ?? {};
  const spotTodo = spot.filter(([i, j]) => !spotCache[key(labels[i]!, labels[j]!)]);
  console.log(`spot-check: judging ${spotTodo.length} below-threshold pairs...`);
  await pool(spotTodo, 6, async ([i, j]) => { spotCache[key(labels[i]!, labels[j]!)] = await judgeOne(labels[i]!, labels[j]!); });
  save(spotCacheName, spotCache);
  const spotSame = spot.filter(([i, j]) => spotCache[key(labels[i]!, labels[j]!)] === 'SAME').length;
  const spotSib = spot.filter(([i, j]) => spotCache[key(labels[i]!, labels[j]!)] === 'SIBLING').length;

  const metrics = {
    space: SPACE, n, candidates: cand.length,
    verdicts: { SAME: nSame, SIBLING: nSib, UNRELATED: nUnrel },
    redundancyStrict: redStrict, redundancyLenient: redLen,
    componentsStrict: Cstrict, componentsLenient: Clen,
    mergesStrict: n - Cstrict, mergesLenient: n - Clen,
    largestStrictComponent: strictSizes[0], largestLenientComponent: lenientSizes[0],
    spotCheck: { belowPoolSize: below.length, sampled: spot.length, same: spotSame, sibling: spotSib, sameRate: spotSame / spot.length },
  };
  save(`redundancy-result-${SPACE}.json`, { prereg: 'doc-26', ...metrics });

  console.log('\n=== REDUNDANCY RESULT (space ' + SPACE + ') ===');
  console.log(`N base nodes: ${n}`);
  console.log(`candidate verdicts: SAME=${nSame} SIBLING=${nSib} UNRELATED=${nUnrel}`);
  console.log(`STRICT  redundancy = ${(redStrict * 100).toFixed(1)}%  (merges ${n - Cstrict}, components ${Cstrict}, largest ${strictSizes[0]})`);
  console.log(`LENIENT redundancy = ${(redLen * 100).toFixed(1)}%  (merges ${n - Clen}, components ${Clen}, largest ${lenientSizes[0]})`);
  console.log(`spot-check (below ${COS_THRESH}, n=${spot.length}): SAME=${spotSame} SIBLING=${spotSib}  SAME-rate=${(100 * spotSame / spot.length).toFixed(1)}%`);
  console.log('=== END ===');
}
main().catch((e) => { console.error(e); process.exit(1); });
