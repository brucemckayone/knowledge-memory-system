/**
 * nmemo-uhp.24 failure analysis — WHY the concept-JOIN recall gate failed.
 *
 * Reads the frozen artifacts + the live DB (post-resolution concept nodes) and lays
 * out, per true (code element -> true rule) pair, the code-side concepts vs the
 * rule-side concepts and their shared nodes — so the non-convergence is visible, not
 * asserted. Also: per-guideline JOIN-vs-cosine recall, the resolution merges, and a
 * "convergence ceiling" tally. Reads only; no LLM, no re-run of the system under test.
 *
 * Run (DB with this run's data intact):
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/concept-join-analysis.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { unwrapRows } from '../../services/audit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '../../../../docs/architecture/cross-corpus-audit/recall-gate-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/concept-join-artifacts');
const CONCEPT_CORPUS = '_concepts';

interface Rule { id: string; text: string }
const rules: Rule[] = JSON.parse(readFileSync(join(CORPUS, 'gate_rules.json'), 'utf8'));
const ruleText = Object.fromEntries(rules.map((r) => [r.id, r.text]));
const frozen = JSON.parse(readFileSync(join(OUT, 'cj-extracted.json'), 'utf8')) as {
  codeIds: Record<string, string>; ruleIds: Record<string, string>;
  resolution: { pairsConsidered: number; judgedSame: number; merged: number };
};
const results = JSON.parse(readFileSync(join(OUT, 'cj-results.json'), 'utf8')) as {
  guidelines: string[]; oracleKey: Record<string, string>;
  perElement: Record<string, { joinRank: number; cosRank: number; bmRank: number; subLexical: boolean; joinSharedTop: number }>;
};

async function conceptNames(entityId: string, relation: 'exhibits' | 'addresses'): Promise<Array<{ id: string; name: string }>> {
  return unwrapRows<{ id: string; name: string }>(await db.execute(sql`
    SELECT be.b_ref::text AS id, e.canonical_name AS name
    FROM public.bridge_edges be JOIN public.entities e ON e.id = be.b_ref
    WHERE be.a_ref = ${entityId}::uuid AND be.relation = ${relation} AND be.expired_at IS NULL
    ORDER BY e.canonical_name
  `));
}

async function main(): Promise<void> {
  const L: string[] = [];
  const p = (s = '') => { L.push(s); console.log(s); };

  p('# Concept-JOIN gate — failure analysis (nmemo-uhp.24, doc-20 §13)');
  p();
  p(`Resolution: ${frozen.resolution.merged} merged / ${frozen.resolution.judgedSame} judged-same / ${frozen.resolution.pairsConsidered} pairs considered.`);

  // resolution merges (from entity_merges reasons on concept entities)
  const merges = unwrapRows<{ reason: string }>(await db.execute(sql`
    SELECT em.merge_reason AS reason FROM public.entity_merges em
    WHERE em.target_entity_id IN (SELECT id FROM public.entities WHERE corpus_id = ${CONCEPT_CORPUS})
  `));
  p();
  p('## Resolution merges (what the Haiku judge collapsed)');
  for (const m of merges) p(`- ${m.reason}`);

  // per true pair: code concepts vs true-rule concepts + shared
  const byGuideline: Record<string, Array<{ el: string; connected: boolean; shared: string[]; code: string[]; rule: string[]; joinRank: number; cosRank: number; subLexical: boolean }>> = {};
  let connectedCount = 0;
  for (const [el, trueRule] of Object.entries(results.oracleKey)) {
    const codeNodes = await conceptNames(frozen.codeIds[el]!, 'exhibits');
    const ruleNodes = await conceptNames(frozen.ruleIds[trueRule]!, 'addresses');
    const ruleIdset = new Set(ruleNodes.map((n) => n.id));
    const shared = codeNodes.filter((n) => ruleIdset.has(n.id)).map((n) => n.name);
    const connected = shared.length > 0;
    if (connected) connectedCount++;
    (byGuideline[trueRule] ??= []).push({
      el, connected, shared,
      code: codeNodes.map((n) => n.name), rule: ruleNodes.map((n) => n.name),
      joinRank: results.perElement[el]!.joinRank, cosRank: results.perElement[el]!.cosRank,
      subLexical: results.perElement[el]!.subLexical,
    });
  }

  p();
  p(`## Convergence: ${connectedCount}/${Object.keys(results.oracleKey).length} true pairs share ≥1 concept node`);
  p();
  p('Per-guideline (JOIN can only recall a pair if code & rule share a concept node):');
  p();
  p('| guideline | n | connected | JOIN@5 | cosine@5 |');
  p('|-----------|---|-----------|--------|----------|');
  for (const g of results.guidelines) {
    const rows = byGuideline[g] ?? [];
    const conn = rows.filter((r) => r.connected).length;
    const j5 = (rows.filter((r) => r.joinRank > 0 && r.joinRank <= 5).length / rows.length);
    const c5 = (rows.filter((r) => r.cosRank > 0 && r.cosRank <= 5).length / rows.length);
    p(`| ${g} | ${rows.length} | ${conn}/${rows.length} | ${j5.toFixed(2)} | ${c5.toFixed(2)} |`);
  }

  p();
  p('## The vocabulary gap — every true pair (★ = shared node exists)');
  for (const g of results.guidelines) {
    p();
    p(`### ${g} — "${ruleText[g]}"`);
    for (const r of byGuideline[g] ?? []) {
      p(`${r.connected ? '★' : '·'} ${r.el}${r.subLexical ? ' [sub-lexical]' : ''}  JOIN-rank ${r.joinRank} / cos-rank ${r.cosRank}`);
      p(`    code: ${r.code.join(', ') || '(none)'}`);
      p(`    rule: ${r.rule.join(', ') || '(none)'}`);
      if (r.connected) p(`    shared: ${r.shared.join(', ')}`);
    }
  }

  writeFileSync(join(OUT, 'cj-analysis.md'), L.join('\n'));
  p();
  p(`wrote cj-analysis.md`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
