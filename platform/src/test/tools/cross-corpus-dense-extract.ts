/**
 * doc-32 — DENSER re-extraction (same relevance-window controlled-vocab mechanism, target 25-40 concepts/doc).
 * Only density changes vs cross-corpus-recall.ts. Shared vocab across A+B, interleaved. Reuses cc-docemb.json.
 * Saves cc-seeded-dense.json ({key:[labels]}) + cc-labelemb-dense.json. Incremental.
 * Run: ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/cross-corpus-dense-extract.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ML = process.env.ML_SERVICES_URL ?? 'http://127.0.0.1:8000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const REL_K = 100;
const load = <T,>(n: string): T | null => existsSync(join(OUT, n)) ? JSON.parse(readFileSync(join(OUT, n), 'utf8')) as T : null;
const save = (n: string, o: unknown) => writeFileSync(join(OUT, n), JSON.stringify(o, null, 2));
function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }
function firstBalancedJson(t: string): string | null { const s = t.indexOf('{'); if (s < 0) return null; let d = 0, q = false, e = false; for (let i = s; i < t.length; i++) { const c = t[i]!; if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') q = false; continue; } if (c === '"') q = true; else if (c === '{') d++; else if (c === '}') { if (--d === 0) return t.slice(s, i + 1); } } return null; }
async function chatJson<T>(prompt: string, system: string, ms = 150_000): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(`${ML}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: prompt, system_prompt: system }), signal: ctrl.signal });
      if (!r.ok) throw new Error(`${r.status}`);
      const raw = (await r.json() as { response: string }).response;
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      for (const c of [cleaned, firstBalancedJson(raw)].filter((x): x is string => !!x)) { try { return JSON.parse(c) as T; } catch { /**/ } }
      throw new Error('parse');
    } catch { await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); } finally { clearTimeout(timer); }
  }
  return null;
}
async function embed(text: string, ms = 60_000): Promise<number[]> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(`${ML}/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: ctrl.signal }); if (!r.ok) throw new Error('embed'); return (await r.json() as { vector: number[] }).vector; } finally { clearTimeout(timer); }
}

const VOCAB_SYS = 'You extract technical concepts and MAINTAIN A CONTROLLED VOCABULARY. Respond ONLY with JSON, no prose, no fences.';
function densePrompt(text: string, vocab: string[]): string {
  const vlist = vocab.length ? vocab.join('\n') : '(empty — first document)';
  return ['You are building a shared concept vocabulary across many documents. Below is the EXISTING vocabulary, then a NEW document.',
    '', 'EXISTING VOCABULARY:', vlist, '', 'DOCUMENT:', text, '',
    'Extract the technical concepts in the DOCUMENT — be EXHAUSTIVE: 25 to 40 concepts, including the main ideas',
    'AND finer-grained sub-concepts, specific methods, tasks, datasets/data types, architectures, metrics, and techniques.',
    'For EACH: if the SAME concept exists in the vocabulary, reuse that EXACT label (copy verbatim); else coin a new short kebab-case label.',
    'No generic filler ("this-paper","results","approach").', '', 'Return ONLY: {"concepts":["label-1",...]}'].join('\n');
}
async function extractDense(text: string, vocab: string[]): Promise<string[]> {
  const r = await chatJson<{ concepts?: string[] }>(densePrompt(text, vocab), VOCAB_SYS);
  return (r?.concepts ?? []).filter((x) => typeof x === 'string').map((x) => x.toLowerCase().trim()).filter(Boolean);
}

interface Doc { id: string; title: string; abstract: string; }
const docText = (d: Doc) => `${d.title}. ${d.abstract}`;

async function main(): Promise<void> {
  const A = load<Doc[]>('corpus-A.json')!, B = load<Doc[]>('corpus-B.json')!;
  const stream: Array<{ key: string; text: string }> = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) { if (i < A.length) stream.push({ key: `A:${A[i]!.id}`, text: docText(A[i]!) }); if (i < B.length) stream.push({ key: `B:${B[i]!.id}`, text: docText(B[i]!) }); }
  const seeded = load<Record<string, string[]>>('cc-seeded-dense.json') ?? {};
  const docEmb = load<Record<string, number[]>>('cc-docemb.json') ?? {}; // reuse existing doc embeddings
  const labelEmb = load<Record<string, number[]>>('cc-labelemb-dense.json') ?? {};
  const vocab: string[] = []; const vset = new Set<string>();
  // rebuild vocab from any cached (resume): insertion order from cache is lost, so recompute from seeded in stream order
  for (const d of stream) for (const l of (seeded[d.key] ?? [])) if (!vset.has(l)) { vocab.push(l); vset.add(l); }
  let di = 0;
  for (const d of stream) {
    if (di % 20 === 0) console.log(`  [dense] ${di}/${stream.length} vocab=${vocab.length}`);
    di++;
    if (seeded[d.key]) continue;
    if (!docEmb[d.key]) { docEmb[d.key] = await embed(d.text); save('cc-docemb.json', docEmb); }
    const de = docEmb[d.key]!;
    let window: string[];
    if (vocab.length <= REL_K) window = [...vocab];
    else window = vocab.filter((l) => labelEmb[l]).map((l) => ({ l, s: cosine(de, labelEmb[l]!) })).sort((a, b) => b.s - a.s).slice(0, REL_K).map((x) => x.l);
    const labels = await extractDense(d.text, window);
    seeded[d.key] = labels;
    for (const l of labels) if (!vset.has(l)) { vocab.push(l); vset.add(l); if (!labelEmb[l]) labelEmb[l] = await embed(l); }
    save('cc-seeded-dense.json', seeded); save('cc-labelemb-dense.json', labelEmb);
  }
  const counts = stream.map((d) => (seeded[d.key] ?? []).length);
  console.log(`done: ${stream.length} docs, vocab=${vocab.length}, mean nodes/doc=${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)}, empty docs=${counts.filter((c) => c === 0).length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
