// Leg 3 harness: constructed judgment-rule pairs, validated, sealed.
// Ground truth by construction (which twin violates). Pre-reg: doc 09 §16.
import { readFileSync, writeFileSync } from 'node:fs';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';

const RULES = [
  ['R.3',   'A raw pointer (T*) is non-owning; do not OWN a resource through a raw pointer — use a smart pointer / RAII for ownership.'],
  ['C.131', 'Avoid trivial getters and setters — an accessor that only returns or assigns a member, adding no value.'],
  ['F.2',   'A function should perform a single logical operation; avoid functions that do several unrelated things.'],
  ['ES.1',  'Prefer the standard library to hand-crafted code; use standard algorithms instead of reimplementing them with raw loops.'],
  ['C.4',   'Make a function a member only if it needs the representation; a member function using no instance state should be static or free.'],
  ['C.35',  'A base class destructor should be either public and virtual, or protected and non-virtual.'],
];

const pairs = [
  ...JSON.parse(readFileSync(`${OUT}/leg3_pairs.json`, 'utf8')),
  ...JSON.parse(readFileSync(`${OUT}/leg3_pairs_2.json`, 'utf8')),
];
const val = [
  ...JSON.parse(readFileSync(`${OUT}/leg3_validation.json`, 'utf8')),
  ...JSON.parse(readFileSync(`${OUT}/leg3_validation_2.json`, 'utf8')),
];
const kept = new Set(val.filter(v => v.keep).map(v => v.pair_id));

// hash for deterministic interleave (no Math.random)
const hash = s => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };

const raw = [];
for (const block of pairs) {
  const rule = block.rule;
  for (const p of block.pairs) {
    if (!kept.has(p.pair_id)) continue;
    raw.push({ sortk: hash(p.pair_id + 'V'), code: p.violating_code, truth: 'violation', guideline: rule, pair_id: p.pair_id, twin: 'violating' });
    raw.push({ sortk: hash(p.pair_id + 'C'), code: p.compliant_code, truth: 'none', guideline: null, pair_id: p.pair_id, twin: 'compliant', rule_family: rule });
  }
}
raw.sort((a, b) => a.sortk - b.sortk);

const elements = []; const key = {}; let id = 0;
for (const r of raw) {
  const eid = `E${String(++id).padStart(3, '0')}`;
  elements.push({ id: eid, code: r.code });
  key[eid] = { truth: r.truth, guideline: r.guideline, pair_id: r.pair_id, twin: r.twin, rule_family: r.rule_family ?? r.guideline };
}

writeFileSync(`${OUT}/leg3_rule_set.json`, JSON.stringify(RULES.map(([id, text]) => ({ id, text })), null, 2));
writeFileSync(`${OUT}/leg3_elements.json`, JSON.stringify(elements, null, 2));
writeFileSync(`${OUT}/leg3_key.json`, JSON.stringify(key, null, 2));

const byRule = {};
for (const k of Object.values(key)) { const r = k.rule_family; byRule[r] = byRule[r] || { v: 0, c: 0 }; if (k.truth === 'violation') byRule[r].v++; else byRule[r].c++; }
const nV = Object.values(key).filter(k => k.truth === 'violation').length;
console.log(`kept pairs: ${kept.size}   elements: ${elements.length}  (violating ${nV}, compliant ${elements.length - nV})`);
console.log('by rule (violating/compliant):', JSON.stringify(byRule));
console.log('avg code length (chars):', Math.round(elements.reduce((a, e) => a + e.code.length, 0) / elements.length));
