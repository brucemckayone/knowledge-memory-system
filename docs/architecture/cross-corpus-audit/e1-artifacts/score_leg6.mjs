// Leg 6 scorer. Ground truth T = capable adjudicator over the 265 superset.
// Classifiers scored vs T: dumb-AST (strict net), smart-AST, net->Haiku pipeline.
// Also: superset-incompleteness via non-superset spotcheck; cross-model agreement.
import { readFileSync, writeFileSync } from 'node:fs';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';
const J = f => JSON.parse(readFileSync(`${OUT}/${f}`, 'utf8'));

const cl = J('leg6_classifiers.json');
const truth = J('leg6_truth.json');
const spot = J('leg6_spotcheck.json');
const haiku = J('leg6_pipeline_haiku.json');

const dumb = new Set(cl.dumb_ids);
const smart = new Set(cl.smart_ids);
const truthV = new Map(truth.map(t => [t.id, t.verdict]));
const haikuV = new Map(haiku.map(h => [h.id, h.verdict]));

const T = new Set(truth.filter(t => t.verdict === 'violation').map(t => t.id)); // true C.131 sites in superset
const supersetIds = cl.superset_ids;

const z = 1.96;
const wilson = (k, n) => { if (n === 0) return [0, 0]; const p = k / n, d = 1 + z*z/n, c = p + z*z/(2*n), m = z*Math.sqrt(p*(1-p)/n + z*z/(4*n*n)); return [(c-m)/d, (c+m)/d]; };
const pct = x => (x * 100).toFixed(1);
const ci = (k, n) => { const [lo, hi] = wilson(k, n); return `[${pct(lo)}, ${pct(hi)}]`; };

function score(predSet, label) {
  const tp = [...predSet].filter(id => T.has(id)).length;
  const fp = [...predSet].filter(id => !T.has(id)).length;
  const fn = [...T].filter(id => !predSet.has(id)).length;
  const prec = predSet.size ? tp / predSet.size : 0;
  const rec = T.size ? tp / T.size : 0;
  return { label, predicted: predSet.size, tp, fp, fn, precision: prec, recall: rec,
           prec_ci: ci(tp, predSet.size), rec_ci: ci(tp, T.size) };
}

// net->Haiku pipeline: strict net (dumb) surfaces 119, Haiku keeps verdict==violation
const H = new Set([...dumb].filter(id => haikuV.get(id) === 'violation'));

const smartPrereg = new Set(cl.smart_prereg_ids);
const dumbR = score(dumb, 'dumb-AST (strict net)');
const smartPreR = score(smartPrereg, 'smart-AST PRE-REGISTERED');
const smartR = score(smart, 'smart-AST v2 (post-hoc)');
const pipeR = score(H, 'net -> Haiku pipeline');

// Precision-difference CIs (two-proportion Wald) vs the LLM pipeline
const diffCI = (a, b) => {
  const p1 = a.tp / a.predicted, p2 = b.tp / b.predicted;
  const se = Math.sqrt(p1*(1-p1)/a.predicted + p2*(1-p2)/b.predicted);
  const d = p1 - p2; return { diff: d, lo: d - z*se, hi: d + z*se };
};
// Precision at field prevalence: TPR/FPR over the whole population (superset assumed complete)
const NONSITE = cl.total_funcs - T.size;
const precAt = (r, pi) => { const tpr = r.tp / T.size, fpr = r.fp / NONSITE; return (tpr*pi) / (tpr*pi + fpr*(1-pi)); };
const prevRows = [dumbR, smartPreR, smartR, pipeR].map(r => ({
  label: r.label, TPR: r.tp/T.size, FPR: r.fp/NONSITE,
  'p@2%': precAt(r,0.02), 'p@5%': precAt(r,0.05), 'p@8.2%': precAt(r, T.size/cl.total_funcs), 'p@50%': precAt(r,0.5),
}));

// Cross-model agreement on the 119 strict-net set (Haiku vs capable truth)
let agree = 0, hVtV = { vv: 0, vn: 0, nv: 0, nn: 0 };
for (const id of dumb) {
  const h = haikuV.get(id) === 'violation', t = T.has(id);
  if (h === t) agree++;
  hVtV[(h ? 'v' : 'n') + (t ? 'v' : 'n')]++;
}

// Superset incompleteness: getters the superset missed (non-superset spotcheck)
const spotViol = spot.filter(s => s.verdict === 'violation');
const spotN = spot.length, spotK = spotViol.length;
const nonSuperTotal = cl.total_funcs - cl.superset;
const estMissed = Math.round((spotK / spotN) * nonSuperTotal);
const corrTdenom = T.size + estMissed; // corrected true-violation count over full population
const dumbRecallCorr = dumbR.tp / corrTdenom;
const pipeRecallCorr = pipeR.tp / corrTdenom;

const report = {
  population: cl.total_funcs,
  superset_size: cl.superset,
  true_C131_in_superset: T.size,
  field_prevalence_in_population: (T.size / cl.total_funcs),
  classifiers: { dumb: dumbR, smart: smartR, pipeline: pipeR },
  llm_marginal: {
    smartAST_precision: smartR.precision, pipeline_precision: pipeR.precision,
    precision_lift_LLM_over_smartAST: pipeR.precision - smartR.precision,
    smartAST_recall: smartR.recall, pipeline_recall: pipeR.recall,
    note: 'pipeline recall <= dumb recall by construction (LLM only filters the net)',
    dumb_recall: dumbR.recall,
  },
  cross_model: { strictnet_n: dumb.size, haiku_vs_truth_agreement: agree / dumb.size,
                 confusion_haiku_truth: hVtV, agreement_ci: ci(agree, dumb.size) },
  superset_incompleteness: { spot_sampled: spotN, spot_violations: spotK,
    nonsuperset_total: nonSuperTotal, est_getters_missed_by_superset: estMissed,
    corrected_true_count: corrTdenom,
    dumb_recall_corrected: dumbRecallCorr, pipeline_recall_corrected: pipeRecallCorr },
};

