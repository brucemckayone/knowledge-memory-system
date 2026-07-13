import { readFileSync } from 'node:fs';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';
const meta = JSON.parse(readFileSync(`${OUT}/leg4_meta.json`, 'utf8'));
const flags = JSON.parse(readFileSync(`${OUT}/leg4_flags.json`, 'utf8'));
const adj = JSON.parse(readFileSync(`${OUT}/leg4_flag_adjudication.json`, 'utf8'));
const spot = JSON.parse(readFileSync(`${OUT}/leg4_spotcheck.json`, 'utf8'));

// adjudication lookup: id|rule -> real
const isReal = {}; for (const a of adj) isReal[`${a.id}|${a.rule}`] = a.real;

const RAND = id => meta[id]?.in_random;
// claim-level on random set
let cReal = 0, cFalse = 0; const perRule = {};
for (const f of flags) {
  if (!RAND(f.id)) continue;
  for (const x of f.findings) {
    const real = isReal[`${f.id}|${x.rule}`];
    perRule[x.rule] = perRule[x.rule] || { real: 0, tot: 0 };
    perRule[x.rule].tot++; if (real) { perRule[x.rule].real++; cReal++; } else cFalse++;
  }
}
// function-level on random set: a flagged function is a TP if >=1 of its findings is real
let fnReal = 0, fnFalse = 0;
for (const f of flags) {
  if (!RAND(f.id) || !f.findings.length) continue;
  const anyReal = f.findings.some(x => isReal[`${f.id}|${x.rule}`]);
  if (anyReal) fnReal++; else fnFalse++;
}
const nRand = Object.values(meta).filter(m => m.in_random).length;

console.log('=== LEG 4 — real-code field measurement (random set, natural prevalence) ===');
console.log(`random functions: ${nRand}   flagged functions: ${fnReal + fnFalse}  (${((fnReal+fnFalse)/nRand*100).toFixed(0)}%)`);
console.log(`\nFIELD PRECISION (claim-level):    ${cReal}/${cReal+cFalse} = ${(cReal/(cReal+cFalse)).toFixed(2)}`);
console.log(`FIELD PRECISION (function-level): ${fnReal}/${fnReal+fnFalse} = ${(fnReal/(fnReal+fnFalse)).toFixed(2)}`);
console.log('\nper-rule precision (random claims):');
for (const [r, v] of Object.entries(perRule).sort((a,b)=>b[1].tot-a[1].tot)) console.log(`  ${r.padEnd(7)} ${v.real}/${v.tot} = ${(v.real/v.tot).toFixed(2)}`);

// prevalence: flagged-real functions + extrapolated missed from spot-check
const flaggedRealFns = fnReal;
const spotN = spot.length; const spotMissed = spot.filter(s => s.missed_violations && s.missed_violations.length).length;
const nonFlagged = nRand - (fnReal + fnFalse);
const estMissed = Math.round(nonFlagged * (spotMissed / spotN));
const prevReal = flaggedRealFns + estMissed;
console.log('\n=== PREVALENCE (fraction of real functions with a genuine violation) ===');
console.log(`flagged-real functions: ${flaggedRealFns}`);
console.log(`spot-check of non-flagged: ${spotMissed}/${spotN} had a MISSED violation -> extrapolated ~${estMissed} misses across ${nonFlagged} non-flagged`);
console.log(`estimated violation-bearing functions: ~${prevReal}/${nRand} = ~${(prevReal/nRand*100).toFixed(0)}% prevalence`);
// prevalence excluding C.131 (the common low-severity rule)
let c131real = 0; for (const f of flags){ if(!RAND(f.id))continue; if(f.findings.some(x=>x.rule==='C.131'&&isReal[`${f.id}|C.131`]) && !f.findings.some(x=>x.rule!=='C.131'&&isReal[`${f.id}|${x.rule}`])) c131real++; }
console.log(`(of the flagged-real, ${c131real} are C.131-only trivial-getter functions -> excluding C.131, "serious" prevalence is far lower)`);

// recall on anchors (checkable rules, prevalence-invariant)
const flagById = Object.fromEntries(flags.map(f=>[f.id,f.findings.map(x=>x.rule)]));
let aHit=0,aTot=0; for(const [id,m] of Object.entries(meta)){ if(!m.nolint_rules.length)continue; aTot++; if(m.nolint_rules.some(w=>(flagById[id]||[]).includes(w)))aHit++; }
console.log(`\n=== IN-CONTEXT RECALL (checkable NOLINT anchors, full context + 25-rule set) ===`);
console.log(`  ${aHit}/${aTot} = ${(aHit/aTot).toFixed(2)}  (vs Leg-2 stripped-snippet 0.90 -> context/candidate-set penalty)`);
