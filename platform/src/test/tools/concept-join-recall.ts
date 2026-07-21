/**
 * nmemo-uhp.24 — doc-20 concept-JOIN recall gate (THE pre-registered measurement).
 *
 * Reads doc-10's recall-gate corpus (29 code elements w/ external clang-tidy
 * `trueGuideline` labels, 27 rules / 9 true guidelines), then measures three recall
 * arms over the SAME raw inputs against that external oracle:
 *
 *   1. Concept-JOIN  — the BUILT pipeline: extractAndLinkConcepts (real Haiku, blind
 *      per side) -> resolveConcepts (real Haiku) -> recallByConcept.
 *   2. Cosine-kNN    — ml.embed(raw code) query vs ml.embed(raw rule text) docs, via
 *      recallAcrossCorpus over element_embeddings.
 *   3. BM25          — textbook Okapi (k1=1.2, b=0.75) over raw code vs raw rule text.
 *
 * The bar (doc-20 §6, FROZEN before this ran): JOIN macro recall@5 must beat
 * max(cosine, BM25) by >= +0.15, win at every k in {1,3,5,8}, AND win the sub-lexical
 * slice (true pairs sharing no surface tokens). All arms rank ALL 27 rules with ties
 * broken AGAINST the true rule (conservative, doc-20 §7).
 *
 * TWO PHASES so the slow non-deterministic Haiku work is done ONCE and frozen:
 *   full run  (default)  : clean -> ingest -> embed -> extract(Haiku) -> resolve(Haiku)
 *                          -> freeze cj-extracted.json -> score -> cj-results.json
 *   --score-only         : re-score from the frozen DB state + cj-extracted.json (for
 *                          SCORER fixes only; never re-runs the system under test — R26).
 *
 * Run (all infra up; ML service on :8000 as provider=claude for real Haiku):
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/concept-join-recall.ts [--score-only]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { unwrapRows } from '../../services/audit.js';
import { ml } from '../../services/ml-client.js';
import { extractAndLinkConcepts, CONCEPT_CORPUS } from '../../services/concept-extraction.js';
import { resolveConcepts } from '../../services/concept-resolution.js';
import { recallByConcept, upsertElementEmbedding, recallAcrossCorpus } from '../../services/element-catalogs.js';

const CODE_CORPUS = 'cj-code';
const RULE_CORPUS = 'cj-rules';
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/recall-gate-artifacts');
const OUT_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/concept-join-artifacts');
const SCORE_ONLY = process.argv.includes('--score-only');
const KS = [1, 3, 5, 8];
const PRIMARY_K = 5;
const MARGIN = 0.15; // doc-20 §6.1, frozen

interface CodeEl { id: string; trueGuideline: string; code: string; file?: string; line?: number }
interface Rule { id: string; text: string }

const codeEls: CodeEl[] = JSON.parse(readFileSync(join(CORPUS_DIR, 'gate_code_raw.json'), 'utf8'));
const rules: Rule[] = JSON.parse(readFileSync(join(CORPUS_DIR, 'gate_rules.json'), 'utf8'));

// ---------- deterministic lexical rig (BM25 arm + sub-lexical slice) ----------
// Frozen tokenizer (doc-20 §7): lower-case alnum/underscore tokens, len>=3, minus a
// small stoplist. IDENTICAL tokenizer for BM25 scoring AND slice membership.
const STOP = new Set(['the','and','for','that','this','with','are','not','has','have','been','via','its','a','an','of','to','in','on','is','be','or','it','as','by','if','no','do','use','used','using','when','which','from','all','any','may','can','shall','should','must']);
function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t));
}
const BM25_K1 = 1.2, BM25_B = 0.75;
interface Bm25 { idf: Map<string, number>; docs: Map<string, { tf: Map<string, number>; len: number }>; avgdl: number }
function buildBm25(docTexts: Array<{ id: string; text: string }>): Bm25 {
  const docs = new Map<string, { tf: Map<string, number>; len: number }>();
  const df = new Map<string, number>();
  let total = 0;
  for (const d of docTexts) {
    const toks = tokenize(d.text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    docs.set(d.id, { tf, len: toks.length });
    total += toks.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = docTexts.length;
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  return { idf, docs, avgdl: total / Math.max(1, N) };
}
function bm25Score(ix: Bm25, docId: string, queryTerms: Set<string>): number {
  const doc = ix.docs.get(docId);
  if (!doc) return 0;
  let s = 0;
  for (const t of queryTerms) {
    const tf = doc.tf.get(t) ?? 0;
    if (tf === 0) continue;
    const idf = ix.idf.get(t) ?? 0;
    s += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.len / ix.avgdl)));
  }
  return s;
}

// ---------- ranking with ties broken AGAINST the true rule (doc-20 §7) ----------
// Rank ALL 27 rules by score DESC; within an equal-score group the true rule sorts
// LAST (conservative), then by rule id. Returns the 1-based rank of the true rule.
function rankTrueRule(scores: Map<string, number>, trueRuleId: string): number {
  const ordered = rules
    .map((r) => ({ id: r.id, score: scores.get(r.id) ?? 0, isTrue: r.id === trueRuleId }))
    .sort((a, b) => (b.score - a.score) || (Number(a.isTrue) - Number(b.isTrue)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ordered.findIndex((o) => o.id === trueRuleId) + 1;
}
function hitsAtKs(rank: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (const k of KS) out[k] = rank > 0 && rank <= k ? 1 : 0;
  return out;
}

// ---------- metrics ----------
const guidelines = [...new Set(codeEls.map((c) => c.trueGuideline))].sort();
function macroAtK(perEl: Map<string, Record<number, number>>, k: number): number {
  let sum = 0;
  for (const g of guidelines) {
    const els = codeEls.filter((c) => c.trueGuideline === g);
    const r = els.reduce((a, e) => a + (perEl.get(e.id)![k] ?? 0), 0) / els.length;
    sum += r;
  }
  return sum / guidelines.length;
}
function microAtK(perEl: Map<string, Record<number, number>>, k: number): number {
  return codeEls.reduce((a, e) => a + (perEl.get(e.id)![k] ?? 0), 0) / codeEls.length;
}
// seeded PRNG so bootstrap CIs reproduce under --score-only
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrapDiffCI(join: Map<string, Record<number, number>>, base: Map<string, Record<number, number>>, k: number) {
  const rng = mulberry32(0xC0FFEE);
  const gEls = guidelines.map((g) => codeEls.filter((c) => c.trueGuideline === g));
  const diffs: number[] = [];
  for (let iter = 0; iter < 10000; iter++) {
    let jSum = 0, bSum = 0;
    for (let i = 0; i < guidelines.length; i++) {
      const pick = Math.floor(rng() * guidelines.length);
      const els = gEls[pick]!;
      jSum += els.reduce((a, e) => a + join.get(e.id)![k]!, 0) / els.length;
      bSum += els.reduce((a, e) => a + base.get(e.id)![k]!, 0) / els.length;
    }
    diffs.push(jSum / guidelines.length - bSum / guidelines.length);
  }
  diffs.sort((a, b) => a - b);
  return { lo: diffs[Math.floor(0.025 * diffs.length)]!, hi: diffs[Math.floor(0.975 * diffs.length)]!, mean: diffs.reduce((a, b) => a + b, 0) / diffs.length };
}

// =====================================================================================

async function clean(): Promise<void> {
  for (const c of [CODE_CORPUS, RULE_CORPUS]) {
    await db.execute(sql`DELETE FROM public.bridge_edges WHERE source_corpus_id = ${c} OR target_corpus_id = ${c}`);
    await db.execute(sql`DELETE FROM public.staging_bridge_edges WHERE source_corpus_id = ${c} OR target_corpus_id = ${c}`);
    await db.execute(sql`DELETE FROM public.element_embeddings WHERE corpus_id = ${c}`);
  }
  // concept nodes + their bridges (reserved test corpus — safe to clear wholesale)
  await db.execute(sql`DELETE FROM public.bridge_edges WHERE target_corpus_id = ${CONCEPT_CORPUS}`);
  await db.execute(sql`DELETE FROM public.staging_bridge_edges WHERE target_corpus_id = ${CONCEPT_CORPUS}`);
  await db.execute(sql`DELETE FROM public.entity_merges WHERE source_entity_id IN (SELECT id FROM public.entities WHERE corpus_id = ${CONCEPT_CORPUS}) OR target_entity_id IN (SELECT id FROM public.entities WHERE corpus_id = ${CONCEPT_CORPUS})`);
  await db.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${CONCEPT_CORPUS}`);
  for (const c of [CODE_CORPUS, RULE_CORPUS]) {
    await db.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${c}`);
  }
}

async function insertEntity(name: string, corpus: string, type: string, props: object): Promise<string> {
  const rows = unwrapRows<{ id: string }>(await db.execute(sql`
    INSERT INTO public.entities (canonical_name, entity_type, corpus_id, confidence, properties)
    VALUES (${name}, ${type}, ${corpus}, 1.0, ${JSON.stringify(props)}::jsonb)
    RETURNING id::text AS id
  `));
  return rows[0]!.id;
}

interface Frozen {
  codeIds: Record<string, string>;        // element id -> entity id
  ruleIds: Record<string, string>;        // rule id -> entity id
  codeConcepts: Record<string, { labels: string[]; conceptIds: string[]; linked: number }>;
  ruleConcepts: Record<string, { labels: string[]; conceptIds: string[]; linked: number }>;
  resolution: { pairsConsidered: number; judgedSame: number; merged: number };
  ruleEmbeddings: Record<string, number[]>;
  codeEmbeddings: Record<string, number[]>;
}

async function extractPhase(): Promise<Frozen> {
  console.log('=== PHASE A: ingest + embed + extract(Haiku) + resolve(Haiku) ===\n');
  await clean();

  // ingest (direct entity creation — tight control, canonical_name = id)
  const codeIds: Record<string, string> = {};
  const ruleIds: Record<string, string> = {};
  for (const e of codeEls) codeIds[e.id] = await insertEntity(e.id, CODE_CORPUS, 'code_element', { trueGuideline: e.trueGuideline, file: e.file, line: e.line });
  for (const r of rules) ruleIds[r.id] = await insertEntity(r.id, RULE_CORPUS, 'rule_element', { ruleId: r.id });

  // R40 plumbing invariant: n-in == n-out, no fusion
  const nCode = unwrapRows<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM public.entities WHERE corpus_id = ${CODE_CORPUS}`))[0]!.n;
  const nRule = unwrapRows<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM public.entities WHERE corpus_id = ${RULE_CORPUS}`))[0]!.n;
  console.log(`plumbing: code entities ${nCode}/${codeEls.length}, rule entities ${nRule}/${rules.length}`);
  if (nCode !== codeEls.length || nRule !== rules.length) throw new Error(`PLUMBING FAIL (fusion?): expected ${codeEls.length}/${rules.length}, got ${nCode}/${nRule}`);

  // cosine arm: embed raw rule text (docs) + raw code (queries), freeze both
  const ruleEmbeddings: Record<string, number[]> = {};
  const codeEmbeddings: Record<string, number[]> = {};
  for (const r of rules) {
    const v = (await ml.embed(r.text)).vector;
    ruleEmbeddings[r.id] = v;
    await upsertElementEmbedding(ruleIds[r.id]!, RULE_CORPUS, 'rule_text', r.text, v);
  }
  for (const e of codeEls) codeEmbeddings[e.id] = (await ml.embed(e.code)).vector;
  console.log(`embedded ${rules.length} rules + ${codeEls.length} code queries`);

  // concept extraction — REAL Haiku, blind per side (no generate override)
  const codeConcepts: Frozen['codeConcepts'] = {};
  const ruleConcepts: Frozen['ruleConcepts'] = {};
  let i = 0;
  for (const e of codeEls) {
    const res = await extractAndLinkConcepts({ elementEntityId: codeIds[e.id]!, corpusId: CODE_CORPUS, side: 'code', name: e.id, text: e.code });
    codeConcepts[e.id] = { labels: res.labels.map((l) => l.name), conceptIds: res.conceptIds, linked: res.linked };
    console.log(`[code ${++i}/${codeEls.length}] ${e.id}: ${res.labels.map((l) => l.name).join(', ') || '(none)'}`);
  }
  i = 0;
  for (const r of rules) {
    const res = await extractAndLinkConcepts({ elementEntityId: ruleIds[r.id]!, corpusId: RULE_CORPUS, side: 'rule', name: r.id, text: r.text });
    ruleConcepts[r.id] = { labels: res.labels.map((l) => l.name), conceptIds: res.conceptIds, linked: res.linked };
    console.log(`[rule ${++i}/${rules.length}] ${r.id}: ${res.labels.map((l) => l.name).join(', ') || '(none)'}`);
  }

  // resolution — REAL Haiku equivalence judge (built pipeline, default threshold)
  const resolution = await resolveConcepts({});
  console.log(`\nresolution: ${resolution.merged} merged / ${resolution.judgedSame} judged-same / ${resolution.pairsConsidered} pairs considered`);

  const frozen: Frozen = { codeIds, ruleIds, codeConcepts, ruleConcepts, resolution, ruleEmbeddings, codeEmbeddings };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'cj-extracted.json'), JSON.stringify(frozen, null, 2));
  console.log(`\nfroze cj-extracted.json`);
  return frozen;
}

async function scorePhase(frozen: Frozen): Promise<void> {
  console.log('\n=== PHASE B: score three arms vs external oracle ===\n');
  const bm25 = buildBm25(rules.map((r) => ({ id: r.id, text: r.text })));

  const joinHits = new Map<string, Record<number, number>>();
  const cosHits = new Map<string, Record<number, number>>();
  const bmHits = new Map<string, Record<number, number>>();
  const perElement: Record<string, unknown> = {};
  const subLexical: string[] = [];

  for (const e of codeEls) {
    const trueRule = e.trueGuideline;
    // sub-lexical slice membership (frozen tokenizer; zero shared tokens w/ true rule)
    const codeToks = new Set(tokenize(e.code));
    const ruleTok = new Set(tokenize(rules.find((r) => r.id === trueRule)!.text));
    const shared = [...codeToks].filter((t) => ruleTok.has(t));
    if (shared.length === 0) subLexical.push(e.id);

    // ---- JOIN ----
    const hits = await recallByConcept(frozen.codeIds[e.id]!, { ruleCorpusId: RULE_CORPUS });
    const entToRule = Object.fromEntries(Object.entries(frozen.ruleIds).map(([rid, eid]) => [eid, rid]));
    const joinScore = new Map<string, number>();
    for (const h of hits) { const rid = entToRule[h.ruleElementRef]; if (rid) joinScore.set(rid, h.sharedConcepts); }
    const joinRank = rankTrueRule(joinScore, trueRule);
    joinHits.set(e.id, hitsAtKs(joinRank));

    // ---- Cosine ----
    const cos = await recallAcrossCorpus(frozen.codeEmbeddings[e.id]!, { targetCorpusId: RULE_CORPUS, kind: 'rule_text', k: rules.length });
    const cosScore = new Map<string, number>();
    for (const h of cos) { const rid = entToRule[h.elementRef]; if (rid) cosScore.set(rid, h.similarity); }
    const cosRank = rankTrueRule(cosScore, trueRule);
    cosHits.set(e.id, hitsAtKs(cosRank));

    // ---- BM25 ----
    const qTerms = new Set(tokenize(e.code));
    const bmScore = new Map<string, number>();
    for (const r of rules) bmScore.set(r.id, bm25Score(bm25, r.id, qTerms));
    const bmRank = rankTrueRule(bmScore, trueRule);
    bmHits.set(e.id, hitsAtKs(bmRank));

    perElement[e.id] = { trueRule, subLexical: shared.length === 0, joinRank, cosRank, bmRank, joinSharedTop: hits[0]?.sharedConcepts ?? 0 };
  }

  // ---- aggregate ----
  const arms = { join: joinHits, cosine: cosHits, bm25: bmHits };
  const macro: Record<string, Record<number, number>> = {};
  const micro: Record<string, Record<number, number>> = {};
  for (const [name, h] of Object.entries(arms)) {
    macro[name] = {}; micro[name] = {};
    for (const k of KS) { macro[name]![k] = macroAtK(h, k); micro[name]![k] = microAtK(h, k); }
  }
  // baseline = max(cosine, BM25) per k
  const baseMacro: Record<number, number> = {};
  for (const k of KS) baseMacro[k] = Math.max(macro.cosine![k]!, macro.bm25![k]!);

  // sub-lexical slice recall (micro over the slice) at each k
  const sliceRecall: Record<string, Record<number, number>> = { join: {}, cosine: {}, bm25: {} };
  for (const [name, h] of Object.entries(arms)) for (const k of KS) {
    sliceRecall[name]![k] = subLexical.length ? subLexical.reduce((a, id) => a + h.get(id)![k]!, 0) / subLexical.length : 0;
  }

  // Pre-registered §8: report the ARM-vs-ARM difference CIs (JOIN vs each baseline),
  // NOT the per-element max(cos,bm25) union (which is harsher than §8 and overstated
  // the loss — adversary correction, nmemo-uhp.24). cond1's point delta vs max stays
  // the BAR metric; these CIs characterise the statistical (in)significance honestly.
  const ciCos = bootstrapDiffCI(joinHits, cosHits, PRIMARY_K);
  const ciBm = bootstrapDiffCI(joinHits, bmHits, PRIMARY_K);
  const pointDeltaVsMax = macro.join![PRIMARY_K]! - baseMacro[PRIMARY_K]!;

  // ---- bar (doc-20 §6, frozen) ----
  const cond1 = macro.join![PRIMARY_K]! - baseMacro[PRIMARY_K]! >= MARGIN;
  const cond2 = KS.every((k) => macro.join![k]! >= baseMacro[k]!);
  const cond3 = KS.includes(PRIMARY_K) && sliceRecall.join![PRIMARY_K]! > sliceRecall.cosine![PRIMARY_K]! && sliceRecall.join![PRIMARY_K]! > sliceRecall.bm25![PRIMARY_K]!;
  const pass = cond1 && cond2 && cond3;

  // ---- report ----
  const q = 1 / guidelines.length;
  const fmt = (o: Record<number, number>) => KS.map((k) => `@${k}=${o[k]!.toFixed(3)}`).join('  ');
  console.log(`guidelines: ${guidelines.length} (macro quantum = ${q.toFixed(3)}) | elements: ${codeEls.length} | sub-lexical slice: ${subLexical.length}`);
  console.log(`\nMACRO recall:`);
  console.log(`  JOIN     ${fmt(macro.join!)}`);
  console.log(`  cosine   ${fmt(macro.cosine!)}`);
  console.log(`  BM25     ${fmt(macro.bm25!)}`);
  console.log(`  base=max ${fmt(baseMacro)}`);
  console.log(`\nMICRO recall:`);
  console.log(`  JOIN     ${fmt(micro.join!)}`);
  console.log(`  cosine   ${fmt(micro.cosine!)}`);
  console.log(`  BM25     ${fmt(micro.bm25!)}`);
  console.log(`\nSUB-LEXICAL slice (n=${subLexical.length}) recall:`);
  console.log(`  JOIN     ${fmt(sliceRecall.join!)}`);
  console.log(`  cosine   ${fmt(sliceRecall.cosine!)}`);
  console.log(`  BM25     ${fmt(sliceRecall.bm25!)}`);
  console.log(`\nJOIN macro@${PRIMARY_K} point delta vs base=max(cos,bm25): ${pointDeltaVsMax.toFixed(3)}  (the +${MARGIN} WIN-bar metric, cond1)`);
  console.log(`arm-vs-arm bootstrap (§8, resample ${guidelines.length} guidelines, 10k, seeded):`);
  console.log(`  JOIN - cosine macro@${PRIMARY_K}: mean ${ciCos.mean.toFixed(3)}  95% CI [${ciCos.lo.toFixed(3)}, ${ciCos.hi.toFixed(3)}]  ${ciCos.lo <= 0 && ciCos.hi >= 0 ? '(includes 0 — tie)' : ''}`);
  console.log(`  JOIN - BM25   macro@${PRIMARY_K}: mean ${ciBm.mean.toFixed(3)}  95% CI [${ciBm.lo.toFixed(3)}, ${ciBm.hi.toFixed(3)}]  ${ciBm.lo <= 0 && ciBm.hi >= 0 ? '(includes 0 — tie)' : ''}`);
  console.log(`\n=== BAR (doc-20 §6, frozen) ===`);
  console.log(`  [${cond1 ? 'PASS' : 'FAIL'}] cond1: JOIN macro@5 - max(cos,bm25) >= +${MARGIN}  (${(macro.join![PRIMARY_K]! - baseMacro[PRIMARY_K]!).toFixed(3)})`);
  console.log(`  [${cond2 ? 'PASS' : 'FAIL'}] cond2: JOIN macro@k >= base at every k`);
  console.log(`  [${cond3 ? 'PASS' : 'FAIL'}] cond3: JOIN wins sub-lexical slice @5 (JOIN ${sliceRecall.join![PRIMARY_K]!.toFixed(3)} vs cos ${sliceRecall.cosine![PRIMARY_K]!.toFixed(3)} / bm25 ${sliceRecall.bm25![PRIMARY_K]!.toFixed(3)})`);
  console.log(`\n  >>> GATE ${pass ? 'PASS' : 'FAIL'} <<<\n`);

  const extractionStats = {
    codeConceptsPerEl: Object.values(frozen.codeConcepts).reduce((a, c) => a + c.labels.length, 0) / codeEls.length,
    ruleConceptsPerEl: Object.values(frozen.ruleConcepts).reduce((a, c) => a + c.labels.length, 0) / rules.length,
    distinctConcepts: new Set([...Object.values(frozen.codeConcepts), ...Object.values(frozen.ruleConcepts)].flatMap((c) => c.labels)).size,
    resolution: frozen.resolution,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'cj-results.json'), JSON.stringify({
    prereg: 'doc-20', corpus: 'doc-10 recall-gate', margin: MARGIN, ks: KS, primaryK: PRIMARY_K,
    guidelines, quantum: q, nElements: codeEls.length, subLexicalIds: subLexical,
    macro, micro, baseMacro, sliceRecall,
    pointDeltaVsMax, bootstrapArmVsArm: { joinMinusCosine: ciCos, joinMinusBm25: ciBm },
    bar: { cond1, cond2, cond3, pass }, extractionStats, perElement,
    oracleKey: Object.fromEntries(codeEls.map((e) => [e.id, e.trueGuideline])),
  }, null, 2));
  console.log(`wrote cj-results.json`);
}

async function main(): Promise<void> {
  let frozen: Frozen;
  if (SCORE_ONLY) {
    frozen = JSON.parse(readFileSync(join(OUT_DIR, 'cj-extracted.json'), 'utf8'));
    console.log('=== --score-only: re-scoring from frozen cj-extracted.json ===');
  } else {
    frozen = await extractPhase();
  }
  await scorePhase(frozen);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
