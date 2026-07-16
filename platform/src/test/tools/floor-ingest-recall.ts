/**
 * nmemo-uhp.19 doc-15 — INGEST + FREEZE + LEG 1 (deterministic prefilter recall).
 *
 * Reads the frozen floor corpus (floor-corpus.json), ingests all 50 code elements +
 * 10 rules through the PRODUCTION blind-authoring path (ingestCodeElement /
 * ingestRuleElement, Haiku), FREEZES the authored descriptions to floor-authored.json
 * (doc-14 freeze discipline: the embedded text is reproducible + adversary-auditable),
 * and leaves the entities in the DB for leg 2 (floor-adjudicate.ts).
 *
 * Then measures the DETERMINISTIC prefilter leg only (no adjudicator, cheap):
 *   - embedding recall@k (k in {1,3,5,8}), MICRO (per-element) + MACRO (per-rule mean)
 *   - per-rule recall on multi-rule snippets (did top-k include ALL true rules — OQ3
 *     collapse at the recall stage, distinct from adjudication collapse)
 *   - lexical baselines (token-Jaccard + BM25) with the embedding removed (doc-15 §5)
 *   - control over-seed (top sim + #rules >= 0.5) — what the prefilter hands stage 2
 *   - the full miss list, for OQ1 implicit-behaviour classification
 * Writes floor-recall-results.json for the adversary.
 *
 * --replay: skip Haiku authoring; re-upsert from floor-authored.json (deterministic
 * embeddings) — use if cognitive_test was truncated between legs.
 *
 * Run (ML services on :8000 for embeddings [+Haiku unless --replay]):
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test \
 *     ML_SERVICES_URL=http://127.0.0.1:8000 npx tsx src/test/tools/floor-ingest-recall.ts [--replay]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  ingestCodeElement,
  ingestRuleElement,
  upsertCorpusElementEntity,
  codeElementKey,
} from '../../services/corpus-ingest.js';
import { recallCrossCorpusCandidates } from '../../services/audit-pass.js';

const CODE_CORPUS = 'floor-code';
const RULE_CORPUS = 'floor-rules';
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '../data/cross-corpus-floor');
const REPLAY = process.argv.includes('--replay');

interface Rule { id: string; text: string }
interface Element {
  id: string;
  kind: 'violation' | 'control-ooc' | 'control-compliant';
  primary_rule: string | null;
  expected_rule_citations: string[];
  snippet: string;
  note: string;
}
interface Corpus { rules: Rule[]; elements: Element[] }

const corpus: Corpus = JSON.parse(readFileSync(join(DATA, 'floor-corpus.json'), 'utf8'));

const short = (id: string) => id.replace('MISRA-CPP-2023-Rule-', 'R');
const ks = [1, 3, 5, 8];

// ---- tiny deterministic lexical rig (doc-15 §5 baseline) ----
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'are', 'not', 'has', 'have', 'been', 'via', 'its', 'a', 'an', 'of', 'to', 'in', 'on', 'is', 'be', 'or', 'it']);
function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

async function main(): Promise<void> {
  console.log(`=== doc-15 LEG 1 — prefilter recall on the clean floor ${REPLAY ? '(REPLAY)' : ''} ===\n`);

  await db.execute(sql`DELETE FROM public.entities WHERE corpus_id IN (${CODE_CORPUS}, ${RULE_CORPUS})`);

  const frozen: { rules: Record<string, string>; code: Record<string, string> } =
    REPLAY ? JSON.parse(readFileSync(join(DATA, 'floor-authored.json'), 'utf8')) : { rules: {}, code: {} };

  // --- Rules ---
  const ridByEntity = new Map<string, string>();
  const ruleDescById = new Map<string, string>();
  for (const r of corpus.rules) {
    let entityId: string, description: string;
    if (REPLAY) {
      description = frozen.rules[r.id]!;
      const res = await upsertCorpusElementEntity({ corpusId: RULE_CORPUS, name: r.id, type: 'rule', description });
      entityId = res.entityId;
    } else {
      const res = await ingestRuleElement({ corpusId: RULE_CORPUS, ruleId: r.id, ruleText: r.text });
      entityId = res.entityId; description = res.description; frozen.rules[r.id] = description;
    }
    ridByEntity.set(entityId, r.id);
    ruleDescById.set(r.id, description);
  }
  console.log(`ingested ${corpus.rules.length} rules`);

  // --- Elements ---
  const qidByEntity = new Map<string, string>();
  const elemById = new Map<string, Element>();
  const elemDesc = new Map<string, string>();
  const leaks: Array<{ id: string; refs: string[] }> = [];
  for (const e of corpus.elements) {
    let entityId: string, description: string, leaked: string[] = [];
    if (REPLAY) {
      description = frozen.code[e.id]!;
      const res = await upsertCorpusElementEntity({
        corpusId: CODE_CORPUS, name: e.id, type: 'code_element', description, dedupeKey: codeElementKey(e.snippet),
      });
      entityId = res.entityId;
    } else {
      const res = await ingestCodeElement({ corpusId: CODE_CORPUS, name: e.id, code: e.snippet });
      entityId = res.entityId; description = res.description; leaked = res.leakedReferences;
      frozen.code[e.id] = description;
    }
    qidByEntity.set(entityId, e.id);
    elemById.set(e.id, e);
    elemDesc.set(e.id, description);
    if (leaked.length) leaks.push({ id: e.id, refs: leaked });
  }
  console.log(`ingested ${corpus.elements.length} elements`);

  if (!REPLAY) {
    writeFileSync(join(DATA, 'floor-authored.json'), JSON.stringify(frozen, null, 2));
    console.log(`FROZE authored descriptions -> floor-authored.json`);
  }
  console.log(`blindness: ${leaks.length} elements leaked a rule reference` +
    (leaks.length ? ` -> ${leaks.map((l) => `${l.id}:${l.refs.join(',')}`).join('; ')}` : ' (clean)'));

  // --- Embedding recall (full ranking) ---
  const candidates = await recallCrossCorpusCandidates(CODE_CORPUS, RULE_CORPUS, {
    k: corpus.rules.length, threshold: 0, maxCells: 100000,
  });
  const embRankByElem = new Map<string, Array<{ rid: string; sim: number }>>();
  for (const c of candidates) {
    const qid = qidByEntity.get(c.elementRef)!;
    const list = embRankByElem.get(qid) ?? [];
    list.push({ rid: ridByEntity.get(c.ruleId) ?? c.ruleId, sim: c.similarity });
    embRankByElem.set(qid, list);
  }
  for (const list of embRankByElem.values()) list.sort((a, b) => b.sim - a.sim);

  // --- Lexical rankings (Jaccard + BM25) over the same rule set ---
  const ruleTokens = new Map<string, string[]>();
  for (const [rid, desc] of ruleDescById) ruleTokens.set(rid, tokenize(`${rid} ${desc}`));
  // BM25 stats over the 10 rule "docs"
  const N = ruleTokens.size;
  const df = new Map<string, number>();
  for (const toks of ruleTokens.values()) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgdl = [...ruleTokens.values()].reduce((s, t) => s + t.length, 0) / N;
  const idf = (t: string) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  function bm25(queryToks: string[], docToks: string[]): number {
    const k1 = 1.5, b = 0.75, dl = docToks.length;
    const tf = new Map<string, number>();
    for (const t of docToks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of new Set(queryToks)) {
      const f = tf.get(t) ?? 0;
      if (f === 0) continue;
      score += idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgdl));
    }
    return score;
  }
  const lexRank = (elemId: string, scorer: (q: string[], d: string[]) => number) => {
    const q = tokenize(`${elemId} ${elemDesc.get(elemId) ?? ''}`);
    return [...ruleDescById.keys()]
      .map((rid) => ({ rid, s: scorer(q, ruleTokens.get(rid)!) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.rid);
  };

  // --- Metrics ---
  const violations = corpus.elements.filter((e) => e.kind === 'violation');
  const controls = corpus.elements.filter((e) => e.kind !== 'violation');

  function recallAtK(rankFor: (id: string) => string[], anyOrAll: 'any' | 'all') {
    // MICRO (per element) + MACRO (per rule)
    const micro: Record<number, number[]> = { 1: [], 3: [], 5: [], 8: [] };
    // perRule[k][rid] = array of 0/1 for elements citing rid
    const perRule: Record<number, Map<string, number[]>> = { 1: new Map(), 3: new Map(), 5: new Map(), 8: new Map() };
    for (const e of violations) {
      const ranked = rankFor(e.id);
      for (const k of ks) {
        const top = ranked.slice(0, k);
        const cited = e.expected_rule_citations;
        const hit = anyOrAll === 'any'
          ? cited.some((r) => top.includes(r)) ? 1 : 0
          : cited.every((r) => top.includes(r)) ? 1 : 0;
        micro[k]!.push(hit);
        for (const rid of cited) {
          const m = perRule[k]!;
          const arr = m.get(rid) ?? [];
          arr.push(top.includes(rid) ? 1 : 0);
          m.set(rid, arr);
        }
      }
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const microAtK: Record<number, number> = {} as any;
    const macroAtK: Record<number, number> = {} as any;
    for (const k of ks) {
      microAtK[k] = mean(micro[k]!);
      const perRuleRecall = [...perRule[k]!.values()].map(mean);
      macroAtK[k] = mean(perRuleRecall);
    }
    return { microAtK, macroAtK };
  }

  const embAny = recallAtK((id) => embRankByElem.get(id)?.map((x) => x.rid) ?? [], 'any');
  const embAll = recallAtK((id) => embRankByElem.get(id)?.map((x) => x.rid) ?? [], 'all');
  const jac = recallAtK((id) => lexRank(id, (q, d) => jaccard(new Set(q), new Set(d))), 'any');
  const bm = recallAtK((id) => lexRank(id, bm25), 'any');

  console.log(`\n--- EMBEDDING recall@k over ${violations.length} violations (PRIMARY metric = MACRO@3) ---`);
  console.log(`  k:        ${ks.map((k) => `@${k}`.padStart(7)).join('')}`);
  console.log(`  MACRO any:${ks.map((k) => embAny.macroAtK[k]!.toFixed(3).padStart(7)).join('')}`);
  console.log(`  MICRO any:${ks.map((k) => embAny.microAtK[k]!.toFixed(3).padStart(7)).join('')}`);
  console.log(`  MACRO ALL:${ks.map((k) => embAll.macroAtK[k]!.toFixed(3).padStart(7)).join('')}   (all true rules in top-k — OQ3 at recall)`);
  console.log(`\n--- LEXICAL baseline recall@k (embedding removed) ---`);
  console.log(`  Jaccard MACRO:${ks.map((k) => jac.macroAtK[k]!.toFixed(3).padStart(7)).join('')}`);
  console.log(`  BM25    MACRO:${ks.map((k) => bm.macroAtK[k]!.toFixed(3).padStart(7)).join('')}`);

  // --- Per-element detail + miss list ---
  console.log(`\n--- per-violation (rank of each true rule; MISS if not in top-8) ---`);
  const misses: Array<{ id: string; note: string; expected: string[]; top: string[] }> = [];
  for (const e of violations) {
    const ranked = embRankByElem.get(e.id)?.map((x) => x.rid) ?? [];
    const ranks = e.expected_rule_citations.map((r) => ({ r, rank: ranked.indexOf(r) + 1 }));
    const anyTop3 = e.expected_rule_citations.some((r) => ranked.slice(0, 3).includes(r));
    const line = ranks.map((x) => `${short(x.r)}@${x.rank || 'MISS'}`).join(' ');
    console.log(`  ${e.id.padEnd(10)} ${anyTop3 ? '  ' : '! '}${line}   top3=[${ranked.slice(0, 3).map(short).join(',')}]`);
    if (!anyTop3) misses.push({ id: e.id, note: e.note, expected: e.expected_rule_citations, top: ranked.slice(0, 3) });
  }

  console.log(`\n--- controls: prefilter over-seed (what stage 2 must reject) ---`);
  const controlSeed: Array<{ id: string; kind: string; top: string; topSim: number; over: number }> = [];
  for (const e of controls) {
    const ranked = embRankByElem.get(e.id) ?? [];
    const over = ranked.filter((x) => x.sim >= 0.5).length;
    const top = ranked[0];
    controlSeed.push({ id: e.id, kind: e.kind, top: top?.rid ?? '-', topSim: top?.sim ?? 0, over });
    console.log(`  ${e.id.padEnd(16)} ${e.kind.padEnd(18)} top=${short(top?.rid ?? '-')} sim=${(top?.sim ?? 0).toFixed(3)}  #>=0.5=${over}`);
  }

  console.log(`\n--- prefilter recall MISSES (${misses.length}) — classify OQ1 implicit-behaviour by hand ---`);
  for (const m of misses) console.log(`  ${m.id}: expected ${m.expected.map(short).join(',')} — ${m.note}`);

  writeFileSync(join(DATA, 'floor-recall-results.json'), JSON.stringify({
    generatedFrom: 'floor-ingest-recall.ts', replay: REPLAY,
    counts: { violations: violations.length, controls: controls.length, rules: corpus.rules.length },
    blindnessLeaks: leaks,
    embedding: { any: embAny, all: embAll },
    lexical: { jaccard: jac, bm25: bm },
    perViolation: violations.map((e) => ({
      id: e.id, expected: e.expected_rule_citations,
      ranked: (embRankByElem.get(e.id) ?? []).map((x) => ({ rid: x.rid, sim: Number(x.sim.toFixed(4)) })),
    })),
    controlSeed, misses,
  }, null, 2));
  console.log(`\nwrote floor-recall-results.json — entities LEFT IN DB for leg 2 (floor-adjudicate.ts)`);
  process.exit(0);
}

main().catch((err) => { console.error('leg1 failed:', err); process.exit(1); });