// Dump disagreement detail for the adversary + inspection
const detail = {
  dumb_FP: [...dumb].filter(id => !T.has(id)).map(id => ({ id, truth_reason: truth.find(t=>t.id===id)?.reason })),
  dumb_FN_getters_net_missed: [...T].filter(id => !dumb.has(id)).map(id => ({ id, truth_reason: truth.find(t=>t.id===id)?.reason })),
  pipeline_FP: [...H].filter(id => !T.has(id)),
  haiku_disagree_truth: [...dumb].filter(id => (haikuV.get(id)==='violation') !== T.has(id))
    .map(id => ({ id, haiku: haikuV.get(id), truth: truthV.get(id), truth_reason: truth.find(t=>t.id===id)?.reason })),
  spot_violations: spotViol,
};
// Taxonomy of dumb-AST FPs: are they all AST-decidable (no semantic judgment)?
const sup = J('leg6_superset.json');
const codeById = new Map(sup.map(s => [s.id, s.code]));
const retLine = code => (code.match(/return[^\n;]*;/) || [''])[0].trim();
const tax = { call: [], literal: [], param_or_local_return: [], other: [] };
for (const id of [...dumb].filter(x => !T.has(x))) {
  const r = retLine(codeById.get(id) || '');
  if (/\(\)\s*;\s*$/.test(r)) tax.call.push(r);
  else if (/^return\s+(true|false|nullptr|NULL|-?\d|0x|""|')/.test(r)) tax.literal.push(r);
  else tax.param_or_local_return.push(r); // return obj.field; / return name;  (needs symbol table)
}
report.dumb_FP_taxonomy = {
  call: tax.call.length, literal: tax.literal.length,
  param_or_local_return: tax.param_or_local_return.length, other: tax.other.length,
  all_AST_decidable: tax.other.length === 0,
  note: 'call+literal removable by pure syntax; param/local-return removable by AST symbol resolution (FieldDecl vs ParmVarDecl); none require semantic judgment',
};
writeFileSync(`${OUT}/leg6_report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/leg6_detail.json`, JSON.stringify(detail, null, 2));

console.log(`POPULATION ${report.population} functions | getter/setter superset ${report.superset_size}`);
console.log(`TRUE C.131 sites in superset (|T|): ${T.size}  -> field prevalence ${pct(report.field_prevalence_in_population)}%\n`);
for (const r of [dumbR, smartR, pipeR]) {
  console.log(`${r.label.padEnd(24)} pred=${String(r.predicted).padStart(3)}  TP=${String(r.tp).padStart(3)} FP=${String(r.fp).padStart(3)} FN=${String(r.fn).padStart(3)}  precision=${pct(r.precision)}% ${r.prec_ci}  recall=${pct(r.recall)}% ${r.rec_ci}`);
}
console.log(`\nLLM marginal precision over smart-AST: ${pct(report.llm_marginal.precision_lift_LLM_over_smartAST)} pts  (smart ${pct(smartR.precision)}% vs pipeline ${pct(pipeR.precision)}%)`);
console.log(`Haiku vs capable-truth agreement on strict net (n=${dumb.size}): ${pct(report.cross_model.haiku_vs_truth_agreement)}% ${report.cross_model.agreement_ci}  confusion(h,t)=${JSON.stringify(hVtV)}`);
console.log(`\nSuperset incompleteness: ${spotK}/${spotN} non-superset sampled are true getters -> est ${estMissed} missed over ${nonSuperTotal}`);
console.log(`  coverage CORRECTED for superset misses: dumb-AST recall ${pct(dumbRecallCorr)}%, pipeline recall ${pct(pipeRecallCorr)}%`);
console.log(`\ndumb-AST FP taxonomy (n=${dumbR.fp}): call=${tax.call.length} literal=${tax.literal.length} param/local-return=${tax.param_or_local_return.length} other=${tax.other.length}  -> all AST-decidable: ${tax.other.length===0}`);

const dPre = diffCI(smartPreR, pipeR), dV2 = diffCI(smartR, pipeR);
console.log(`\nprecision diff vs LLM pipeline (95% Wald):`);
console.log(`  smart-AST PRE-REG − pipeline: ${(dPre.diff*100).toFixed(1)} pts [${(dPre.lo*100).toFixed(1)}, ${(dPre.hi*100).toFixed(1)}]  (pre-reg recall ${pct(smartPreR.recall)}% vs pipeline ${pct(pipeR.recall)}%)`);
console.log(`  smart-AST v2    − pipeline: ${(dV2.diff*100).toFixed(1)} pts [${(dV2.lo*100).toFixed(1)}, ${(dV2.hi*100).toFixed(1)}]`);
console.log(`\nprecision at field prevalence (TPR/FPR over ${cl.total_funcs}-fn population):`);
for (const r of prevRows) console.log(`  ${r.label.padEnd(26)} TPR=${pct(r.TPR)}% FPR=${pct(r.FPR)}%  p@2%=${pct(r['p@2%'])}% p@5%=${pct(r['p@5%'])}% p@8.2%=${pct(r['p@8.2%'])}% p@50%=${pct(r['p@50%'])}%`);
report.prereg_vs_posthoc = { prereg: smartPreR, posthoc_v2: smartR, diff_prereg_minus_pipeline: dPre, diff_v2_minus_pipeline: dV2 };
report.prevalence_projection = prevRows;
writeFileSync(`${OUT}/leg6_report.json`, JSON.stringify(report, null, 2));
