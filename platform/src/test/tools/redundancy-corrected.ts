/**
 * doc-27 — Corrected redundancy metric (non-chaining + order-swap noise model).
 * Aggregation-only over the FROZEN doc-26 judge caches, plus ~60 order-swap confirmation calls.
 *
 *   R_strict    = Σ(s-1)/N over SAME-only connected components (= doc-26 strict).
 *   R_confirmed = R_strict keeping only SAME edges that are SAME in BOTH orderings (order-swap denoise).
 *   R_upper     = R_strict after promoting SIBLING pairs with cosine >= 0.85 to SAME (bounded missed-dup guard).
 *
 * Run: ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/redundancy-corrected.ts --space R
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ML = process.env.ML_SERVICES_URL ?? 'http://127.0.0.1:8000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const SPACE = (process.argv[process.argv.indexOf('--space') + 1] ?? 'R').toUpperCase();
const PROMOTE_COS = 0.85;

function load<T>(name: string): T | null { const p = join(OUT, name); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as T : null; }
function save(name: string, obj: unknown): void { writeFileSync(join(OUT, name), JSON.stringify(obj, null, 2)); }
function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }
const key = (a: string, b: string) => [a, b].sort().join('|||');

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
    return 'SAME';
  } finally { clearTimeout(timer); }
}
async function judge(a: string, b: string): Promise<Verdict> {
  for (let attempt = 0; attempt < 4; attempt++) { try { return await judgeCall(a, b, 150_000); } catch { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); } }
  return await judgeCall(a, b, 150_000);
}

interface Corpus { base: Array<{ id: string; text: string }>; }
function baseLabels(): { labels: string[]; emb: Record<string, number[]> } {
  if (SPACE === 'R') {
    const seeded = load<Record<string, string[]>>('seeded-extractions-R.json')!;
    const order = load<{ perDoc: Array<{ key: string; provenance: string }> }>('cv2-results-armR.json')!.perDoc.filter((p) => p.provenance === 'base').map((p) => p.key);
    const seen = new Set<string>(); const labels: string[] = [];
    for (const k of order) for (const l of (seeded[k] ?? [])) if (!seen.has(l)) { seen.add(l); labels.push(l); }
    return { labels, emb: load<Record<string, number[]>>('label-embeddings-R.json')! };
  }
  const ex = load<Record<string, string[]>>('extractions.json')!;
  const order = load<{ perDoc: Array<{ key: string; provenance: string }> }>('cv2-results-arm0.json')!.perDoc.filter((p) => p.provenance === 'base').map((p) => p.key);
  const seen = new Set<string>(); const labels: string[] = [];
  for (const k of order) for (const raw of (ex[k] ?? [])) { const l = raw.toLowerCase().trim(); if (l && !seen.has(l)) { seen.add(l); labels.push(l); } }
  return { labels, emb: load<Record<string, number[]>>('label-embeddings.json')! };
}
function componentSizes(n: number, edges: Array<[number, number]>): number[] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
  for (const [u, v] of edges) { const ru = find(u), rv = find(v); if (ru !== rv) parent[ru] = rv; }
  const sizes = new Map<number, number>(); for (let i = 0; i < n; i++) { const r = find(i); sizes.set(r, (sizes.get(r) ?? 0) + 1); }
  return [...sizes.values()];
}
const redundancy = (n: number, edges: Array<[number, number]>): number => (n - componentSizes(n, edges).length) / n;

async function main(): Promise<void> {
  const { labels, emb } = baseLabels();
  const n = labels.length;
  const idx = new Map(labels.map((l, i) => [l, i] as const));
  const judgeCache = load<Record<string, Verdict>>(`redundancy-judge-${SPACE}.json`)!;

  // classify frozen candidate verdicts back onto index pairs
  const samePairs: Array<[number, number]> = [], highSibPairs: Array<[number, number]> = [];
  for (const [k, v] of Object.entries(judgeCache)) {
    const [a, b] = k.split('|||'); if (!idx.has(a!) || !idx.has(b!)) continue;
    const i = idx.get(a!)!, j = idx.get(b!)!;
    if (v === 'SAME') samePairs.push([i, j]);
    else if (v === 'SIBLING') { const c = (emb[a!] && emb[b!]) ? cosine(emb[a!]!, emb[b!]!) : 0; if (c >= PROMOTE_COS) highSibPairs.push([i, j]); }
  }

  // order-swap confirmation of SAME pairs (NEW calls, cached)
  const confName = `redundancy-confirm-${SPACE}.json`;
  const conf = load<Record<string, Verdict>>(confName) ?? {};
  const need = samePairs.filter(([i, j]) => !conf[`swap:${key(labels[i]!, labels[j]!)}`]);
  console.log(`order-swap confirming ${need.length} SAME pairs (${samePairs.length - need.length} cached)...`);
  for (const [i, j] of need) { conf[`swap:${key(labels[i]!, labels[j]!)}`] = await judge(labels[j]!, labels[i]!); save(confName, conf); } // judge (b,a)

  const confirmedPairs = samePairs.filter(([i, j]) => conf[`swap:${key(labels[i]!, labels[j]!)}`] === 'SAME');
  const rStrict = redundancy(n, samePairs);
  const rConfirmed = redundancy(n, confirmedPairs);
  const rUpper = redundancy(n, [...samePairs, ...highSibPairs]);

  const dropped = samePairs.filter(([i, j]) => conf[`swap:${key(labels[i]!, labels[j]!)}`] !== 'SAME').map(([i, j]) => `${labels[i]}|${labels[j]}->${conf[`swap:${key(labels[i]!, labels[j]!)}`]}`);
  const promoted = highSibPairs.map(([i, j]) => `${labels[i]}|${labels[j]}`);
  const result = {
    prereg: 'doc-27', space: SPACE, n,
    samePairs: samePairs.length, confirmedPairs: confirmedPairs.length, highCosSiblingsPromoted: highSibPairs.length,
    R_strict: rStrict, R_confirmed: rConfirmed, R_upper: rUpper,
    orderSwapDropped: dropped, promotedPairs: promoted,
  };
  save(`redundancy-corrected-${SPACE}.json`, result);
  console.log(`\n=== CORRECTED REDUNDANCY (space ${SPACE}) ===`);
  console.log(`N=${n}  SAME=${samePairs.length}  confirmed(both-orderings)=${confirmedPairs.length}  high-cos-sibs-promoted=${highSibPairs.length}`);
  console.log(`R_strict    = ${(rStrict * 100).toFixed(2)}%`);
  console.log(`R_confirmed = ${(rConfirmed * 100).toFixed(2)}%   (headline; order-swap denoised)`);
  console.log(`R_upper     = ${(rUpper * 100).toFixed(2)}%   (bounded guard; +${highSibPairs.length} high-cos siblings promoted)`);
  if (dropped.length) console.log(`order-swap DROPPED (order-fragile SAMEs): ${dropped.join(', ')}`);
  console.log('=== END ===');
}
main().catch((e) => { console.error(e); process.exit(1); });
