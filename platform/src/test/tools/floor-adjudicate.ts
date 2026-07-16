/**
 * nmemo-uhp.19 doc-15 — LEG 2 (adjudication, the expensive LLM leg).
 *
 * Operates on the frozen floor corpus LEFT IN THE DB by floor-ingest-recall.ts
 * (floor-code / floor-rules entities). Runs the REAL two-stage composition:
 *   recallCrossCorpusCandidates(k=3, threshold=0.5)  [pre-registered budget]
 *     -> seed a coverage cell per (element, rule)
 *     -> ADJUDICATE each cell with the production invokeAuditAgent (spawns Claude Code
 *        + graph MCP), then applyBridgePromotion + stampCoverage — the exact per-cell
 *        body of runAuditPass, but swept with bounded CONCURRENCY (default 4) instead
 *        of serially. Per-cell work is isolated by invocation_id, so the verdicts are
 *        production-identical; only wall-clock differs (disclosed in results).
 *
 * Metrics (doc-15 §4): composition recall, composition precision, control specificity,
 * per-rule recall (OQ3 collapse), and per-leg attribution of every recall miss
 * (prefilter never surfaced it in top-3 vs adjudicator surfaced-but-dropped).
 * Writes floor-composition-results.json.
 *
 * Run (after leg 1; ML :8000 + Claude Code on PATH):
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/floor-adjudicate.ts [--conc N] [--no-variance]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { recallCrossCorpusCandidates, type AuditCellScope } from '../../services/audit-pass.js';
import { invokeAuditAgent } from '../../services/causal-agent.js';
import { applyBridgePromotion } from '../../services/bridge-promotion.js';
import { createOrLoadAuditRun, seedCoverageUnits, stampCoverage, type CoverageVerdict } from '../../services/audit-ledger.js';

const CODE_CORPUS = 'floor-code';
const RULE_CORPUS = 'floor-rules';
const RUN_NAME = 'nmemo-uhp.19-floor-composition';
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '../data/cross-corpus-floor');

const argN = (flag: string, def: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const CONC = argN('--conc', 4);
const DO_VARIANCE = !process.argv.includes('--no-variance');

const short = (id: string) => id.replace('MISRA-CPP-2023-Rule-', 'R');

interface Element { id: string; kind: string; expected_rule_citations: string[]; note: string }
const corpus: { elements: Element[] } = JSON.parse(readFileSync(join(DATA, 'floor-corpus.json'), 'utf8'));
const elemByName = new Map(corpus.elements.map((e) => [e.id, e]));

interface EntRow { id: string; name: string; type: string; description: string | null; corpus: string }

async function loadCorpusEntities(): Promise<Map<string, EntRow>> {
  const r = (await db.execute(sql`
    SELECT id::text AS id, canonical_name AS name, entity_type AS type, description, corpus_id AS corpus
    FROM public.entities WHERE corpus_id IN (${CODE_CORPUS}, ${RULE_CORPUS})
  `)) as unknown as EntRow[];
  return new Map(r.map((e) => [e.id, e]));
}

async function liveBridgeFor(a: string, b: string): Promise<{ edgeId: string; relation: string } | null> {
  const r = (await db.execute(sql`
    SELECT id::text AS id, relation FROM public.bridge_edges
    WHERE a_ref = ${a}::uuid AND b_ref = ${b}::uuid AND expired_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `)) as unknown as Array<{ id: string; relation: string }>;
  return r.length ? { edgeId: r[0]!.id, relation: r[0]!.relation } : null;
}

/** Bounded-concurrency map. Preserves order-independence; each task isolated. */
async function pool<T>(items: T[], conc: number, worker: (t: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(conc, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
}

interface Cell { elementRef: string; ruleId: string; similarity: number }

async function sweep(runName: string, cells: Cell[], ents: Map<string, EntRow>, label: string): Promise<string> {
  const { run } = await createOrLoadAuditRun({
    name: runName, sourceCorpusId: CODE_CORPUS, targetCorpusId: RULE_CORPUS, ruleSetHash: 'floor-v1',
  });
  await seedCoverageUnits(run.id, cells.map((c) => ({ elementRef: c.elementRef, ruleId: c.ruleId })));
  let done = 0;
  await pool(cells, CONC, async (c) => {
    const invocationId = randomUUID();
    const el = ents.get(c.elementRef)!;
    const ru = ents.get(c.ruleId)!;
    const scope: AuditCellScope = {
      runId: run.id, invocationId, sourceCorpusId: CODE_CORPUS, targetCorpusId: RULE_CORPUS,
      similarity: c.similarity,
      element: { ref: c.elementRef, name: el.name, type: el.type, description: el.description },
      rule: { ref: c.ruleId, name: ru.name, type: ru.type, description: ru.description },
    };
    try {
      await invokeAuditAgent(scope);
    } catch (err) {
      console.warn(`  [${label}] cell ${el.name}->${short(ru.name)} invoke failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await applyBridgePromotion(invocationId);
    const bridge = await liveBridgeFor(c.elementRef, c.ruleId);
    await stampCoverage({
      runId: run.id, elementRef: c.elementRef, ruleId: c.ruleId,
      verdict: (bridge ? bridge.relation : 'not_applicable') as CoverageVerdict,
      edgeId: bridge?.edgeId ?? null, invocationId,
    });
    done += 1;
    if (done % 10 === 0 || done === cells.length) console.log(`  [${label}] ${done}/${cells.length} cells swept`);
  });
  return run.id;
}

async function main(): Promise<void> {
  const started = Date.now();
  console.log(`=== doc-15 LEG 2 — adjudication (composition) conc=${CONC} ===\n`);
  const ents = await loadCorpusEntities();
  const codeEnts = [...ents.values()].filter((e) => e.corpus === CODE_CORPUS);
  if (codeEnts.length === 0) { console.error('no floor-code entities in DB — run floor-ingest-recall.ts first'); process.exit(1); }
  console.log(`loaded ${codeEnts.length} code + ${ents.size - codeEnts.length} rule entities from DB`);
  const nameByEnt = new Map([...ents].map(([id, e]) => [id, e.name]));

  // clean any prior run of this name
  await db.execute(sql`DELETE FROM public.audit_runs WHERE name IN (${RUN_NAME}, ${RUN_NAME + '-var'})`);
  await db.execute(sql`DELETE FROM public.bridge_edges WHERE source_corpus_id = ${CODE_CORPUS}`);
  await db.execute(sql`DELETE FROM public.staging_bridge_edges WHERE source_corpus_id = ${CODE_CORPUS}`);

  // --- pre-registered recall budget k=3 threshold=0.5 ---
  const cand = await recallCrossCorpusCandidates(CODE_CORPUS, RULE_CORPUS, { k: 3, threshold: 0.5, maxCells: 100000 });
  const cells: Cell[] = cand.map((c) => ({ elementRef: c.elementRef, ruleId: c.ruleId, similarity: c.similarity }));
  console.log(`recall k=3 thr=0.5 seeded ${cells.length} cells across ${new Set(cells.map((c) => c.elementRef)).size} elements\n`);

  const runId = await sweep(RUN_NAME, cells, ents, 'main');

  // --- read back coverage + bridges ---
  const coverage = (await db.execute(sql`
    SELECT element_ref, rule_id, verdict, edge_id::text AS edge_id FROM public.audit_coverage WHERE run_id = ${runId}
  `)) as unknown as Array<{ element_ref: string; rule_id: string; verdict: string; edge_id: string | null }>;
  const bridges = (await db.execute(sql`
    SELECT a_ref::text AS a_ref, b_ref::text AS b_ref, relation, reasoning
    FROM public.bridge_edges WHERE source_corpus_id = ${CODE_CORPUS} AND expired_at IS NULL
  `)) as unknown as Array<{ a_ref: string; b_ref: string; relation: string; reasoning: string }>;

  // map to element/rule ids
  const eid = (ref: string) => nameByEnt.get(ref) ?? ref.slice(0, 8);
  const rid = (ref: string) => short(nameByEnt.get(ref) ?? ref.slice(0, 8));

  const violations = corpus.elements.filter((e) => e.kind === 'violation');
  const controls = corpus.elements.filter((e) => e.kind !== 'violation');

  // violates-bridge set: element name -> set of rule ids the agent said 'violates'
  const violBridge = new Map<string, Set<string>>();
  for (const b of bridges) {
    if (b.relation !== 'violates') continue;
    const en = eid(b.a_ref); const rn = short(nameByEnt.get(b.b_ref) ?? b.b_ref);
    const s = violBridge.get(en) ?? new Set(); s.add(rn); violBridge.set(en, s);
  }
  const satisBridgeCount = bridges.filter((b) => b.relation === 'satisfies').length;

  // composition precision: correct violates bridges / all violates bridges
  let totalViol = 0, correctViol = 0;
  const fpBridges: string[] = [];
  for (const b of bridges) {
    if (b.relation !== 'violates') continue;
    totalViol += 1;
    const en = eid(b.a_ref); const rn = nameByEnt.get(b.b_ref) ?? b.b_ref;
    const el = elemByName.get(en);
    const correct = !!el && el.kind === 'violation' && el.expected_rule_citations.includes(rn);
    if (correct) correctViol += 1; else fpBridges.push(`${en}->${short(rn)}`);
  }
  const precision = totalViol ? correctViol / totalViol : 1;

  // composition recall: fraction of violations with >=1 CORRECT violates bridge
  let recalled = 0;
  const recallMiss: Array<{ id: string; expected: string[]; note: string; attribution: string }> = [];
  // seeded rules per element (what prefilter surfaced in top-3)
  const seededByElem = new Map<string, Set<string>>();
  for (const c of cells) {
    const en = eid(c.elementRef); const rn = short(nameByEnt.get(c.ruleId) ?? c.ruleId);
    const s = seededByElem.get(en) ?? new Set(); s.add(rn); seededByElem.set(en, s);
  }
  for (const e of violations) {
    const got = violBridge.get(e.id) ?? new Set();
    const expectedShort = e.expected_rule_citations.map(short);
    const hit = expectedShort.some((r) => got.has(r));
    if (hit) { recalled += 1; continue; }
    const seeded = seededByElem.get(e.id) ?? new Set();
    const surfacedTrue = expectedShort.some((r) => seeded.has(r));
    recallMiss.push({
      id: e.id, expected: expectedShort, note: e.note,
      attribution: surfacedTrue ? 'ADJUDICATOR (true rule surfaced in top-3 but not confirmed)' : 'PREFILTER (no true rule in top-3)',
    });
  }
  const compRecall = violations.length ? recalled / violations.length : 0;

  // per-rule recall (OQ3): on multi-rule violations, all true rules confirmed?
  const multi = violations.filter((e) => e.expected_rule_citations.length > 1);
  let multiAll = 0;
  const collapse: Array<{ id: string; expected: string[]; confirmed: string[] }> = [];
  for (const e of multi) {
    const got = violBridge.get(e.id) ?? new Set();
    const exp = e.expected_rule_citations.map(short);
    const confirmed = exp.filter((r) => got.has(r));
    if (confirmed.length === exp.length) multiAll += 1;
    else collapse.push({ id: e.id, expected: exp, confirmed });
  }

  // control specificity: controls with ZERO violates bridge
  let cleanControls = 0;
  const controlFP: Array<{ id: string; kind: string; violates: string[] }> = [];
  for (const e of controls) {
    const got = [...(violBridge.get(e.id) ?? new Set())];
    if (got.length === 0) cleanControls += 1;
    else controlFP.push({ id: e.id, kind: e.kind, violates: got });
  }
  const specificity = controls.length ? cleanControls / controls.length : 1;

  // --- report ---
  console.log(`\n=== COMPOSITION RESULTS (single sample; FLOOR; not field prevalence) ===`);
  console.log(`  prefilter seeded ${cells.length} cells; ${bridges.length} bridges laid (${totalViol} violates, ${satisBridgeCount} satisfies)`);
  console.log(`  [1] composition RECALL   = ${compRecall.toFixed(3)}  (${recalled}/${violations.length} violations got a correct violates-bridge)   bar>=0.70`);
  console.log(`  [2] composition PRECISION= ${precision.toFixed(3)}  (${correctViol}/${totalViol} violates-bridges correct)                       bar>=0.80`);
  console.log(`  [3] control SPECIFICITY  = ${specificity.toFixed(3)}  (${cleanControls}/${controls.length} controls with zero violates-bridge)      bar>=0.80`);
  console.log(`  [4] multi-rule ALL-confirmed = ${multi.length ? (multiAll / multi.length).toFixed(3) : 'n/a'}  (${multiAll}/${multi.length}) — OQ3 collapse (diagnostic)`);

  if (fpBridges.length) console.log(`\n  false-positive violates-bridges (${fpBridges.length}): ${fpBridges.join(', ')}`);
  if (controlFP.length) { console.log(`\n  controls FALSELY flagged violates:`); for (const c of controlFP) console.log(`    ${c.id} [${c.kind}] -> ${c.violates.join(',')}`); }
  if (recallMiss.length) { console.log(`\n  recall misses (${recallMiss.length}) with leg attribution:`); for (const m of recallMiss) console.log(`    ${m.id} exp=${m.expected.join(',')} — ${m.attribution}`); }
  if (collapse.length) { console.log(`\n  OQ3 collapse (multi-rule, partial confirm):`); for (const c of collapse) console.log(`    ${c.id} exp=${c.expected.join(',')} confirmed=${c.confirmed.join(',') || 'none'}`); }

  // --- variance disclosure: re-adjudicate each control's TOP cell in a 2nd run ---
  let variance: any = null;
  if (DO_VARIANCE) {
    console.log(`\n--- variance pass: re-adjudicate each control's top cell (2nd sample) ---`);
    const topControlCell = new Map<string, Cell>();
    for (const c of cells) {
      const en = eid(c.elementRef); if (!elemByName.get(en) || elemByName.get(en)!.kind === 'violation') continue;
      const cur = topControlCell.get(en);
      if (!cur || c.similarity > cur.similarity) topControlCell.set(en, c);
    }
    const varCells = [...topControlCell.values()];
    const varRunId = await sweep(RUN_NAME + '-var', varCells, ents, 'var');
    const varCov = (await db.execute(sql`
      SELECT element_ref, rule_id, verdict FROM public.audit_coverage WHERE run_id = ${varRunId}
    `)) as unknown as Array<{ element_ref: string; rule_id: string; verdict: string }>;
    // agreement vs main run on the same cells
    const mainVerdict = new Map(coverage.map((c) => [`${c.element_ref} ${c.rule_id}`, c.verdict]));
    let agree = 0; const disagreements: string[] = [];
    for (const v of varCov) {
      const key = `${v.element_ref} ${v.rule_id}`;
      const m = mainVerdict.get(key);
      if (m === v.verdict) agree += 1;
      else disagreements.push(`${eid(v.element_ref)}->${rid(v.rule_id)}: main=${m} var=${v.verdict}`);
    }
    variance = { cells: varCov.length, agree, agreement: varCov.length ? agree / varCov.length : 1, disagreements };
    console.log(`  self-agreement ${agree}/${varCov.length} = ${(variance.agreement).toFixed(3)}` + (disagreements.length ? ` — ${disagreements.join('; ')}` : ''));
  }

  const pass = compRecall >= 0.70 && precision >= 0.80 && specificity >= 0.80;
  console.log(`\n=== VERDICT (recall bar checked in leg-1 results; here: recall/precision/specificity) ===`);
  console.log(`  ${pass ? 'PASS' : 'FAIL'} — recall>=0.70:${compRecall >= 0.70} precision>=0.80:${precision >= 0.80} specificity>=0.80:${specificity >= 0.80}`);
  console.log(`  elapsed ${Math.round((Date.now() - started) / 1000)}s`);

  writeFileSync(join(DATA, 'floor-composition-results.json'), JSON.stringify({
    generatedFrom: 'floor-adjudicate.ts', concurrency: CONC, singleSample: true,
    seededCells: cells.length, bridgesLaid: bridges.length, violatesBridges: totalViol, satisfiesBridges: satisBridgeCount,
    metrics: { compositionRecall: compRecall, compositionPrecision: precision, controlSpecificity: specificity,
      multiRuleAllConfirmed: multi.length ? multiAll / multi.length : null },
    bars: { recall: 0.70, precision: 0.80, specificity: 0.80 }, pass,
    falsePositiveBridges: fpBridges, controlFalsePositives: controlFP, recallMisses: recallMiss, collapse,
    bridges: bridges.map((b) => ({ element: eid(b.a_ref), rule: short(nameByEnt.get(b.b_ref) ?? b.b_ref), relation: b.relation, reasoning: b.reasoning })),
    variance,
  }, null, 2));
  console.log(`\nwrote floor-composition-results.json`);
  process.exit(0);
}

main().catch((err) => { console.error('leg2 failed:', err); process.exit(1); });
