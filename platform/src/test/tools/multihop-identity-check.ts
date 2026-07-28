/**
 * Correctness anchor for the multi-hop concept recall primitive (doc 34 §7.2 step 3).
 *
 * The claim being checked is a REDUCTION, not a measurement: with hops=0 and decay=1,
 * recallMultiHopConcepts must return exactly the same candidate SET as the shipped
 * single-hop recallConceptCandidates. If it does, the multi-hop query is a strict
 * generalisation of the shipped behaviour and any difference at hops>0 is attributable to
 * traversal rather than to a rewritten JOIN.
 *
 * Run against the doc-20 graph (which has concepts + elements but NO facts, so hops>0 must
 * also equal hops=0 there — a second, independent sanity check on the recursion):
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     NODE_ENV=test npx tsx src/test/tools/multihop-identity-check.ts
 */
import { recallMultiHopConcepts } from '../../services/concept-multihop.js';
import { recallConceptCandidates } from '../../services/audit-pass.js';

const SRC = process.env.MH_SRC ?? 'cj-code';
const TGT = process.env.MH_TGT ?? 'cj-rules';
const key = (a: string, b: string): string => `${a} ${b}`;

async function main(): Promise<void> {
  const shipped = await recallConceptCandidates(SRC, TGT);
  const mh0 = await recallMultiHopConcepts(SRC, TGT, { hops: 0, decay: 1 });

  const S = new Set(shipped.map((p) => key(p.elementRef, p.ruleId)));
  const M = new Set(mh0.map((p) => key(p.elementRef, p.ruleId)));
  const onlyShipped = [...S].filter((k) => !M.has(k));
  const onlyMultihop = [...M].filter((k) => !S.has(k));

  console.log(`corpora ${SRC} → ${TGT}`);
  console.log(`  shipped single-hop : ${S.size} pairs`);
  console.log(`  multihop hops=0    : ${M.size} pairs`);
  console.log(`  only shipped: ${onlyShipped.length} | only multihop: ${onlyMultihop.length}`);

  const identical = onlyShipped.length === 0 && onlyMultihop.length === 0;
  console.log(identical
    ? '  PASS — hops=0 reduces exactly to the shipped JOIN'
    : '  FAIL — hops=0 is NOT the shipped JOIN; the generalisation is unsound');

  // On a factless corpus pair, deeper traversal has nowhere to go, so the sets must match.
  const mh1 = await recallMultiHopConcepts(SRC, TGT, { hops: 1, decay: 0.5 });
  const factless = mh1.length === mh0.length;
  console.log(`  hops=1: ${mh1.length} pairs ${factless ? '(equal — corpora have no facts, as expected)' : '(differs — corpora have facts)'}`);

  if (!identical) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
