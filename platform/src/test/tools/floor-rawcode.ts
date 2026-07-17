/**
 * nmemo-uhp.19 doc-16 — RAW-CODE adjudication test (corrected after doc-15 INFLATED).
 *
 * Kills the authoring leak: the adjudicator is fed the RAW C++ (entity description =
 * verbatim snippet, NO Haiku authoring), so nothing pre-states the verdict. Isolates
 * adjudication from the lexical prefilter with a CONTROLLED candidate set: each element
 * is adjudicated against {true rule(s)} + {its top-2 lexically over-seeded FALSE rules}
 * (distractors from the doc-15 description-embedding recall ranking). Pre-registers the
 * defect-regex + BM25 baselines AS THE BAR (doc-16 §4-5); the LLM must beat them,
 * especially on the SEMANTIC slice (22.1/22.3/22.4) where no keyword decides it.
 *
 * Run (after leg-1 froze floor-code/floor-rules in the DB; ML :8000 + Claude Code):
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx <abs>/floor-rawcode.ts [--pilot] [--conc N]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { upsertCorpusElementEntity, codeElementKey } from '../../services/corpus-ingest.js';
import { recallCrossCorpusCandidates, type AuditCellScope } from '../../services/audit-pass.js';
import { invokeAuditAgent } from '../../services/causal-agent.js';
import { applyBridgePromotion } from '../../services/bridge-promotion.js';
import { createOrLoadAuditRun, seedCoverageUnits, stampCoverage, type CoverageVerdict } from '../../services/audit-ledger.js';

const DESC_CORPUS = 'floor-code';      // leaky-description corpus (leg-1) — used ONLY for the distractor ranking
const RAW_CORPUS = 'floor-coderaw';    // raw-code corpus — what the adjudicator judges
const RULE_CORPUS = 'floor-rules';
const RUN_NAME = 'nmemo-uhp.19-rawcode';
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '../data/cross-corpus-floor');
const PILOT = process.argv.includes('--pilot');
const argN = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const CONC = argN('--conc', 4);
const PILOT_VIOLATIONS = new Set(['V22_1_a', 'V22_3_a', 'V22_4_a', 'V22_5_a', 'V22_7_c', 'V22_9_b', 'V22_2_a']);

const short = (id: string) => id.replace('MISRA-CPP-2023-Rule-', 'R');
const ruleNum = (id: string) => id.replace('MISRA-CPP-2023-Rule-', '');
const SEMANTIC = new Set(['22.1', '22.3', '22.4']); // doc-16 decisive slice
const MECHANICAL = new Set(['22.5', '22.6', '22.7', '22.8', '22.9', '22.10']);
const ruleClass = (rid: string) => { const n = ruleNum(rid); return SEMANTIC.has(n) ? 'semantic' : MECHANICAL.has(n) ? 'mechanical' : 'mixed'; };

// FROZEN per-rule defect regexes (baseline a) — the obvious first-grep a linter would try.
const RULE_REGEX: Record<string, RegExp> = {
  '22.1': /\bnew\b|\bmalloc\b|operator new/,
  '22.2': /\block\s*\(\s*\)|fopen|\bnew\b/,
  '22.3': /\bnew\b/,
  '22.4': /\w+\s*\*\s*\w+\s*[,)]|\*\s*\w+\s*[,)]/,
  '22.5': /return\s*&|delete\s+\w+\s*;[\s\S]*\*|push_back[\s\S]*\*|return\s+[a-z_]+\s*\(\)/,
  '22.6': /\+\+\s*\*?\w*p|\bp\s*\+\+|\bp\s*\+=|\(\s*\w+\s*\+\s*\w+\s*\)|start\s*\+/,
  '22.7': /malloc[\s\S]*delete|new[\s\S]*free|new\s*\[[\s\S]*delete\b(?!\s*\[)/,
  '22.8': /new\s*\[[\s\S]*delete\b(?!\s*\[)/,
  '22.9': /delete[\s\S]*delete|free\s*\([\s\S]*free\s*\(/,
  '22.10': /\.lock\s*\(\s*\)/,
};

interface Rule { id: string; text: string }
interface Element { id: string; kind: string; expected_rule_citations: string[]; snippet: string; note: string }
const corpus: { rules: Rule[]; elements: Element[] } = JSON.parse(readFileSync(join(DATA, 'floor-corpus.json'), 'utf8'));
const frozen: { rules: Record<string, string>; code: Record<string, string> } = JSON.parse(readFileSync(join(DATA, 'floor-authored.json'), 'utf8'));
const elemById = new Map(corpus.elements.map((e) => [e.id, e]));

// tiny BM25 (baseline b)
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'are', 'not', 'has', 'have', 'been', 'via', 'its', 'of', 'to', 'in', 'on', 'is', 'be', 'or', 'it']);
const tok = (s: string) => (s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t));

interface EntRow { id: string; name: string; type: string; description: string | null; corpus: string }
async function loadEnts(corpora: string[]): Promise<Map<string, EntRow>> {
  const idList = sql.join(corpora.map((c) => sql`${c}`), sql`, `);
  const r = (await db.execute(sql`SELECT id::text AS id, canonical_name AS name, entity_type AS type, description, corpus_id AS corpus FROM public.entities WHERE corpus_id IN (${idList})`)) as unknown as EntRow[];
  return new Map(r.map((e) => [e.id, e]));
}
async function liveBridge(a: string, b: string): Promise<{ edgeId: string; relation: string } | null> {
  const r = (await db.execute(sql`SELECT id::text AS id, relation FROM public.bridge_edges WHERE a_ref=${a}::uuid AND b_ref=${b}::uuid AND expired_at IS NULL ORDER BY created_at DESC LIMIT 1`)) as unknown as Array<{ id: string; relation: string }>;
  return r.length ? { edgeId: r[0]!.id, relation: r[0]!.relation } : null;
}
async function pool<T>(items: T[], conc: number, w: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; await w(items[i]!); } }));
}

interface Cell { elementRef: string; ruleRef: string; elementId: string; ruleId: string; sim: number; isTrue: boolean }

async function main(): Promise<void> {
  const started = Date.now();
  console.log(`=== doc-16 RAW-CODE adjudication ${PILOT ? 'PILOT ' : ''}conc=${CONC} ===\n`);

  // --- rules: reuse/refresh floor-rules from frozen authored descriptions ---
  const ruleEntIdByRuleId = new Map<string, string>();
  for (const r of corpus.rules) {
    const res = await upsertCorpusElementEntity({ corpusId: RULE_CORPUS, name: r.id, type: 'rule', description: frozen.rules[r.id]! });
    ruleEntIdByRuleId.set(r.id, res.entityId);
  }
  // --- code RAW: description = verbatim snippet, NO authoring ---
  const rawEntIdByElemId = new Map<string, string>();
  await db.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${RAW_CORPUS}`);
  for (const e of corpus.elements) {
    const res = await upsertCorpusElementEntity({ corpusId: RAW_CORPUS, name: e.id, type: 'code_element', description: e.snippet, dedupeKey: codeElementKey(e.snippet) });
    rawEntIdByElemId.set(e.id, res.entityId);
  }
  console.log(`ingested ${corpus.rules.length} rules + ${corpus.elements.length} RAW code elements`);

  // --- distractor ranking: doc-15 description-embedding recall over floor-code (still in DB) ---
  const descCand = await recallCrossCorpusCandidates(DESC_CORPUS, RULE_CORPUS, { k: corpus.rules.length, threshold: 0, maxCells: 100000 });
  const descEnts = await loadEnts([DESC_CORPUS]);
  const descNameByRef = new Map([...descEnts].map(([id, e]) => [id, e.name]));
  const ruleEntIdByName = new Map([...(await loadEnts([RULE_CORPUS]))].map(([id, e]) => [e.name, id]));
  const rankByElem = new Map<string, Array<{ ruleId: string; sim: number }>>();
  for (const c of descCand) {
    const en = descNameByRef.get(c.elementRef); if (!en) continue;
    const rn = [...ruleEntIdByRuleId].find(([, v]) => v === c.ruleId)?.[0] ?? null;
    if (!rn) continue;
    const l = rankByElem.get(en) ?? []; l.push({ ruleId: rn, sim: c.similarity }); rankByElem.set(en, l);
  }
  for (const l of rankByElem.values()) l.sort((a, b) => b.sim - a.sim);

  // --- build controlled candidate cells: true rules + top-2 false (over-seeded) rules ---
  const allCells: Cell[] = [];
  for (const e of corpus.elements) {
    const ranked = rankByElem.get(e.id) ?? [];
    const trueSet = new Set(e.expected_rule_citations);
    const falseTop2 = ranked.filter((r) => !trueSet.has(r.ruleId)).slice(0, 2).map((r) => r.ruleId);
    const rulesForCell = [...e.expected_rule_citations, ...falseTop2];
    for (const rid of rulesForCell) {
      const simEntry = ranked.find((r) => r.ruleId === rid);
      allCells.push({
        elementRef: rawEntIdByElemId.get(e.id)!, ruleRef: ruleEntIdByRuleId.get(rid)!,
        elementId: e.id, ruleId: rid, sim: simEntry?.sim ?? 0, isTrue: trueSet.has(rid),
      });
    }
  }
  const cells = PILOT ? allCells.filter((c) => { const el = elemById.get(c.elementId)!; return el.kind !== 'violation' || PILOT_VIOLATIONS.has(c.elementId); }) : allCells;
  console.log(`controlled candidate cells: ${cells.length}${PILOT ? ` (pilot: ${PILOT_VIOLATIONS.size} violations + all controls)` : ''}`);
  console.log(`  true cells: ${cells.filter((c) => c.isTrue).length}, false cells: ${cells.filter((c) => !c.isTrue).length}\n`);

  // --- adjudicate (real invoker) ---
  await db.execute(sql`DELETE FROM public.audit_runs WHERE name = ${RUN_NAME}`);
  await db.execute(sql`DELETE FROM public.bridge_edges WHERE source_corpus_id = ${RAW_CORPUS}`);
  await db.execute(sql`DELETE FROM public.staging_bridge_edges WHERE source_corpus_id = ${RAW_CORPUS}`);
  const { run } = await createOrLoadAuditRun({ name: RUN_NAME, sourceCorpusId: RAW_CORPUS, targetCorpusId: RULE_CORPUS, ruleSetHash: 'rawcode-v1' });
  await seedCoverageUnits(run.id, cells.map((c) => ({ elementRef: c.elementRef, ruleId: c.ruleRef })));
  const rawEnts = await loadEnts([RAW_CORPUS, RULE_CORPUS]);
  let done = 0;
  await pool(cells, CONC, async (c) => {
    const invocationId = randomUUID();
    const el = rawEnts.get(c.elementRef)!, ru = rawEnts.get(c.ruleRef)!;
    const scope: AuditCellScope = {
      runId: run.id, invocationId, sourceCorpusId: RAW_CORPUS, targetCorpusId: RULE_CORPUS, similarity: c.sim,
      element: { ref: c.elementRef, name: el.name, type: el.type, description: el.description }, // description = RAW CODE
      rule: { ref: c.ruleRef, name: ru.name, type: ru.type, description: ru.description },
    };
    try { await invokeAuditAgent(scope); } catch (err) { console.warn(`  cell ${c.elementId}->${short(c.ruleId)} failed: ${err instanceof Error ? err.message : String(err)}`); }
    await applyBridgePromotion(invocationId);
    const b = await liveBridge(c.elementRef, c.ruleRef);
    await stampCoverage({ runId: run.id, elementRef: c.elementRef, ruleId: c.ruleRef, verdict: (b ? b.relation : 'not_applicable') as CoverageVerdict, edgeId: b?.edgeId ?? null, invocationId });
    done += 1; if (done % 10 === 0 || done === cells.length) console.log(`  ${done}/${cells.length} swept`);
  });

  // --- LLM verdicts: violates-bridge per cell ---
  const bridges = (await db.execute(sql`SELECT a_ref::text AS a, b_ref::text AS b, relation FROM public.bridge_edges WHERE source_corpus_id=${RAW_CORPUS} AND expired_at IS NULL`)) as unknown as Array<{ a: string; b: string; relation: string }>;
  const llmViolates = new Set(bridges.filter((b) => b.relation === 'violates').map((b) => `${b.a} ${b.b}`));

  // --- baselines ---
  const bm25Top1 = new Map<string, string>(); // elementId -> top-1 rule id by BM25 over raw code
  const ruleToks = new Map(corpus.rules.map((r) => [r.id, tok(`${r.id} ${frozen.rules[r.id]}`)]));
  const Nr = ruleToks.size, df = new Map<string, number>();
  for (const t of ruleToks.values()) for (const u of new Set(t)) df.set(u, (df.get(u) ?? 0) + 1);
  const avgdl = [...ruleToks.values()].reduce((s, t) => s + t.length, 0) / Nr;
  const idf = (t: string) => Math.log(1 + (Nr - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const bm25 = (q: string[], d: string[]) => { const k1 = 1.5, b = 0.75, tf = new Map<string, number>(); for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1); let s = 0; for (const t of new Set(q)) { const f = tf.get(t) ?? 0; if (!f) continue; s += idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avgdl)); } return s; };
  for (const e of corpus.elements) {
    const q = tok(e.snippet);
    const best = corpus.rules.map((r) => ({ id: r.id, s: bm25(q, ruleToks.get(r.id)!) })).sort((a, b) => b.s - a.s)[0];
    bm25Top1.set(e.id, best!.id);
  }
  const regexPred = (elemId: string, rid: string) => RULE_REGEX[ruleNum(rid)]?.test(elemById.get(elemId)!.snippet) ?? false;
  const bm25Pred = (elemId: string, rid: string) => bm25Top1.get(elemId) === rid;
  const llmPred = (c: Cell) => llmViolates.has(`${c.elementRef} ${c.ruleRef}`);

  // --- metrics per classifier, overall + by rule class ---
  function score(pred: (c: Cell) => boolean, subset: Cell[]) {
    const T = subset.filter((c) => c.isTrue), F = subset.filter((c) => !c.isTrue);
    const tp = T.filter(pred).length, fn = T.length - tp, fp = F.filter(pred).length, tn = F.length - fp;
    const recall = T.length ? tp / T.length : NaN, spec = F.length ? tn / F.length : NaN;
    const ba = (Number.isNaN(recall) ? spec : Number.isNaN(spec) ? recall : (recall + spec) / 2);
    return { tp, fn, fp, tn, recall, spec, ba, nTrue: T.length, nFalse: F.length };
  }
  const classifiers: Array<[string, (c: Cell) => boolean]> = [
    ['LLM', llmPred], ['regex', (c) => regexPred(c.elementId, c.ruleId)], ['BM25', (c) => bm25Pred(c.elementId, c.ruleId)],
  ];
  const slices: Array<[string, Cell[]]> = [
    ['ALL', cells],
    ['mechanical', cells.filter((c) => ruleClass(c.ruleId) === 'mechanical')],
    ['SEMANTIC(22.1/3/4)', cells.filter((c) => ruleClass(c.ruleId) === 'semantic')],
    ['mixed(22.2)', cells.filter((c) => ruleClass(c.ruleId) === 'mixed')],
  ];

  console.log(`\n=== RESULTS (${PILOT ? 'PILOT ' : ''}single sample; FLOOR) — recall / specificity / balanced-accuracy ===`);
  const out: any = { generatedFrom: 'floor-rawcode.ts', pilot: PILOT, cells: cells.length, byClassifier: {} };
  for (const [cname, pred] of classifiers) {
    out.byClassifier[cname] = {};
    console.log(`\n  ${cname}:`);
    for (const [sname, sub] of slices) {
      const m = score(pred, sub);
      out.byClassifier[cname][sname] = m;
      console.log(`    ${sname.padEnd(20)} rec=${(m.recall).toFixed(2)} spec=${(m.spec).toFixed(2)} BA=${(m.ba).toFixed(3)}  (T=${m.nTrue} F=${m.nFalse}; tp${m.tp} fn${m.fn} fp${m.fp} tn${m.tn})`);
    }
  }

  // --- pass check (doc-16 §5) ---
  const baBest = (sname: string) => Math.max(out.byClassifier.regex[sname].ba, out.byClassifier.BM25[sname].ba);
  const llmBA = (sname: string) => out.byClassifier.LLM[sname].ba;
  const allDelta = llmBA('ALL') - baBest('ALL');
  const semDelta = llmBA('SEMANTIC(22.1/3/4)') - baBest('SEMANTIC(22.1/3/4)');
  const llmSpecAll = out.byClassifier.LLM.ALL.spec;
  const pass = allDelta >= 0.10 && llmSpecAll >= 0.70;
  console.log(`\n=== ${PILOT ? 'PILOT SIGNAL (subset, not the gate)' : 'VERDICT'} (doc-16 §5) ===`);
  console.log(`  LLM BA − best-baseline BA:  ALL ${allDelta >= 0 ? '+' : ''}${allDelta.toFixed(3)} (bar +0.10)   SEMANTIC ${semDelta >= 0 ? '+' : ''}${semDelta.toFixed(3)} (decisive)`);
  console.log(`  LLM specificity (ALL): ${llmSpecAll.toFixed(3)} (bar >=0.70)`);
  console.log(`  ${PILOT ? 'signal' : 'VERDICT'}: BA-beats-baseline+0.10:${allDelta >= 0.10}  spec>=0.70:${llmSpecAll >= 0.70}  => ${pass ? 'bars met' : 'a bar missed'}`);
  console.log(`  NOTE: the DECISIVE slice is SEMANTIC — a win carried only by mechanical rules does NOT license an adjudication claim (doc-16 §5).`);
  console.log(`\n  elapsed ${Math.round((Date.now() - started) / 1000)}s`);

  out.deltas = { allDelta, semDelta, llmSpecAll, pass };
  out.perCell = cells.map((c) => ({ element: c.elementId, rule: short(c.ruleId), class: ruleClass(c.ruleId), isTrue: c.isTrue, sim: Number(c.sim.toFixed(3)), llm: llmPred(c), regex: regexPred(c.elementId, c.ruleId), bm25: bm25Pred(c.elementId, c.ruleId) }));
  writeFileSync(join(DATA, PILOT ? 'floor-rawcode-pilot-results.json' : 'floor-rawcode-results.json'), JSON.stringify(out, null, 2));
  console.log(`\nwrote floor-rawcode${PILOT ? '-pilot' : ''}-results.json`);
  process.exit(0);
}

main().catch((err) => { console.error('rawcode failed:', err); process.exit(1); });
