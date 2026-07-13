import { readFileSync } from 'node:fs';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';
const key = JSON.parse(readFileSync(`${OUT}/leg3_key.json`, 'utf8'));
const resp = JSON.parse(readFileSync(`${OUT}/leg3_responses.json`, 'utf8'));
const reaudit = JSON.parse(readFileSync(`${OUT}/leg3_twin_reaudit.json`, 'utf8'));
const byId = Object.fromEntries(resp.map(r => [r.id, r.finding]));

// apply full-reaudit corrections symmetrically: contaminated "compliant" twins become violations
const contam = {}; for (const r of reaudit) if (!r.clean) contam[r.pair_id] = r.violations[0]; // primary violated rule
const idByPairTwin = {}; for (const [id, k] of Object.entries(key)) idByPairTwin[`${k.pair_id}|${k.twin}`] = id;
const corrections = [];
for (const [pid, rule] of Object.entries(contam)) {
  const id = idByPairTwin[`${pid}|compliant`]; if (!id) continue;
  key[id] = { ...key[id], truth: 'violation', guideline: rule };
  corrections.push({ id, pid, rule, system: byId[id] ?? 'none' });
}

function score(K) {
  let TP=0,FP=0,FN=0,TN=0;
  for (const [id,k] of Object.entries(K)) {
    const f = byId[id] ?? 'none'; const tv = k.truth==='violation'; const sv = f!=='none';
    if (tv&&sv&&f===k.guideline) TP++;
    else if (tv){ FN++; if(sv) FP++; }
    else if (!tv&&sv) FP++;
    else TN++;
  }
  return {TP,FP,FN,TN, precision:TP/(TP+FP)||0, recall:TP/(TP+FN)||0};
}
const s = score(key);
const TPR = s.TP/(s.TP+s.FN), FPR = s.FP/(s.FP+s.TN);
console.log('=== LEG 3 CORRECTED (full-reaudit; 3 contaminated twins relabelled symmetrically) ===');
console.log('corrections applied:'); corrections.forEach(c => console.log(`  ${c.id} ${c.pid} -> violation/${c.rule}  (system said ${c.system})  ${c.system===c.rule?'[now TP]':'[now FN — hidden miss]'}`));
console.log(`\nTP=${s.TP} FP=${s.FP} FN=${s.FN} TN=${s.TN}`);
console.log(`rule-level precision=${s.precision.toFixed(2)}  recall=${s.recall.toFixed(2)}`);
console.log(`TPR=${TPR.toFixed(3)}  FPR=${FPR.toFixed(3)}`);
console.log('\n=== base-rate-adjusted precision (field prevalence) — the operating-point reality ===');
for (const p of [0.50, 0.20, 0.10, 0.05, 0.02]) {
  const prec = (TPR*p)/(TPR*p + FPR*(1-p)) || 0;
  console.log(`  prevalence ${(p*100).toFixed(0).padStart(2)}%  ->  field precision ${prec.toFixed(2)}`);
}
console.log('\n(recall/TPR is prevalence-invariant = '+TPR.toFixed(2)+'; precision collapses as prevalence drops unless a candidate-prefilter raises effective prevalence.)');
