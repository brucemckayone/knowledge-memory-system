/**
 * nmemo-uhp.19 SMOKE — stage 1 (recall) of the built cross-corpus linker, on REAL data.
 *
 * NOT a measurement gate — a plumbing + sanity smoke. It ingests a small real corpus
 * through the ACTUAL pipeline (ingestCodeElement / ingestRuleElement — Haiku authors
 * each side BLIND to the other), then runs the production recall stage
 * (recallCrossCorpusCandidates) and reports, per snippet, at what rank the TRUE MISRA
 * rule surfaces. This exercises the prefilter the .17 gate measured, but on real MISRA
 * rule names + real bad-C++ snippets instead of the opaque-ID constructed floor.
 *
 * Corpus (real, from the repo):
 *   code  = the 8 e2e-misra snippets (7 real Ch.22 violations + 1 out-of-chapter control)
 *   rules = the 10 MISRA C++:2023 Chapter-22 rules (misra-chapter-impact.sql fixture)
 *   truth = each snippet's expected_rule_citations (queries.json)
 *
 * Rule text below is a neutral restatement of each rule's TOPIC, written WITHOUT
 * looking at the snippets (non-circular). A real pre-registered run needs authoritative
 * MISRA text; this is a smoke.
 *
 * Run:
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/audit-recall-smoke.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ingestCodeElement, ingestRuleElement } from '../../services/corpus-ingest.js';
import { recallCrossCorpusCandidates } from '../../services/audit-pass.js';

const CODE_CORPUS = 'smoke-code';
const RULE_CORPUS = 'smoke-rules';
const HERE = dirname(fileURLToPath(import.meta.url));

interface Query {
  id: string;
  snippet: string;
  expected_rule_citations: string[];
}

const queries: Query[] = (
  JSON.parse(
    readFileSync(join(HERE, '../data/e2e-misra/queries.json'), 'utf8'),
  ) as { queries: Query[] }
).queries;

// 10 real Chapter-22 rules (id -> neutral restatement of the fixture's topic; blind to snippets).
const RULES: Array<{ id: string; text: string }> = [
  { id: 'MISRA-CPP-2023-Rule-22.1', text: 'Dynamic heap allocation shall not be used in safety-critical or hard real-time code paths.' },
  { id: 'MISRA-CPP-2023-Rule-22.2', text: 'Dynamically allocated resources shall be managed using RAII so acquisition and release are tied to object lifetime.' },
  { id: 'MISRA-CPP-2023-Rule-22.3', text: 'Dynamically allocated memory shall be owned through smart pointers rather than raw owning pointers.' },
  { id: 'MISRA-CPP-2023-Rule-22.4', text: 'Ownership of a dynamically allocated resource shall be explicit and unambiguous.' },
  { id: 'MISRA-CPP-2023-Rule-22.5', text: 'A pointer shall not be dereferenced after the object it refers to has ended its lifetime (no dangling pointer dereference).' },
  { id: 'MISRA-CPP-2023-Rule-22.6', text: 'Arithmetic on raw pointers shall not be performed; bounded abstractions shall be used instead.' },
  { id: 'MISRA-CPP-2023-Rule-22.7', text: 'A resource released with delete shall have been allocated with the matching new form.' },
  { id: 'MISRA-CPP-2023-Rule-22.8', text: 'Memory allocated with array new[] shall be released with array delete[].' },
  { id: 'MISRA-CPP-2023-Rule-22.9', text: 'A dynamically allocated resource shall not be released more than once (no double free).' },
  { id: 'MISRA-CPP-2023-Rule-22.10', text: 'A weak pointer shall be locked to obtain a valid owning pointer, and null-checked, before use.' },
];

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM public.entities WHERE corpus_id IN (${CODE_CORPUS}, ${RULE_CORPUS})`);
}

async function main(): Promise<void> {
  console.log('=== nmemo-uhp.19 recall smoke — real MISRA Ch.22 corpus ===\n');
  await cleanup();

  // --- Ingest rules (blind to code) ---
  const ruleIdByEntity = new Map<string, string>(); // entity uuid -> MISRA rule id
  for (const r of RULES) {
    const res = await ingestRuleElement({ corpusId: RULE_CORPUS, ruleId: r.id, ruleText: r.text });
    ruleIdByEntity.set(res.entityId, r.id);
  }
  console.log(`ingested ${RULES.length} rules into '${RULE_CORPUS}'`);

  // --- Ingest code snippets (blind to rules) ---
  const codeMeta = new Map<string, { qid: string; expected: string[]; leaked: string[] }>();
  for (const q of queries) {
    const res = await ingestCodeElement({ corpusId: CODE_CORPUS, name: q.id, code: q.snippet });
    codeMeta.set(res.entityId, { qid: q.id, expected: q.expected_rule_citations, leaked: res.leakedReferences });
  }
  console.log(`ingested ${queries.length} code snippets into '${CODE_CORPUS}'`);
  const anyLeak = [...codeMeta.values()].filter((m) => m.leaked.length > 0);
  console.log(`blindness: ${anyLeak.length} snippet descriptions leaked a rule reference` +
    (anyLeak.length ? ` -> ${anyLeak.map((m) => `${m.qid}:${m.leaked.join(',')}`).join('; ')}` : ' (clean)'));

  // --- Recall: all rules ranked per snippet (threshold 0 so we see full ranking) ---
  const candidates = await recallCrossCorpusCandidates(CODE_CORPUS, RULE_CORPUS, {
    k: RULES.length,
    threshold: 0,
    maxCells: 10000,
  });

  // group by code element, ordered by similarity desc (recall already orders by sim desc per element)
  const byElement = new Map<string, Array<{ ruleId: string; sim: number }>>();
  for (const c of candidates) {
    const list = byElement.get(c.elementRef) ?? [];
    list.push({ ruleId: ruleIdByEntity.get(c.ruleId) ?? c.ruleId, sim: c.similarity });
    byElement.set(c.elementRef, list);
  }

  const ks = [1, 3, 5];
  const hitAtK: Record<number, number[]> = { 1: [], 3: [], 5: [] };
  let controlFalsePos = 0;

  console.log('\n--- per-snippet recall (rank of the FIRST true rule) ---');
  for (const [entityId, meta] of codeMeta) {
    const ranked = (byElement.get(entityId) ?? []).sort((a, b) => b.sim - a.sim);
    const rankedIds = ranked.map((r) => r.ruleId);

    if (meta.expected.length === 0) {
      // control snippet — should NOT strongly match any Ch.22 rule; report top hit
      const top = ranked[0];
      const flagged = top && top.sim >= 0.5; // arbitrary "would seed a cell" line
      if (flagged) controlFalsePos += 1;
      console.log(`  ${meta.qid} [CONTROL] top=${top?.ruleId ?? '-'} sim=${top?.sim.toFixed(3) ?? '-'}` +
        `${flagged ? '  <-- would seed a candidate (specificity concern)' : '  (top sim below 0.5 — ok)'}`);
      continue;
    }

    const firstTrueRank = Math.min(
      ...meta.expected
        .map((e) => rankedIds.indexOf(e))
        .filter((i) => i >= 0)
        .map((i) => i + 1),
    );
    const rank = Number.isFinite(firstTrueRank) ? firstTrueRank : Infinity;
    for (const k of ks) hitAtK[k]!.push(rank <= k ? 1 : 0);
    const topSim = ranked[0]?.sim.toFixed(3) ?? '-';
    console.log(`  ${meta.qid} expected=[${meta.expected.map((e) => e.replace('MISRA-CPP-2023-Rule-', 'R')).join(',')}]` +
      ` firstTrueRank=${rank === Infinity ? 'MISS' : rank} topSim=${topSim}` +
      ` ranked=[${rankedIds.slice(0, 5).map((r) => r.replace('MISRA-CPP-2023-Rule-', 'R')).join(',')}]`);
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  console.log('\n--- recall@k over the 7 violation snippets (macro = micro here, 1 item/guideline) ---');
  for (const k of ks) console.log(`  recall@${k} = ${mean(hitAtK[k]!).toFixed(3)}  (${hitAtK[k]!.filter(Boolean).length}/${hitAtK[k]!.length})`);
  console.log(`\n  control specificity: ${controlFalsePos === 0 ? 'OK — control matched nothing above 0.5' : `${controlFalsePos} false candidate(s)`}`);

  console.log('\n(smoke only — plumbing + sanity, not a pre-registered measurement)');
  await cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
