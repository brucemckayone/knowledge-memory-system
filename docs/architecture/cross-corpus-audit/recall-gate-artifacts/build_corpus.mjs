import fs from 'node:fs';
const A = 'docs/architecture/cross-corpus-audit/e1-artifacts';
const OUT = 'docs/architecture/cross-corpus-audit/recall-gate-artifacts';

// ---- std corpus: union(leg2, leg4) by id, leg2 text preferred ----
const rs2 = JSON.parse(fs.readFileSync(`${A}/leg2_rule_set.json`,'utf8'));
const rs4 = JSON.parse(fs.readFileSync(`${A}/leg4_rule_set.json`,'utf8'));
const byId = new Map();
for (const r of rs4) byId.set(r.id, r.text);   // leg4 first
for (const r of rs2) byId.set(r.id, r.text);   // leg2 overwrites (preferred)
const rules = [...byId.entries()].map(([id,text])=>({id,text})).sort((a,b)=>a.id.localeCompare(b.id));
fs.writeFileSync(`${OUT}/gate_rules.json`, JSON.stringify(rules,null,2));

// ---- code corpus: 29 leg2 positives, cleaned code + true guideline ----
const key = JSON.parse(fs.readFileSync(`${A}/leg2_key.json`,'utf8'));
const els = JSON.parse(fs.readFileSync(`${A}/leg2_elements.json`,'utf8'));
const elById = new Map(els.map(e=>[e.id,e]));
function clean(code){
  return code.split('\n')
    .map(l=>l.replace(/^\s*\d+\s*>?\s*\|\s?/,''))   // strip "  NN >| " / "  NN  | " gutters
    .filter(l=>l.trim()!=='...')                     // drop truncation markers
    .join('\n').trim();
}
const positives = Object.entries(key).filter(([,v])=>v.truth==='violation');
const code = positives.map(([id,v])=>{
  const el = elById.get(id);
  return { id, trueGuideline: v.guideline, file: el.file, line: el.line, code: clean(el.code) };
});
fs.writeFileSync(`${OUT}/gate_code_raw.json`, JSON.stringify(code,null,2));

// sanity: every true guideline present in rules
const ruleIds = new Set(rules.map(r=>r.id));
const missing = [...new Set(code.map(c=>c.trueGuideline))].filter(g=>!ruleIds.has(g));
console.log(`rules(std corpus): ${rules.length}  |  code items: ${code.length}`);
console.log(`distractor rules: ${rules.length - new Set(code.map(c=>c.trueGuideline)).size}`);
console.log(`true guidelines missing from std corpus: [${missing.join(', ')}]  (must be empty)`);
console.log(`\nrule ids: ${rules.map(r=>r.id).join(', ')}`);
console.log(`\nsample cleaned code (${code[0].id}, true=${code[0].trueGuideline}):\n${code[0].code}`);
