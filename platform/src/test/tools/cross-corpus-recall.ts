/**
 * doc-28 — cross-corpus concept-JOIN recall gate.
 * Build ONE shared concept space over corpus A (NLP) + B (CV) with the validated Arm R mechanism
 * (relevance-window controlled-vocab extraction, K=100, shared vocab), then compare cross-corpus retrieval:
 *   concept-JOIN (IDF-weighted shared-node overlap) vs embedding (nomic cosine) vs BM25 vs RRF.
 * Ground truth = external OpenAlex concepts (unseen by extraction), shared at level>=L (L frozen from §5 sweep).
 *
 * Run: ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/cross-corpus-recall.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ML = process.env.ML_SERVICES_URL ?? 'http://127.0.0.1:8000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const REL_K = 100;            // Arm R relevance window (doc-25/27)
const L_PRIMARY = 2;          // frozen per doc-28 §5 sweep (only L with median>=3 AND >=60% coverage)
const L_SENS = 3;             // sparse sensitivity
const SCORE_MIN = 0.3;
const K1 = 1.2, B = 0.75, RRF_K = 60;
const SPLIT = new Set(['C204321447', 'C31972630']);

function load<T>(name: string): T | null { const p = join(OUT, name); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as T : null; }
function save(name: string, obj: unknown): void { writeFileSync(join(OUT, name), JSON.stringify(obj, null, 2)); }
function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }

// ---- extraction (COPIED VERBATIM from concept-convergence-v2.ts Arm R) ----
function firstBalancedJson(t: string): string | null { const s = t.indexOf('{'); if (s < 0) return null; let d = 0, q = false, e = false; for (let i = s; i < t.length; i++) { const c = t[i]!; if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') q = false; continue; } if (c === '"') q = true; else if (c === '{') d++; else if (c === '}') { if (--d === 0) return t.slice(s, i + 1); } } return null; }
async function chatJson<T>(prompt: string, system: string, ms = 150_000): Promise<T> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${ML}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: prompt, system_prompt: system }), signal: ctrl.signal });
    if (!r.ok) throw new Error(`/chat ${r.status}`);
    const raw = (await r.json() as { response: string }).response;
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    for (const c of [cleaned, firstBalancedJson(raw)].filter((x): x is string => !!x)) { try { return JSON.parse(c) as T; } catch { /* next */ } }
    throw new Error(`unparseable: ${raw.slice(0, 120)}`);
  } finally { clearTimeout(timer); }
}
async function embed(text: string, ms = 60_000): Promise<number[]> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(`${ML}/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: ctrl.signal }); if (!r.ok) throw new Error(`/embed ${r.status}`); return (await r.json() as { vector: number[] }).vector; } finally { clearTimeout(timer); }
}
const VOCAB_SYS = 'You extract key technical concepts and MAINTAIN A CONTROLLED VOCABULARY. Respond ONLY with JSON, no prose, no fences.';
function vocabPrompt(text: string, vocab: string[]): string {
  const vlist = vocab.length ? vocab.join('\n') : '(empty — this is the first document)';
  return ['You are building a shared concept vocabulary across many documents. Below is the EXISTING vocabulary',
    '(concept labels already in use), then a NEW document.', '', 'EXISTING VOCABULARY:', vlist, '',
    'DOCUMENT:', text, '', 'Extract the key technical concepts named in the DOCUMENT (4 to 10). For EACH concept:',
    '- If the SAME concept already exists in the vocabulary, reuse that EXACT label (copy it verbatim).',
    '- Only if no existing label fits, coin a NEW short kebab-case label.',
    'Do not include generic filler ("this-paper","results").', '', 'Return ONLY: {"concepts":["label-1","label-2",...]}'].join('\n');
}
async function extractSeeded(text: string, vocab: string[]): Promise<string[]> {
  try { const r = await chatJson<{ concepts?: string[] }>(vocabPrompt(text, vocab), VOCAB_SYS); return (r.concepts ?? []).filter((x) => typeof x === 'string').map((x) => x.toLowerCase().trim()).filter(Boolean); }
  catch { return []; }
}

interface Doc { id: string; title: string; abstract: string; concepts: Array<{ id: string; display_name: string; level: number; score: number }>; }
const docText = (d: Doc) => `${d.title}. ${d.abstract}`;

// ---- BM25 ----
const STOP = new Set('the a an of to in and or for with on is are be this that we our their they it as by from at using use based can which such more most also into than then them these those our can not our approach method model results using between within'.split(' '));
function tok(s: string): string[] { return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)); }
function bm25Scorer(corpus: string[][]) {
  const N = corpus.length; const df = new Map<string, number>();
  for (const d of corpus) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const avgdl = corpus.reduce((s, d) => s + d.length, 0) / N;
  const tf = corpus.map((d) => { const m = new Map<string, number>(); for (const t of d) m.set(t, (m.get(t) ?? 0) + 1); return m; });
  return (qi: number, di: number): number => {
    let s = 0; const dl = corpus[di]!.length;
    for (const t of new Set(corpus[qi]!)) { const f = tf[di]!.get(t) ?? 0; if (!f) continue; s += idf(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / avgdl)); }
    return s;
  };
}

function recallAtK(ranked: number[], related: Set<number>, k: number): number { if (!related.size) return NaN; let hit = 0; for (let i = 0; i < Math.min(k, ranked.length); i++) if (related.has(ranked[i]!)) hit++; return hit / related.size; }
function mrr(ranked: number[], related: Set<number>): number { for (let i = 0; i < ranked.length; i++) if (related.has(ranked[i]!)) return 1 / (i + 1); return 0; }
function mean(a: number[]): number { return a.reduce((x, y) => x + y, 0) / a.length; }

async function main(): Promise<void> {
  const A = load<Doc[]>('corpus-A.json')!, Bc = load<Doc[]>('corpus-B.json')!;
  const docs = [...A.map((d) => ({ ...d, side: 'A' as const })), ...Bc.map((d) => ({ ...d, side: 'B' as const }))];
  // interleave A,B by rank so neither seeds the vocab first
  const stream: typeof docs = []; for (let i = 0; i < Math.max(A.length, Bc.length); i++) { if (i < A.length) stream.push({ ...A[i]!, side: 'A' }); if (i < Bc.length) stream.push({ ...Bc[i]!, side: 'B' }); }
  const key = (d: { side: string; id: string }) => `${d.side}:${d.id}`;

  // ---- build shared concept space (Arm R mechanism) ----
  const seeded = load<Record<string, string[]>>('cc-seeded.json') ?? {};
  const docEmb = load<Record<string, number[]>>('cc-docemb.json') ?? {};
  const labelEmb = load<Record<string, number[]>>('cc-labelemb.json') ?? {};
  const vocab: string[] = []; const vset = new Set<string>();
  let di = 0;
  for (const d of stream) {
    const k = key(d);
    if (di % 20 === 0) console.log(`  [extract] ${di}/${stream.length} vocab=${vocab.length}`);
    di++;
    if (!docEmb[k]) { docEmb[k] = await embed(docText(d)); save('cc-docemb.json', docEmb); }
    const de = docEmb[k]!;
    let window: string[];
    if (vocab.length <= REL_K) window = [...vocab];
    else window = vocab.filter((l) => labelEmb[l]).map((l) => ({ l, s: cosine(de, labelEmb[l]!) })).sort((a, b) => b.s - a.s).slice(0, REL_K).map((x) => x.l);
    let labels = seeded[k];
    if (!labels) { labels = await extractSeeded(docText(d), window); seeded[k] = labels; save('cc-seeded.json', seeded); }
    for (const label of labels) if (!vset.has(label)) { vocab.push(label); vset.add(label); if (!labelEmb[label]) { labelEmb[label] = await embed(label); save('cc-labelemb.json', labelEmb); } }
  }
  save('cc-labelemb.json', labelEmb);
  console.log(`shared vocab size: ${vocab.length}`);

  // ---- our concept nodes per doc + IDF ----
  const nodesOf = new Map<string, Set<string>>(); docs.forEach((d) => nodesOf.set(key(d), new Set(seeded[key(d)] ?? [])));
  const Ndoc = docs.length; const df = new Map<string, number>();
  for (const d of docs) for (const c of nodesOf.get(key(d))!) df.set(c, (df.get(c) ?? 0) + 1);
  const idfNode = (c: string) => Math.log(Ndoc / (df.get(c) ?? 1));

  // ---- ground truth (external oracle) ----
  const oracleAt = (d: Doc, L: number) => new Set(d.concepts.filter((c) => c.level >= L && c.level >= 2 && c.score >= SCORE_MIN && !SPLIT.has(c.id)).map((c) => c.id));
  function relatedMatrix(qs: Doc[], cs: Doc[], L: number): Set<number>[] {
    const cSets = cs.map((d) => oracleAt(d, L));
    return qs.map((q) => { const qc = oracleAt(q, L); const r = new Set<number>(); cSets.forEach((cc, j) => { for (const c of qc) if (cc.has(c)) { r.add(j); break; } }); return r; });
  }

  // ---- arms: given query index qi (side S) over candidate list (other side), return ranked candidate indices ----
  const aText = A.map(docText), bText = Bc.map(docText);
  const aTok = aText.map(tok), bTok = bText.map(tok);
  const bm25_AtoB = bm25Scorer(bTok), bm25_BtoA = bm25Scorer(aTok);
  const eA = A.map((d) => docEmb[`A:${d.id}`]!), eB = Bc.map((d) => docEmb[`B:${d.id}`]!);
  const nA = A.map((d) => nodesOf.get(`A:${d.id}`)!), nB = Bc.map((d) => nodesOf.get(`B:${d.id}`)!);
  const joinScore = (qn: Set<string>, cn: Set<string>) => { let s = 0; for (const c of qn) if (cn.has(c)) s += idfNode(c); return s; };
  const rankBy = (score: (j: number) => number, m: number): number[] => Array.from({ length: m }, (_, j) => j).sort((x, y) => (score(y) - score(x)) || 0);
  const rankJoinTieAgainst = (qn: Set<string>, cn: Set<string>[], related: Set<number>): number[] => {
    // ties broken AGAINST join: among equal scores, related items go last
    return Array.from({ length: cn.length }, (_, j) => j).sort((x, y) => { const dz = joinScore(qn, cn[y]!) - joinScore(qn, cn[x]!); if (dz) return dz; const rx = related.has(x) ? 1 : 0, ry = related.has(y) ? 1 : 0; return rx - ry; });
  };
  const rrf = (r1: number[], r2: number[], m: number): number[] => { const s = new Array(m).fill(0); r1.forEach((c, i) => s[c] += 1 / (RRF_K + i + 1)); r2.forEach((c, i) => s[c] += 1 / (RRF_K + i + 1)); return Array.from({ length: m }, (_, j) => j).sort((x, y) => s[y] - s[x]); };

  function runDirection(qs: Doc[], cs: Doc[], qEmb: number[][], cEmb: number[][], qNodes: Set<string>[], cNodes: Set<string>[], bm25: (qi: number, di: number) => number, L: number) {
    const related = relatedMatrix(qs, cs, L);
    const rows: Array<{ join: number[]; emb: number[]; bm: number[]; rrf: number[]; rel: Set<number> }> = [];
    qs.forEach((_, qi) => {
      const rel = related[qi]!; if (!rel.size) return;
      const rJoin = rankJoinTieAgainst(qNodes[qi]!, cNodes, rel);
      const rEmb = rankBy((j) => cosine(qEmb[qi]!, cEmb[j]!), cs.length);
      const rBm = rankBy((j) => bm25(qi, j), cs.length);
      const rRrf = rrf(rJoin, rEmb, cs.length);
      rows.push({ join: rJoin, emb: rEmb, bm: rBm, rrf: rRrf, rel });
    });
    return rows;
  }

  const report: any = { prereg: 'doc-28', vocabSize: vocab.length, Ndoc, levels: {} };
  for (const L of [L_PRIMARY, L_SENS]) {
    const ab = runDirection(A, Bc, eA, eB, nA, nB, bm25_AtoB, L);
    const ba = runDirection(Bc, A, eB, eA, nB, nA, bm25_BtoA, L);
    const rows = [...ab, ...ba];
    const arms = ['join', 'emb', 'bm', 'rrf'] as const;
    const metric = (name: 'r10' | 'r5' | 'mrr', arm: typeof arms[number]) => mean(rows.map((r) => name === 'mrr' ? mrr(r[arm], r.rel) : recallAtK(r[arm], r.rel, name === 'r10' ? 10 : 5)));
    // paired bootstrap CI for diffs on recall@10
    const perQ = (arm: typeof arms[number]) => rows.map((r) => recallAtK(r[arm], r.rel, 10));
    const jv = perQ('join'), ev = perQ('emb'), bv = perQ('bm');
    function bootCI(x: number[], y: number[]): [number, number] {
      const n = x.length; const diffs: number[] = [];
      let seed = 28 * 1000 + n;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let b = 0; b < 10000; b++) { let s = 0; for (let i = 0; i < n; i++) { const idx = Math.floor(rnd() * n); s += x[idx]! - y[idx]!; } diffs.push(s / n); }
      diffs.sort((a, c) => a - c); return [diffs[250]!, diffs[9750]!];
    }
    report.levels[`L>=${L}`] = {
      queries: rows.length, medRelated: (() => { const c = rows.map((r) => r.rel.size).sort((a, b) => a - b); return c[Math.floor(c.length / 2)]; })(),
      recall10: Object.fromEntries(arms.map((a) => [a, +metric('r10', a).toFixed(4)])),
      recall5: Object.fromEntries(arms.map((a) => [a, +metric('r5', a).toFixed(4)])),
      mrr: Object.fromEntries(arms.map((a) => [a, +metric('mrr', a).toFixed(4)])),
      diffCI10: { 'join-bm': bootCI(jv, bv).map((v) => +v.toFixed(4)), 'join-emb': bootCI(jv, ev).map((v) => +v.toFixed(4)) },
    };
  }
  // persist rankings for adversary (compact: store per-query related + top-20 of each arm at L_PRIMARY)
  save('cc-recall-result.json', report);
  console.log('\n=== CROSS-CORPUS RECALL ===');
  console.log(JSON.stringify(report.levels, null, 2));
  console.log('=== END ===');
}
main().catch((e) => { console.error(e); process.exit(1); });
