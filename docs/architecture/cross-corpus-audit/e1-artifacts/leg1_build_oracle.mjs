// Real E1 gate — Leg 1 harness builder (v2: content-anchored, drift-robust).
// The clang-tidy-coverage checkout has drifted from the log version, so LINE NUMBERS
// are unreliable. We relocate each diagnostic by the SYMBOL in its message and verify
// the violating construct still exists; drift-casualties (violation refactored away)
// are dropped and logged. Pre-registration: docs/.../09-e1-proxy-test.md §12.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CHECKOUT = 'C:/Users/bruce.mckay/dev/maverick/clang-tidy-coverage';
const LOGS = [`${CHECKOUT}/doc/tidy-logs/conv-test.log`, `${CHECKOUT}/doc/tidy-logs/rep-test.log`];
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';

const MAP = {
  'cppcoreguidelines-pro-type-member-init':               ['C.48',  'Initialize all data members; do not leave a member uninitialized by the constructor.'],
  'readability-convert-member-functions-to-static':       ['C.4',   'Make a function a member only if it needs direct access to the representation; a method using none of the object state should not be a non-static member.'],
  'cppcoreguidelines-avoid-const-or-ref-data-members':    ['C.12',  'Do not make data members const or references in a copyable/movable type.'],
  'cppcoreguidelines-avoid-c-arrays':                     ['SL.con.1','Prefer std::array or std::vector to C-style arrays.'],
  'cppcoreguidelines-avoid-do-while':                     ['ES.75', 'Avoid do-while loops.'],
  'bugprone-implicit-widening-of-multiplication-result':  ['ES.46', 'Avoid implicit widening of a multiplication performed in a narrower type.'],
  'cppcoreguidelines-pro-bounds-pointer-arithmetic':      ['ES.42', 'Keep pointer use simple; avoid pointer arithmetic.'],
  'cppcoreguidelines-pro-type-reinterpret-cast':          ['Type.1','Avoid reinterpret_cast.'],
  'cppcoreguidelines-macro-usage':                        ['ES.30', 'Do not use macros for constants/functions.'],
  'modernize-use-using':                                  ['Modernize.use-using', 'Prefer a using alias to a typedef.'],
};
const EXCLUDED = new Set(['readability-identifier-naming','cppcoreguidelines-avoid-non-const-global-variables','misc-include-cleaner','readability-identifier-length','bugprone-reserved-identifier','clang-diagnostic-error','-warnings-as-errors']);
const VENDORED = rel => /mxml-4\.0\.4|third[_-]?party|\/external\/|\/vendor\//i.test(rel);
const DIAG = /^(.*?):(\d+):(\d+):\s+(warning|error):\s+(.*?)\s+\[([a-zA-Z0-9_.,-]+)\]\s*$/;
const toLocal = p => p.replace(/^\/workspace\//, '');

// candidate rule set shown to the system (all 10; some may end up as distractors)
const seenId = new Set();
const RULE_SET = Object.values(MAP).map(([id, text]) => ({ id, text })).filter(r => !seenId.has(r.id) && seenId.add(r.id));

const fileCache = new Map();
const lines = abs => fileCache.has(abs) ? fileCache.get(abs) : (fileCache.set(abs, readFileSync(abs, 'utf8').split(/\r?\n/)), fileCache.get(abs));
const clean = s => (s || '').replace(/\r/g, '');
function window(abs, line, before = 8, after = 10) {
  const ls = lines(abs); const lo = Math.max(1, line - before), hi = Math.min(ls.length, line + after);
  const out = []; for (let i = lo; i <= hi; i++) out.push(`${String(i).padStart(4)}${i === line ? ' >' : '  '}| ${clean(ls[i - 1])}`);
  return out.join('\n');
}
const findLine = (ls, re, from = 0) => { for (let i = from; i < ls.length; i++) if (re.test(clean(ls[i]))) return i + 1; return 0; };

// ---- content relocation per rule; returns {line, before, after} or null (drop) ----
function relocate(abs, guideline, msg) {
  const ls = lines(abs);
  if (guideline === 'C.48') {
    const m = /initialize these fields:\s*(.+)$/.exec(msg); if (!m) return null;
    const fields = m[1].split(',').map(s => s.trim()).filter(Boolean);
    let anchor = 0, uninit = false;
    for (const f of fields) {
      const ln = findLine(ls, new RegExp(`\\b${f.replace(/[^\w]/g, '')}\\b\\s*[;={,]`));
      if (ln) { if (!anchor || ln < anchor) anchor = ln; const t = clean(ls[ln - 1]); if (!/[={]/.test(t.split('//')[0])) uninit = true; }
    }
    if (!anchor) return null;                 // fields gone -> drift, drop
    if (!uninit) return null;                 // all now initialized -> fixed, drop
    return { line: anchor, before: 6, after: 14 };
  }
  if (guideline === 'C.12') {
    const m = /member '([^']+)'/.exec(msg); if (!m) return null;
    const ln = findLine(ls, new RegExp(`\\b${m[1]}\\b`));
    if (!ln) return null;
    if (!/\bconst\b/.test(clean(ls[ln - 1]))) return null;   // no longer const -> drop
    return { line: ln, before: 4, after: 4 };
  }
  if (guideline === 'C.4') {
    const m = /method '([^']+)'/.exec(msg); if (!m) return null;
    // require a type token immediately before NAME( -> the definition, not a call site
    const ln = findLine(ls, new RegExp(`[\\w>&*:]\\s+${m[1]}\\s*\\(`));
    if (!ln) return null;
    return { line: ln, before: 2, after: 8 };
  }
  if (guideline === 'ES.75') { const ln = findLine(ls, /^\s*do\b/); return ln ? { line: ln, before: 2, after: 12 } : null; }
  if (guideline === 'SL.con.1') { const ln = findLine(ls, /\b\w+\s+\w+\s*\[\s*[0-9A-Za-z_]/); return ln ? { line: ln, before: 4, after: 4 } : null; }
  if (guideline === 'Type.1') { const ln = findLine(ls, /reinterpret_cast/); return ln ? { line: ln, before: 4, after: 4 } : null; }
  // ES.42 (generic pointer-arith) and ES.46 (generic multiplication-widening) have no
  // reliable content anchor after drift -> dropped rather than mis-anchored.
  return null; // ES.42/ES.46/ES.30/Modernize -> no positives (distractors in the rule set)
}

