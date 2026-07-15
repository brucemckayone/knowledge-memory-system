/**
 * Description-formula bake-off (bead nmemo-uhp.15). Pre-registered: doc 11.
 *
 * Reuses doc-10's rig (entityEmbedTextFor + ml.embed + recallCrossCorpusCandidates,
 * deterministic conservative rank) but varies the DESCRIPTION FORMULA instead of the
 * on/off flag. 4 code formulas x 2 rule formulas = 8 combos; primary metric = MACRO
 * recall@5 (the honest lens). Composition held fixed at name\n<formula-text>.
 *
 * NOT a vitest test. Run:
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     npx tsx src/test/tools/recall-bakeoff.ts
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
interface ItemResult { id: string; trueGuideline: string; rank: number | null }

const CODE_FORMULAS = ['plain', 'facets', 'concepts', 'rawcode'] as const;
const RULE_FORMULAS = ['oneliner', 'richer'] as const;
type CodeF = (typeof CODE_FORMULAS)[number];
type RuleF = (typeof RULE_FORMULAS)[number];
const FLOORED = ['F.16', 'C.48', 'ES.20', 'ES.75']; // never recalled@5 under plain (doc 10)
const ks = [1, 3, 5, 8];

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
const ruleText = (r: Rule, rf: RuleF): string => (rf === 'oneliner' ? r.text : (richBy.get(r.id)?.richer ?? r.text));

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

// Conservative deterministic rank: ties count AGAINST the true rule.
function scoreItem(meta: CodeItem, entries: Array<{ ruleId: string; similarity: number }>, ruleNameById: Map<string, string>): ItemResult {
  const withName = entries.map((e) => ({ name: ruleNameById.get(e.ruleId)!, sim: e.similarity }));
  const t = withName.find((e) => e.name === meta.trueGuideline);
  const rank = t == null ? null : withName.filter((e) => e.sim >= t.sim).length;
  return { id: meta.id, trueGuideline: meta.trueGuideline, rank };
}
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
// Of the FLOORED guidelines, how many now have >=1 item recalled@5.
const flooredRescued = (items: ItemResult[]): number => {
  let n = 0;
  for (const g of FLOORED) { const its = items.filter((x) => x.trueGuideline === g); if (its.length > 0 && its.some((x) => x.rank !== null && x.rank <= 5)) n += 1; }
  return n;
};

async function main(): Promise<void> {
  console.log(`[bakeoff] ${code.length} code items, ${rules.length} rules; formulas ${CODE_FORMULAS.length}x${RULE_FORMULAS.length}=8 combos`);

  // Embed each code formula corpus + each rule formula corpus ONCE.
  const codeCorpora: Record<CodeF, { corpus: string; metaById: Map<string, CodeItem> }> = {} as never;
  for (const cf of CODE_FORMULAS) {
    const corpus = `bo_code__${cf}`; await clean([corpus]);
    const metaById = new Map<string, CodeItem>();
    for (const c of code) { const id = await insert(c.name, corpus, c.texts[cf], await embed(entityEmbedTextFor(c.name, c.texts[cf], 'name_description'))); metaById.set(id, c); }
    codeCorpora[cf] = { corpus, metaById };
  }
  const ruleCorpora: Record<RuleF, { corpus: string; nameById: Map<string, string> }> = {} as never;
  for (const rf of RULE_FORMULAS) {
    const corpus = `bo_std__${rf}`; await clean([corpus]);
    const nameById = new Map<string, string>();
    for (const r of rules) { const id = await insert(r.id, corpus, ruleText(r, rf), await embed(entityEmbedTextFor(r.id, ruleText(r, rf), 'name_description'))); nameById.set(id, r.id); }
    ruleCorpora[rf] = { corpus, nameById };
  }

  const grid: Array<{ code: CodeF; rule: RuleF; micro: Record<number, number>; macro: Record<number, number>; rescued: number }> = [];
  for (const cf of CODE_FORMULAS) {
    for (const rf of RULE_FORMULAS) {
      const cc = codeCorpora[cf]; const rc = ruleCorpora[rf];
      const cands = await recallCrossCorpusCandidates(cc.corpus, rc.corpus, { k: rules.length, threshold: -1, maxCells: 100000 });
      const byEl = new Map<string, Array<{ ruleId: string; similarity: number }>>();
      for (const p of cands) { if (!byEl.has(p.elementRef)) byEl.set(p.elementRef, []); byEl.get(p.elementRef)!.push({ ruleId: p.ruleId, similarity: p.similarity }); }
      const items = [...cc.metaById.entries()].map(([elId, meta]) => scoreItem(meta, byEl.get(elId) ?? [], rc.nameById));
      grid.push({ code: cf, rule: rf, micro: microRecall(items), macro: macroRecall(items), rescued: flooredRescued(items) });
    }
  }

  // Winner = highest MACRO recall@5 (doc 11 §5).
  const winner = grid.slice().sort((a, b) => (b.macro[5] ?? 0) - (a.macro[5] ?? 0))[0]!;

  console.log(`\ncode formula | rule formula | macro@5 | micro@5 | macro@1  @3  @8 | floored-rescued/4`);
  console.log('-------------+--------------+---------+---------+-----------------+------------------');
  for (const g of grid.slice().sort((a, b) => (b.macro[5] ?? 0) - (a.macro[5] ?? 0))) {
    console.log(`${g.code.padEnd(12)} | ${g.rule.padEnd(12)} |  ${(g.macro[5] ?? 0).toFixed(3)}  |  ${(g.micro[5] ?? 0).toFixed(3)}  |  ${(g.macro[1] ?? 0).toFixed(3)} ${(g.macro[3] ?? 0).toFixed(3)} ${(g.macro[8] ?? 0).toFixed(3)} |        ${g.rescued}`);
  }
  console.log(`\nWINNER (macro@5): code=${winner.code} rule=${winner.rule}  macro@5=${(winner.macro[5] ?? 0).toFixed(3)}  micro@5=${(winner.micro[5] ?? 0).toFixed(3)}  floored-rescued=${winner.rescued}/4`);
  const baseline = grid.find((g) => g.code === 'plain' && g.rule === 'oneliner')!;
  console.log(`BASELINE (plain,oneliner): macro@5=${(baseline.macro[5] ?? 0).toFixed(3)}  → winner lifts macro@5 by ${((winner.macro[5] ?? 0) - (baseline.macro[5] ?? 0)).toFixed(3)}`);

  await clean([...CODE_FORMULAS.map((c) => `bo_code__${c}`), ...RULE_FORMULAS.map((r) => `bo_std__${r}`)]);
  writeFileSync(join(ART, 'bakeoff_results.json'), JSON.stringify({ n: code.length, rules: rules.length, ks, grid, winner, baseline }, null, 2));
  console.log(`\nwrote ${join(ART, 'bakeoff_results.json')}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
