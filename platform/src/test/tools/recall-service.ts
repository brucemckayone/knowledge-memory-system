/**
 * Service recall-lift acceptance gate (bead nmemo-uhp.17.4). Pre-reg: doc 14.
 *
 * Exercises the BUILT .17 path end-to-end: (1) author a faceted description for each
 * gate code item via the production authorElementDescription service (Haiku, blind to
 * rules) — done ONCE and FROZEN to gate_code_service_facets.json; (2) seed both the
 * service-faceted and the plain-prose baseline corpora via the production
 * upsertCorpusElementEntity (.17.3) so the real embed composition + storage is under
 * test; (3) recall via production recallCrossCorpusCandidates; (4) score with the
 * identical doc-11/12 machinery (frozen tokenizer, conservative rank, macro/micro,
 * paired bootstrap, BM25). Rule side held FIXED = oneliner (single variable = code
 * description). NOT a vitest test.
 *
 * Run:
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/recall-service.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { entityEmbedTextFor } from '../../services/embed-text.js';
import { authorElementDescription } from '../../services/element-authoring.js';
import { detectRuleReferences } from '../../services/element-description.js';
import { upsertCorpusElementEntity, codeElementKey } from '../../services/corpus-ingest.js';
import { recallCrossCorpusCandidates } from '../../services/audit-pass.js';

interface Rule { id: string; text: string }
interface CodeRaw { id: string; trueGuideline: string; code: string }
interface CodeDesc { id: string; functionName: string; description: string }
interface ServiceFacet { id: string; functionName: string; description: string; leakedReferences: string[] }

const ks = [1, 3, 5, 8];
const FLOORED = ['F.16', 'C.48', 'ES.20', 'ES.75'];
const HELDOUT_SEED = 17;
const HELDOUT_COUNT = 5; // of 9 guidelines (doc 14 §2 — committed here)
const BOOT_SEED = 12345;

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '../../../../docs/architecture/cross-corpus-audit/recall-gate-artifacts');
const load = <T>(f: string): T => JSON.parse(readFileSync(join(ART, f), 'utf8')) as T;

const rules = load<Rule[]>('gate_rules.json');
const codeRaw = load<CodeRaw[]>('gate_code_raw.json');
const codeDesc = load<CodeDesc[]>('gate_code_desc.json');
const descBy = new Map(codeDesc.map((d) => [d.id, d]));

// --- frozen tokenizer + lexical channels (doc 12 §3, identical) ---
function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.toLowerCase().matchAll(/[a-z0-9]+/g)) if (m[0].length >= 2) out.add(m[0]);
  return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}
const BM25_K1 = 1.2;
const BM25_B = 0.75;
function tokenCounts(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of s.toLowerCase().matchAll(/[a-z0-9]+/g)) if (g[0].length >= 2) m.set(g[0], (m.get(g[0]) ?? 0) + 1);
  return m;
}
interface Bm25Index { idf: Map<string, number>; docs: Map<string, { tf: Map<string, number>; len: number }>; avgdl: number }
function buildBm25(docTexts: Map<string, string>): Bm25Index {
  const docs = new Map<string, { tf: Map<string, number>; len: number }>();
  const df = new Map<string, number>();
  let total = 0;
  for (const [id, text] of docTexts) {
    const tf = tokenCounts(text);
    let len = 0; for (const c of tf.values()) len += c;
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.set(id, { tf, len }); total += len;
  }
  const N = docs.size;
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  return { idf, docs, avgdl: total / N };
}
function bm25Score(index: Bm25Index, docId: string, queryTerms: Set<string>): number {
  const doc = index.docs.get(docId); if (!doc) return 0;
  let s = 0;
  for (const t of queryTerms) {
    const tf = doc.tf.get(t); if (!tf) continue;
    const idf = index.idf.get(t) ?? 0;
    s += (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.len / index.avgdl)));
  }
  return s;
}

// --- conservative rank + recall (doc 11/12, identical) ---
function rankOf(scoreByRule: Map<string, number>, trueRule: string): number | null {
  const t = scoreByRule.get(trueRule);
  if (t === undefined) return null;
  let n = 0;
  for (const s of scoreByRule.values()) if (s >= t) n += 1;
  return n;
}
interface ItemResult { trueGuideline: string; rank: number | null }
const microRecall = (items: ItemResult[]): Record<number, number> => {
  const r: Record<number, number> = {};
  for (const k of ks) r[k] = items.filter((x) => x.rank !== null && x.rank <= k).length / items.length;
  return r;
};
function groupsOf(items: ItemResult[]): Map<string, ItemResult[]> {
  const m = new Map<string, ItemResult[]>();
  for (const it of items) { if (!m.has(it.trueGuideline)) m.set(it.trueGuideline, []); m.get(it.trueGuideline)!.push(it); }
  return m;
}
const macroRecall = (items: ItemResult[]): Record<number, number> => {
  const byG = groupsOf(items);
  const r: Record<number, number> = {};
  for (const k of ks) { const per = [...byG.values()].map((g) => g.filter((x) => x.rank !== null && x.rank <= k).length / g.length); r[k] = per.reduce((a, b) => a + b, 0) / per.length; }
  return r;
};
const flooredRescued = (items: Array<ItemResult & { g: string }>): number => {
  let n = 0;
  for (const g of FLOORED) { const its = items.filter((x) => x.g === g); if (its.length > 0 && its.some((x) => x.rank !== null && x.rank <= 5)) n += 1; }
  return n;
};
function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function macroAt5FromGroups(groups: Map<string, ItemResult[]>): number {
  const per = [...groups.values()].map((g) => g.filter((x) => x.rank !== null && x.rank <= 5).length / g.length);
  return per.reduce((a, b) => a + b, 0) / per.length;
}
function bootstrapPairedDelta(a: ItemResult[], b: ItemResult[], iters = 5000, seed = BOOT_SEED): { mean: number; lo: number; hi: number; pLE0: number } {
  const ga = groupsOf(a), gb = groupsOf(b);
  const keys = [...ga.keys()];
  const rnd = lcg(seed);
  const deltas: number[] = [];
  for (let i = 0; i < iters; i += 1) {
    const sa = new Map<string, ItemResult[]>(), sb = new Map<string, ItemResult[]>();
    for (let j = 0; j < keys.length; j += 1) { const k = keys[Math.floor(rnd() * keys.length)]!; sa.set(`${k}#${j}`, ga.get(k)!); sb.set(`${k}#${j}`, gb.get(k)!); }
    deltas.push(macroAt5FromGroups(sa) - macroAt5FromGroups(sb));
  }
  deltas.sort((x, y) => x - y);
  const q = (p: number): number => deltas[Math.min(deltas.length - 1, Math.max(0, Math.floor(p * deltas.length)))]!;
  return { mean: deltas.reduce((x, y) => x + y, 0) / deltas.length, lo: q(0.025), hi: q(0.975), pLE0: deltas.filter((d) => d <= 0).length / deltas.length };
}

// deterministic guideline held-out split
function heldoutSplit(guidelines: string[]): { heldout: Set<string>; train: Set<string> } {
  const shuffled = [...guidelines];
  const rnd = lcg(HELDOUT_SEED);
  for (let i = shuffled.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
  const heldout = new Set(shuffled.slice(0, HELDOUT_COUNT));
  const train = new Set(shuffled.slice(HELDOUT_COUNT));
  return { heldout, train };
}

async function embedAuthorFrozen(): Promise<ServiceFacet[]> {
  const path = join(ART, 'gate_code_service_facets.json');
  if (existsSync(path)) {
    console.log('[service] frozen faceted artifact exists — loading (deterministic reuse)');
    return load<ServiceFacet[]>('gate_code_service_facets.json');
  }
  console.log('[service] authoring faceted descriptions via Haiku (once, then frozen)…');
  const out: ServiceFacet[] = [];
  for (const c of codeRaw) {
    const fn = descBy.get(c.id)?.functionName ?? c.id;
    let authored: { description: string; leakedReferences: string[] } | null = null;
    for (let attempt = 0; attempt < 2 && !authored; attempt += 1) {
      try {
        authored = await authorElementDescription({ name: fn, code: c.code });
      } catch (err) {
        console.warn(`  [${c.id}] attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!authored) throw new Error(`authoring failed for ${c.id} after retries`);
    out.push({ id: c.id, functionName: fn, description: authored.description, leakedReferences: authored.leakedReferences });
    console.log(`  [${c.id}] ${fn}: ${authored.description.length} chars${authored.leakedReferences.length ? ` LEAKED=${authored.leakedReferences.join(',')}` : ''}`);
  }
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`[service] froze ${out.length} authored descriptions -> gate_code_service_facets.json`);
  return out;
}

/** Seed one code corpus via the production upsert; returns entityId->code.id map. */
async function seedCode(corpus: string, texts: Map<string, string>): Promise<Map<string, string>> {
  await db.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${corpus}`);
  const idByEl = new Map<string, string>();
  for (const c of codeRaw) {
    const fn = descBy.get(c.id)?.functionName ?? c.id;
    // Content-key identity (the production key) so distinct same-named items — the 6
    // INITIAL_VARIANCE_SCALAR (ES.45) elements — never fuse. Without this all 29 items
    // collapse to 24 entities and the 5 dropped items score as forced misses
    // (nmemo-uhp.17.4 seeding bug the adversary caught).
    const { entityId } = await upsertCorpusElementEntity({
      corpusId: corpus, name: fn, type: 'code_element', description: texts.get(c.id) ?? '',
      dedupeKey: codeElementKey(c.code),
    });
    idByEl.set(entityId, c.id);
  }
  return idByEl;
}
async function seedRules(corpus: string): Promise<Map<string, string>> {
  await db.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${corpus}`);
  const ruleIdByEl = new Map<string, string>();
  for (const r of rules) {
    const { entityId } = await upsertCorpusElementEntity({ corpusId: corpus, name: r.id, type: 'rule', description: r.text });
    ruleIdByEl.set(entityId, r.id);
  }
  return ruleIdByEl;
}

