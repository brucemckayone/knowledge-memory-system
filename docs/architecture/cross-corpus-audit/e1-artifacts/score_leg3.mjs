import { readFileSync, writeFileSync } from 'node:fs';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';
const key = JSON.parse(readFileSync(`${OUT}/leg3_key.json`, 'utf8'));
const resp = JSON.parse(readFileSync(`${OUT}/leg3_responses.json`, 'utf8'));
const byId = Object.fromEntries(resp.map(r => [r.id, r.finding]));

let TP = 0, FP = 0, FN = 0, TN = 0; const disagreements = [];
for (const [id, k] of Object.entries(key)) {
  const f = byId[id] ?? '(missing)';
  const tv = k.truth === 'violation';
  const sv = f !== 'none' && f !== '(missing)';
  let cls;
  if (tv && sv && f === k.guideline) { cls = 'TP'; TP++; }
  else if (tv) { cls = sv ? 'FN(wrong-rule)' : 'FN'; FN++; if (sv) FP++; }
  else if (!tv && sv) { cls = 'FP'; FP++; }
  else { cls = 'TN'; TN++; }
  if (cls !== 'TP' && cls !== 'TN') disagreements.push({ id, pair: k.pair_id, twin: k.twin, oracle: tv ? k.guideline : 'none', system: f });
}
const prec = TP / (TP + FP) || 0, rec = TP / (TP + FN) || 0;
// verdict-level
let vTP=0,vFP=0,vFN=0,vTN=0;
for (const [id,k] of Object.entries(key)){const f=byId[id]??'none';const tv=k.truth==='violation';const sv=f!=='none'&&f!=='(missing)';if(tv&&sv)vTP++;else if(tv&&!sv)vFN++;else if(!tv&&sv)vFP++;else vTN++;}
// paired discrimination: for each pair, violating flagged w/ correct rule AND compliant cleared
const pairs = {};
for (const [id,k] of Object.entries(key)){ (pairs[k.pair_id] ||= {})[k.twin] = { id, k, f: byId[id] ?? 'none' }; }
let pairOK=0, pairN=0;
for (const [pid,p] of Object.entries(pairs)){
  if(!p.violating||!p.compliant) continue; pairN++;
  const vOK = p.violating.f === p.violating.k.guideline;
  const cOK = p.compliant.f === 'none';
  if (vOK && cOK) pairOK++;
}
console.log('=== LEG 3 (constructed judgment rules) — system vs sealed plant key ===');
console.log(`elements=${Object.keys(key).length}  positives=${TP+FN}  negatives=${TN+FP}`);
console.log(`TP=${TP} FP=${FP} FN=${FN} TN=${TN}`);
console.log(`RULE-LEVEL   precision=${prec.toFixed(2)}  recall=${rec.toFixed(2)}`);
console.log(`VERDICT-LEVEL precision=${(vTP/(vTP+vFP)||0).toFixed(2)}  recall=${(vTP/(vTP+vFN)||0).toFixed(2)}  (vTP=${vTP} vFP=${vFP} vFN=${vFN} vTN=${vTN})`);
console.log(`PAIRED DISCRIMINATION: ${pairOK}/${pairN} (${(pairOK/pairN).toFixed(2)}) pairs where violating twin flagged w/ correct rule AND compliant twin cleared`);
console.log('\nPRE-REGISTERED BAR: PASS iff precision>=0.70 AND recall>=0.60 (>=40 elems). HARD FAIL if precision<0.50 or recall<0.40.');
console.log(`VERDICT: ${prec>=0.70&&rec>=0.60?'PASS':(prec<0.50||rec<0.40?'HARD FAIL':'AMBIGUOUS')}`);
console.log('\n=== per-rule recall (violating twins) ===');
const g={}; for(const [id,k] of Object.entries(key)){ if(k.truth!=='violation')continue; const f=byId[id]; g[k.guideline]=g[k.guideline]||{n:0,hit:0}; g[k.guideline].n++; if(f===k.guideline)g[k.guideline].hit++; }
for(const [gid,v] of Object.entries(g)) console.log(`  ${gid.padEnd(6)} ${v.hit}/${v.n}`);
console.log('\n=== per-rule false positives (compliant twins flagged) ===');
const c={}; for(const [id,k] of Object.entries(key)){ if(k.truth!=='none')continue; const f=byId[id]; if(f!=='none'&&f!=='(missing)'){c[k.rule_family]=(c[k.rule_family]||0)+1;} }
console.log('  '+(Object.keys(c).length?JSON.stringify(c):'none'));
console.log('\n=== DISAGREEMENTS ===');
for(const d of disagreements) console.log(`  ${d.id} ${d.pair}/${d.twin}  oracle=${d.oracle} system=${d.system}`);
writeFileSync(`${OUT}/leg3_disagreements.json`, JSON.stringify(disagreements,null,2));
