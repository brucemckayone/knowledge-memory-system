/**
 * doc-33 — Sweep coverage at equal adjudicator budget (frontier form, per §13 amendment).
 *
 * Scores the SHIPPED sweep configuration instead of recall@k: runAuditPass seeds
 * candidates = recallConceptCandidates UNION recallCrossCorpusCandidates and then spends
 * ONE adjudicator invocation per cell. Rank order is never consulted, so the questions are
 * (a) how many true pairs land in the candidate set, (b) how many cells that costs, and
 * (c) does the concept leg sit above cosine's cost/coverage frontier.
 *
 * Deterministic: no LLM, no re-extraction. Runs against the doc-20 graph surviving in
 * cognitive_test via the SHIPPED functions (no reimplementation — that is how proxies crept
 * into docs 28-32 and it is barred by the pre-reg §4).
 *
 * Run: cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *   NODE_ENV=test npx tsx src/test/tools/sweep-coverage.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  recallCrossCorpusCandidates,
  recallConceptCandidates,
  type CandidatePair,
} from '../../services/audit-pass.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '../../../../docs/architecture/cross-corpus-audit');
const OUT = join(DOCS, 'sweep-coverage-artifacts');

const CODE_CORPUS = 'cj-code';
const RULE_CORPUS = 'cj-rules';
const CONCEPT_CORPUS = '_concepts';

// Shipped defaults, straight off audit-pass.ts RecallOptions.
const DEFAULT_K = 8;
const DEFAULT_THRESHOLD = 0.5;

interface CodeEl { id: string; trueGuideline: string }
interface Extracted {
  codeIds: Record<string, string>;
  ruleIds: Record<string, string>;
  codeEmbeddings: Record<string, number[]>;
  ruleEmbeddings: Record<string, number[]>;
}

function rows(r: unknown): Array<Record<string, unknown>> {
  return r as unknown as Array<Record<string, unknown>>;
}
const cellKey = (a: string, b: string) => `${a} ${b}`;

/** Plumbing invariant (pre-reg §12.6 / R40): the substrate must be doc-20's, unchanged. */
async function plumbing(): Promise<Record<string, number>> {
  const ent = rows(
    await db.execute(sql`
      SELECT corpus_id, count(*)::int AS n, count(embedding)::int AS emb
      FROM public.entities WHERE corpus_id IN (${CODE_CORPUS}, ${RULE_CORPUS}, ${CONCEPT_CORPUS})
      GROUP BY corpus_id`),
  );
  const br = rows(
    await db.execute(sql`
      SELECT relation, count(*)::int AS n FROM public.bridge_edges
      WHERE relation IN ('exhibits','addresses') AND expired_at IS NULL GROUP BY relation`),
  );
  const out: Record<string, number> = {};
  for (const r of ent) {
    out[`entities:${r.corpus_id as string}`] = r.n as number;
    out[`embedded:${r.corpus_id as string}`] = r.emb as number;
  }
  for (const r of br) out[`bridge:${r.relation as string}`] = r.n as number;
  return out;
}

/**
 * The one disclosed data load (pre-reg §3): entities.embedding is NULL on this corpus because
 * doc-20 wrote its cosine arm to element_embeddings (the older .10 substrate). The shipped
 * recallCrossCorpusCandidates reads entities.embedding, so backfill it with doc-20's IDENTICAL
 * raw-text vectors. A load, not a metric choice.
 */
async function backfillEmbeddings(ex: Extracted): Promise<number> {
  let n = 0;
  for (const [side, ids, embs] of [
    ['code', ex.codeIds, ex.codeEmbeddings],
    ['rule', ex.ruleIds, ex.ruleEmbeddings],
  ] as const) {
    for (const [key, entityId] of Object.entries(ids)) {
      const v = embs[key];
      if (!v) throw new Error(`missing ${side} embedding for ${key}`);
      if (v.length !== 768) throw new Error(`${side} ${key} dim ${v.length} != 768`);
      await db.execute(sql`
        UPDATE public.entities SET embedding = ${sql.raw(`'[${v.join(',')}]'::vector`)}
        WHERE id = ${entityId}::uuid`);
      n += 1;
    }
  }
  return n;
}

interface ArmStats {
  cells: number;
  covered: number;
  coverage: number;
  waste: number;
  coveredElements: string[];
}

function score(set: Set<string>, truth: Map<string, string>, elemByCell: Map<string, string>): ArmStats {
  const coveredElements: string[] = [];
  for (const [elemId, trueCell] of truth) if (set.has(trueCell)) coveredElements.push(elemId);
  const covered = coveredElements.length;
  return {
    cells: set.size,
    covered,
    coverage: +(covered / truth.size).toFixed(4),
    waste: set.size === 0 ? 0 : +(1 - covered / set.size).toFixed(4),
    coveredElements: coveredElements.sort(),
  };
}

