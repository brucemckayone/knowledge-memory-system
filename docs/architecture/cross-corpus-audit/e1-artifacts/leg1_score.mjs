import { readFileSync } from 'node:fs';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';
const key = JSON.parse(readFileSync(`${OUT}/key.json`, 'utf8'));
const resp = JSON.parse(readFileSync(`${OUT}/responses.json`, 'utf8'));
const byId = Object.fromEntries(resp.map(r => [r.id, r.finding]));

// exact-id equivalence for now (system used only C.12/C.48, both exact); scorer subagent handles fuzzy
let TP = 0, FP = 0, FN = 0, TN = 0;
const rows = [];
const disagreements = [];
for (const [id, k] of Object.entries(key)) {
  const f = byId[id] ?? '(missing)';
  const truthViol = k.truth === 'violation';
  const sysViol = f !== 'none' && f !== '(missing)';
  let cls;
  if (truthViol && sysViol && f === k.guideline) { cls = 'TP'; TP++; }
  else if (truthViol && (!sysViol || f !== k.guideline)) { cls = 'FN'; FN++; if (sysViol) { cls = 'FN(wrong-rule)'; FP++; } }
  else if (!truthViol && sysViol) { cls = 'FP'; FP++; }
  else { cls = 'TN'; TN++; }
  rows.push({ id, truth: truthViol ? k.guideline : 'none', sys: f, cls });
  if (cls !== 'TP' && cls !== 'TN') disagreements.push({ id, file: k.file, line: k.line, oracle: truthViol ? k.guideline : 'none', system: f, check: k.check, msg: k.msg });
}
const prec = TP / (TP + FP) || 0, rec = TP / (TP + FN) || 0;
// verdict-level (binary violation vs none, ignore which rule)
let vTP=0,vFP=0,vFN=0,vTN=0;
for (const [id,k] of Object.entries(key)){const f=byId[id]??'none';const tv=k.truth==='violation';const sv=f!=='none'&&f!=='(missing)';if(tv&&sv)vTP++;else if(tv&&!sv)vFN++;else if(!tv&&sv)vFP++;else vTN++;}
const vprec=vTP/(vTP+vFP)||0, vrec=vTP/(vTP+vFN)||0;

console.log('=== RAW (system vs clang-tidy oracle, exact-rule match) ===');
console.log(`positives=${TP+FN}  negatives=${TN+FP}  total=${rows.length}`);
console.log(`TP=${TP} FP=${FP} FN=${FN} TN=${TN}`);
console.log(`RULE-LEVEL  precision=${prec.toFixed(2)}  recall=${rec.toFixed(2)}`);
console.log(`VERDICT-LEVEL (violation vs none)  precision=${vprec.toFixed(2)}  recall=${vrec.toFixed(2)}  (vTP=${vTP} vFP=${vFP} vFN=${vFN} vTN=${vTN})`);
console.log('\nPRE-REGISTERED BAR: PASS iff precision>=0.70 AND recall>=0.60 (>=40 elements). HARD FAIL if precision<0.50 or recall<0.40.');
const verdict = prec>=0.70&&rec>=0.60 ? 'PASS' : (prec<0.50||rec<0.40 ? 'HARD FAIL' : 'AMBIGUOUS');
console.log(`RAW rule-level verdict: ${verdict}`);
console.log('\n=== breakdown by oracle guideline ===');
const g = {}; for (const [id,k] of Object.entries(key)){ if(k.truth!=='violation')continue; const f=byId[id]; g[k.guideline]=g[k.guideline]||{n:0,hit:0}; g[k.guideline].n++; if(f===k.guideline)g[k.guideline].hit++; }
for (const [gid,v] of Object.entries(g)) console.log(`  ${gid}: recall ${v.hit}/${v.n}`);
console.log('\n=== DISAGREEMENTS (for independent adjudication) ===');
for (const d of disagreements) console.log(`  ${d.id} ${d.file.split('/').pop()}:${d.line}  oracle=${d.oracle}  system=${d.system}`);
import('node:fs').then(fs=>fs.writeFileSync(`${OUT}/disagreements.json`, JSON.stringify(disagreements,null,2)));