async function cosineMatrix(codeCorpus: string, stdCorpus: string, idByEl: Map<string, string>, ruleIdByEl: Map<string, string>): Promise<Map<string, Map<string, number>>> {
  const cands = await recallCrossCorpusCandidates(codeCorpus, stdCorpus, { k: rules.length, threshold: -1, maxCells: 100000 });
  const cosByCode = new Map<string, Map<string, number>>(); // code.id -> (rule.id -> cos)
  for (const p of cands) {
    const codeId = idByEl.get(p.elementRef); const ruleId = ruleIdByEl.get(p.ruleId);
    if (!codeId || !ruleId) continue;
    if (!cosByCode.has(codeId)) cosByCode.set(codeId, new Map());
    cosByCode.get(codeId)!.set(ruleId, p.similarity);
  }
  return cosByCode;
}

interface FormulaResult {
  vector: Array<ItemResult & { g: string }>;
  lexical: Array<ItemResult & { g: string }>;
  bm25: Array<ItemResult & { g: string }>;
}

async function scoreFormula(codeCorpus: string, stdCorpus: string, texts: Map<string, string>): Promise<FormulaResult> {
  const idByEl = await seedCode(codeCorpus, texts);
  const ruleIdByEl = await seedRules(stdCorpus);
  const cos = await cosineMatrix(codeCorpus, stdCorpus, idByEl, ruleIdByEl);

  // Lexical channels over the SAME composed embed text (name\ndescription).
  const codeTok = new Map<string, Set<string>>();
  for (const c of codeRaw) { const fn = descBy.get(c.id)?.functionName ?? c.id; codeTok.set(c.id, tokens(entityEmbedTextFor(fn, texts.get(c.id) ?? '', 'name_description'))); }
  const ruleDocText = new Map<string, string>();
  for (const r of rules) ruleDocText.set(r.id, entityEmbedTextFor(r.id, r.text, 'name_description'));
  const ruleTok = new Map<string, Set<string>>();
  for (const r of rules) ruleTok.set(r.id, tokens(ruleDocText.get(r.id)!));
  const bm25 = buildBm25(ruleDocText);

  const vector: Array<ItemResult & { g: string }> = [];
  const lexical: Array<ItemResult & { g: string }> = [];
  const bm25res: Array<ItemResult & { g: string }> = [];
  for (const c of codeRaw) {
    const cosRow = cos.get(c.id) ?? new Map<string, number>();
    const lex = new Map<string, number>();
    for (const r of rules) lex.set(r.id, jaccard(codeTok.get(c.id)!, ruleTok.get(r.id)!));
    const bm = new Map<string, number>();
    for (const r of rules) bm.set(r.id, bm25Score(bm25, r.id, codeTok.get(c.id)!));
    vector.push({ trueGuideline: c.trueGuideline, g: c.trueGuideline, rank: rankOf(cosRow, c.trueGuideline) });
    lexical.push({ trueGuideline: c.trueGuideline, g: c.trueGuideline, rank: rankOf(lex, c.trueGuideline) });
    bm25res.push({ trueGuideline: c.trueGuideline, g: c.trueGuideline, rank: rankOf(bm, c.trueGuideline) });
  }
  return { vector, lexical, bm25: bm25res };
}

