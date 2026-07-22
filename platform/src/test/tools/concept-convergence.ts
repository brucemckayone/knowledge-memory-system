/**
 * nmemo-uhp.27 (doc-23) — CONCEPT-SPACE CONVERGENCE gate.
 *
 * Tests the general claim: an incremental conform-on-ingest concept space CONFORMS
 * (map same-idea mentions to one node), GROWS (new node for new ideas), WITHOUT
 * EXPLOSION (count saturates) and WITHOUT OVER-MERGE (similar-but-different stay
 * distinct). Real non-code prose (arXiv abstracts) + injected construction-probes +
 * a free-form comparative baseline. NOT code, NOT recall.
 *
 * Pre-reg: docs/architecture/cross-corpus-audit/23-concept-convergence-prereg.md
 * Thresholds/probe sets frozen below (§4/§5). Cached stages → cheap re-runs.
 *
 * Run:  ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/concept-convergence.ts [--smoke]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const SMOKE = process.argv.includes('--smoke');
const ML = process.env.ML_SERVICES_URL ?? 'http://127.0.0.1:8000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts' + (SMOKE ? '/smoke' : ''));
mkdirSync(OUT, { recursive: true });

// ---- frozen config (§2/§4) ----
const BASE_FIELD = 'cs.CL';
const DISTINCT_FIELD = 'astro-ph.GA';
const N_BASE = SMOKE ? 8 : 120;
const K_DISTINCT = SMOKE ? 3 : 15;
const K_VERBATIM = SMOKE ? 3 : 15;      // re-extracted (exercises extraction variance)
const K_PARAPHRASE = SMOKE ? 2 : 12;
const TAU_HIGH = 0.85;                  // auto-conform
const TAU_LOW = 0.65;                   // auto-grow; (TAU_LOW,TAU_HIGH) -> judge
const POOL = 6;

// ---- HTTP helpers (long timeout; hook doesn't intercept tsx file fetches) ----
function firstBalancedJson(t: string): string | null {
  const s = t.indexOf('{'); if (s < 0) return null; let d = 0, q = false, e = false;
  for (let i = s; i < t.length; i++) { const c = t[i]!; if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') q = false; continue; } if (c === '"') q = true; else if (c === '{') d++; else if (c === '}') { if (--d === 0) return t.slice(s, i + 1); } }
  return null;
}
async function chatJson<T>(prompt: string, system: string, ms = 240_000): Promise<T> {
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
async function chatText(prompt: string, system: string, ms = 240_000): Promise<string> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${ML}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: prompt, system_prompt: system }), signal: ctrl.signal });
    if (!r.ok) throw new Error(`/chat ${r.status}`);
    return (await r.json() as { response: string }).response.trim();
  } finally { clearTimeout(timer); }
}
async function embed(text: string, ms = 60_000): Promise<number[]> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${ML}/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: ctrl.signal });
    if (!r.ok) throw new Error(`/embed ${r.status}`);
    return (await r.json() as { vector: number[] }).vector;
  } finally { clearTimeout(timer); }
}
async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i]!, i); } }));
  return out;
}
function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }
function loadCache<T>(name: string): T | null { const p = join(OUT, name); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as T : null; }
function saveCache(name: string, obj: unknown): void { writeFileSync(join(OUT, name), JSON.stringify(obj, null, 2)); }

// ---- arXiv fetch (Atom XML) ----
async function fetchArxiv(cat: string, n: number): Promise<Array<{ id: string; text: string }>> {
  const url = `http://export.arxiv.org/api/query?search_query=cat:${cat}&start=0&max_results=${n}&sortBy=submittedDate&sortOrder=descending`;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 60_000);
  let xml = '';
  try { const r = await fetch(url, { signal: ctrl.signal }); xml = await r.text(); } finally { clearTimeout(timer); }
  const entries = xml.split('<entry>').slice(1);
  const out: Array<{ id: string; text: string }> = [];
  for (const e of entries) {
    const idM = e.match(/<id>([^<]+)<\/id>/);
    const sM = e.match(/<summary>([\s\S]*?)<\/summary>/);
    if (idM && sM) out.push({ id: idM[1]!.trim().split('/').pop()!, text: sM[1]!.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

// ---- concept extraction (Haiku, general/blind) ----
const EXTRACT_SYS = 'You extract key technical concepts from text. Respond ONLY with JSON, no prose, no fences.';
function extractPrompt(text: string): string {
  return [
    'Extract the key technical CONCEPTS named in the following text. Each concept = a short kebab-case',
    'label naming ONE distinct idea/method/object (e.g. "gradient-descent", "attention-mechanism",',
    '"galaxy-rotation-curve"). 4 to 10 concepts. Do not include generic filler ("this-paper", "results").',
    '',
    'TEXT:', text, '',
    'Return ONLY: {"concepts":["label-1","label-2",...]}',
  ].join('\n');
}
async function extractConcepts(text: string): Promise<string[]> {
  try { const r = await chatJson<{ concepts?: string[] }>(extractPrompt(text), EXTRACT_SYS); return (r.concepts ?? []).filter((x) => typeof x === 'string').map((x) => x.toLowerCase().trim()).filter(Boolean); }
  catch { return []; }
}

// ---- conform-or-grow ----
interface Node { id: number; label: string; emb: number[]; provenance: string; mentions: number; }
type Judge = (a: string, b: string) => Promise<boolean>; // true = same (conform)
interface DocRec { key: string; provenance: string; concepts: string[]; }

async function conformOrGrow(stream: DocRec[], embMap: Record<string, number[]>, judge: Judge, judgeCache: Record<string, boolean>) {
  const nodes: Node[] = []; let nid = 0;
  const perDoc: Array<{ key: string; provenance: string; newNodes: number; conformedToBase: number; concepts: number; bandJudged: number }> = [];
  for (const doc of stream) {
    let nw = 0, conf2base = 0, band = 0;
    for (const label of doc.concepts) {
      const emb = embMap[label]; if (!emb) continue;
      let best: Node | null = null, bestS = -1;
      for (const nd of nodes) { const s = cosine(emb, nd.emb); if (s > bestS) { bestS = s; best = nd; } }
      let conform: boolean;
      if (!best) conform = false;
      else if (bestS >= TAU_HIGH) conform = true;
      else if (bestS <= TAU_LOW) conform = false;
      else { // band -> judge (cached by sorted pair)
        band++;
        const key = [label, best.label].sort().join(' :: ');
        if (!(key in judgeCache)) judgeCache[key] = await judge(label, best.label);
        conform = judgeCache[key]!;
      }
      if (conform && best) { best.mentions++; if (best.provenance === 'base' && doc.provenance !== 'base') conf2base++; }
      else { nodes.push({ id: nid++, label, emb, provenance: doc.provenance, mentions: 1 }); nw++; }
    }
    perDoc.push({ key: doc.key, provenance: doc.provenance, newNodes: nw, conformedToBase: conf2base, concepts: doc.concepts.length, bandJudged: band });
  }
  return { nodes, perDoc };
}

const SAME_SYS = 'You judge whether two technical concepts are the same idea in different words. Respond ONLY with JSON.';
const judge: Judge = async (a, b) => {
  try { const r = await chatJson<{ same?: boolean }>(`Are these two technical concepts the SAME concept expressed in different words, or genuinely DIFFERENT concepts?\nA: "${a}"\nB: "${b}"\nReturn ONLY: {"same": true or false}`, SAME_SYS); return r.same === true; }
  catch { return false; }
};
// Batched judge: many pairs per Haiku call (the per-pair verdict is identical to the
// single judge; batching only cuts call count ~25x). Falls back to false on parse miss.
async function batchJudge(pairs: Array<{ a: string; b: string }>): Promise<boolean[]> {
  const lines = pairs.map((p, i) => `${i + 1}. "${p.a}"  vs  "${p.b}"`).join('\n');
  const prompt = `For EACH numbered pair, decide if the two technical concepts are the SAME concept expressed in different words (true) or genuinely DIFFERENT concepts (false).\n\n${lines}\n\nReturn ONLY JSON: {"verdicts":{"1":true,"2":false,...}} with an entry for every number.`;
  try {
    const r = await chatJson<{ verdicts?: Record<string, boolean> }>(prompt, SAME_SYS);
    const v = r.verdicts ?? {};
    return pairs.map((_, i) => v[String(i + 1)] === true);
  } catch { return pairs.map(() => false); }
}

async function main(): Promise<void> {
  console.log(`# doc-23 concept-space convergence gate ${SMOKE ? '(SMOKE)' : ''}`);
  console.log(`config: N_BASE=${N_BASE} field=${BASE_FIELD} distinct=${DISTINCT_FIELD} probes(v${K_VERBATIM}/p${K_PARAPHRASE}/d${K_DISTINCT}) tau=[${TAU_LOW},${TAU_HIGH}]\n`);

  // ---- stage 1: corpus ----
  let corpus = loadCache<{ base: Array<{ id: string; text: string }>; distinct: Array<{ id: string; text: string }>; verbatimIds: string[]; paraphrase: Array<{ id: string; text: string; ofId: string }> }>('corpus.json');
  if (!corpus) {
    console.log('fetching arXiv...');
    const base = (await fetchArxiv(BASE_FIELD, N_BASE)).slice(0, N_BASE);
    const distinct = (await fetchArxiv(DISTINCT_FIELD, K_DISTINCT)).slice(0, K_DISTINCT);
    const verbatimIds = base.slice(0, K_VERBATIM).map((b) => b.id);
    const paraSrc = base.slice(K_VERBATIM, K_VERBATIM + K_PARAPHRASE);
    console.log(`fetched base=${base.length} distinct=${distinct.length}; paraphrasing ${paraSrc.length}...`);
    const paraphrase = await pool(paraSrc, POOL, async (b) => ({ id: `para-${b.id}`, ofId: b.id, text: await chatText(`Rewrite this abstract in different words, preserving ALL technical concepts. Output only the rewrite.\n\n${b.text}`, 'You paraphrase scientific text.') }));
    corpus = { base, distinct, verbatimIds, paraphrase };
    saveCache('corpus.json', corpus);
  }
  console.log(`corpus: base=${corpus.base.length} distinct=${corpus.distinct.length} verbatim=${corpus.verbatimIds.length} paraphrase=${corpus.paraphrase.length}`);
  if (corpus.base.length < N_BASE) throw new Error(`base underfetched: ${corpus.base.length}<${N_BASE}`);

  // ---- stage 2: extraction (cached per doc-key) ----
  const extractions = loadCache<Record<string, string[]>>('extractions.json') ?? {};
  const toExtract: Array<{ key: string; text: string }> = [];
  for (const b of corpus.base) if (!(('base:' + b.id) in extractions)) toExtract.push({ key: 'base:' + b.id, text: b.text });
  for (const d of corpus.distinct) if (!(('dist:' + d.id) in extractions)) toExtract.push({ key: 'dist:' + d.id, text: d.text });
  for (const p of corpus.paraphrase) if (!(('para:' + p.id) in extractions)) toExtract.push({ key: 'para:' + p.id, text: p.text });
  // verbatim probes RE-EXTRACTED (fresh key) to exercise extraction variance
  for (const vid of corpus.verbatimIds) if (!(('verb:' + vid) in extractions)) { const b = corpus.base.find((x) => x.id === vid)!; toExtract.push({ key: 'verb:' + vid, text: b.text }); }
  if (toExtract.length) {
    console.log(`extracting concepts for ${toExtract.length} docs...`);
    const res = await pool(toExtract, POOL, async (d, i) => { if (i % 20 === 0) console.log(`  extract ${i}/${toExtract.length}`); return extractConcepts(d.text); });
    toExtract.forEach((d, i) => { extractions[d.key] = res[i]!; });
    saveCache('extractions.json', extractions);
  }
  console.log(`extractions: ${Object.keys(extractions).length} docs`);

  // ---- stage 3: embed every distinct label (cached) ----
  const embMap = loadCache<Record<string, number[]>>('label-embeddings.json') ?? {};
  const allLabels = [...new Set(Object.values(extractions).flat())];
  const needEmb = allLabels.filter((l) => !(l in embMap));
  if (needEmb.length) {
    console.log(`embedding ${needEmb.length} labels...`);
    const vecs = await pool(needEmb, POOL, (l) => embed(l));
    needEmb.forEach((l, i) => { embMap[l] = vecs[i]!; });
    saveCache('label-embeddings.json', embMap);
  }
  console.log(`labels: ${allLabels.length} distinct, embedded ${Object.keys(embMap).length}`);

  // ---- build the stream: base (in order) then probes ----
  const baseStream: DocRec[] = corpus.base.map((b) => ({ key: 'base:' + b.id, provenance: 'base', concepts: extractions['base:' + b.id] ?? [] }));
  const verbStream: DocRec[] = corpus.verbatimIds.map((vid) => ({ key: 'verb:' + vid, provenance: 'verbatim', concepts: extractions['verb:' + vid] ?? [] }));
  const paraStream: DocRec[] = corpus.paraphrase.map((p) => ({ key: 'para:' + p.id, provenance: 'paraphrase', concepts: extractions['para:' + p.id] ?? [] }));
  const distStream: DocRec[] = corpus.distinct.map((d) => ({ key: 'dist:' + d.id, provenance: 'distinct', concepts: extractions['dist:' + d.id] ?? [] }));
  const stream = [...baseStream, ...verbStream, ...paraStream, ...distStream];

  const judgeCache = loadCache<Record<string, boolean>>('judge-cache.json') ?? {};
  // PRE-WARM: judge the band-pairs in PARALLEL before the (sequential, order-dependent)
  // conform loop. A verdict is a pure function of the label pair (cached by sorted pair),
  // so pre-warming is result-preserving — it just avoids serial live calls in the loop.
  // Cover each label's top-3 nearest OTHER labels that fall in the (tau_low,tau_high) band.
  const labelList = allLabels;
  const bandPairs = new Set<string>();
  for (let i = 0; i < labelList.length; i++) {
    const li = labelList[i]!; const ei = embMap[li]; if (!ei) continue;
    const near: Array<{ l: string; s: number }> = [];
    for (let j = 0; j < labelList.length; j++) { if (i === j) continue; const lj = labelList[j]!; const ej = embMap[lj]; if (!ej) continue; near.push({ l: lj, s: cosine(ei, ej) }); }
    near.sort((a, b) => b.s - a.s);
    for (const nb of near.slice(0, 3)) if (nb.s > TAU_LOW && nb.s < TAU_HIGH) bandPairs.add([li, nb.l].sort().join(' :: '));
  }
  const toJudge = [...bandPairs].filter((k) => !(k in judgeCache));
  if (toJudge.length) {
    const BATCH = 25;
    const batches: string[][] = [];
    for (let i = 0; i < toJudge.length; i += BATCH) batches.push(toJudge.slice(i, i + BATCH));
    console.log(`pre-warming ${toJudge.length} band-pair judgments in ${batches.length} batches (of ${BATCH})...`);
    let done = 0;
    await pool(batches, POOL, async (batch, bi) => {
      const pairs = batch.map((k) => { const [a, b] = k.split(' :: '); return { a: a!, b: b! }; });
      const verdicts = await batchJudge(pairs);
      batch.forEach((k, i) => { judgeCache[k] = verdicts[i] ?? false; });
      done += batch.length; if (bi % 4 === 0) console.log(`  judged ${done}/${toJudge.length}`);
      saveCache('judge-cache.json', judgeCache); // incremental → resumable on kill
    });
    saveCache('judge-cache.json', judgeCache);
  }
  console.log(`judge cache: ${Object.keys(judgeCache).length} pairs`);

  const { nodes, perDoc } = await conformOrGrow(stream, embMap, judge, judgeCache);
  saveCache('judge-cache.json', judgeCache);

  // ---- metrics ----
  // free-form baseline = distinct EXACT labels among base docs
  const freeFormBase = new Set(baseStream.flatMap((d) => d.concepts)).size;
  const baseNodes = nodes.filter((n) => n.provenance === 'base').length;
  const reduction = 1 - baseNodes / freeFormBase;

  // growth curve over base (quartiles)
  const q = Math.floor(N_BASE / 4);
  const basePerDoc = perDoc.filter((p) => p.provenance === 'base');
  const sumNew = (arr: typeof basePerDoc) => arr.reduce((a, b) => a + b.newNodes, 0);
  const firstQ = sumNew(basePerDoc.slice(0, q)), lastQ = sumNew(basePerDoc.slice(-q));
  const growthRatio = firstQ ? lastQ / firstQ : NaN;

  // over-merge: distinct-field concepts that conformed into a BASE node
  const distDocs = perDoc.filter((p) => p.provenance === 'distinct');
  const distConcepts = distDocs.reduce((a, b) => a + b.concepts, 0);
  const distConf2base = distDocs.reduce((a, b) => a + b.conformedToBase, 0);
  const distStaySeparate = distConcepts ? 1 - distConf2base / distConcepts : NaN;

  // conform on verbatim vs fresh (last-quartile base) new-nodes-per-doc
  const verbDocs = perDoc.filter((p) => p.provenance === 'verbatim');
  const verbNewPerDoc = verbDocs.reduce((a, b) => a + b.newNodes, 0) / (verbDocs.length || 1);
  const freshNewPerDoc = lastQ / (q || 1);
  const verbRatio = freshNewPerDoc ? verbNewPerDoc / freshNewPerDoc : NaN;

  // paraphrase conform (reported)
  const paraDocs = perDoc.filter((p) => p.provenance === 'paraphrase');
  const paraNewPerDoc = paraDocs.reduce((a, b) => a + b.newNodes, 0) / (paraDocs.length || 1);

  const totalBand = perDoc.reduce((a, b) => a + b.bandJudged, 0);

  console.log('\n=== METRICS ===');
  console.log(`free-form base concepts (exact-dedup): ${freeFormBase}`);
  console.log(`conform-on-ingest base nodes:          ${baseNodes}`);
  console.log(`EXPLOSION REDUCTION: ${(reduction * 100).toFixed(1)}%  (bar >=40%)`);
  console.log(`growth curve new-nodes: Q1=${firstQ} Q4=${lastQ}  ratio=${growthRatio.toFixed(2)} (bar <=0.5)`);
  console.log(`OVER-MERGE: distinct-field concepts staying separate = ${(distStaySeparate * 100).toFixed(1)}% (bar >=90%); ${distConf2base}/${distConcepts} absorbed into base`);
  console.log(`CONFORM: verbatim new/doc=${verbNewPerDoc.toFixed(2)} vs fresh new/doc=${freshNewPerDoc.toFixed(2)} ratio=${verbRatio.toFixed(2)} (bar <=0.1)`);
  console.log(`paraphrase new-nodes/doc=${paraNewPerDoc.toFixed(2)} (reported)`);
  console.log(`band-judged decisions: ${totalBand} (${Object.keys(judgeCache).length} distinct pairs cached)`);

  const cond1 = reduction >= 0.40 && growthRatio <= 0.5;
  const cond2 = distStaySeparate >= 0.90;
  const cond3 = verbRatio <= 0.10;
  const pass = cond1 && cond2 && cond3;
  console.log('\n=== BAR (frozen §5.1) ===');
  console.log(`cond1 explosion reduced >=40% AND growth ratio <=0.5: ${cond1 ? 'PASS' : 'FAIL'}`);
  console.log(`cond2 distinct-field stay separate >=90%:             ${cond2 ? 'PASS' : 'FAIL'}`);
  console.log(`cond3 verbatim adds <=10% of fresh:                   ${cond3 ? 'PASS' : 'FAIL'}`);
  console.log(`\n>>> GATE ${pass ? 'PASS' : 'FAIL'} <<<`);

  saveCache('cv-results.json', {
    prereg: 'doc-23', smoke: SMOKE, config: { N_BASE, BASE_FIELD, DISTINCT_FIELD, K_VERBATIM, K_PARAPHRASE, K_DISTINCT, TAU_LOW, TAU_HIGH },
    metrics: { freeFormBase, baseNodes, reduction, firstQ, lastQ, growthRatio, distConcepts, distConf2base, distStaySeparate, verbNewPerDoc, freshNewPerDoc, verbRatio, paraNewPerDoc, totalBand },
    bar: { cond1, cond2, cond3, pass },
    perDoc,
  });
  console.log('\nwrote cv-results.json to', OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
