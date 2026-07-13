// Leg 5: prefilter/net experiment. Re-extract all real functions, apply one
// rule-level net per rule, measure how well each net concentrates candidates.
// Pre-reg: doc 09 §20. Reuses the Leg-4 extractor.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
const ROOT = 'C:/Users/bruce.mckay/dev/maverick/ALPHA-2570-base-classes';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'build' || e === 'out' || e === 'mxml-4.0.4' || e === '.git') continue;
    const p = `${dir}/${e}`; const s = statSync(p);
    if (s.isDirectory()) walk(p, acc); else if (/\.(cpp|hpp)$/.test(e)) acc.push(p);
  }
  return acc;
}
const CTRL = /^(if|for|while|switch|catch|do|else|return|namespace|struct|class|enum|union|template)\b/;
function extractFunctions(text) {
  const out = []; let i = 0, n = text.length; let state = 'code'; const stack = []; let lastB = -1;
  while (i < n) {
    const c = text[i], c2 = text[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === '"') { state = 'str'; i++; continue; }
      if (c === "'") { state = 'chr'; i++; continue; }
      if (c === ';') { lastB = i; i++; continue; }
      if (c === '{') { stack.push({ pos: i, header: text.slice(lastB + 1, i) }); lastB = i; i++; continue; }
      if (c === '}') { const o = stack.pop(); lastB = i; if (o) mf(text, o, i, out); i++; continue; }
      i++; continue;
    }
    if (state === 'line') { if (c === '\n') state = 'code'; i++; continue; }
    if (state === 'block') { if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; } i++; continue; }
    if (state === 'str') { if (c === '\\') { i += 2; continue; } if (c === '"') state = 'code'; i++; continue; }
    if (state === 'chr') { if (c === '\\') { i += 2; continue; } if (c === "'") state = 'code'; i++; continue; }
  }
  return out;
}
function mf(text, o, close, out) {
  let h = o.header.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
  if (!/\)\s*(const|noexcept|override|final|&|&&|mutable|\s)*(:\s*[^{]*)?$/.test(h)) return;
  if (!h.includes('(')) return;
  const nm = /([A-Za-z_~][A-Za-z0-9_]*)\s*\(/.exec(h); if (!nm) return;
  if (/^[A-Z][A-Z0-9_]+$/.test(nm[1])) return;
  if (CTRL.test(h) || CTRL.test(nm[1])) return;
  if (/\]\s*\(/.test(h) || /=\s*$/.test(h)) return;
  out.push({ headerStart: o.pos - o.header.length, open: o.pos, close: close + 1, name: nm[1], header: h });
}
const cache = {}; const rd = a => cache[a] || (cache[a] = readFileSync(a, 'utf8').replace(/\r/g, ''));
const lineOf = (t, p) => t.slice(0, p).split('\n').length;

const funcs = [];
for (const abs of walk(ROOT)) {
  const text = rd(abs); let fns; try { fns = extractFunctions(text); } catch { continue; }
  for (const f of fns) {
    const full = text.slice(f.headerStart, f.close).replace(/^\s+/, '');
    const body = text.slice(f.open + 1, f.close - 1);
    const nlines = full.split('\n').length;
    if (nlines < 2 || nlines > 120 || full.length > 6000) continue;
    // strip comments from body for net matching
    const bodyClean = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    funcs.push({ file: abs.slice(ROOT.length + 1), line: lineOf(text, f.headerStart), name: f.name, header: f.header, nlines, code: full, body: bodyClean });
  }
}

// ---- NETS (rule-level, codebase-agnostic form) ----
const nets = {
  'C.131': f => /^\s*return\s+[A-Za-z_][\w.]*(\(\))?\s*;\s*$/.test(f.body.trim()) && !/[-+*/%<>=!&|?]/.test(f.body.replace(/->/g,'').replace(/==|!=|<=|>=/g,'')),
  'C.4':   f => /::/.test(f.header) && !/\bm_[A-Za-z]|\bthis\b|->/.test(f.body) && !/\bstatic\b/.test(f.header) && !/\boverride\b|\bvirtual\b/.test(f.header),
  'R.3/R.11': f => /\bnew\b|\bdelete\b/.test(f.body),
  'F.2(hollow)': f => f.nlines > 25 || (f.body.match(/\b(if|for|while|switch|case)\b/g) || []).length > 6,
};
const hash = s => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
const results = {}; const candidatesForAdj = [];
for (const [rule, net] of Object.entries(nets)) {
  const cands = funcs.filter(net);
  cands.sort((a, b) => hash(a.file + a.line + rule) - hash(b.file + b.line + rule));
  const sampleN = Math.min(12, cands.length);
  const sample = cands.slice(0, sampleN);
  results[rule] = { total_funcs: funcs.length, candidates: cands.length, concentration: (cands.length / funcs.length), sampled: sampleN };
  for (const c of sample) candidatesForAdj.push({ net: rule, file: c.file, line: c.line, name: c.name, code: c.code.slice(0, 1200) });
}
writeFileSync(`${OUT}/leg5_candidates.json`, JSON.stringify(candidatesForAdj, null, 2));
writeFileSync(`${OUT}/leg5_netstats.json`, JSON.stringify(results, null, 2));
console.log(`total functions: ${funcs.length}`);
for (const [r, v] of Object.entries(results)) console.log(`  net ${r.padEnd(12)} candidates=${String(v.candidates).padStart(4)}  (${(v.concentration*100).toFixed(1)}% of funcs)  sampled ${v.sampled} for adjudication`);
console.log(`\ntotal candidate-samples to adjudicate: ${candidatesForAdj.length}`);
console.log('\n--- 2 sample candidates per net ---');
for (const r of Object.keys(nets)) { const ex = candidatesForAdj.filter(c=>c.net===r).slice(0,2); for(const e of ex) console.log(`\n[${r}] ${e.file.split('/').pop()}:${e.line}\n${e.code.slice(0,150)}`); }
