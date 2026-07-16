/**
 * Hybrid lexical+vector retrieval experiment (bead nmemo-uhp.16). Pre-reg: doc 12.
 *
 * Reuses doc-10/11's rig (entityEmbedTextFor + ml.embed + recallCrossCorpusCandidates,
 * deterministic conservative rank, macro/micro recall) but scores FOUR retrieval methods
 * per formula combo — vector, lexical (token-Jaccard), rrf (K=60), linear (min-max, a=0.5)
 * — over the doc-11 grid of 4 code formulas x 2 rule formulas = 8 combos = 32 cells.
 * Primary metric = MACRO recall@5. All settings fixed/standard; no tuning (doc 12 §2).
 *
 * NOT a vitest test. Run:
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/recall-hybrid.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ml } from '../../services/ml-client.js';
import { entityEmbedTextFor } from '../../services/embed-text.js';
import { recallCrossCorpusCandidates } from '../../services/audit-pass.js';

interface Rule { id: string; text: string }
interface CodeRaw { id: string; trueGuideline: string; code: string }
interface CodeDesc { id: string; functionName: string; description: string }
interface CodeFormulas { id: string; facets: string; concepts: string }
interface RuleRicher { id: string; richer: string }

const CODE_FORMULAS = ['plain', 'facets', 'concepts', 'rawcode'] as const;
const RULE_FORMULAS = ['oneliner', 'richer'] as const;
const METHODS = ['vector', 'lexical', 'rrf', 'linear'] as const;
type CodeF = (typeof CODE_FORMULAS)[number];
type RuleF = (typeof RULE_FORMULAS)[number];
type Method = (typeof METHODS)[number];
const FLOORED = ['F.16', 'C.48', 'ES.20', 'ES.75'];
const ks = [1, 3, 5, 8];
const RRF_KS = [10, 30, 60, 100]; // K=60 is the frozen headline (doc 12 §2, §6)
const RRF_K_PRIMARY = 60;

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '../../../../docs/architecture/cross-corpus-audit/recall-gate-artifacts');
const load = <T>(f: string): T => JSON.parse(readFileSync(join(ART, f), 'utf8')) as T;

const rules = load<Rule[]>('gate_rules.json');
const codeRaw = load<CodeRaw[]>('gate_code_raw.json');
const codeDesc = load<CodeDesc[]>('gate_code_desc.json');
const codeForm = load<CodeFormulas[]>('gate_code_formulas.json');
const ruleRicher = load<RuleRicher[]>('gate_rules_richer.json');

const descBy = new Map(codeDesc.map((d) => [d.id, d]));
const formBy = new Map(codeForm.map((d) => [d.id, d]));
const richBy = new Map(ruleRicher.map((r) => [r.id, r]));

interface CodeItem { id: string; name: string; trueGuideline: string; texts: Record<CodeF, string> }
const code: CodeItem[] = codeRaw.map((c) => {
  const d = descBy.get(c.id); const f = formBy.get(c.id);
  if (!d || !f) throw new Error(`missing desc/formulas for ${c.id}`);
  return { id: c.id, name: d.functionName, trueGuideline: c.trueGuideline, texts: { plain: d.description, facets: f.facets, concepts: f.concepts, rawcode: c.code } };
});
const ruleTextOf = (r: Rule, rf: RuleF): string => (rf === 'oneliner' ? r.text : (richBy.get(r.id)?.richer ?? r.text));

// --- frozen tokenizer (doc 12 §3) ---
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

// --- POST-HOC ROBUSTNESS (doc 12 RESULTS): textbook Okapi BM25 lexical channel.
// Added AFTER the pre-registered raw-Jaccard `lexical` result, in response to the
// adversary (agent a5f1133): the frozen raw-Jaccard channel has NO IDF, so common/
// stopword tokens count equally and the tie-against rank inflates the true rule's
// lexical rank on prose. BM25 is the canonical real lexical retriever; params are the
// textbook defaults (k1=1.2, b=0.75) — the SAME "canonical, untuned" discipline as
// RRF K=60 / linear a=0.5. Same frozen [a-z0-9]{2,} tokenizer. NOT the pre-registered
// primary; reported to test whether the H1 method-ranking transfers past the toy channel.
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
// Score one document (rule) against a query token-set (code item), Okapi BM25.
function bm25Score(index: Bm25Index, docId: string, queryTerms: Set<string>): number {
  const doc = index.docs.get(docId); if (!doc) return 0;
  let s = 0;
  for (const t of queryTerms) {
    const tf = doc.tf.get(t); if (!tf) continue;
    const idf = index.idf.get(t) ?? 0;
    s += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.len / index.avgdl)));
  }
  return s;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> { return result as unknown as Array<Record<string, unknown>>; }
async function embed(text: string): Promise<number[]> {
  const r = (await ml.embed(text)) as { vector?: number[] };
  const v = r.vector ?? [];
  if (v.length === 0) throw new Error(`empty embedding: ${text.slice(0, 50)}`);
  return v;
}
const vecLit = (v: number[]): string => `[${v.join(',')}]`;
async function clean(cids: string[]): Promise<void> { for (const c of cids) await db.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${c}`); }
async function insert(name: string, corpus: string, desc: string, v: number[]): Promise<string> {
  const r = rowsOf(await db.execute(sql`
    INSERT INTO public.entities (canonical_name, entity_type, corpus_id, description, embedding)
    VALUES (${name}, 'concept', ${corpus}, ${desc}, ${vecLit(v)}::vector) RETURNING id::text AS id`));
  return r[0]!.id as string;
}

// Conservative rank on a per-item score map (rule name -> score): ties AGAINST true rule.
function rankOf(scoreByRule: Map<string, number>, trueRule: string): number | null {
  const t = scoreByRule.get(trueRule);
  if (t === undefined) return null;
  let n = 0;
  for (const s of scoreByRule.values()) if (s >= t) n += 1;
  return n;
}
// Stingy channel rank (count with channel score >= r's) — deterministic RRF input.
function channelRanks(scoreByRule: Map<string, number>): Map<string, number> {
  const vals = [...scoreByRule.values()];
  const out = new Map<string, number>();
  for (const [name, s] of scoreByRule) out.set(name, vals.filter((v) => v >= s).length);
  return out;
}
function minmax(scoreByRule: Map<string, number>): Map<string, number> {
  const vals = [...scoreByRule.values()];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo;
  const out = new Map<string, number>();
  for (const [name, s] of scoreByRule) out.set(name, span === 0 ? 0 : (s - lo) / span);
  return out;
}

interface ItemResult { trueGuideline: string; rank: number | null }
const microRecall = (items: ItemResult[]): Record<number, number> => {
  const r: Record<number, number> = {};
  for (const k of ks) r[k] = items.filter((x) => x.rank !== null && x.rank <= k).length / items.length;
  return r;
};
const macroRecall = (items: ItemResult[]): Record<number, number> => {
  const byG = new Map<string, ItemResult[]>();
  for (const it of items) { if (!byG.has(it.trueGuideline)) byG.set(it.trueGuideline, []); byG.get(it.trueGuideline)!.push(it); }
  const r: Record<number, number> = {};
  for (const k of ks) { const per = [...byG.values()].map((g) => g.filter((x) => x.rank !== null && x.rank <= k).length / g.length); r[k] = per.reduce((a, b) => a + b, 0) / per.length; }
  return r;
};
const flooredRescued = (items: Array<ItemResult & { g: string }>): number => {
  let n = 0;
  for (const g of FLOORED) { const its = items.filter((x) => x.g === g); if (its.length > 0 && its.some((x) => x.rank !== null && x.rank <= 5)) n += 1; }
  return n;
};

// Deterministic bootstrap over the 9 guidelines (fixed LCG seed) for macro@5 CI / paired Δ.
function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function macroAt5FromGroups(groups: Map<string, ItemResult[]>): number {
  const per = [...groups.values()].map((g) => g.filter((x) => x.rank !== null && x.rank <= 5).length / g.length);
  return per.reduce((a, b) => a + b, 0) / per.length;
}
function groupsOf(items: ItemResult[]): Map<string, ItemResult[]> {
  const m = new Map<string, ItemResult[]>();
  for (const it of items) { if (!m.has(it.trueGuideline)) m.set(it.trueGuideline, []); m.get(it.trueGuideline)!.push(it); }
  return m;
}
function bootstrapPairedDelta(a: ItemResult[], b: ItemResult[], iters = 5000, seed = 12345): { mean: number; lo: number; hi: number; pLE0: number } {
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

interface Cell { code: CodeF; rule: RuleF; method: Method; micro: Record<number, number>; macro: Record<number, number>; rescued: number }

async function main(): Promise<void> {
  console.log(`[hybrid] ${code.length} code items, ${rules.length} rules; ${CODE_FORMULAS.length}x${RULE_FORMULAS.length}x${METHODS.length}=${CODE_FORMULAS.length * RULE_FORMULAS.length * METHODS.length} cells`);

  // Pre-tokenize composed texts (name\nformula) — identical text the vector sees.
  const codeTok: Record<CodeF, Map<string, Set<string>>> = {} as never; // by code id
  for (const cf of CODE_FORMULAS) { const m = new Map<string, Set<string>>(); for (const c of code) m.set(c.id, tokens(entityEmbedTextFor(c.name, c.texts[cf], 'name_description'))); codeTok[cf] = m; }
  const ruleTok: Record<RuleF, Map<string, Set<string>>> = {} as never; // by rule id
  for (const rf of RULE_FORMULAS) { const m = new Map<string, Set<string>>(); for (const r of rules) m.set(r.id, tokens(entityEmbedTextFor(r.id, ruleTextOf(r, rf), 'name_description'))); ruleTok[rf] = m; }
  // BM25 index per rule formula (docs = composed rule texts; query = code token set).
  const bm25Index: Record<RuleF, Bm25Index> = {} as never;
  for (const rf of RULE_FORMULAS) { const dt = new Map<string, string>(); for (const r of rules) dt.set(r.id, entityEmbedTextFor(r.id, ruleTextOf(r, rf), 'name_description')); bm25Index[rf] = buildBm25(dt); }

  // Embed each code-formula corpus + each rule-formula corpus ONCE (same as bake-off).
  const codeCorpora: Record<CodeF, { corpus: string; idByEl: Map<string, string> }> = {} as never; // elId -> code.id
  for (const cf of CODE_FORMULAS) {
    const corpus = `hy_code__${cf}`; await clean([corpus]);
    const idByEl = new Map<string, string>();
    for (const c of code) { const elId = await insert(c.name, corpus, c.texts[cf], await embed(entityEmbedTextFor(c.name, c.texts[cf], 'name_description'))); idByEl.set(elId, c.id); }
    codeCorpora[cf] = { corpus, idByEl };
  }
  const ruleCorpora: Record<RuleF, { corpus: string; ruleIdByEl: Map<string, string> }> = {} as never; // elId -> rule.id
  for (const rf of RULE_FORMULAS) {
    const corpus = `hy_std__${rf}`; await clean([corpus]);
    const ruleIdByEl = new Map<string, string>();
    for (const r of rules) { const elId = await insert(r.id, corpus, ruleTextOf(r, rf), await embed(entityEmbedTextFor(r.id, ruleTextOf(r, rf), 'name_description'))); ruleIdByEl.set(elId, r.id); }
    ruleCorpora[rf] = { corpus, ruleIdByEl };
  }

  const cells: Cell[] = [];
  // Keep per-item results for the specific contrasts the bootstrap/robustness need.
  const items: Partial<Record<`${CodeF}|${RuleF}|${Method}`, Array<ItemResult & { g: string }>>> = {};
  const rrfKSweep: Array<{ code: CodeF; rule: RuleF; k: number; macro5: number }> = [];
  const bm25Cells: Array<{ code: CodeF; rule: RuleF; method: 'lexical' | 'rrf' | 'linear'; macro5: number; vector: number }> = [];

  for (const cf of CODE_FORMULAS) {
    for (const rf of RULE_FORMULAS) {
      const cc = codeCorpora[cf]; const rc = ruleCorpora[rf];
      // Cosine ranking for every code element over all rules.
      const cands = await recallCrossCorpusCandidates(cc.corpus, rc.corpus, { k: rules.length, threshold: -1, maxCells: 100000 });
      const cosByEl = new Map<string, Map<string, number>>(); // elId -> (ruleName -> cos)
      for (const p of cands) {
        const ruleName = rc.ruleIdByEl.get(p.ruleId)!;
        if (!cosByEl.has(p.elementRef)) cosByEl.set(p.elementRef, new Map());
        cosByEl.get(p.elementRef)!.set(ruleName, p.similarity);
      }

      const perMethod: Record<Method, Array<ItemResult & { g: string }>> = { vector: [], lexical: [], rrf: [], linear: [] };
      const perMethodKprim: Record<number, Array<ItemResult & { g: string }>> = {}; // for K-sweep on rrf
      for (const kk of RRF_KS) perMethodKprim[kk] = [];
      // POST-HOC BM25 robustness (see buildBm25 note): lexical/rrf/linear on a real IDF channel.
      const bm25 = bm25Index[rf];
      const perBm25: Record<'lexical' | 'rrf' | 'linear', Array<ItemResult & { g: string }>> = { lexical: [], rrf: [], linear: [] };

      for (const [elId, codeId] of cc.idByEl) {
        const c = code.find((x) => x.id === codeId)!;
        const cos = cosByEl.get(elId) ?? new Map<string, number>();
        // Lexical scores for this code item vs every rule.
        const lex = new Map<string, number>();
        for (const r of rules) lex.set(r.id, jaccard(codeTok[cf].get(c.id)!, ruleTok[rf].get(r.id)!));
        // vector
        perMethod.vector.push({ trueGuideline: c.trueGuideline, g: c.trueGuideline, rank: rankOf(cos, c.trueGuideline) });
        // lexical
        perMethod.lexical.push({ trueGuideline: c.trueGuideline, g: c.trueGuideline, rank: rankOf(lex, c.trueGuideline) });
        // fusion inputs
        const rankVec = channelRanks(cos); const rankLex = channelRanks(lex);
        const cosN = minmax(cos); const lexN = minmax(lex);
        // rrf @ primary K + K-sweep
        for (const K of RRF_KS) {
          const rrf = new Map<string, number>();
          for (const r of rules) rrf.set(r.id, 1 / (K + (rankVec.get(r.id) ?? rules.length)) + 1 / (K + (rankLex.get(r.id) ?? rules.length)));
          const res = { trueGuideline: c.trueGuideline, g: c.trueGuideline, rank: rankOf(rrf, c.trueGuideline) };
          perMethodKprim[K]!.push(res);
          if (K === RRF_K_PRIMARY) perMethod.rrf.push(res);
        }
        // linear (a=0.5, min-max)
        const lin = new Map<string, number>();
        for (const r of rules) lin.set(r.id, 0.5 * (cosN.get(r.id) ?? 0) + 0.5 * (lexN.get(r.id) ?? 0));
        perMethod.linear.push({ trueGuideline: c.trueGuideline, g: c.trueGuideline, rank: rankOf(lin, c.trueGuideline) });
        // --- BM25 variants (same cosine channel, real IDF lexical channel) ---
        const bm = new Map<string, number>();
        for (const r of rules) bm.set(r.id, bm25Score(bm25, r.id, codeTok[cf].get(c.id)!));
        perBm25.lexical.push({ trueGuideline: c.trueGuideline, g: c.trueGuideline, rank: rankOf(bm, c.trueGuideline) });
        const rankBm = channelRanks(bm); const bmN = minmax(bm);
        const rrfBm = new Map<string, number>();
        for (const r of rules) rrfBm.set(r.id, 1 / (RRF_K_PRIMARY + (rankVec.get(r.id) ?? rules.length)) + 1 / (RRF_K_PRIMARY + (rankBm.get(r.id) ?? rules.length)));
        perBm25.rrf.push({ trueGuideline: c.trueGuideline, g: c.trueGuideline, rank: rankOf(rrfBm, c.trueGuideline) });
        const linBm = new Map<string, number>();
        for (const r of rules) linBm.set(r.id, 0.5 * (cosN.get(r.id) ?? 0) + 0.5 * (bmN.get(r.id) ?? 0));
        perBm25.linear.push({ trueGuideline: c.trueGuideline, g: c.trueGuideline, rank: rankOf(linBm, c.trueGuideline) });
      }

      for (const m of METHODS) {
        items[`${cf}|${rf}|${m}`] = perMethod[m];
        cells.push({ code: cf, rule: rf, method: m, micro: microRecall(perMethod[m]), macro: macroRecall(perMethod[m]), rescued: flooredRescued(perMethod[m]) });
      }
      for (const K of RRF_KS) rrfKSweep.push({ code: cf, rule: rf, k: K, macro5: macroRecall(perMethodKprim[K]!)[5] ?? 0 });
      for (const m of ['lexical', 'rrf', 'linear'] as const) bm25Cells.push({ code: cf, rule: rf, method: m, macro5: macroRecall(perBm25[m])[5] ?? 0, vector: macroRecall(perMethod.vector)[5] ?? 0 });
    }
  }

  // ---- report ----
  const get = (cf: CodeF, rf: RuleF, m: Method): Cell => cells.find((c) => c.code === cf && c.rule === rf && c.method === m)!;
  console.log(`\nMACRO recall@5 grid (primary metric):`);
  console.log(`code       | rule     | vector | lexical |  rrf   | linear`);
  console.log('-----------+----------+--------+---------+--------+-------');
  for (const cf of CODE_FORMULAS) for (const rf of RULE_FORMULAS) {
    console.log(`${cf.padEnd(10)} | ${rf.padEnd(8)} | ${METHODS.map((m) => (get(cf, rf, m).macro[5] ?? 0).toFixed(3)).join('  | ')}`);
  }

  console.log(`\nMICRO recall@5 grid (context):`);
  console.log(`code       | rule     | vector | lexical |  rrf   | linear`);
  console.log('-----------+----------+--------+---------+--------+-------');
  for (const cf of CODE_FORMULAS) for (const rf of RULE_FORMULAS) {
    console.log(`${cf.padEnd(10)} | ${rf.padEnd(8)} | ${METHODS.map((m) => (get(cf, rf, m).micro[5] ?? 0).toFixed(3)).join('  | ')}`);
  }

  // H1: fusion vs its best channel, per combo (macro@5).
  console.log(`\nH1 — rrf vs max(vector,lexical) macro@5 (per combo; +ve = fusion >= best channel):`);
  const h1: Array<{ combo: string; rrf: number; best: number; delta: number; ok: boolean }> = [];
  for (const cf of CODE_FORMULAS) for (const rf of RULE_FORMULAS) {
    const v = get(cf, rf, 'vector').macro[5] ?? 0, l = get(cf, rf, 'lexical').macro[5] ?? 0, r = get(cf, rf, 'rrf').macro[5] ?? 0;
    const best = Math.max(v, l); const delta = r - best; const ok = delta >= -0.03;
    h1.push({ combo: `${cf}/${rf}`, rrf: r, best, delta, ok });
    console.log(`  ${`${cf}/${rf}`.padEnd(20)} rrf=${r.toFixed(3)} best=${best.toFixed(3)} Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(3)} ${ok ? 'ok' : 'BELOW'}`);
  }
  const h1Supported = h1.filter((x) => x.ok).length > h1.length / 2;
  // H1-strong on prose combos.
  const h1StrongRows = (['oneliner', 'richer'] as RuleF[]).map((rf) => { const r = get('plain', rf, 'rrf').macro[5] ?? 0; const v = get('plain', rf, 'vector').macro[5] ?? 0; return { rf, rrf: r, vector: v, delta: r - v, strong: r - v >= 0.03 }; });

  // H2: rrf(plain,*) vs vector(concepts,*).
  console.log(`\nH2 — rrf(plain,r) vs vector(concepts,r) macro@5 (can honest prose+hybrid reach the keyword ceiling?):`);
  const h2Rows = (['oneliner', 'richer'] as RuleF[]).map((rf) => {
    const prose = get('plain', rf, 'rrf').macro[5] ?? 0; const ceil = get('concepts', rf, 'vector').macro[5] ?? 0;
    const ok = prose >= ceil - 0.05;
    console.log(`  rule=${rf.padEnd(9)} rrf(plain)=${prose.toFixed(3)}  vector(concepts)=${ceil.toFixed(3)}  Δ=${(prose - ceil >= 0 ? '+' : '')}${(prose - ceil).toFixed(3)}  ${ok ? 'REACHES' : 'below'}`);
    return { rf, prose, ceil, delta: prose - ceil, ok };
  });
  const h2Supported = h2Rows.some((x) => x.ok);

  // Bootstrap the two key contrasts.
  const bsH1 = bootstrapPairedDelta(items['plain|oneliner|rrf']!, items['plain|oneliner|vector']!);
  const bsH2 = bootstrapPairedDelta(items['plain|oneliner|rrf']!, items['concepts|oneliner|vector']!);
  console.log(`\nBootstrap (macro@5, n=9 guidelines, 5000 iters):`);
  console.log(`  H1  rrf(plain,one) − vector(plain,one)   mean=${bsH1.mean.toFixed(3)}  95% CI [${bsH1.lo.toFixed(3)}, ${bsH1.hi.toFixed(3)}]  P(Δ<=0)=${bsH1.pLE0.toFixed(2)}`);
  console.log(`  H2  rrf(plain,one) − vector(concepts,one) mean=${bsH2.mean.toFixed(3)}  95% CI [${bsH2.lo.toFixed(3)}, ${bsH2.hi.toFixed(3)}]  P(Δ<=0)=${bsH2.pLE0.toFixed(2)}`);

  // RRF K-sensitivity for prose combos.
  console.log(`\nRRF K-sensitivity (macro@5; K=60 = frozen headline):`);
  for (const cf of ['plain', 'concepts'] as CodeF[]) for (const rf of RULE_FORMULAS) {
    const row = RRF_KS.map((K) => `K${K}=${(rrfKSweep.find((x) => x.code === cf && x.rule === rf && x.k === K)!.macro5).toFixed(3)}`).join('  ');
    console.log(`  ${`${cf}/${rf}`.padEnd(20)} ${row}`);
  }

  // Cross-check lexical vs doc-11 adversary anchors.
  console.log(`\nLexical cross-check vs doc-11 adversary (expect ~0.085 / ~0.611 / ~0.778):`);
  console.log(`  plain/oneliner    lexical macro@5 = ${(get('plain', 'oneliner', 'lexical').macro[5] ?? 0).toFixed(3)}`);
  console.log(`  concepts/oneliner lexical macro@5 = ${(get('concepts', 'oneliner', 'lexical').macro[5] ?? 0).toFixed(3)}`);
  console.log(`  concepts/richer   lexical macro@5 = ${(get('concepts', 'richer', 'lexical').macro[5] ?? 0).toFixed(3)}`);

  console.log(`\nVERDICTS: H1(majority fusion>=best)=${h1Supported ? 'SUPPORTED' : 'NOT'}  H1-strong(prose)=${JSON.stringify(h1StrongRows.map((r) => ({ rf: r.rf, strong: r.strong })))}  H2(prose+hybrid reaches keyword ceiling)=${h2Supported ? 'SUPPORTED' : 'NOT'}`);

  // ---- POST-HOC BM25 robustness (adversary a5f1133): does H1's method-ranking transfer? ----
  const bmGet = (cf: CodeF, rf: RuleF, m: 'lexical' | 'rrf' | 'linear'): { macro5: number; vector: number } => bm25Cells.find((x) => x.code === cf && x.rule === rf && x.method === m)!;
  let bmH1ok = 0;
  const bmH1rows: Array<{ combo: string; vector: number; bm25lex: number; bm25rrf: number; ok: boolean }> = [];
  console.log(`\nBM25 robustness — rrf(vec+BM25) vs max(vector, BM25-lexical) macro@5 (post-hoc, k1=1.2 b=0.75):`);
  for (const cf of CODE_FORMULAS) for (const rf of RULE_FORMULAS) {
    const v = bmGet(cf, rf, 'rrf').vector; const l = bmGet(cf, rf, 'lexical').macro5; const r = bmGet(cf, rf, 'rrf').macro5;
    const ok = r >= Math.max(v, l) - 0.03; if (ok) bmH1ok += 1;
    bmH1rows.push({ combo: `${cf}/${rf}`, vector: v, bm25lex: l, bm25rrf: r, ok });
    console.log(`  ${`${cf}/${rf}`.padEnd(20)} vec=${v.toFixed(3)} bm25lex=${l.toFixed(3)} bm25rrf=${r.toFixed(3)}  ${ok ? 'ok' : 'BELOW'}`);
  }
  console.log(`  H1 under BM25: ${bmH1ok}/8 cells fusion>=best-0.03 (raw-Jaccard was ${h1.filter((x) => x.ok).length}/8)`);
  console.log(`  plain/oneliner  bm25rrf=${bmGet('plain', 'oneliner', 'rrf').macro5.toFixed(3)} vs vec ${bmGet('plain', 'oneliner', 'rrf').vector.toFixed(3)} (H1-strong prose still ${bmGet('plain', 'oneliner', 'rrf').macro5 >= bmGet('plain', 'oneliner', 'rrf').vector + 0.03 ? 'help' : 'no-help'})`);
  console.log(`  concepts/richer bm25lex=${bmGet('concepts', 'richer', 'lexical').macro5.toFixed(3)} bm25rrf=${bmGet('concepts', 'richer', 'rrf').macro5.toFixed(3)} vs vec ${bmGet('concepts', 'richer', 'rrf').vector.toFixed(3)}`);

  await clean([...CODE_FORMULAS.map((c) => `hy_code__${c}`), ...RULE_FORMULAS.map((r) => `hy_std__${r}`)]);
  const out = {
    n: code.length, rules: rules.length, ks, methods: METHODS, rrfKPrimary: RRF_K_PRIMARY,
    grid: cells, h1: { rows: h1, supported: h1Supported, strongProse: h1StrongRows },
    h2: { rows: h2Rows, supported: h2Supported },
    bootstrap: { h1_rrf_vs_vector_plain: bsH1, h2_rrf_plain_vs_vector_concepts: bsH2 },
    rrfKSweep,
    lexicalCrosscheck: { plain_oneliner: get('plain', 'oneliner', 'lexical').macro[5], concepts_oneliner: get('concepts', 'oneliner', 'lexical').macro[5], concepts_richer: get('concepts', 'richer', 'lexical').macro[5] },
    bm25Robustness: { params: { k1: BM25_K1, b: BM25_B }, cells: bm25Cells, h1OkCells: bmH1ok, h1Rows: bmH1rows },
  };
  writeFileSync(join(ART, 'hybrid_results.json'), JSON.stringify(out, null, 2));
  console.log(`\nwrote ${join(ART, 'hybrid_results.json')}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
