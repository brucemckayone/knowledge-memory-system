// Leg 6: rule->code coverage + AST baseline for C.131. Pre-reg: doc 09 §22.
// Extract all functions (reuse Leg-5 extractor), build an over-inclusive
// getter/setter SUPERSET (the coverage denominator), plus three deterministic
// classifiers: dumb-AST (strict net), smart-AST (member-aware). Emit superset
// for blind adjudication + a random non-superset spot-check.
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
    const bodyClean = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    funcs.push({ file: abs.slice(ROOT.length + 1), line: lineOf(text, f.headerStart), name: f.name, header: f.header, nlines, code: full, body: bodyClean });
  }
}

// ---- classifiers ----
// Dumb-AST (= Leg-5 strict net): single `return <member>;`, no operators.
const dumbAst = f => {
  const b = f.body.trim();
  return /^\s*return\s+[A-Za-z_][\w.]*(\(\))?\s*;\s*$/.test(b)
    && !/[-+*/%<>=!&|?]/.test(b.replace(/->/g, '').replace(/==|!=|<=|>=/g, ''));
};
// Smart-AST v2: dumb-AST minus the pure-syntax-detectable non-getters.
// A better STATIC query with no LLM: exclude returns that are a CALL
// (`return x.foo();` / `return foo();`) or a bare LITERAL (`return false;`).
// It CANNOT exclude param-returns (`return obj.field;` where obj is a param) —
// that needs symbol resolution (a full AST), not regex. So this is the ceiling
// of a pure-syntax query; the residue is what a real AST/symbol table would remove.
const smartAst = f => {
  if (!dumbAst(f)) return false;
  const b = f.body.trim();
  if (/\(\)\s*;\s*$/.test(b)) return false;                                   // return x.foo(); / return foo();
  if (/^\s*return\s+(true|false|nullptr|NULL|-?\d[\w.]*|0x[0-9a-fA-F]+|""|'.'?)\s*;\s*$/.test(b)) return false; // literal
  return true;
};
// Wide SUPERSET: over-inclusive getter/setter shape (coverage denominator).
const ACC = /^(get|set|is|has|size|count|length|empty|data|value|at|front|back|begin|end|c_str|str|name|id|type|key|first|second|find|contains)/i;
const superset = f => {
  const b = f.body.trim();
  const stmts = b.split(';').map(s => s.trim()).filter(Boolean);
  const singleReturn = stmts.length === 1 && /^return\b/.test(stmts[0]);
  const singleAssign = stmts.length === 1 && /^[A-Za-z_][\w.\->:]*\s*=\s*[^=]/.test(stmts[0]) && !/^return\b/.test(stmts[0]);
  const shortAccessor = f.nlines <= 6 && ACC.test(f.name);
  return singleReturn || singleAssign || shortAccessor;
};

// smartAst_prereg: the ACTUALLY pre-registered §22 classifier (member-awareness),
// faithfully implemented (no buggy .Y branch). Reported as THE pre-registered result.
const smartAstPrereg = f => {
  if (!dumbAst(f)) return false;
  const isMethod = /::/.test(f.header) || /\)\s*const\b/.test(f.header);
  const b = f.body.trim();
  const returnsMemberName = /^return\s+(m_[A-Za-z]\w*|s_[A-Za-z]\w*|[A-Za-z]\w*_|this->\w+)\s*;\s*$/.test(b);
  return isMethod && returnsMemberName;
};

const supersetFuncs = funcs.filter(superset);
const dumb = funcs.filter(dumbAst);
const smart = funcs.filter(smartAst);           // post-hoc exclude-call/literal (DISCLOSED as such)
const smartPrereg = funcs.filter(smartAstPrereg); // the pre-registered member-aware classifier

const hash = s => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
const idOf = f => `${f.file}:${f.line}:${f.name}`;
const dumbSet = new Set(dumb.map(idOf));
const smartSet = new Set(smart.map(idOf));

// Emit superset candidates for blind adjudication (shuffled, no classifier hints).
const cands = supersetFuncs.map(f => ({ id: idOf(f), file: f.file, line: f.line, name: f.name, code: f.code.slice(0, 1400) }));
cands.sort((a, b) => hash(a.id + 'x') - hash(b.id + 'y'));

// Non-superset random spot-check: estimate getters the superset MISSED.
const nonSuper = funcs.filter(f => !superset(f));
nonSuper.sort((a, b) => hash(idOf(a) + 'spot') - hash(idOf(b) + 'spot'));
const spot = nonSuper.slice(0, 40).map(f => ({ id: idOf(f), file: f.file, line: f.line, name: f.name, code: f.code.slice(0, 1400) }));

writeFileSync(`${OUT}/leg6_superset.json`, JSON.stringify(cands, null, 2));
writeFileSync(`${OUT}/leg6_spotcheck_input.json`, JSON.stringify(spot, null, 2));
writeFileSync(`${OUT}/leg6_classifiers.json`, JSON.stringify({
  total_funcs: funcs.length,
  superset: supersetFuncs.length,
  dumb_ast: dumb.length,
  smart_ast: smart.length,
  dumb_ids: [...dumbSet], smart_ids: [...smartSet],
  smart_prereg_ids: smartPrereg.map(idOf),
  superset_ids: cands.map(c => c.id),
}, null, 2));

console.log(`total functions:        ${funcs.length}`);
console.log(`getter/setter superset: ${supersetFuncs.length}  (${(supersetFuncs.length/funcs.length*100).toFixed(1)}%)  -> adjudicate all (ground truth T)`);
console.log(`dumb-AST (strict net):  ${dumb.length}`);
console.log(`smart-AST:              ${smart.length}`);
console.log(`non-superset spotcheck: ${spot.length} sampled of ${nonSuper.length}`);
console.log(`\ndumb NOT in superset (should be ~0): ${dumb.filter(f=>!superset(f)).length}`);
console.log('\n--- 3 sample superset candidates ---');
for (const c of cands.slice(0, 3)) console.log(`\n[${c.id}]\n${c.code.slice(0, 200)}`);
