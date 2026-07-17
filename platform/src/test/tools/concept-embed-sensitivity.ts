/**
 * Doc-17 Stage-1 robustness check (nmemo-uhp.19): does the embedding FAIL survive using
 * nomic-embed-text's proper task PREFIXES?  The pre-registered run embedded raw (the
 * production entity path). nomic is an asymmetric model; the honest anti-launder check
 * (rule 37: re-derive a negative with the canonical component) is whether the embedding
 * still loses to BM25 once we use search_document / clustering prefixes.
 *
 * Reuses the FROZEN concept-authored.json (does not re-author, does not touch the
 * pre-registered result). Recomputes ONLY Stage-1 recall + the cosine near-miss
 * specificity, under 3 prefix modes.
 *
 *   npx tsx C:/Users/bruce.mckay/dev/nmemo/platform/src/test/tools/concept-embed-sensitivity.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ml } from '../../services/ml-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data', 'concept-resolution');
const corpus = JSON.parse(readFileSync(join(DATA, 'mechanisms.json'), 'utf8')) as { mechanisms: { id: string; near_miss: string }[] };
const authored = JSON.parse(readFileSync(join(DATA, 'concept-authored.json'), 'utf8')) as Record<string, Record<string, string>>;
const REGISTERS = ['normative', 'advisory', 'reference'] as const;
const MECHS = corpus.mechanisms;

function cos(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0; }
const STOP = new Set(['the','a','an','of','to','is','are','be','that','this','it','its','and','or','not','no','in','on','at','by','for','with','as','from','into','than','then','so','if','when','which','while','has','have','had','was','were','been','will','shall','may','must','should','can','could','would','do','does','done','but','out','back','up','off','over','more','less','one','two','their','they','them','all','each','such','only','via','per','using','use','used','you','your']);
function tok(s: string): string[] { return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOP.has(t)); }
const K1 = 1.2, B = 0.75;
function bm25all(texts: Map<string, string>) {
  const docs = new Map<string, { tf: Map<string, number>; len: number }>(); const df = new Map<string, number>(); let total = 0;
  for (const [id, t] of texts) { const ts = tok(t); const tf = new Map<string, number>(); for (const x of ts) tf.set(x, (tf.get(x) ?? 0) + 1); docs.set(id, { tf, len: ts.length }); total += ts.length; for (const x of tf.keys()) df.set(x, (df.get(x) ?? 0) + 1); }
  const N = docs.size; const idf = new Map<string, number>(); for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  const avgdl = total / Math.max(1, N);
  return (docId: string, q: Set<string>) => { const doc = docs.get(docId)!; let s = 0; for (const t of q) { const tf = doc.tf.get(t); if (!tf) continue; s += (idf.get(t) ?? 0) * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.len / avgdl))); } return s; };
}

interface D { key: string; mech: string; text: string; vec: number[] }

async function runPrefix(label: string, prefix: string) {
  const pool: D[] = [];
  for (const m of MECHS) for (const r of REGISTERS) pool.push({ key: `${m.id}::${r}`, mech: m.id, text: authored[r]![m.id]!, vec: [] });
  for (const d of pool) { const { vector } = await ml.embed(prefix + d.text); d.vec = vector; }
  const byKey = new Map(pool.map((d) => [d.key, d]));
  const score = bm25all(new Map(pool.map((d) => [d.key, d.text])));
  const qtok = new Map(pool.map((d) => [d.key, new Set(tok(d.text))]));
  let embR1 = 0, embR3 = 0, bmR1 = 0, gap = 0, embR1gap = 0;
  for (const q of pool) {
    const others = pool.filter((d) => d.key !== q.key);
    const eRank = [...others].sort((a, b) => cos(q.vec, b.vec) - cos(q.vec, a.vec));
    const bRank = [...others].sort((a, b) => score(b.key, qtok.get(q.key)!) - score(a.key, qtok.get(q.key)!));
    const t = (d: D) => d.mech === q.mech;
    const e1 = t(eRank[0]!), e3 = eRank.slice(0, 3).some(t), b1 = t(bRank[0]!);
    if (e1) embR1++; if (e3) embR3++; if (b1) bmR1++;
    if (!b1) { gap++; if (e1) embR1gap++; }
  }
  const n = pool.length;
  // cosine near-miss specificity (best-in-hindsight over the near-miss + far + true pairs)
  const combos: [string, string][] = [['normative', 'advisory'], ['normative', 'reference'], ['advisory', 'reference']];
  const pairs: { a: string; b: string; gt: boolean; near: boolean }[] = [];
  for (const m of MECHS) for (const [ra, rb] of combos) pairs.push({ a: `${m.id}::${ra}`, b: `${m.id}::${rb}`, gt: true, near: false });
  const seen = new Set<string>();
  for (const m of MECHS) { const s = [m.id, m.near_miss].sort().join('|'); if (seen.has(s)) continue; seen.add(s); for (const [ra, rb] of combos) pairs.push({ a: `${m.id}::${ra}`, b: `${m.near_miss}::${rb}`, gt: false, near: true }); }
  const withCos = pairs.map((p) => ({ ...p, c: cos(byKey.get(p.a)!.vec, byKey.get(p.b)!.vec) }));
  const ths = [...new Set(withCos.map((p) => p.c))].sort((a, b) => a - b);
  let bestBA = 0, bestNearSpec = 0;
  for (const th of ths) {
    const pred = (p: typeof withCos[0]) => p.c >= th;
    const tp = withCos.filter((p) => p.gt && pred(p)).length, fn = withCos.filter((p) => p.gt && !pred(p)).length;
    const fp = withCos.filter((p) => !p.gt && pred(p)).length, tn = withCos.filter((p) => !p.gt && !pred(p)).length;
    const ba = ((tp / (tp + fn || 1)) + (tn / (fp + tn || 1))) / 2;
    if (ba > bestBA) { bestBA = ba; const nr = withCos.filter((p) => p.near); bestNearSpec = nr.filter((p) => !pred(p)).length / (nr.length || 1); }
  }
  const pct = (x: number) => (100 * x).toFixed(0) + '%';
  console.log(`\n[${label}] prefix=${JSON.stringify(prefix)}`);
  console.log(`  embedding R@1 ${pct(embR1 / n)} R@3 ${pct(embR3 / n)}  |  BM25 R@1 ${pct(bmR1 / n)}  |  gap n=${gap} emb-R@1-on-gap ${pct(gap ? embR1gap / gap : 0)}`);
  console.log(`  cosine best-BA ${bestBA.toFixed(3)} near-miss-spec ${pct(bestNearSpec)}`);
}

async function main() {
  await runPrefix('raw (as pre-registered)', '');
  await runPrefix('search_document', 'search_document: ');
  await runPrefix('clustering', 'clustering: ');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
