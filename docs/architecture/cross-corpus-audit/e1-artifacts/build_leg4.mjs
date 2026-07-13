// Leg 4 harness: real-code field-prevalence run. Extract whole functions (Allman,
// brace-matched, string/comment-safe) from a pinned real checkout, seeded-random
// sample, large candidate rule set. Pre-reg: doc 09 §18. Ground truth = NOLINT
// anchors (non-LLM) + downstream flag adjudication.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
const ROOT = 'C:/Users/bruce.mckay/dev/maverick/ALPHA-2570-base-classes';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';
const SAMPLE_N = 140;

const RULES = [
  ['R.3','A raw pointer (T*) is non-owning; do not own a resource through a raw pointer.'],
  ['R.11','Avoid calling new and delete explicitly.'],
  ['R.20','Use unique_ptr or shared_ptr to represent ownership.'],
  ['C.4','Make a function a member only if it needs the representation; a method using no instance state should be static/free.'],
  ['C.12','Do not make data members const or references in a copyable/movable type.'],
  ['C.35','A base class destructor should be public+virtual or protected+non-virtual.'],
  ['C.131','Avoid trivial getters and setters (an accessor that only returns/assigns a member).'],
  ['C.21','If you define or delete any copy/move/destructor, define or delete them all (rule of five).'],
  ['C.46','By default, declare single-argument constructors explicit.'],
  ['F.2','A function should perform a single logical operation.'],
  ['F.16','For "in" parameters, pass cheaply-copied types by value, others by reference to const.'],
  ['F.21','To return multiple values, prefer a struct/tuple over many out-parameters.'],
  ['ES.1','Prefer the standard library to hand-crafted code (use std algorithms over raw loops).'],
  ['ES.20','Always initialize an object/variable.'],
  ['ES.42','Keep pointer use simple; avoid pointer arithmetic.'],
  ['ES.45','Avoid "magic" numeric constants; use symbolic/named constants.'],
  ['ES.46','Avoid lossy/implicit arithmetic conversions.'],
  ['ES.48','Avoid casts; especially reinterpret_cast and C-style casts.'],
  ['ES.71','Prefer a range-for to a plain index for-loop where possible.'],
  ['ES.75','Avoid do-while loops.'],
  ['ES.78','Do not rely on implicit fallthrough in switch statements.'],
  ['Type.1','Avoid reinterpret_cast and unsafe casts.'],
  ['I.23','Keep the number of function arguments low.'],
  ['ES.30','Do not use macros for constants or functions.'],
  ['C.9','Minimize exposure of members (avoid needless public data).'],
];

// map NOLINT check -> guideline (for recall anchors)
const CHECK2RULE = {
  'cppcoreguidelines-pro-type-reinterpret-cast':'Type.1','cppcoreguidelines-pro-bounds-pointer-arithmetic':'ES.42',
  'cppcoreguidelines-macro-usage':'ES.30','readability-magic-numbers':'ES.45',
  'readability-convert-member-functions-to-static':'C.4','performance-unnecessary-value-param':'F.16',
  'cppcoreguidelines-pro-type-member-init':'ES.20','cppcoreguidelines-init-variables':'ES.20',
  'cppcoreguidelines-avoid-do-while':'ES.75','cppcoreguidelines-avoid-const-or-ref-data-members':'C.12',
  'cppcoreguidelines-avoid-c-arrays':'ES.48',
};

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'build' || e === 'out' || e === 'mxml-4.0.4' || e === '.git') continue;
    const p = `${dir}/${e}`; const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(cpp|hpp)$/.test(e)) acc.push(p);
  }
  return acc;
}
const files = walk(ROOT);

// string/comment-safe brace scan → function bodies with reconstructed headers
const CTRL = /^(if|for|while|switch|catch|do|else|return|namespace|struct|class|enum|union|template)\b/;
function extractFunctions(text) {
  const out = [];
  let i = 0, n = text.length;
  let state = 'code'; // code|line|block|str|chr
  const stack = [];   // open-brace positions
  let lastBoundary = -1; // last ; { } in code state (header start-1)
  const boundaryStack = [];
  while (i < n) {
    const c = text[i], c2 = text[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === '"') { state = 'str'; i++; continue; }
      if (c === "'") { state = 'chr'; i++; continue; }
      if (c === ';') { lastBoundary = i; i++; continue; }
      if (c === '{') { stack.push({ pos: i, header: text.slice(lastBoundary + 1, i) }); boundaryStack.push(lastBoundary); lastBoundary = i; i++; continue; }
      if (c === '}') { const o = stack.pop(); boundaryStack.pop(); lastBoundary = i; if (o) maybeFunc(text, o, i, out); i++; continue; }
      i++; continue;
    }
    if (state === 'line') { if (c === '\n') state = 'code'; i++; continue; }
    if (state === 'block') { if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; } i++; continue; }
    if (state === 'str') { if (c === '\\') { i += 2; continue; } if (c === '"') state = 'code'; i++; continue; }
    if (state === 'chr') { if (c === '\\') { i += 2; continue; } if (c === "'") state = 'code'; i++; continue; }
  }
  return out;
}
function maybeFunc(text, o, close, out) {
  let h = o.header.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
  // header should end with a param list + optional qualifiers/init-list
  if (!/\)\s*(const|noexcept|override|final|&|&&|mutable|\s)*(:\s*[^{]*)?$/.test(h)) return;
  if (!h.includes('(')) return;
  // name before first '(' must be an identifier and not a control keyword
  const nameMatch = /([A-Za-z_~][A-Za-z0-9_]*)\s*\(/.exec(h);
  if (!nameMatch) return;
  if (/^[A-Z][A-Z0-9_]+$/.test(nameMatch[1])) return; // all-caps => macro (SECTION/TEST_CASE/REQUIRE/GIVEN/WHEN/THEN...)
  if (CTRL.test(h) || CTRL.test(nameMatch[1])) return;
  if (/[\]\)]\s*\($/.test(h) || /\]\s*\(/.test(h)) return; // lambda-ish
  if (/=\s*$/.test(h)) return;
  const code = text.slice(o.pos - h.length >= 0 ? headerStartOf(text, o) : o.pos, close + 1);
  out.push({ startPos: headerStartOf(text, o), endPos: close + 1, name: nameMatch[1] });
}
function headerStartOf(text, o) { return o.pos - o.header.length; }

