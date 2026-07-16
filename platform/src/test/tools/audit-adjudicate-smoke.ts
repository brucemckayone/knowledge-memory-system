/**
 * nmemo-uhp.19 SMOKE — stage 2 (adjudicate) of the built cross-corpus linker, END-TO-END.
 *
 * The stage-1 smoke (audit-recall-smoke.ts) exercised ONLY the deterministic recall
 * prefilter. THIS smoke runs the WHOLE production pipeline with the REAL invoker:
 *
 *   recallCrossCorpusCandidates  (vector prefilter, .14 lever)
 *     → runAuditPass seeds a coverage cell per recalled (element, rule) pair
 *       → invokeAuditAgent  → POST ${ML_SERVICES_URL}/audit-agent
 *         → ML spawns Claude Code (Haiku) with the graph MCP server (actor-pinned
 *           'audit_agent', reads + propose_bridge_edge only)
 *           → agent adjudicates violates | satisfies | not_applicable
 *             → applyBridgePromotion disposes the staged edge (D4 idempotent)
 *               → stampCoverage writes the cell verdict (D6 fork)
 *
 * It answers two things a fake-invoker test cannot:
 *   (1) DOES THE CHAIN RUN HERE? Claude Code on PATH, /audit-agent live, the graph
 *       MCP server starts under `npx tsx`, a bridge gets promoted, coverage stamps.
 *   (2) DOES THE ADJUDICATOR DISCRIMINATE? A clear true-positive (Q2: new int[10]
 *       freed with plain delete) should be stamped 'violates' with a bridge; the
 *       out-of-chapter CONTROL (Q8: uninitialised unused var) that the prefilter
 *       OVER-SEEDS (stage-1: top cosine 0.733 vs a Ch.22 rule) should be REJECTED
 *       as not_applicable with NO bridge. This is OQ2 (prefilter over-seed → does
 *       stage-2 reject?) probed end-to-end on 2 cells.
 *
 * HONESTY: This is a SMOKE, not a pre-registered measurement. n is tiny (2 code
 * elements, 3 rules, ~4 cells). corpus-ingest stores a Haiku-AUTHORED description
 * of each element (NOT the raw source), and a flat corpus has no facts/memories, so
 * the agent adjudicates on the authored descriptions + the pair — exactly the built
 * system's behaviour on a flat code corpus. The authored descriptions are printed so
 * we can see what the agent actually judged on. A real gate needs the pre-registered
 * ~50-corpus run (nmemo-uhp.19 proper).
 *
 * Run (ML services on :8000 + Claude Code on PATH required):
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/audit-adjudicate-smoke.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ingestCodeElement, ingestRuleElement } from '../../services/corpus-ingest.js';
import { runAuditPass } from '../../services/audit-pass.js';

const CODE_CORPUS = 'smoke2-code';
const RULE_CORPUS = 'smoke2-rules';
const RUN_NAME = 'nmemo-uhp.19-adjudicate-smoke';
const HERE = dirname(fileURLToPath(import.meta.url));

interface Query {
  id: string;
  snippet: string;
  expected_rule_citations: string[];
}

const allQueries: Query[] = (
  JSON.parse(readFileSync(join(HERE, '../data/e2e-misra/queries.json'), 'utf8')) as {
    queries: Query[];
  }
).queries;

// The true-positive (Q2: array new / plain delete) + the out-of-chapter control (Q8).
const PICKED = new Set(['Q2', 'Q8']);
const queries = allQueries.filter((q) => PICKED.has(q.id));

// Three rules: Q2's two true rules (22.7/22.8) + the rule Q8 over-seeds on (22.2, RAII).
const RULES: Array<{ id: string; text: string }> = [
  { id: 'MISRA-CPP-2023-Rule-22.2', text: 'Dynamically allocated resources shall be managed using RAII so acquisition and release are tied to object lifetime.' },
  { id: 'MISRA-CPP-2023-Rule-22.7', text: 'A resource released with delete shall have been allocated with the matching new form.' },
  { id: 'MISRA-CPP-2023-Rule-22.8', text: 'Memory allocated with array new[] shall be released with array delete[].' },
];

const short = (id: string) => id.replace('MISRA-CPP-2023-Rule-', 'R');

async function cleanup(): Promise<void> {
  // Order: coverage cells cascade off the run; bridges/staging filtered by corpus;
  // entities last (bridges FK a_ref/b_ref → entities).
  await db.execute(sql`DELETE FROM public.audit_runs WHERE name = ${RUN_NAME}`);
  await db.execute(sql`DELETE FROM public.bridge_edges WHERE source_corpus_id = ${CODE_CORPUS} OR target_corpus_id = ${RULE_CORPUS}`);
  await db.execute(sql`DELETE FROM public.staging_bridge_edges WHERE source_corpus_id = ${CODE_CORPUS} OR target_corpus_id = ${RULE_CORPUS}`);
  await db.execute(sql`DELETE FROM public.entities WHERE corpus_id IN (${CODE_CORPUS}, ${RULE_CORPUS})`);
}

interface CoverageRow { element_ref: string; rule_id: string; verdict: string; edge_id: string | null }
interface BridgeRow { a_ref: string; b_ref: string; relation: string; reasoning: string; source_references: unknown }

async function main(): Promise<void> {
  console.log('=== nmemo-uhp.19 STAGE-2 adjudicator smoke — real MISRA Ch.22, real agent ===\n');
  const started = Date.now();
  await cleanup();

  // --- Ingest rules (blind to code) ---
  const ridByEntity = new Map<string, string>();
  for (const r of RULES) {
    const res = await ingestRuleElement({ corpusId: RULE_CORPUS, ruleId: r.id, ruleText: r.text });
    ridByEntity.set(res.entityId, r.id);
  }
  console.log(`ingested ${RULES.length} rules into '${RULE_CORPUS}'`);

  // --- Ingest code (blind to rules) ---
  const qidByEntity = new Map<string, string>();
  const expectedByQid = new Map<string, string[]>();
  console.log(`\n--- authored code descriptions (what the agent will judge on) ---`);
  for (const q of queries) {
    const res = await ingestCodeElement({ corpusId: CODE_CORPUS, name: q.id, code: q.snippet });
    qidByEntity.set(res.entityId, q.id);
    expectedByQid.set(q.id, q.expected_rule_citations);
    console.log(`  ${q.id} [expected=${q.expected_rule_citations.map(short).join(',') || '(control: none)'}]` +
      (res.leakedReferences.length ? ` LEAK=${res.leakedReferences.join(',')}` : '') +
      `\n      "${res.description.replace(/\s+/g, ' ').slice(0, 240)}"`);
  }

  // --- Run the REAL two-stage pass (default invoker → Claude Code) ---
  const ruleSetHash = createHash('sha256').update(RULES.map((r) => r.id + r.text).join('|')).digest('hex').slice(0, 16);
  console.log(`\n--- runAuditPass (REAL invoker: /audit-agent → Claude Code → graph MCP) ---`);
  console.log(`  recall: k=2 threshold=0.5 — expect Q2→{true rules} + Q8→{over-seeded rule}`);

  let chainRan = false;
  let result: Awaited<ReturnType<typeof runAuditPass>> | null = null;
  try {
    result = await runAuditPass(
      {
        name: RUN_NAME,
        sourceCorpusId: CODE_CORPUS,
        targetCorpusId: RULE_CORPUS,
        ruleSetHash,
        recall: { k: 2, threshold: 0.5, maxCells: 100 },
      },
      // NO injected invoker → the production invokeAuditAgent runs.
    );
    chainRan = result.swept > 0;
    console.log(`  seeded=${result.seeded} swept=${result.swept}  progress=` +
      `pending:${result.progress.pending} violates:${result.progress.violates} ` +
      `satisfies:${result.progress.satisfies} n/a:${result.progress.notApplicable}`);
  } catch (err) {
    console.log(`  runAuditPass THREW: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Read back per-cell verdicts + laid bridges ---
  const runId = result?.runId;
  const coverage = runId
    ? ((await db.execute(sql`
        SELECT element_ref, rule_id, verdict, edge_id::text AS edge_id
        FROM public.audit_coverage WHERE run_id = ${runId}
        ORDER BY element_ref, rule_id
      `)) as unknown as CoverageRow[])
    : [];
  const bridges = (await db.execute(sql`
    SELECT a_ref::text AS a_ref, b_ref::text AS b_ref, relation, reasoning, source_references
    FROM public.bridge_edges WHERE source_corpus_id = ${CODE_CORPUS} AND expired_at IS NULL
    ORDER BY created_at
  `)) as unknown as BridgeRow[];

  console.log(`\n--- per-cell verdicts (${coverage.length} cells) ---`);
  for (const c of coverage) {
    const qid = qidByEntity.get(c.element_ref) ?? c.element_ref.slice(0, 8);
    const rid = short(ridByEntity.get(c.rule_id) ?? c.rule_id.slice(0, 8));
    const isControl = (expectedByQid.get(qid) ?? []).length === 0;
    console.log(`  ${qid}${isControl ? '[CONTROL]' : ''} vs ${rid}: ${c.verdict}` +
      `${c.edge_id ? ` (bridge ${c.edge_id.slice(0, 8)})` : ''}`);
  }

  console.log(`\n--- laid bridges (${bridges.length}) ---`);
  for (const b of bridges) {
    const qid = qidByEntity.get(b.a_ref) ?? b.a_ref.slice(0, 8);
    const rid = short(ridByEntity.get(b.b_ref) ?? b.b_ref.slice(0, 8));
    const nrefs = Array.isArray(b.source_references) ? b.source_references.length : 0;
    console.log(`  ${qid} --${b.relation}--> ${rid}  [${nrefs} source refs]`);
    console.log(`      reasoning: "${(b.reasoning ?? '').replace(/\s+/g, ' ').slice(0, 300)}"`);
  }

  // --- Smoke checks (NOT a gate) ---
  const tpCells = coverage.filter((c) => (expectedByQid.get(qidByEntity.get(c.element_ref) ?? '') ?? []).length > 0);
  const controlCells = coverage.filter((c) => (expectedByQid.get(qidByEntity.get(c.element_ref) ?? '') ?? []).length === 0);
  const tpBridged = tpCells.some((c) => c.verdict === 'violates' && c.edge_id);
  const controlRejected = controlCells.length > 0 && controlCells.every((c) => c.verdict === 'not_applicable' && !c.edge_id);

  console.log(`\n=== SMOKE VERDICT (n tiny — signal, not a measurement) ===`);
  console.log(`  (1) chain ran end-to-end (agent spawned + coverage stamped): ${chainRan ? 'YES' : 'NO'}`);
  console.log(`  (2) true-positive (Q2) stamped 'violates' with a bridge:      ${tpBridged ? 'YES' : 'NO'}`);
  console.log(`  (3) control (Q8 over-seed) rejected as not_applicable:        ${controlRejected ? 'YES' : `NO — control cells: ${controlCells.map((c) => c.verdict).join(',') || 'none seeded'}`}`);
  console.log(`\n  elapsed ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('\n(smoke only — plumbing + adjudicator discrimination, not a pre-registered measurement)');

  await cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