function subset(items: Array<ItemResult & { g: string }>, keep: Set<string>): Array<ItemResult & { g: string }> {
  return items.filter((x) => keep.has(x.g));
}

async function main(): Promise<void> {
  const faceted = await embedAuthorFrozen();
  const facetText = new Map(faceted.map((f) => [f.id, f.description]));
  const plainText = new Map(codeDesc.map((d) => [d.id, d.description]));

  console.log(`\n[service] scoring ${codeRaw.length} code items vs ${rules.length} rules (rule side = oneliner, FIXED)`);
  const facetedRes = await scoreFormula('svc_code_faceted', 'svc_std', facetText);
  const plainRes = await scoreFormula('svc_code_plain', 'svc_std', plainText);

  const guidelines = [...new Set(codeRaw.map((c) => c.trueGuideline))];
  const { heldout, train } = heldoutSplit(guidelines);

  // Primary metric: MACRO recall@5.
  const macroF = macroRecall(facetedRes.vector);
  const macroP = macroRecall(plainRes.vector);
  const microF = microRecall(facetedRes.vector);
  const microP = microRecall(plainRes.vector);

  const heldoutF = macroRecall(subset(facetedRes.vector, heldout));
  const heldoutP = macroRecall(subset(plainRes.vector, heldout));
  const trainF = macroRecall(subset(facetedRes.vector, train));
  const trainP = macroRecall(subset(plainRes.vector, train));

  const boot = bootstrapPairedDelta(facetedRes.vector, plainRes.vector);

  // Lexical / BM25 disclosure (rule 36).
  const macroFlex = macroRecall(facetedRes.lexical)[5] ?? 0;
  const macroPlex = macroRecall(plainRes.lexical)[5] ?? 0;
  const macroFbm = macroRecall(facetedRes.bm25)[5] ?? 0;
  const macroPbm = macroRecall(plainRes.bm25)[5] ?? 0;

  // Leakage battery on service-authored faceted text.
  const leaks: Array<{ id: string; refs: string[]; jTrue: number; jOtherMean: number }> = [];
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  for (const c of codeRaw) {
    const desc = facetText.get(c.id) ?? '';
    const refs = detectRuleReferences(desc);
    const dTok = tokens(desc);
    const trueRule = ruleById.get(c.trueGuideline);
    const jTrue = trueRule ? jaccard(dTok, tokens(trueRule.text)) : 0;
    const others = rules.filter((r) => r.id !== c.trueGuideline).map((r) => jaccard(dTok, tokens(r.text)));
    const jOtherMean = others.reduce((a, b) => a + b, 0) / (others.length || 1);
    if (refs.length || jTrue > 0) leaks.push({ id: c.id, refs, jTrue, jOtherMean });
  }
  const totalLeaks = leaks.filter((l) => l.refs.length > 0);

  const heldoutDelta = (heldoutF[5] ?? 0) - (heldoutP[5] ?? 0);
  const cond1 = heldoutDelta >= 0.1;
  const cond2 = boot.lo > 0;
  const pass = cond1 && cond2;

  const results = {
    prereg: 'doc 14', metric: 'MACRO recall@5', ruleSide: 'oneliner (fixed)',
    heldoutSplit: { seed: HELDOUT_SEED, heldout: [...heldout], train: [...train] },
    full: {
      faceted: { macro: macroF, micro: microF, flooredRescued: flooredRescued(facetedRes.vector) },
      plain: { macro: macroP, micro: microP, flooredRescued: flooredRescued(plainRes.vector) },
      macro5Delta: (macroF[5] ?? 0) - (macroP[5] ?? 0),
    },
    heldout: { facetedMacro5: heldoutF[5], plainMacro5: heldoutP[5], delta: heldoutDelta },
    train: { facetedMacro5: trainF[5], plainMacro5: trainP[5] },
    bootstrapFullDelta: boot,
    lexicalDisclosure: {
      note: 'no-embedding baselines; doc 11 found the faceted lift is largely lexical',
      faceted: { jaccardMacro5: macroFlex, bm25Macro5: macroFbm },
      plain: { jaccardMacro5: macroPlex, bm25Macro5: macroPbm },
    },
    leakage: { serviceLeakedRuleRefs: totalLeaks, jaccardTrueVsOther: leaks },
    passConditions: { heldoutDeltaGE0_10: cond1, fullBootstrapCIExcludes0: cond2 },
    VERDICT: pass ? 'PASS' : 'FAIL',
  };
  writeFileSync(join(ART, 'service_recall_results.json'), JSON.stringify(results, null, 2));

  // --- console summary ---
  const f3 = (n: number | undefined): string => (n ?? 0).toFixed(3);
  console.log('\n================ MACRO recall (primary) ================');
  console.log('formula   |  @1   |  @3   |  @5   |  @8');
  console.log(`faceted   | ${f3(macroF[1])} | ${f3(macroF[3])} | ${f3(macroF[5])} | ${f3(macroF[8])}`);
  console.log(`plain     | ${f3(macroP[1])} | ${f3(macroP[3])} | ${f3(macroP[5])} | ${f3(macroP[8])}`);
  console.log(`\nMICRO @5: faceted=${f3(microF[5])} plain=${f3(microP[5])}`);
  console.log(`\nHELD-OUT (${[...heldout].join(',')}): faceted@5=${f3(heldoutF[5])} plain@5=${f3(heldoutP[5])} Δ=${heldoutDelta >= 0 ? '+' : ''}${heldoutDelta.toFixed(3)}`);
  console.log(`TRAIN    (${[...train].join(',')}): faceted@5=${f3(trainF[5])} plain@5=${f3(trainP[5])}`);
  console.log(`\nFULL macro@5 Δ (faceted−plain) = ${((macroF[5] ?? 0) - (macroP[5] ?? 0)).toFixed(3)}`);
  console.log(`Paired bootstrap Δ: mean=${boot.mean.toFixed(3)} 95%CI=[${boot.lo.toFixed(3)}, ${boot.hi.toFixed(3)}] P(Δ≤0)=${boot.pLE0.toFixed(3)}`);
  console.log(`\nLEXICAL disclosure (no embedding): faceted Jaccard@5=${f3(macroFlex)} BM25@5=${f3(macroFbm)} | plain Jaccard@5=${f3(macroPlex)} BM25@5=${f3(macroPbm)}`);
  console.log(`Service-authored LEAKED rule refs: ${totalLeaks.length} item(s)${totalLeaks.length ? ' -> ' + totalLeaks.map((l) => `${l.id}:[${l.refs.join(',')}]`).join(' ') : ''}`);
  console.log(`\nPASS conditions: heldoutΔ≥0.10=${cond1} (Δ=${heldoutDelta.toFixed(3)}) ; fullBootstrapCI>0=${cond2} (lo=${boot.lo.toFixed(3)})`);
  console.log(`\n================ VERDICT: ${pass ? 'PASS' : 'FAIL'} ================`);

  // cleanup
  for (const c of ['svc_code_faceted', 'svc_code_plain', 'svc_std']) await db.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${c}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
