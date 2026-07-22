/**
 * nmemo-r0o (doc-24) — CONVERGENCE MECHANISM BAKE-OFF.
 *
 * Same frozen corpus (convergence-artifacts/corpus.json) + same probe oracle +
 * same doc-23 §5.1 bars. Only the MECHANISM varies across arms:
 *   --arm 0  control (doc-23 naive): free-form label extraction, bare-label
 *            embedding, first-mention identity, tau=[0.65,0.85], top-3 band judge.
 *   --arm A  description-embedding: free-form {label,gloss} extraction, embed the
 *            GLOSS not the label; everything else = arm 0.
 *   --arm B  controlled-vocabulary extraction (sequential): each doc sees the
 *            current vocabulary V and reuses existing labels or coins new ones;
 *            conform = exact label match. No embedding/threshold/judge in the loop.
 *
 * Pre-reg: docs/architecture/cross-corpus-audit/24-convergence-mechanisms-prereg.md
 * Bars inherited verbatim from doc-23 §5.1. Per-arm artifacts cached → resumable.
 *
 * Run: ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/concept-convergence-v2.ts --arm B
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const ARM = (() => { const i = process.argv.indexOf('--arm'); return i >= 0 ? (process.argv[i + 1] ?? '0') : '0'; })();
if (!['0', 'A', 'B', 'R'].includes(ARM)) { console.error(`bad --arm ${ARM}`); process.exit(1); }
const ML = process.env.ML_SERVICES_URL ?? 'http://127.0.0.1:8000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
mkdirSync(OUT, { recursive: true });

// ---- frozen config (inherited from doc-23) ----
const N_BASE = 120;
const TAU_HIGH = 0.85;
const TAU_LOW = 0.65;
const POOL = 6;
const VOCAB_CAP = 500; // arm B: MRU labels passed to the extractor
const REL_K = 100;     // arm R: relevance-window size (top-K nearest existing labels by embedding)

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

// ---- corpus (frozen; no re-fetch — pre-reg §1) ----
interface Corpus { base: Array<{ id: string; text: string }>; distinct: Array<{ id: string; text: string }>; verbatimIds: string[]; paraphrase: Array<{ id: string; text: string; ofId: string }>; }

// ---- shared types ----
interface DocRec { key: string; provenance: string; text: string; concepts: Array<{ label: string; embKey: string }>; }
interface PerDoc { key: string; provenance: string; newNodes: number; conformedToBase: number; concepts: number; bandJudged?: number; }

// ---- free-form extraction (arm 0) ----
const EXTRACT_SYS = 'You extract key technical concepts from text. Respond ONLY with JSON, no prose, no fences.';
function extractPrompt(text: string): string {
  return ['Extract the key technical CONCEPTS named in the following text. Each concept = a short kebab-case',
    'label naming ONE distinct idea/method/object (e.g. "gradient-descent", "attention-mechanism",',
    '"galaxy-rotation-curve"). 4 to 10 concepts. Do not include generic filler ("this-paper", "results").',
    '', 'TEXT:', text, '', 'Return ONLY: {"concepts":["label-1","label-2",...]}'].join('\n');
}
async function extractConcepts(text: string): Promise<string[]> {
  try { const r = await chatJson<{ concepts?: string[] }>(extractPrompt(text), EXTRACT_SYS); return (r.concepts ?? []).filter((x) => typeof x === 'string').map((x) => x.toLowerCase().trim()).filter(Boolean); }
  catch { return []; }
}

// ---- glossed extraction (arm A) ----
const GLOSS_SYS = 'You extract key technical concepts and define each. Respond ONLY with JSON, no prose, no fences.';
function glossPrompt(text: string): string {
  return ['Extract the key technical CONCEPTS named in the following text. For EACH concept give a short',
    'kebab-case label naming ONE distinct idea/method/object AND a one-sentence definition ("gloss") of the',
    'concept AS USED IN THIS TEXT. 4 to 10 concepts. No generic filler.',
    '', 'TEXT:', text, '', 'Return ONLY: {"concepts":[{"label":"attention-mechanism","gloss":"a mechanism that weights..."},...]}'].join('\n');
}
async function extractGlossed(text: string): Promise<Array<{ label: string; gloss: string }>> {
  try {
    const r = await chatJson<{ concepts?: Array<{ label?: string; gloss?: string }> }>(glossPrompt(text), GLOSS_SYS);
    return (r.concepts ?? []).map((c) => ({ label: String(c.label ?? '').toLowerCase().trim(), gloss: String(c.gloss ?? '').trim() })).filter((c) => c.label && c.gloss);
  } catch { return []; }
}

// ---- vocabulary-seeded extraction (arm B) ----
const VOCAB_SYS = 'You extract key technical concepts and MAINTAIN A CONTROLLED VOCABULARY. Respond ONLY with JSON, no prose, no fences.';
function vocabPrompt(text: string, vocab: string[]): string {
  const vlist = vocab.length ? vocab.join('\n') : '(empty — this is the first document)';
  return ['You are building a shared concept vocabulary across many documents. Below is the EXISTING vocabulary',
    '(concept labels already in use), then a NEW document.', '',
    'EXISTING VOCABULARY:', vlist, '',
    'DOCUMENT:', text, '',
    'Extract the key technical concepts named in the DOCUMENT (4 to 10). For EACH concept:',
    '- If the SAME concept already exists in the vocabulary, reuse that EXACT label (copy it verbatim).',
    '- Only if no existing label fits, coin a NEW short kebab-case label.',
    'Do not include generic filler ("this-paper","results").', '',
    'Return ONLY: {"concepts":["label-1","label-2",...]}'].join('\n');
}
async function extractSeeded(text: string, vocab: string[]): Promise<string[]> {
  try { const r = await chatJson<{ concepts?: string[] }>(vocabPrompt(text, vocab), VOCAB_SYS); return (r.concepts ?? []).filter((x) => typeof x === 'string').map((x) => x.toLowerCase().trim()).filter(Boolean); }
  catch { return []; }
}

// ---- band judge (arms 0/A) — pure function of the label pair ----
const SAME_SYS = 'You judge whether two technical concepts are the same idea in different words. Respond ONLY with JSON.';
async function batchJudge(pairs: Array<{ a: string; b: string }>): Promise<boolean[]> {
  const lines = pairs.map((p, i) => `${i + 1}. "${p.a}"  vs  "${p.b}"`).join('\n');
  const prompt = `For EACH numbered pair, decide if the two technical concepts are the SAME concept expressed in different words (true) or genuinely DIFFERENT concepts (false).\n\n${lines}\n\nReturn ONLY JSON: {"verdicts":{"1":true,"2":false,...}} with an entry for every number.`;
  try { const r = await chatJson<{ verdicts?: Record<string, boolean> }>(prompt, SAME_SYS); const v = r.verdicts ?? {}; return pairs.map((_, i) => v[String(i + 1)] === true); }
  catch { return pairs.map(() => false); }
}

// ---- embedding-based conform/grow (arms 0/A) ----
interface ENode { id: number; label: string; emb: number[]; provenance: string; mentions: number; }
async function conformOrGrowEmb(stream: DocRec[], embMap: Record<string, number[]>, judgeCache: Record<string, boolean>): Promise<{ perDoc: PerDoc[]; nodes: ENode[] }> {
  const nodes: ENode[] = []; let nid = 0; const perDoc: PerDoc[] = [];
  for (const doc of stream) {
    let nw = 0, conf2base = 0, band = 0;
    for (const { label, embKey } of doc.concepts) {
      const emb = embMap[embKey]; if (!emb) continue;
      let best: ENode | null = null, bestS = -1;
      for (const nd of nodes) { const s = cosine(emb, nd.emb); if (s > bestS) { bestS = s; best = nd; } }
      let conform: boolean;
      if (!best) conform = false;
      else if (bestS >= TAU_HIGH) conform = true;
      else if (bestS <= TAU_LOW) conform = false;
      else { band++; const key = [label, best.label].sort().join(' :: '); if (!(key in judgeCache)) judgeCache[key] = (await batchJudge([{ a: label, b: best.label }]))[0] ?? false; conform = judgeCache[key]!; }
      if (conform && best) { best.mentions++; if (best.provenance === 'base' && doc.provenance !== 'base') conf2base++; }
      else { nodes.push({ id: nid++, label, emb, provenance: doc.provenance, mentions: 1 }); nw++; }
    }
    perDoc.push({ key: doc.key, provenance: doc.provenance, newNodes: nw, conformedToBase: conf2base, concepts: doc.concepts.length, bandJudged: band });
  }
  return { perDoc, nodes };
}

// ---- vocabulary conform/grow (arm B) ----
async function conformOrGrowVocab(stream: Array<{ key: string; provenance: string; text: string }>, seededCache: Record<string, string[]>): Promise<{ perDoc: PerDoc[]; vocab: string[]; origin: Record<string, string> }> {
  const vocab: string[] = [];               // canonical labels, insertion order
  const origin: Record<string, string> = {}; // label -> provenance of the doc that introduced it
  const touch: Record<string, number> = {};  // label -> last-used counter (MRU)
  let clock = 0; let capHits = 0; let di = 0;
  const perDoc: PerDoc[] = [];
  for (const doc of stream) {
    if (di % 10 === 0) console.log(`  [arm B] doc ${di}/${stream.length} vocab=${vocab.length}`);
    di++;
    // MRU window into the vocabulary (pre-reg §2: cap 500, logged if triggers)
    let vshown = vocab;
    if (vocab.length > VOCAB_CAP) { capHits++; vshown = [...vocab].sort((a, b) => (touch[b] ?? 0) - (touch[a] ?? 0)).slice(0, VOCAB_CAP); }
    let labels = seededCache[doc.key];
    if (!labels) { labels = await extractSeeded(doc.text, vshown); seededCache[doc.key] = labels; saveCache('seeded-extractions.json', seededCache); }
    const vocabSet = new Set(vocab);
    let nw = 0, conf2base = 0;
    for (const label of labels) {
      if (vocabSet.has(label)) { touch[label] = ++clock; if (origin[label] === 'base' && doc.provenance !== 'base') conf2base++; }
      else { vocab.push(label); vocabSet.add(label); origin[label] = doc.provenance; touch[label] = ++clock; nw++; }
    }
    perDoc.push({ key: doc.key, provenance: doc.provenance, newNodes: nw, conformedToBase: conf2base, concepts: labels.length });
  }
  if (capHits) console.log(`  [arm B] vocab cap (${VOCAB_CAP}) triggered on ${capHits} docs`);
  return { perDoc, vocab, origin };
}

// ---- relevance-window conform/grow (arm R) — ONLY diff vs arm B is window selection ----
async function conformOrGrowRelevance(
  stream: Array<{ key: string; provenance: string; text: string }>,
  seededCache: Record<string, string[]>,
  docEmb: Record<string, number[]>,
  labelEmb: Record<string, number[]>,
): Promise<{ perDoc: PerDoc[]; vocab: string[]; origin: Record<string, string> }> {
  const vocab: string[] = [];
  const origin: Record<string, string> = {};
  const windowLog: Record<string, string[]> = {}; // doc.key -> retrieved window (adversary can verify twin labels present)
  const perDoc: PerDoc[] = [];
  let di = 0;
  for (const doc of stream) {
    if (di % 10 === 0) console.log(`  [arm R] doc ${di}/${stream.length} vocab=${vocab.length}`);
    di++;
    if (!docEmb[doc.key]) { docEmb[doc.key] = await embed(doc.text); saveCache('doc-embeddings.json', docEmb); }
    const de = docEmb[doc.key]!;
    // relevance window: top-REL_K existing labels nearest the document (all if |V|<=K)
    let window: string[];
    if (vocab.length <= REL_K) window = [...vocab];
    else window = vocab.filter((l) => labelEmb[l]).map((l) => ({ l, s: cosine(de, labelEmb[l]!) })).sort((a, b) => b.s - a.s).slice(0, REL_K).map((x) => x.l);
    windowLog[doc.key] = window;
    let labels = seededCache[doc.key];
    if (!labels) { labels = await extractSeeded(doc.text, window); seededCache[doc.key] = labels; saveCache('seeded-extractions-R.json', seededCache); }
    const vocabSet = new Set(vocab);
    let nw = 0, conf2base = 0;
    for (const label of labels) {
      if (vocabSet.has(label)) { if (origin[label] === 'base' && doc.provenance !== 'base') conf2base++; }
      else {
        vocab.push(label); vocabSet.add(label); origin[label] = doc.provenance; nw++;
        if (!labelEmb[label]) { labelEmb[label] = await embed(label); }
      }
    }
    perDoc.push({ key: doc.key, provenance: doc.provenance, newNodes: nw, conformedToBase: conf2base, concepts: labels.length });
  }
  saveCache('label-embeddings-R.json', labelEmb);
  saveCache('doc-embeddings.json', docEmb);
  saveCache('rel-window-log.json', windowLog);
  return { perDoc, vocab, origin };
}

// ---- shared metrics (identical across arms; pre-reg §3) ----
function computeMetrics(perDoc: PerDoc[], freeFormBase: number) {
  const basePerDoc = perDoc.filter((p) => p.provenance === 'base');
  const sumNew = (arr: PerDoc[]) => arr.reduce((a, b) => a + b.newNodes, 0);
  const baseNodes = sumNew(basePerDoc);
  const reduction = 1 - baseNodes / freeFormBase;
  const q = Math.floor(N_BASE / 4);
  const firstQ = sumNew(basePerDoc.slice(0, q)), lastQ = sumNew(basePerDoc.slice(-q));
  const growthRatio = firstQ ? lastQ / firstQ : NaN;
  const distDocs = perDoc.filter((p) => p.provenance === 'distinct');
  const distConcepts = distDocs.reduce((a, b) => a + b.concepts, 0);
  const distConf2base = distDocs.reduce((a, b) => a + b.conformedToBase, 0);
  const distStaySeparate = distConcepts ? 1 - distConf2base / distConcepts : NaN;
  const verbDocs = perDoc.filter((p) => p.provenance === 'verbatim');
  const verbNewPerDoc = verbDocs.reduce((a, b) => a + b.newNodes, 0) / (verbDocs.length || 1);
  const freshNewPerDoc = lastQ / (q || 1);
  const verbRatio = freshNewPerDoc ? verbNewPerDoc / freshNewPerDoc : NaN;
  const paraDocs = perDoc.filter((p) => p.provenance === 'paraphrase');
  const paraNewPerDoc = paraDocs.reduce((a, b) => a + b.newNodes, 0) / (paraDocs.length || 1);
  const cond1 = reduction >= 0.40 && growthRatio <= 0.5;
  const cond2 = distStaySeparate >= 0.90;
  const cond3 = verbRatio <= 0.10;
  return { freeFormBase, baseNodes, reduction, firstQ, lastQ, growthRatio, distConcepts, distConf2base, distStaySeparate, verbNewPerDoc, freshNewPerDoc, verbRatio, paraNewPerDoc, cond1, cond2, cond3, pass: cond1 && cond2 && cond3 };
}

async function main(): Promise<void> {
  console.log(`# doc-24 convergence bake-off — ARM ${ARM}`);
  const corpus = loadCache<Corpus>('corpus.json');
  if (!corpus) throw new Error('corpus.json missing — pre-reg §1 forbids re-fetch; restore the frozen snapshot');
  if (corpus.base.length < N_BASE) throw new Error(`base underfetched: ${corpus.base.length}<${N_BASE}`);
  console.log(`corpus: base=${corpus.base.length} distinct=${corpus.distinct.length} verbatim=${corpus.verbatimIds.length} paraphrase=${corpus.paraphrase.length}`);

  // free-form baseline denominator (906) = distinct exact labels among base docs, from the arm-0 cached extraction
  const ff = loadCache<Record<string, string[]>>('extractions.json') ?? {};
  const freeFormBase = new Set(corpus.base.flatMap((b) => ff['base:' + b.id] ?? [])).size;
  if (!freeFormBase) throw new Error('extractions.json (free-form baseline) missing — run arm 0 first');
  console.log(`free-form baseline (denominator): ${freeFormBase}`);

  let metrics; let perDoc: PerDoc[]; const extra: Record<string, unknown> = {};

  if (ARM === '0' || ARM === 'A') {
    const glossed = ARM === 'A';
    // stage 1: extraction (cached per arm)
    const cacheName = glossed ? 'extractions-glossed.json' : 'extractions.json';
    const ex = loadCache<Record<string, any>>(cacheName) ?? {};
    const docs: Array<{ key: string; text: string }> = [];
    for (const b of corpus.base) docs.push({ key: 'base:' + b.id, text: b.text });
    for (const vid of corpus.verbatimIds) docs.push({ key: 'verb:' + vid, text: corpus.base.find((x) => x.id === vid)!.text });
    for (const p of corpus.paraphrase) docs.push({ key: 'para:' + p.id, text: p.text });
    for (const d of corpus.distinct) docs.push({ key: 'dist:' + d.id, text: d.text });
    const need = docs.filter((d) => !(d.key in ex));
    if (need.length) {
      console.log(`extracting ${need.length} docs (${glossed ? 'glossed' : 'bare'})...`);
      const res = await pool(need, POOL, async (d, i) => { if (i % 20 === 0) console.log(`  extract ${i}/${need.length}`); return glossed ? extractGlossed(d.text) : extractConcepts(d.text); });
      need.forEach((d, i) => { ex[d.key] = res[i]; });
      saveCache(cacheName, ex);
    }

    // build stream with embKeys; embKey = label (arm 0) or gloss (arm A)
    const mkConcepts = (key: string): Array<{ label: string; embKey: string }> => {
      if (glossed) return (ex[key] as Array<{ label: string; gloss: string }>).map((c) => ({ label: c.label, embKey: c.gloss }));
      return (ex[key] as string[]).map((l) => ({ label: l, embKey: l }));
    };
    const stream: DocRec[] = [];
    for (const b of corpus.base) stream.push({ key: 'base:' + b.id, provenance: 'base', text: b.text, concepts: mkConcepts('base:' + b.id) });
    for (const vid of corpus.verbatimIds) stream.push({ key: 'verb:' + vid, provenance: 'verbatim', text: '', concepts: mkConcepts('verb:' + vid) });
    for (const p of corpus.paraphrase) stream.push({ key: 'para:' + p.id, provenance: 'paraphrase', text: '', concepts: mkConcepts('para:' + p.id) });
    for (const d of corpus.distinct) stream.push({ key: 'dist:' + d.id, provenance: 'distinct', text: '', concepts: mkConcepts('dist:' + d.id) });

    // stage 2: embed every distinct embKey (cached per arm)
    const embName = glossed ? 'gloss-embeddings.json' : 'label-embeddings.json';
    const embMap = loadCache<Record<string, number[]>>(embName) ?? {};
    const allKeys = [...new Set(stream.flatMap((d) => d.concepts.map((c) => c.embKey)))];
    const needEmb = allKeys.filter((k) => !(k in embMap));
    if (needEmb.length) {
      console.log(`embedding ${needEmb.length} ${glossed ? 'glosses' : 'labels'}...`);
      const vecs = await pool(needEmb, POOL, (k) => embed(k));
      needEmb.forEach((k, i) => { embMap[k] = vecs[i]!; });
      saveCache(embName, embMap);
    }

    // stage 3: pre-warm band judge over unique labels (representative emb = first-seen embKey's emb)
    const judgeName = glossed ? 'judge-cache-A.json' : 'judge-cache.json';
    const judgeCache = loadCache<Record<string, boolean>>(judgeName) ?? {};
    const repEmb: Record<string, number[]> = {};
    for (const d of stream) for (const c of d.concepts) if (!(c.label in repEmb) && embMap[c.embKey]) repEmb[c.label] = embMap[c.embKey]!;
    const uniq = Object.keys(repEmb);
    const bandPairs = new Set<string>();
    for (let i = 0; i < uniq.length; i++) {
      const ei = repEmb[uniq[i]!]!; const near: Array<{ l: string; s: number }> = [];
      for (let j = 0; j < uniq.length; j++) { if (i === j) continue; near.push({ l: uniq[j]!, s: cosine(ei, repEmb[uniq[j]!]!) }); }
      near.sort((a, b) => b.s - a.s);
      for (const nb of near.slice(0, 3)) if (nb.s > TAU_LOW && nb.s < TAU_HIGH) bandPairs.add([uniq[i]!, nb.l].sort().join(' :: '));
    }
    const toJudge = [...bandPairs].filter((k) => !(k in judgeCache));
    if (toJudge.length) {
      const BATCH = 25; const batches: string[][] = [];
      for (let i = 0; i < toJudge.length; i += BATCH) batches.push(toJudge.slice(i, i + BATCH));
      console.log(`pre-warming ${toJudge.length} band-pair judgments in ${batches.length} batches...`);
      await pool(batches, POOL, async (batch, bi) => {
        const pairs = batch.map((k) => { const [a, b] = k.split(' :: '); return { a: a!, b: b! }; });
        const verdicts = await batchJudge(pairs);
        batch.forEach((k, i) => { judgeCache[k] = verdicts[i] ?? false; });
        if (bi % 4 === 0) console.log(`  judged batch ${bi + 1}/${batches.length}`);
        saveCache(judgeName, judgeCache);
      });
      saveCache(judgeName, judgeCache);
    }

    const r = await conformOrGrowEmb(stream, embMap, judgeCache);
    saveCache(judgeName, judgeCache);
    perDoc = r.perDoc;
    metrics = computeMetrics(perDoc, freeFormBase);
    extra.bandJudged = perDoc.reduce((a, b) => a + (b.bandJudged ?? 0), 0);
    extra.totalNodes = r.nodes.length;
  } else if (ARM === 'B') {
    // ARM B: sequential vocabulary-seeded extraction (MRU window)
    const seededCache = loadCache<Record<string, string[]>>('seeded-extractions.json') ?? {};
    const stream: Array<{ key: string; provenance: string; text: string }> = [];
    for (const b of corpus.base) stream.push({ key: 'base:' + b.id, provenance: 'base', text: b.text });
    for (const vid of corpus.verbatimIds) stream.push({ key: 'verb:' + vid, provenance: 'verbatim', text: corpus.base.find((x) => x.id === vid)!.text });
    for (const p of corpus.paraphrase) stream.push({ key: 'para:' + p.id, provenance: 'paraphrase', text: p.text });
    for (const d of corpus.distinct) stream.push({ key: 'dist:' + d.id, provenance: 'distinct', text: d.text });
    const already = stream.filter((s) => s.key in seededCache).length;
    console.log(`arm B: sequential seeded extraction over ${stream.length} docs (${already} cached)...`);
    const r = await conformOrGrowVocab(stream, seededCache);
    saveCache('seeded-extractions.json', seededCache);
    perDoc = r.perDoc;
    metrics = computeMetrics(perDoc, freeFormBase);
    extra.vocabSize = r.vocab.length;
    extra.vocabSample = r.vocab.slice(0, 40);
  } else {
    // ARM R: sequential seeded extraction with a RELEVANCE window (top-REL_K nearest labels)
    const seededCache = loadCache<Record<string, string[]>>('seeded-extractions-R.json') ?? {};
    const docEmb = loadCache<Record<string, number[]>>('doc-embeddings.json') ?? {};
    const labelEmb = loadCache<Record<string, number[]>>('label-embeddings-R.json') ?? {};
    const stream: Array<{ key: string; provenance: string; text: string }> = [];
    for (const b of corpus.base) stream.push({ key: 'base:' + b.id, provenance: 'base', text: b.text });
    for (const vid of corpus.verbatimIds) stream.push({ key: 'verb:' + vid, provenance: 'verbatim', text: corpus.base.find((x) => x.id === vid)!.text });
    for (const p of corpus.paraphrase) stream.push({ key: 'para:' + p.id, provenance: 'paraphrase', text: p.text });
    for (const d of corpus.distinct) stream.push({ key: 'dist:' + d.id, provenance: 'distinct', text: d.text });
    const already = stream.filter((s) => s.key in seededCache).length;
    console.log(`arm R: relevance-window (K=${REL_K}) seeded extraction over ${stream.length} docs (${already} cached)...`);
    const r = await conformOrGrowRelevance(stream, seededCache, docEmb, labelEmb);
    saveCache('seeded-extractions-R.json', seededCache);
    perDoc = r.perDoc;
    metrics = computeMetrics(perDoc, freeFormBase);
    extra.vocabSize = r.vocab.length;
    extra.relK = REL_K;
    extra.vocabSample = r.vocab.slice(0, 40);
  }

  console.log('\n=== METRICS (arm ' + ARM + ') ===');
  console.log(`free-form baseline base concepts: ${metrics.freeFormBase}`);
  console.log(`arm ${ARM} base nodes:              ${metrics.baseNodes}`);
  console.log(`EXPLOSION REDUCTION: ${(metrics.reduction * 100).toFixed(1)}%  (bar >=40%)`);
  console.log(`growth Q1=${metrics.firstQ} Q4=${metrics.lastQ} ratio=${metrics.growthRatio.toFixed(2)} (bar <=0.5)`);
  console.log(`OVER-MERGE: distinct-field stay separate = ${(metrics.distStaySeparate * 100).toFixed(1)}% (bar >=90%); ${metrics.distConf2base}/${metrics.distConcepts} absorbed`);
  console.log(`CONFORM: verbatim new/doc=${metrics.verbNewPerDoc.toFixed(2)} vs fresh new/doc=${metrics.freshNewPerDoc.toFixed(2)} ratio=${metrics.verbRatio.toFixed(2)} (bar <=0.1)`);
  console.log(`paraphrase new-nodes/doc=${metrics.paraNewPerDoc.toFixed(2)} (reported)`);
  console.log(`\ncond1 (reduction>=40% AND growth<=0.5): ${metrics.cond1 ? 'PASS' : 'FAIL'}`);
  console.log(`cond2 (distinct stay separate >=90%):   ${metrics.cond2 ? 'PASS' : 'FAIL'}`);
  console.log(`cond3 (verbatim adds <=10% of fresh):   ${metrics.cond3 ? 'PASS' : 'FAIL'}`);
  console.log(`\n>>> ARM ${ARM} GATE ${metrics.pass ? 'PASS' : 'FAIL'} <<<`);

  saveCache(`cv2-results-arm${ARM}.json`, { prereg: 'doc-24', arm: ARM, config: { N_BASE, TAU_LOW, TAU_HIGH, VOCAB_CAP }, metrics, extra, perDoc });
  console.log(`\nwrote cv2-results-arm${ARM}.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