// ---- parse + relocate positives (dedup by file+guideline+symbol) ----
const seen = new Set(); const positives = []; const dropped = [];
for (const log of LOGS) {
  for (const line of readFileSync(log, 'utf8').split(/\r?\n/)) {
    const m = DIAG.exec(line); if (!m) continue;
    const [, path, , , , msg, checksRaw] = m; const checks = checksRaw.split(',');
    if (checks.includes('clang-diagnostic-error')) continue;
    for (const chk of checks) {
      if (EXCLUDED.has(chk) || !MAP[chk]) continue;
      const rel = toLocal(path); if (VENDORED(rel)) continue;
      const abs = `${CHECKOUT}/${rel}`; if (!existsSync(abs)) continue;
      const [gid] = MAP[chk];
      const sym = (/fields:\s*(.+)$/.exec(msg)?.[1] || /'([^']+)'/.exec(msg)?.[1] || gid).trim();
      const dk = `${rel}|${gid}|${sym}`; if (seen.has(dk)) continue; seen.add(dk);
      const loc = relocate(abs, gid, msg);
      if (!loc) { dropped.push(`${rel} ${gid} [${sym}]`); continue; }
      positives.push({ rel, abs, line: loc.line, guideline: gid, check: chk, msg, before: loc.before, after: loc.after });
    }
  }
}