const cache = {};
const rd = abs => cache[abs] || (cache[abs] = readFileSync(abs, 'utf8').replace(/\r/g, ''));
const lineOf = (text, pos) => text.slice(0, pos).split('\n').length;
const NOLINT = /\/\/\s*NOLINT(NEXTLINE|BEGIN|END)?\s*(\(([^)]*)\))?/g;

const funcs = [];
for (const abs of files) {
  const text = rd(abs);
  let fns;
  try { fns = extractFunctions(text); } catch { continue; }
  for (const f of fns) {
    const raw = text.slice(f.startPos, f.endPos).replace(/^\s+/, '');
    const nlines = raw.split('\n').length;
    if (nlines < 2 || nlines > 70 || raw.length > 3500) continue;
    // NOLINT anchors inside this function
    const rules = new Set(); let m; NOLINT.lastIndex = 0;
    while ((m = NOLINT.exec(raw))) { const checks = (m[3] || '').split(',').map(s => s.trim()); for (const ck of checks) if (CHECK2RULE[ck]) rules.add(CHECK2RULE[ck]); }
    const codeStripped = raw.replace(/\/\/\s*(NOLINT|NOSONAR)[^\n]*/g, '').replace(/\/\*\s*(NOLINT|NOSONAR)[\s\S]*?\*\//g, '');
    funcs.push({ file: abs.slice(ROOT.length + 1), line: lineOf(text, f.startPos), name: f.name, nlines, code: codeStripped.trim(), nolint_rules: [...rules] });
  }
}

// deterministic seeded sample
const hash = s => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
funcs.sort((a, b) => hash(a.file + a.line + 'seed7') - hash(b.file + b.line + 'seed7'));
// RANDOM set (natural composition) -> field precision + prevalence:
const randomSet = funcs.slice(0, SAMPLE_N);
const randKey = new Set(randomSet.map(f => f.file + ':' + f.line));
// ANCHORED set (all NOLINT-bearing functions) -> in-context recall on checkable rules (prevalence-invariant):
const anchoredSet = funcs.filter(f => f.nolint_rules.length && !randKey.has(f.file + ':' + f.line));
// union, deterministic order
const union = [...randomSet, ...anchoredSet];

const elements = []; const meta = {}; let id = 0;
for (const f of union) {
  const eid = `E${String(++id).padStart(3, '0')}`;
  elements.push({ id: eid, file: f.file, line: f.line, code: f.code });
  meta[eid] = { file: f.file, line: f.line, name: f.name, nlines: f.nlines, nolint_rules: f.nolint_rules, in_random: randKey.has(f.file + ':' + f.line) };
}

writeFileSync(`${OUT}/leg4_rule_set.json`, JSON.stringify(RULES.map(([id, text]) => ({ id, text })), null, 2));
writeFileSync(`${OUT}/leg4_elements.json`, JSON.stringify(elements, null, 2));
writeFileSync(`${OUT}/leg4_meta.json`, JSON.stringify(meta, null, 2));
const allAnchored = funcs.filter(f => f.nolint_rules.length).length;
console.log(`total functions extracted: ${funcs.length}   all NOLINT-anchored: ${allAnchored}`);
console.log(`RANDOM set (precision/prevalence): ${randomSet.length}   ANCHORED-extra (recall): ${anchoredSet.length}   union elements: ${elements.length}`);
console.log(`anchor rules in union:`, JSON.stringify(union.flatMap(f => f.nolint_rules).reduce((a, r) => (a[r] = (a[r] || 0) + 1, a), {})));
console.log(`random-set src/test split:`, randomSet.filter(f=>/(^|\/)test\//.test(f.file)||/Test\./.test(f.file)).length + ' test, ' + randomSet.filter(f=>!(/(^|\/)test\//.test(f.file)||/Test\./.test(f.file))).length + ' src');
console.log(`median lines (random): ${randomSet.map(f => f.nlines).sort((a, b) => a - b)[Math.floor(randomSet.length / 2)]}`);
console.log(`\n--- 4 sample functions (random set) ---`);
for (const e of elements.slice(0, 4)) console.log(`\n### ${e.id} ${e.file}:${e.line}\n${e.code.slice(0, 220)}`);
