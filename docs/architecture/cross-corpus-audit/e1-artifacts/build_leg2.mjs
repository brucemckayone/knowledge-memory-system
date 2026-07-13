// Leg 2 harness: natural violations mined from human NOLINT annotations.
// Drift-free (live NOLINT = live violation), non-LLM labels (human + clang-tidy).
// Pre-registration: docs/architecture/cross-corpus-audit/09-e1-proxy-test.md §14.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
const ROOT = 'C:/Users/bruce.mckay/dev/maverick/ALPHA-2570-base-classes';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';

const MAP = {
  'cppcoreguidelines-pro-type-reinterpret-cast':      ['Type.1', 'Avoid reinterpret_cast; do not use unsafe casts.'],
  'cppcoreguidelines-pro-bounds-pointer-arithmetic':  ['ES.42',  'Keep pointer use simple; avoid pointer arithmetic.'],
  'cppcoreguidelines-macro-usage':                    ['ES.30',  'Do not use macros for constants or functions; prefer constexpr/inline.'],
  'readability-magic-numbers':                        ['ES.45',  'Avoid "magic" constants; use symbolic/named constants.'],
  'readability-convert-member-functions-to-static':   ['C.4',    'A member function that uses no instance state should be static or free (make a function a member only if it needs the object).'],
  'performance-unnecessary-value-param':              ['F.16',   'For "in" parameters, pass cheaply-copied types by value and others by reference to const; avoid unnecessary by-value copies.'],
  'cppcoreguidelines-pro-type-member-init':           ['C.48',   'Initialize all data members.'],
  'cppcoreguidelines-init-variables':                 ['ES.20',  'Always initialize an object/variable.'],
  'cppcoreguidelines-avoid-do-while':                 ['ES.75',  'Avoid do-while loops.'],
  'cppcoreguidelines-avoid-const-or-ref-data-members':['C.12',   'Do not make data members const or references in a copyable/movable type.'],
  'cppcoreguidelines-avoid-c-arrays':                 ['SL.con.1','Prefer std::array or std::vector to C-style arrays.'],
};
const CAP = 6;
const RULE_SET = Object.values(MAP).map(([id, text]) => ({ id, text }));
const seenR = new Set(); const RULES = RULE_SET.filter(r => !seenR.has(r.id) && seenR.add(r.id));

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
const clean = s => (s || '').replace(/\r/g, '');
const rel = abs => abs.slice(ROOT.length + 1);
const NOLINT_RE = /\/\/\s*NOLINT(NEXTLINE)?\s*\(([^)]*)\)/;
const ANY_NOLINT = /NOLINT|NOSONAR/;
// advance past bare template<>/attribute/blank prefix lines to the real code element
function resolveTarget(ls, line) {
  let t = line;
  for (let hop = 0; hop < 3; hop++) {
    const s = clean(ls[t - 1] ?? '').trim();
    if (s === '' || /^template\s*<[^>]*>\s*$/.test(s) || /^\[\[.*\]\]\s*$/.test(s)) t++;
    else break;
  }
  return t;
}

// ---- mine positives ----
const positives = [];
for (const abs of files) {
  const ls = clean(readFileSync(abs, 'utf8')).split('\n');
  for (let i = 0; i < ls.length; i++) {
    const m = NOLINT_RE.exec(ls[i]);
    if (!m) continue;
    const isNext = !!m[1];
    const checks = m[2].split(',').map(s => s.trim()).filter(Boolean);
    const targetLine = resolveTarget(ls, isNext ? i + 2 : i + 1); // NEXTLINE->next line; advance past template<>/attr
    for (const chk of checks) {
      if (!MAP[chk]) continue;
      const [gid] = MAP[chk];
      positives.push({ abs, rel: rel(abs), line: targetLine, check: chk, guideline: gid });
    }
  }
}
// dedup by rel:line:guideline, cap per guideline (deterministic: sort by path/line)
const seen = new Set(); const capCount = {};
positives.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
const pos = [];
for (const p of positives) {
  const k = `${p.rel}:${p.line}:${p.guideline}`; if (seen.has(k)) continue; seen.add(k);
  capCount[p.guideline] = (capCount[p.guideline] || 0);
  if (capCount[p.guideline] >= CAP) continue;
  capCount[p.guideline]++; pos.push(p);
}

