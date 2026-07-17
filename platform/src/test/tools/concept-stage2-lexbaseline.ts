/**
 * Doc-17 Stage-2 HONEST BASELINE (nmemo-uhp.19), post-hoc, added at the blind adversary's
 * demand (labelled, NOT the pre-registered bar — rule 26: don't swap the pre-reg baseline,
 * ADD and disclose). The pre-reg pitted the adjudicator only against a cosine threshold on
 * the prefix-crippled embeddings — Stage-1's LOSER. The method that WON Stage 1 (keyword /
 * lexical overlap) was never entered as a Stage-2 pair classifier. This builds it.
 *
 * For each of the SAME 66 pairs (rebuilt identically from the frozen authored.json), compute
 * a parameter-free symmetric LEXICAL similarity (Jaccard over filtered token sets), sweep a
 * threshold for best balanced-accuracy, and report near-miss specificity — then compare to
 * the frozen adjudicator verdicts. Also independently recomputes the adversary's "smoking
 * gun" Jaccard for the two adjudicator error pairs.
 *
 *   npx tsx C:/Users/bruce.mckay/dev/nmemo/platform/src/test/tools/concept-stage2-lexbaseline.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data', 'concept-resolution');
const corpus = JSON.parse(readFileSync(join(DATA, 'mechanisms.json'), 'utf8')) as { mechanisms: { id: string; near_miss: string }[] };
const authored = JSON.parse(readFileSync(join(DATA, 'concept-authored.json'), 'utf8')) as Record<string, Record<string, string>>;
const results = JSON.parse(readFileSync(join(DATA, 'concept-resolution-results.json'), 'utf8')) as { judged: { a: string; b: string; kind: string; gt: boolean; same: boolean }[] };
const REGISTERS = ['normative', 'advisory', 'reference'] as const;
const MECHS = corpus.mechanisms;

const STOP = new Set(['the','a','an','of','to','is','are','be','that','this','it','its','and','or','not','no','in','on','at','by','for','with','as','from','into','than','then','so','if','when','which','while','has','have','had','was','were','been','will','shall','may','must','should','can','could','would','do','does','done','but','out','back','up','off','over','more','less','one','two','their','they','them','all','each','such','only','via','per','using','use','used','you','your']);
function toks(s: string): Set<string> { return new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOP.has(t))); }
function jaccard(a: Set<string>, b: Set<string>): number { let inter = 0; for (const t of a) if (b.has(t)) inter++; const uni = a.size + b.size - inter; return uni ? inter / uni : 0; }

const text = (key: string) => { const [mech, reg] = key.split('::'); return authored[reg!]![mech!]!; };

// rebuild pairs identically to the harness (true + near-miss + far), reusing frozen GT/verdicts
const pairs = results.judged.map((p) => ({ ...p, jac: jaccard(toks(text(p.a)), toks(text(p.b))) }));

function confAtThreshold(th: number) {
  const pred = (p: typeof pairs[0]) => p.jac >= th; // >= => "same"
  const tp = pairs.filter((p) => p.gt && pred(p)).length, fn = pairs.filter((p) => p.gt && !pred(p)).length;
  const fp = pairs.filter((p) => !p.gt && pred(p)).length, tn = pairs.filter((p) => !p.gt && !pred(p)).length;
  const near = pairs.filter((p) => p.kind === 'nearmiss');
  const nearSpec = near.filter((p) => !pred(p)).length / (near.length || 1);
  const recall = tp / (tp + fn || 1), spec = tn / (fp + tn || 1);
  return { th, tp, fn, fp, tn, recall, spec, ba: (recall + spec) / 2, nearSpec };
}

const ths = [...new Set(pairs.map((p) => p.jac))].sort((a, b) => a - b);
let bestBA = confAtThreshold(-1); // everything "same"
for (const th of ths) { const c = confAtThreshold(th); if (c.ba > bestBA.ba) bestBA = c; }
// also the threshold that best rejects near-misses while keeping recall (max of ba but track)
let bestNear = confAtThreshold(-1);
for (const th of ths) { const c = confAtThreshold(th); if (c.nearSpec > bestNear.nearSpec || (c.nearSpec === bestNear.nearSpec && c.ba > bestNear.ba)) bestNear = c; }

// adjudicator (frozen)
const adjTp = pairs.filter((p) => p.gt && p.same).length, adjFn = pairs.filter((p) => p.gt && !p.same).length;
const adjFp = pairs.filter((p) => !p.gt && p.same).length, adjTn = pairs.filter((p) => !p.gt && !p.same).length;
const adjNear = pairs.filter((p) => p.kind === 'nearmiss');
const adjNearSpec = adjNear.filter((p) => !p.same).length / adjNear.length;
const adjRecall = adjTp / (adjTp + adjFn), adjSpec = adjTn / (adjFp + adjTn), adjBA = (adjRecall + adjSpec) / 2;

const pct = (x: number) => (100 * x).toFixed(0) + '%';
console.log('=== STAGE 2 honest baseline: Jaccard keyword-overlap classifier vs adjudicator ===\n');
console.log(`  adjudicator (frozen):     BA ${adjBA.toFixed(3)}  recall ${pct(adjRecall)}  spec ${pct(adjSpec)}  near-miss-spec ${pct(adjNearSpec)}  (tp${adjTp} fn${adjFn} fp${adjFp} tn${adjTn})`);
console.log(`  Jaccard @ best-BA (t=${bestBA.th.toFixed(3)}):  BA ${bestBA.ba.toFixed(3)}  recall ${pct(bestBA.recall)}  spec ${pct(bestBA.spec)}  near-miss-spec ${pct(bestBA.nearSpec)}  (tp${bestBA.tp} fn${bestBA.fn} fp${bestBA.fp} tn${bestBA.tn})`);
console.log(`  Jaccard @ best-near (t=${bestNear.th.toFixed(3)}):  BA ${bestNear.ba.toFixed(3)}  recall ${pct(bestNear.recall)}  near-miss-spec ${pct(bestNear.nearSpec)}`);
console.log(`\n  adjudicator BA - Jaccard(best-BA) BA = ${(adjBA - bestBA.ba).toFixed(3)}`);

console.log('\n=== adversary smoking-gun: the adjudicator\'s two errors, by Jaccard ===');
for (const p of pairs) {
  const err = (p.gt && !p.same) || (!p.gt && p.same);
  if (err) console.log(`  ${p.kind.padEnd(9)} gt=${p.gt ? 'SAME' : 'diff'} adj=${p.same ? 'SAME' : 'diff'}  jac=${p.jac.toFixed(3)}   ${p.a}  <->  ${p.b}`);
}
console.log('\n=== all near-miss pairs by Jaccard (are they keyword-separable?) ===');
for (const p of pairs.filter((x) => x.kind === 'nearmiss').sort((a, b) => b.jac - a.jac)) {
  console.log(`  jac=${p.jac.toFixed(3)} adj=${p.same ? 'SAME(fp)' : 'diff(ok)'}   ${p.a}  <->  ${p.b}`);
}
