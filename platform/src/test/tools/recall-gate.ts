/**
 * EMBED_DESCRIPTIONS recall-lift gate harness (bead nmemo-uhp.12.4).
 * Pre-registered protocol: docs/architecture/cross-corpus-audit/10-recall-lift-gate-prereg.md.
 *
 * NOT a vitest test (no `.test.ts`), so the normal suite never runs it. Run manually:
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     npx tsx src/test/tools/recall-gate.ts
 * Requires Ollama (nomic-embed-text) via ML services :8000 for real 768-dim vectors.
 *
 * Faithfulness: uses the PRODUCTION helpers verbatim — entityEmbedTextFor (the exact
 * text the flag selects), ml.embed (the backend generateEmbedding wraps), and
 * recallCrossCorpusCandidates (the exact audit-pass recall query). The only deviation
 * from a config toggle is driving `mode` directly through entityEmbedTextFor, which is
 * exactly what entityEmbedModeFromFlag(config.EMBED_DESCRIPTIONS) returns — equivalent,
 * and lets both settings run in one deterministic process.
 *
 * Refinement vs the pre-reg {k:8, threshold:0}: recall is computed from the FULL
 * per-source ranking (k = all rules, threshold = -1 = pure ranking) so recall@8 is
 * exact and no source's candidate list is truncated. threshold:0 could truncate lists
 * where cosine clusters near zero (opaque names) — which would DEFLATE off-recall and
 * BIAS TOWARD the hypothesis. Pure ranking is the conservative choice. The as-registered
 * {k:8, threshold:0} numbers are also reported for transparency.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ml } from '../../services/ml-client.js';
import { entityEmbedTextFor, type EntityEmbedMode } from '../../services/embed-text.js';
import { recallCrossCorpusCandidates } from '../../services/audit-pass.js';

interface Rule { id: string; text: string }
interface CodeRaw { id: string; trueGuideline: string; file?: string; line?: number }
interface CodeDesc { id: string; functionName: string; description: string }
interface CodeItem { id: string; trueGuideline: string; name: string; description: string }
interface ItemResult { id: string; name: string; trueGuideline: string; rank: number | null; top: string[] }

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '../../../../docs/architecture/cross-corpus-audit/recall-gate-artifacts');

const rules: Rule[] = JSON.parse(readFileSync(join(ART, 'gate_rules.json'), 'utf8'));
const codeRaw: CodeRaw[] = JSON.parse(readFileSync(join(ART, 'gate_code_raw.json'), 'utf8'));
const codeDesc: CodeDesc[] = JSON.parse(readFileSync(join(ART, 'gate_code_desc.json'), 'utf8'));
const descById = new Map<string, CodeDesc>(codeDesc.map((d) => [d.id, d]));
const code: CodeItem[] = codeRaw.map((c) => {
  const d = descById.get(c.id);
  if (!d) throw new Error(`no description for ${c.id}`);
  return { id: c.id, trueGuideline: c.trueGuideline, name: d.functionName, description: d.description };
});

function rows(result: unknown): Array<Record<string, unknown>> {
  return result as unknown as Array<Record<string, unknown>>;
}
async function embed(text: string): Promise<number[]> {
  const r = (await ml.embed(text)) as { vector?: number[] };
  const v = r.vector ?? [];
  if (v.length === 0) throw new Error(`empty embedding for: ${text.slice(0, 50)}`);
  return v;
}
const vecLit = (v: number[]): string => `[${v.join(',')}]`;

async function cleanCorpora(cids: string[]): Promise<void> {
  for (const c of cids) await db.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${c}`);
}

async function insertEntity(name: string, corpus: string, description: string, v: number[]): Promise<string> {
  const r = rows(
    await db.execute(sql`
      INSERT INTO public.entities (canonical_name, entity_type, corpus_id, description, embedding)
      VALUES (${name}, 'concept', ${corpus}, ${description}, ${vecLit(v)}::vector)
      RETURNING id::text AS id
    `),
  );
  return r[0]!.id as string;
}

// Embed one corpus side under a given mode; returns id→name/meta maps.
async function embedRules(mode: EntityEmbedMode): Promise<Map<string, string>> {
  const corpus = `gate_std__${mode}`;
  await cleanCorpora([corpus]);
  const ruleNameById = new Map<string, string>();
  for (const r of rules) {
    const id = await insertEntity(r.id, corpus, r.text, await embed(entityEmbedTextFor(r.id, r.text, mode)));
    ruleNameById.set(id, r.id);
  }
  return ruleNameById;
}
async function embedCode(mode: EntityEmbedMode): Promise<Map<string, CodeItem>> {
  const corpus = `gate_code__${mode}`;
  await cleanCorpora([corpus]);
  const metaById = new Map<string, CodeItem>();
  for (const c of code) {
    const id = await insertEntity(c.name, corpus, c.description, await embed(entityEmbedTextFor(c.name, c.description, mode)));
    metaById.set(id, c);
  }
  return metaById;
}

// Score one element CONSERVATIVELY + DETERMINISTICALLY: the true rule's rank =
// count of candidates with similarity >= the true rule's similarity. Ties therefore
// count AGAINST the true rule (worst-case rank), which (a) removes DB row-order
// nondeterminism for near-tied cosines and (b) is the anti-hypothesis (stingy) choice.
function scoreItem(
  meta: CodeItem,
  entries: Array<{ ruleId: string; similarity: number }>,
  ruleNameById: Map<string, string>,
): ItemResult {
  const withName = entries.map((e) => ({ name: ruleNameById.get(e.ruleId)!, sim: e.similarity }));
  const trueEntry = withName.find((e) => e.name === meta.trueGuideline);
  const rank = trueEntry == null ? null : withName.filter((e) => e.sim >= trueEntry.sim).length;
  const top = withName
    .slice()
    .sort((a, b) => (b.sim - a.sim) || a.name.localeCompare(b.name)) // deterministic display order
    .slice(0, 5)
    .map((e) => e.name);
  return { id: meta.id, name: meta.name, trueGuideline: meta.trueGuideline, rank, top };
}

async function candidatesByElement(
  codeMode: EntityEmbedMode,
  ruleMode: EntityEmbedMode,
  k: number,
  threshold: number,
): Promise<Map<string, Array<{ ruleId: string; similarity: number }>>> {
  const cands = await recallCrossCorpusCandidates(`gate_code__${codeMode}`, `gate_std__${ruleMode}`, { k, threshold, maxCells: 100000 });
  const byEl = new Map<string, Array<{ ruleId: string; similarity: number }>>();
  for (const p of cands) {
    if (!byEl.has(p.elementRef)) byEl.set(p.elementRef, []);
    byEl.get(p.elementRef)!.push({ ruleId: p.ruleId, similarity: p.similarity });
  }
  return byEl;
}

// Full per-source ranking: k = every rule, threshold = -1 (cos_sim >= -1 ⇒ all ranked).
async function scoreCondition(codeMode: EntityEmbedMode, ruleMode: EntityEmbedMode, metaById: Map<string, CodeItem>, ruleNameById: Map<string, string>): Promise<ItemResult[]> {
  const byEl = await candidatesByElement(codeMode, ruleMode, rules.length, -1);
  return [...metaById.entries()].map(([elId, meta]) => scoreItem(meta, byEl.get(elId) ?? [], ruleNameById));
}

// As-pre-registered variant: {k:8, threshold:0}. Truncated top-8, cos_sim>=0 floor.
async function scoreAsRegistered(codeMode: EntityEmbedMode, ruleMode: EntityEmbedMode, metaById: Map<string, CodeItem>, ruleNameById: Map<string, string>): Promise<ItemResult[]> {
  const byEl = await candidatesByElement(codeMode, ruleMode, 8, 0);
  return [...metaById.entries()].map(([elId, meta]) => scoreItem(meta, byEl.get(elId) ?? [], ruleNameById));
}

const ks = [1, 3, 5, 8];
// Micro recall@k: per-item (n=29).
function microRecall(items: ItemResult[]): Record<number, number> {
  const r: Record<number, number> = {};
  for (const k of ks) r[k] = items.filter((x) => x.rank !== null && x.rank <= k).length / items.length;
  return r;
}
// Macro recall@k: mean over the distinct guidelines (each guideline weighted equally,
// so a 6x near-duplicate cluster counts once) — the adversary's robustness view.
function macroRecall(items: ItemResult[]): Record<number, number> {
  const byG = new Map<string, ItemResult[]>();
  for (const it of items) { if (!byG.has(it.trueGuideline)) byG.set(it.trueGuideline, []); byG.get(it.trueGuideline)!.push(it); }
  const r: Record<number, number> = {};
  for (const k of ks) {
    const per = [...byG.values()].map((g) => g.filter((x) => x.rank !== null && x.rank <= k).length / g.length);
    r[k] = per.reduce((a, b) => a + b, 0) / per.length;
  }
  return r;
}
// Per-guideline hit@5 counts (the adversary's "4 improve / 1 regress / 4 floored" view).
function perGuidelineAt5(items: ItemResult[]): Record<string, { n: number; hits5: number }> {
  const byG = new Map<string, ItemResult[]>();
  for (const it of items) { if (!byG.has(it.trueGuideline)) byG.set(it.trueGuideline, []); byG.get(it.trueGuideline)!.push(it); }
  const out: Record<string, { n: number; hits5: number }> = {};
  for (const [g, arr] of byG) out[g] = { n: arr.length, hits5: arr.filter((x) => x.rank !== null && x.rank <= 5).length };
  return out;
}
const deltaOf = (a: Record<number, number>, b: Record<number, number>): Record<number, number> => {
  const d: Record<number, number> = {}; for (const k of ks) d[k] = (a[k] ?? 0) - (b[k] ?? 0); return d;
};
const fmtRow = (label: string, r: Record<number, number>): string =>
  `${label.padEnd(22)} | ${ks.map((k) => (r[k] ?? 0).toFixed(3)).join('  | ')}`;
const monotone = (hi: Record<number, number>, lo: Record<number, number>): boolean =>
  ks.every((k) => (hi[k] ?? 0) >= (lo[k] ?? 0));

async function main(): Promise<void> {
  console.log(`[recall-gate] n=${code.length} code items, ${rules.length} rules; ${new Set(code.map((c) => c.trueGuideline)).size} distinct guidelines`);

  // Embed all four corpus sides once, then score every (codeMode × ruleMode) condition.
  const ruleName = await embedRules('name');
  const ruleDesc = await embedRules('name_description');
  const codeName = await embedCode('name');
  const codeDescM = await embedCode('name_description');

  // Global flag conditions (the primary gate): off = (name,name), on = (nd,nd).
  const off = await scoreCondition('name', 'name', codeName, ruleName);
  const on = await scoreCondition('name_description', 'name_description', codeDescM, ruleDesc);
  // Decomposition: isolate each side by holding the other fixed.
  const codeOnly = await scoreCondition('name_description', 'name', codeDescM, ruleName); // vs off ⇒ pure code-side
  const ruleOnly = await scoreCondition('name', 'name_description', codeName, ruleDesc);  // vs off ⇒ pure rule-side
  // As-pre-registered {k:8, threshold:0} for the primary conditions.
  const offReg = await scoreAsRegistered('name', 'name', codeName, ruleName);
  const onReg = await scoreAsRegistered('name_description', 'name_description', codeDescM, ruleDesc);

  const microOff = microRecall(off), microOn = microRecall(on);
  const macroOff = macroRecall(off), macroOn = macroRecall(on);
  const microDelta = deltaOf(microOn, microOff);
  const pass = (microDelta[5] ?? 0) >= 0.15 && monotone(microOn, microOff);

  const report: Record<string, unknown> = {
    n: code.length, rules: rules.length, distinctGuidelines: new Set(code.map((c) => c.trueGuideline)).size, ks,
    bar: 'recall@5(on)-recall@5(off) >= 0.15 AND on>=off for all k in {1,3,5,8} (primary = MICRO, global flag)',
    primary_micro: { off: microOff, on: microOn, delta: microDelta, pass },
    primary_macro: { off: macroOff, on: macroOn, delta: deltaOf(macroOn, macroOff) },
    as_registered_k8_thr0_micro: { off: microRecall(offReg), on: microRecall(onReg) },
    decomposition_micro: {
      off_neither: microOff,
      code_side_only: microRecall(codeOnly), // code=nd, rule=name
      rule_side_only: microRecall(ruleOnly), // code=name, rule=nd
      on_both: microOn,
      pure_code_side_delta_vs_off: deltaOf(microRecall(codeOnly), microOff),
      pure_rule_side_delta_vs_off: deltaOf(microRecall(ruleOnly), microOff),
      code_side_given_rule_text_delta: deltaOf(microOn, microRecall(ruleOnly)), // on_both - rule_only
    },
    // Macro (per-guideline) decomposition — the CONSISTENT lens. Micro decomposition
    // headlines (e.g. code-given-rule +0.517) are near-duplicate-inflated; the honest
    // per-guideline marginals are here (adversary a386599: code-side ~+0.20, the SMALLER
    // of the two; rule-side is the primary driver; "neither alone" is false under macro).
    decomposition_macro: {
      off_neither: macroOff,
      code_side_only: macroRecall(codeOnly),
      rule_side_only: macroRecall(ruleOnly),
      on_both: macroOn,
      pure_code_side_delta_vs_off: deltaOf(macroRecall(codeOnly), macroOff),
      pure_rule_side_delta_vs_off: deltaOf(macroRecall(ruleOnly), macroOff),
      code_side_given_rule_text_delta: deltaOf(macroOn, macroRecall(ruleOnly)),
      rule_side_given_code_text_delta: deltaOf(macroOn, macroRecall(codeOnly)),
    },
    per_guideline_at5: { off: perGuidelineAt5(off), on: perGuidelineAt5(on) },
    perItem: { off, on, codeOnly, ruleOnly },
  };

  console.log(`\nMICRO recall@k (per-item, n=${code.length}) — PRIMARY GATE`);
  console.log(`k                      | ${ks.join('      | ')}`);
  console.log(fmtRow('off (name,name)', microOff));
  console.log(fmtRow('on  (nd,nd)', microOn));
  console.log(fmtRow('delta', microDelta));
  console.log(`\nMACRO recall@k (per-guideline mean, ${report.distinctGuidelines} guidelines) — robustness`);
  console.log(fmtRow('off', macroOff));
  console.log(fmtRow('on', macroOn));
  console.log(fmtRow('delta', deltaOf(macroOn, macroOff)));
  console.log(`\nDECOMPOSITION micro recall@k (which side's descriptions help?)`);
  console.log(fmtRow('neither (name,name)', microOff));
  console.log(fmtRow('code-only (nd,name)', microRecall(codeOnly)));
  console.log(fmtRow('rule-only (name,nd)', microRecall(ruleOnly)));
  console.log(fmtRow('both (nd,nd)', microOn));
  console.log(fmtRow('pure code-side Δ', deltaOf(microRecall(codeOnly), microOff)));
  console.log(fmtRow('pure rule-side Δ', deltaOf(microRecall(ruleOnly), microOff)));
  console.log(fmtRow('code-side | rule-text Δ', deltaOf(microOn, microRecall(ruleOnly))));
  console.log(`\nGATE (primary, micro, global flag): ${pass ? 'PASS' : 'FAIL'}  (Δ@5=${(microDelta[5] ?? 0).toFixed(3)}, need>=0.15, monotone=${monotone(microOn, microOff)})`);

  await cleanCorpora(['gate_std__name', 'gate_std__name_description', 'gate_code__name', 'gate_code__name_description']);
  writeFileSync(join(ART, 'gate_results.json'), JSON.stringify(report, null, 2));
  console.log(`\nwrote ${join(ART, 'gate_results.json')}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