// ---- code window with ALL NOLINT markers stripped ----
const fileLines = abs => clean(readFileSync(abs, 'utf8')).split('\n');
function windowStripped(abs, line, before = 6, after = 7) {
  const ls = fileLines(abs);
  const lo = Math.max(1, line - before), hi = Math.min(ls.length, line + after);
  const out = [];
  for (let i = lo; i <= hi; i++) {
    let t = ls[i - 1] ?? '';
    if (ANY_NOLINT.test(t)) {                    // strip lint marker; keep code if inline before comment
      t = t.replace(/\/\/\s*(NOLINT|NOSONAR).*$/, '').replace(/\/\*\s*(NOLINT|NOSONAR).*?\*\//g, '');
      if (!t.trim()) continue;                   // drop pure-marker lines
    }
    out.push(`${String(i).padStart(4)}${i === line ? ' >' : '  '}| ${t}`);
  }
  return out.join('\n');
}

// ---- negatives: clearly-compliant near-misses from the same files, no NOLINT nearby ----
const posFiles = [...new Set(pos.map(p => p.rel))];
const NEG_KINDS = [
  { kind: 'static_cast',   re: /\bstatic_cast<|\bdynamic_cast</ },      // control for Type.1
  { kind: 'named-const',   re: /\b(static\s+)?constexpr\b.*=|\bconst\s+\w+\s+[A-Z][A-Z0-9_]{2,}\s*=/ }, // control for ES.30/ES.45
  { kind: 'range-for',     re: /\bfor\s*\(\s*(const\s+)?auto\s*[&:]/ }, // control for ES.75/ES.42
  { kind: 'func-def',      re: /^[\w:<>,&*\s]+\b\w+\s*\([^;{]*\)\s*(const)?\s*(noexcept)?\s*\{/ },
  { kind: 'using',         re: /^\s*using\s+\w+\s*=/ },
];
const BAD_IN_NEG = /reinterpret_cast|#\s*define|\breturn\b.*[^=<>!]=[^=]|\bdo\b|\[\s*\d|\b[2-9]\d*\b/; // exclude potential uncaught violations & magic numbers>=2
const negatives = [];
for (const rf of posFiles) {
  const abs = `${ROOT}/${rf}`;
  const ls = fileLines(abs);
  const nolintLines = []; for (let i = 1; i <= ls.length; i++) if (ANY_NOLINT.test(ls[i - 1])) nolintLines.push(i);
  const near = i => nolintLines.some(n => Math.abs(n - i) <= 3);
  const cands = [];
  for (let i = 1; i <= ls.length; i++) {
    const t = ls[i - 1]; if (!t || t.trim().length < 8) continue;
    if (near(i)) continue;
    if (BAD_IN_NEG.test(t)) continue;
    const hit = NEG_KINDS.find(k => k.re.test(t)); if (!hit) continue;
    cands.push({ line: i, kind: hit.kind });
  }
  const stride = Math.max(1, Math.floor(cands.length / 3));
  let taken = 0;
  for (let j = 0; j < cands.length && taken < 3; j += stride) { negatives.push({ abs, rel: rf, line: cands[j].line, kind: cands[j].kind }); taken++; }
}

// ---- assemble + seal ----
const elements = []; const key = {}; let id = 0;
for (const p of pos) { const eid = `E${String(++id).padStart(3,'0')}`; elements.push({ id: eid, file: p.rel, line: p.line, code: windowStripped(p.abs, p.line) }); key[eid] = { truth: 'violation', guideline: p.guideline, check: p.check, file: p.rel, line: p.line }; }
for (const n of negatives) { const eid = `E${String(++id).padStart(3,'0')}`; elements.push({ id: eid, file: n.rel, line: n.line, code: windowStripped(n.abs, n.line, 4, 4) }); key[eid] = { truth: 'none', guideline: null, kind: n.kind, file: n.rel, line: n.line }; }
elements.sort((a, b) => (a.id.charCodeAt(3) % 2) - (b.id.charCodeAt(3) % 2) || a.id.localeCompare(b.id));

writeFileSync(`${OUT}/leg2_rule_set.json`, JSON.stringify(RULES, null, 2));
writeFileSync(`${OUT}/leg2_elements.json`, JSON.stringify(elements, null, 2));
writeFileSync(`${OUT}/leg2_key.json`, JSON.stringify(key, null, 2));
const byRule = {}; for (const p of pos) byRule[p.guideline] = (byRule[p.guideline]||0)+1;
console.log(`positives: ${pos.length}  negatives: ${negatives.length}  total: ${elements.length}`);
console.log(`positives by guideline:`, JSON.stringify(byRule));
console.log(`negatives by kind:`, JSON.stringify(negatives.reduce((a,n)=>(a[n.kind]=(a[n.kind]||0)+1,a),{})));