/** Paired bootstrap over the 29 elements (pre-reg §8, DEMOTED to secondary by §13.4). */
function bootstrap(aHits: boolean[], cHits: boolean[], iters = 10_000): { mean: number; lo: number; hi: number } {
  const n = aHits.length;
  const diffs: number[] = [];
  // Deterministic LCG — Math.random() is barred in this repo's harness discipline (reproducibility).
  let seed = 20260728;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let it = 0; it < iters; it++) {
    let a = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rnd() * n);
      if (aHits[j]) a++;
      if (cHits[j]) c++;
    }
    diffs.push((c - a) / n);
  }
  diffs.sort((x, y) => x - y);
  return {
    mean: +(diffs.reduce((s, d) => s + d, 0) / iters).toFixed(4),
    lo: +diffs[Math.floor(0.025 * iters)]!.toFixed(4),
    hi: +diffs[Math.floor(0.975 * iters)]!.toFixed(4),
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const ex: Extracted = JSON.parse(
    readFileSync(join(DOCS, 'concept-join-artifacts/cj-extracted.json'), 'utf8'),
  );
  const codeEls: CodeEl[] = JSON.parse(
    readFileSync(join(DOCS, 'recall-gate-artifacts/gate_code_raw.json'), 'utf8'),
  );

  const before = await plumbing();
  console.log('plumbing BEFORE:', JSON.stringify(before));

  // Hard substrate gate (pre-reg §3 + §12.6/R40). The doc-20 graph must be present EXACTLY as
  // doc-20 §13 reported it, or we are not measuring the audited substrate. Fail loud: an earlier
  // run silently produced all-zeros because it connected to the dev DB instead of cognitive_test,
  // and UPDATE-on-missing-id affects 0 rows without error.
  const EXPECT: Record<string, number> = {
    'entities:cj-code': 29,
    'entities:cj-rules': 27,
    'entities:_concepts': 104,
    'bridge:exhibits': 97,
    'bridge:addresses': 51,
  };
  const drift = Object.entries(EXPECT).filter(([k, v]) => before[k] !== v);
  if (drift.length > 0) {
    throw new Error(
      `substrate gate FAILED — expected doc-20 graph, got ${JSON.stringify(before)}; ` +
        `mismatched: ${drift.map(([k, v]) => `${k} want ${v} got ${before[k] ?? 'absent'}`).join(', ')}. ` +
        `Is DATABASE_URL pointed at cognitive_test?`,
    );
  }

  const loaded = await backfillEmbeddings(ex);
  console.log(`backfilled entities.embedding for ${loaded} entities (doc-20 raw-text vectors)`);

  // Sealed ground truth: 29 cells (E, trueGuideline(E)), in entity-UUID space.
  const truth = new Map<string, string>(); // elementId(E00x) -> cellKey
  const elemByCell = new Map<string, string>();
  for (const e of codeEls) {
    const a = ex.codeIds[e.id];
    const b = ex.ruleIds[e.trueGuideline];
    if (!a || !b) throw new Error(`unmapped truth pair ${e.id} -> ${e.trueGuideline}`);
    const k = cellKey(a, b);
    truth.set(e.id, k);
    elemByCell.set(k, e.id);
  }
  if (truth.size !== 29) throw new Error(`expected 29 true pairs, got ${truth.size}`);

  const toSet = (ps: CandidatePair[]) => new Set(ps.map((p) => cellKey(p.elementRef, p.ruleId)));

  // ---- Arm B: concept-only (shipped fn, no knobs) ----
  const bPairs = await recallConceptCandidates(CODE_CORPUS, RULE_CORPUS);
  const bSet = toSet(bPairs);
  const armB = score(bSet, truth, elemByCell);

  // ---- Arm A: cosine-only, at defaults and across the frozen grid ----
  const aDefaultPairs = await recallCrossCorpusCandidates(CODE_CORPUS, RULE_CORPUS, {
    k: DEFAULT_K,
    threshold: DEFAULT_THRESHOLD,
  });
  const aDefaultSet = toSet(aDefaultPairs);
  const armADefault = score(aDefaultSet, truth, elemByCell);

  const grid: Array<{ k: number; threshold: number; cells: number; coverage: number }> = [];
  for (let k = 1; k <= 27; k++) {
    for (let t = 0; t <= 19; t++) {
      const threshold = +(t * 0.05).toFixed(2);
      const s = toSet(await recallCrossCorpusCandidates(CODE_CORPUS, RULE_CORPUS, { k, threshold }));
      const st = score(s, truth, elemByCell);
      grid.push({ k, threshold, cells: st.cells, coverage: st.coverage });
    }
    if (k % 9 === 0) console.log(`  grid k=${k}/27 (${grid.length} settings)`);
  }

  // ---- Arm C: the shipped union, byte-for-byte audit-pass.ts:307-319 ----
  const byCell = new Map<string, CandidatePair>();
  for (const c of bPairs) byCell.set(cellKey(c.elementRef, c.ruleId), c);
  for (const c of aDefaultPairs) byCell.set(cellKey(c.elementRef, c.ruleId), c);
  const cSet = new Set(byCell.keys());
  const armC = score(cSet, truth, elemByCell);

  // ---- Primary 1: complementarity (true pairs B gets that A@defaults misses) ----
  const complementaryElements: string[] = [];
  for (const [elemId, cell] of truth) {
    if (bSet.has(cell) && !aDefaultSet.has(cell)) complementaryElements.push(elemId);
  }
  // Reverse direction reported for symmetry (R29): what cosine gets that concept misses.
  const cosineOnlyElements: string[] = [];
  for (const [elemId, cell] of truth) {
    if (aDefaultSet.has(cell) && !bSet.has(cell)) cosineOnlyElements.push(elemId);
  }

  // ---- Primary 2: frontier dominance ----
  const frontierAt = (c: number): number => {
    let best = 0;
    for (const g of grid) if (g.cells <= c && g.coverage > best) best = g.coverage;
    return best;
  };
  const domC = { cells: armC.cells, coverage: armC.coverage, frontier: +frontierAt(armC.cells).toFixed(4) };
  const domB = { cells: armB.cells, coverage: armB.coverage, frontier: +frontierAt(armB.cells).toFixed(4) };
  const pairsAboveC = Math.round((domC.coverage - domC.frontier) * truth.size);
  const pairsAboveB = Math.round((domB.coverage - domB.frontier) * truth.size);

  const grade = (pairs: number): string =>
    pairs >= 3 ? 'CLEAR_WIN(>=3 pairs above frontier)'
      : pairs >= 1 ? `FRAGILE_DOMINANCE(${pairs} pair(s), no transfer claim)`
        : 'FAIL(at or below frontier)';

  // ---- Secondary (§13.4, demoted): matched-budget point + bootstrap ----
  const atOrAbove = grid.filter((g) => g.cells >= armC.cells);
  let matched: typeof grid[number] | null = null;
  if (atOrAbove.length > 0) {
    const minCells = Math.min(...atOrAbove.map((g) => g.cells));
    const tied = atOrAbove.filter((g) => g.cells === minCells);
    matched = tied.reduce((best, g) => (g.coverage > best.coverage ? g : best), tied[0]!);
  }
  const matchedSet = matched
    ? toSet(await recallCrossCorpusCandidates(CODE_CORPUS, RULE_CORPUS, { k: matched.k, threshold: matched.threshold }))
    : null;
  const armAMatched = matchedSet ? score(matchedSet, truth, elemByCell) : null;
  const elemOrder = [...truth.keys()].sort();
  const boot = armAMatched
    ? bootstrap(
      elemOrder.map((e) => matchedSet!.has(truth.get(e)!)),
      elemOrder.map((e) => cSet.has(truth.get(e)!)),
    )
    : null;

  const after = await plumbing();
  const plumbingStable =
    before['entities:cj-code'] === after['entities:cj-code'] &&
    before['entities:cj-rules'] === after['entities:cj-rules'] &&
    before['entities:_concepts'] === after['entities:_concepts'] &&
    before['bridge:exhibits'] === after['bridge:exhibits'] &&
    before['bridge:addresses'] === after['bridge:addresses'];

  const result = {
    prereg: 'doc-33 (§13 amended: frontier dominance primary)',
    corpus: { elements: truth.size, rules: Object.keys(ex.ruleIds).length, crossProduct: truth.size * Object.keys(ex.ruleIds).length },
    shippedDefaults: { k: DEFAULT_K, threshold: DEFAULT_THRESHOLD },
    plumbing: { before, after, stable: plumbingStable, embeddingsBackfilled: loaded },
    arms: { A_cosine_defaults: armADefault, B_concept: armB, C_union_shipped: armC },
    primary1_complementarity: {
      count: complementaryElements.length,
      elements: complementaryElements,
      bar: '>=1',
      verdict: complementaryElements.length >= 1 ? 'PASS' : 'FAIL',
      reverse_cosineOnly: { count: cosineOnlyElements.length, elements: cosineOnlyElements },
    },
    primary2_frontierDominance: {
      C: { ...domC, pairsAboveFrontier: pairsAboveC, grade: grade(pairsAboveC) },
      B: { ...domB, pairsAboveFrontier: pairsAboveB, grade: grade(pairsAboveB) },
    },
    secondary_matchedBudget: { matched, armAMatched, bootstrap: boot, note: 'DEMOTED per §13.4 — illustration only, not gating' },
    grid,
  };

  writeFileSync(join(OUT, 'sweep-results.json'), JSON.stringify(result, null, 2));
  const { grid: _g, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\ngrid: ${grid.length} settings written to sweep-results.json`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