// ---- negatives: genuinely-compliant near-misses, same files, junk & violations excluded ----
const posFiles = [...new Set(positives.map(p => p.rel))].sort();
const posAnchorTxt = new Set(positives.map(p => clean(lines(p.abs)[p.line - 1]).trim()));
// symbols named in any positive msg per file -> a negative must not touch these
const posSymByFile = new Map();
for (const p of positives) {
  const syms = (/fields:\s*(.+)$/.exec(p.msg)?.[1]?.split(',').map(s => s.trim()) || []);
  const one = /'([^']+)'/.exec(p.msg)?.[1]; if (one) syms.push(one);
  if (!posSymByFile.has(p.rel)) posSymByFile.set(p.rel, new Set());
  for (const s of syms) if (s) posSymByFile.get(p.rel).add(s.replace(/[^\w]/g, ''));
}
const JUNK = /^\s*#|^\s*(throw|return|REQUIRE|CHECK|SECTION|GIVEN|WHEN|THEN|static_cast<void>|mxml|\/\/|\/\*|\*|})/;
const KIND = [
  // method decl/def (near-miss for C.4): a type token before NAME(
  { kind: 'method', re: /[\w>&*:]\s+\w+\s*\([^;{]*\)\s*(const)?\s*(override|final|noexcept)?\s*[{;]/ },
  // using-alias (distractor for the modernize rule)
  { kind: 'using',  re: /^\s*using\s+\w+\s*=/ },
  // loop (near-miss for ES.75/ES.71)
  { kind: 'loop',   re: /^\s*(for|while)\s*\(/ },
  // clearly-compliant constant member: static/constexpr with an initializer (never a C.48/C.12 target)
  { kind: 'const-member', re: /^\s*static\s+(constexpr\s+)?const[\w:<>,&*\s]+\w+\s*=/ },
];
const isConstDataMember = t => /^\s*const\b/.test(t) && !/\bstatic\b/.test(t);   // would be a C.12 violation
const touchesPosSym = (t, rel) => { const s = posSymByFile.get(rel); if (!s) return false; for (const sym of s) if (sym && new RegExp(`\\b${sym}\\b`).test(t)) return true; return false; };
const negatives = [];
for (const rel of posFiles) {
  const abs = `${CHECKOUT}/${rel}`; const ls = lines(abs);
  const cands = [];
  for (let i = 1; i <= ls.length; i++) {
    const t = clean(ls[i - 1]); if (t.trim().length < 8) continue;
    if (JUNK.test(t)) continue;
    if (isConstDataMember(t)) continue;                 // avoid C.12 violations
    if (posAnchorTxt.has(t.trim())) continue;           // not a positive anchor
    if (touchesPosSym(t, rel)) continue;                // not a symbol named in a violation here
    const hit = KIND.find(k => k.re.test(t)); if (!hit) continue;
    cands.push({ line: i, kind: hit.kind });
  }
  const stride = Math.max(1, Math.floor(cands.length / 3));
  let taken = 0;
  for (let j = 0; j < cands.length && taken < 3; j += stride) { negatives.push({ rel, abs, line: cands[j].line, kind: cands[j].kind }); taken++; }
}

// ---- assemble + seal ----
const elements = []; const key = {}; let id = 0;
for (const p of positives) { const eid = `E${String(++id).padStart(3,'0')}`; elements.push({ id: eid, file: p.rel, line: p.line, code: window(p.abs, p.line, p.before, p.after) }); key[eid] = { truth: 'violation', guideline: p.guideline, check: p.check, msg: p.msg, file: p.rel, line: p.line }; }
for (const n of negatives) { const eid = `E${String(++id).padStart(3,'0')}`; elements.push({ id: eid, file: n.rel, line: n.line, code: window(n.abs, n.line, 5, 5) }); key[eid] = { truth: 'none', guideline: null, kind: n.kind, file: n.rel, line: n.line }; }
elements.sort((a, b) => (a.id.charCodeAt(3) % 2) - (b.id.charCodeAt(3) % 2) || a.id.localeCompare(b.id));

writeFileSync(`${OUT}/rule_set.json`, JSON.stringify(RULE_SET, null, 2));
writeFileSync(`${OUT}/elements.json`, JSON.stringify(elements, null, 2));
writeFileSync(`${OUT}/key.json`, JSON.stringify(key, null, 2));

const byRule = {}; for (const p of positives) byRule[p.guideline] = (byRule[p.guideline]||0)+1;
console.log(`positives: ${positives.length}  negatives: ${negatives.length}  total: ${elements.length}`);
console.log(`positives by guideline:`, JSON.stringify(byRule));
console.log(`negatives by kind:`, JSON.stringify(negatives.reduce((a,n)=>(a[n.kind]=(a[n.kind]||0)+1,a),{})));
console.log(`DROPPED (drift/unrelocatable): ${dropped.length}`); dropped.forEach(d => console.log('  - ' + d));
