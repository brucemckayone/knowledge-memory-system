// Leg 7: settling experiment for F.2 with HUMAN ground truth. Pre-reg doc §25.
// Build a seeded random sample of the population + a BLIND labelling sheet
// (full function bodies, no LLM/baseline hints). Store structural features
// (nlines, control-flow count) for the deterministic baseline, but DO NOT
// put them in the sheet.
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
    const nlines = full.split('\n').length;
    if (nlines < 2 || nlines > 120 || full.length > 6000) continue;
    const body = text.slice(f.open + 1, f.close - 1).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const nonblank = full.split('\n').filter(l => l.trim()).length;
    const cf = (body.match(/\b(if|for|while|switch|case|catch)\b/g) || []).length;
    funcs.push({ id: `${abs.slice(ROOT.length + 1)}:${lineOf(text, f.headerStart)}:${f.name}`,
      file: abs.slice(ROOT.length + 1), line: lineOf(text, f.headerStart), name: f.name,
      nlines, nonblank, cf, code: full });
  }
}

const hash = s => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
funcs.sort((a, b) => hash(a.id + 'leg7') - hash(b.id + 'leg7'));

const KEEP = 300;                 // store this many in stable order (extendable without reshuffle)
const PILOT = 30;
const sample = funcs.slice(0, KEEP);
writeFileSync(`${OUT}/leg7_sample.json`, JSON.stringify(sample, null, 2));

// Blind labelling sheet for the pilot (full code, NO hints)
let md = `# Leg 7 — F.2 blind labelling sheet (pilot, n=${PILOT})\n\n`;
md += `**Rule F.2:** a function should perform *a single logical operation*.\n\n`;
md += `Mark **VIOLATION** if the function does more than one logical operation / has more than one responsibility / mixes abstraction levels / can't be named without "and". Mark **OK** if it does one coherent thing (a chain of helper calls at one level of abstraction is still "one thing"). Mark **SKIP** if it isn't really a function or you genuinely can't judge it.\n\n`;
md += `Fill in \`Verdict:\` (VIOLATION / OK / SKIP) and \`Conf:\` (H/M/L) for each. Do this **before** looking at any tool output. Optional one-line \`Note:\`.\n\n---\n`;
for (let k = 0; k < PILOT; k++) {
  const f = sample[k];
  md += `\n### ${k + 1}. \`${f.file}:${f.line}\` — ${f.name}  _(${f.nlines} lines)_\n\n`;
  md += '```cpp\n' + f.code + '\n```\n\n';
  md += `- Verdict: \n- Conf: \n- Note: \n`;
}
writeFileSync(`${OUT}/leg7_pilot_sheet.md`, md);

console.log(`population functions: ${funcs.length}`);
console.log(`stored sample (stable order): ${sample.length}  | pilot sheet items: ${PILOT}`);
console.log(`pilot line-count distribution: min ${Math.min(...sample.slice(0,PILOT).map(f=>f.nlines))}, max ${Math.max(...sample.slice(0,PILOT).map(f=>f.nlines))}, median ${sample.slice(0,PILOT).map(f=>f.nlines).sort((a,b)=>a-b)[15]}`);
console.log(`sheet written: ${OUT}/leg7_pilot_sheet.md`);
