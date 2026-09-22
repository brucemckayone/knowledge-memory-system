/**
 * longmemeval-i2-baseline.ts — nmemo-asf.14 (Phase 4, I2 "multi-hop"). PATH B.
 *
 * Multi-session (multi-evidence) retrieval on LongMemEval_S, pre-registered in
 * docs/architecture/single-graph/43-longmemeval-i2-multihop-prereg.md (FROZEN).
 * Per-question haystack; each question has >=2 gold sessions (mean 2.61), so the
 * PRIMARY metric is session-level recall_ALL@k (retrieve EVERY gold session),
 * per LongMemEval eval_utils.py. Three arms: DENSE-FLAT, BM25-FLAT, DENSE+BM25
 * (retrieved-set RRF-60). Convention inherited verbatim from doc 42 §3 (nomic
 * asymmetric prefixes; 256/64-char chunks; session score = MAX over its turns'
 * chunks; BM25 over whole turns). SHARES the I1 binary embed cache (i1-vecs.bin +
 * i1-keys.jsonl), so ~15% of chunks are already embedded.
 *
 * Deterministic + Claude-free (nomic via Ollama through ml :8000). No Claude, no
 * DB writes — cognitive_test and _cronqa untouched.
 *
 * Run from platform/ (embed up):
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *   ML_SERVICES_URL=http://localhost:8000 EMBED_MODEL=nomic-embed-text \
 *   NODE_ENV=test NODE_OPTIONS=--max-old-space-size=6144 \
 *   [LME_LIMIT=5] [EMBED_CONCURRENCY=8] \
 *     npx tsx src/test/tools/longmemeval-i2-baseline.ts
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dot, normalise, rankByScore, mean, buildBm25, bm25Scores, clusteredBootstrap } from './retrieval-eval/core.js';
import { reciprocalRankFusion, RRF_K_DEFAULT } from '../../services/fusion.js';
import { ml, SEARCH_DOCUMENT_PREFIX, SEARCH_QUERY_PREFIX } from '../../services/ml-client.js';

const REPO = 'C:/Users/bruce.mckay/dev/nmemo';
const CUT = `${REPO}/benchmarks/longmemeval/i2-multi-cut.json`;
const VECS = `${REPO}/benchmarks/longmemeval/i1-vecs.bin`;   // SHARED with I1 (content-keyed)
const KEYS = `${REPO}/benchmarks/longmemeval/i1-keys.jsonl`;
const RESULTS_DIR = `${REPO}/benchmarks/results/longmemeval/runs`;

const LIMIT = process.env.LME_LIMIT ? Number(process.env.LME_LIMIT) : 0;
const CONCURRENCY = process.env.EMBED_CONCURRENCY ? Number(process.env.EMBED_CONCURRENCY) : 8;
const UNIT_CHARS = 256;
const UNIT_OVERLAP = 64;
const KS = [5, 10] as const;

interface Turn { content: string; has_answer: boolean }
interface Session { session_id: string; turns: Turn[] }
interface CutQ { question_id: string; question_type: string; question: string; answer_session_ids: string[]; haystack: Session[] }

// ---- append-only binary vector cache (identical to the I1 harness) ---------
class VecCache {
  private dim = 0;
  private cap = 1 << 16;
  private buf = new Float32Array(this.cap * 1);
  private len = 0;
  private persisted = 0;
  private readonly index = new Map<string, number>();
  private readonly keys: string[] = [];
  static load(): VecCache {
    const c = new VecCache();
    if (existsSync(KEYS) && existsSync(VECS)) {
      const keyLines = readFileSync(KEYS, 'utf8').split('\n').filter((l) => l.length > 0);
      const n = keyLines.length;
      const raw = readFileSync(VECS);
      const dim = n > 0 ? Math.floor((raw.byteLength / 4) / n) : 0;
      if (n > 0 && dim > 0 && dim * n * 4 === raw.byteLength) {
        c.dim = dim; c.cap = Math.max(1 << 16, n); c.buf = new Float32Array(c.cap * dim);
        c.buf.set(new Float32Array(raw.buffer, raw.byteOffset, n * dim), 0);
        c.len = n; c.persisted = n;
        for (let i = 0; i < n; i++) { const k = JSON.parse(keyLines[i]!) as string; c.index.set(k, i); c.keys.push(k); }
        console.log(`  cache load: ${n} vectors (dim ${dim}) from disk`);
      } else {
        console.log(`  cache load: SKIPPED (keys ${n}, bytes ${raw.byteLength}, dim ${dim} inconsistent) — fresh`);
      }
    }
    return c;
  }
  private ensureDim(d: number): void {
    if (this.dim === 0) { this.dim = d; this.buf = new Float32Array(this.cap * d); }
    else if (this.dim !== d) throw new Error(`embedding dim changed ${this.dim} -> ${d}`);
  }
  private ensureCap(n: number): void {
    if (n <= this.cap) return;
    while (this.cap < n) this.cap *= 2;
    const nb = new Float32Array(this.cap * this.dim);
    nb.set(this.buf.subarray(0, this.len * this.dim)); this.buf = nb;
  }
  has(k: string): boolean { return this.index.has(k); }
  get(k: string): Float32Array | undefined {
    const i = this.index.get(k);
    return i === undefined ? undefined : this.buf.subarray(i * this.dim, (i + 1) * this.dim);
  }
  add(k: string, vec: number[]): void {
    this.ensureDim(vec.length); this.ensureCap(this.len + 1);
    const off = this.len * this.dim;
    for (let j = 0; j < this.dim; j++) this.buf[off + j] = vec[j]!;
    this.index.set(k, this.len); this.keys.push(k); this.len += 1;
  }
  size(): number { return this.len; }
  flush(): void {
    if (this.len === this.persisted) return;
    appendFileSync(VECS, Buffer.from(this.buf.buffer, this.persisted * this.dim * 4, (this.len - this.persisted) * this.dim * 4));
    let keyChunk = '';
    for (let i = this.persisted; i < this.len; i++) keyChunk += JSON.stringify(this.keys[i]) + '\n';
    appendFileSync(KEYS, keyChunk);
    this.persisted = this.len;
  }
}

function splitUnits(text: string): string[] {
  const stride = UNIT_CHARS - UNIT_OVERLAP;
  if (text.length === 0) return [];
  const units: string[] = [];
  for (let start = 0; start < text.length; start += stride) {
    const end = Math.min(start + UNIT_CHARS, text.length);
    units.push(text.slice(start, end));
    if (end === text.length) break;
  }
  return units;
}
const docKey = (chunk: string): string => SEARCH_DOCUMENT_PREFIX + chunk;
const qKey = (question: string): string => SEARCH_QUERY_PREFIX + question;

async function embedConcurrent(keys: Set<string>, cache: VecCache): Promise<void> {
  const missing = [...keys].filter((k) => !cache.has(k));
  if (missing.length === 0) { console.log(`embed: 0 missing (have ${cache.size()})`); return; }
  console.log(`embedding ${missing.length} texts (concurrency ${CONCURRENCY}) -> ${VECS}`);
  const t0 = Date.now();
  const results = new Array<number[] | null>(missing.length).fill(null);
  let done = 0; let idx = 0; let committed = 0;
  const commitReady = (): void => {
    while (committed < missing.length && results[committed] !== null) {
      cache.add(missing[committed]!, results[committed]!); results[committed] = null; committed += 1;
      if (committed % 2000 === 0) { cache.flush(); console.log(`  ${committed}/${missing.length}  (${(committed / ((Date.now() - t0) / 1000)).toFixed(1)}/s)`); }
    }
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      const my = idx++;
      if (my >= missing.length) return;
      const { vector } = await ml.embed(missing[my]!);
      if (!vector || vector.length === 0) throw new Error(`empty embedding for: ${missing[my]!.slice(0, 60)}`);
      results[my] = normalise(vector); done += 1; commitReady();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  commitReady(); cache.flush();
  console.log(`  embedded ${done} in ${((Date.now() - t0) / 1000).toFixed(0)}s (cache ${cache.size()})`);
}

/** recall_ALL@k: 1 iff EVERY gold index is in the top-k. */
function recallAllAtK(ranking: number[], gold: Set<number>, k: number): number {
  const top = new Set(ranking.slice(0, k));
  for (const g of gold) if (!top.has(g)) return 0;
  return 1;
}
function recallAnyAtK(ranking: number[], gold: Set<number>, k: number): number {
  return ranking.slice(0, k).some((i) => gold.has(i)) ? 1 : 0;
}
/** fraction of gold sessions present in top-k (partial-recall diagnostic). */
function fracGoldAtK(ranking: number[], gold: Set<number>, k: number): number {
  if (gold.size === 0) return 0;
  const top = new Set(ranking.slice(0, k));
  let hit = 0; for (const g of gold) if (top.has(g)) hit += 1;
  return hit / gold.size;
}
function ndcgAtK(ranking: number[], gold: Set<number>, k: number): number {
  let dcg = 0;
  for (let r = 0; r < Math.min(k, ranking.length); r++) if (gold.has(ranking[r]!)) dcg += 1 / Math.log2(r + 2);
  let idcg = 0;
  for (let r = 0; r < Math.min(k, gold.size); r++) idcg += 1 / Math.log2(r + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}
const stratumOf = (nGold: number): string => (nGold === 2 ? '2' : nGold === 3 ? '3' : '4-5');

async function main(): Promise<void> {
  let all = JSON.parse(readFileSync(CUT, 'utf8')) as CutQ[];
  console.log(`[lme-i2] loaded ${all.length} multi-session questions from cut`);
  if (LIMIT > 0) { all = all.slice(0, LIMIT); console.log(`[lme-i2] LME_LIMIT=${LIMIT} -> ${all.length} (SMOKE)`); }

  let unresolved = 0; let lt2 = 0;
  for (const q of all) {
    const ids = new Set(q.haystack.map((s) => s.session_id));
    for (const a of q.answer_session_ids) if (!ids.has(a)) unresolved += 1;
    if (q.answer_session_ids.length < 2) lt2 += 1;
  }
  if (unresolved > 0) { console.log(`=== INVALID: ${unresolved} gold ids unresolved ===`); process.exit(1); }
  if (lt2 > 0) { console.log(`=== INVALID: ${lt2} questions with <2 gold (not multi-session) ===`); process.exit(1); }
  console.log(`gold resolvability: 0 unresolved, 0 with <2 gold (OK)`);

  const docKeys = new Set<string>();
  for (const q of all) for (const s of q.haystack) for (const t of s.turns) for (const c of splitUnits(t.content)) docKeys.add(docKey(c));
  const qKeys = new Set(all.map((q) => qKey(q.question)));
  console.log(`unique chunk docs: ${docKeys.size}, questions: ${qKeys.size}`);
  const cache = VecCache.load();
  console.log(`embed cache on disk: ${cache.size()}`);
  await embedConcurrent(docKeys, cache);
  await embedConcurrent(qKeys, cache);

  const armNames = ['DENSE-FLAT', 'BM25-FLAT', 'DENSE+BM25'] as const;
  type Arm = typeof armNames[number];
  const rAll: Record<Arm, Record<number, number[]>> = { 'DENSE-FLAT': { 5: [], 10: [] }, 'BM25-FLAT': { 5: [], 10: [] }, 'DENSE+BM25': { 5: [], 10: [] } };
  const rAny10: Record<Arm, number[]> = { 'DENSE-FLAT': [], 'BM25-FLAT': [], 'DENSE+BM25': [] };
  const frac10: Record<Arm, number[]> = { 'DENSE-FLAT': [], 'BM25-FLAT': [], 'DENSE+BM25': [] };
  const ndcg10: Record<Arm, number[]> = { 'DENSE-FLAT': [], 'BM25-FLAT': [], 'DENSE+BM25': [] };
  const denseAllDesc: number[] = [];
  const strata: string[] = [];

  for (const q of all) {
    const qv = cache.get(qKey(q.question))!;
    const gold = new Set<number>();
    q.haystack.forEach((s, i) => { if (q.answer_session_ids.includes(s.session_id)) gold.add(i); });

    const nSess = q.haystack.length;
    const denseSess = new Array<number>(nSess).fill(-Infinity);
    const bm25Sess = new Array<number>(nSess).fill(0);
    const turnContents: string[] = [];
    const turnSession: number[] = [];
    q.haystack.forEach((s, si) => {
      for (const t of s.turns) {
        let best = -Infinity;
        for (const c of splitUnits(t.content)) { const d = dot(qv as unknown as number[], cache.get(docKey(c))! as unknown as number[]); if (d > best) best = d; }
        if (best > denseSess[si]!) denseSess[si] = best;
        turnContents.push(t.content); turnSession.push(si);
      }
    });
    const bm25idx = buildBm25(turnContents);
    const bm25Turn = bm25Scores(bm25idx, q.question);
    for (let ti = 0; ti < turnContents.length; ti++) { const si = turnSession[ti]!; if (bm25Turn[ti]! > bm25Sess[si]!) bm25Sess[si] = bm25Turn[ti]!; }

    const denseRank = rankByScore(denseSess);
    const bm25Rank = rankByScore(bm25Sess, 0);
    const denseRankDesc = denseSess.map((_, i) => i).filter((i) => denseSess[i]! > -Infinity).sort((a, b) => (denseSess[b]! - denseSess[a]!) || (b - a));
    const fused = reciprocalRankFusion([denseRank, bm25Rank], { k: RRF_K_DEFAULT, tieBreak: (a, b) => a - b });
    const ranks: Record<Arm, number[]> = { 'DENSE-FLAT': denseRank, 'BM25-FLAT': bm25Rank, 'DENSE+BM25': fused };

    for (const arm of armNames) {
      for (const k of KS) rAll[arm][k]!.push(recallAllAtK(ranks[arm], gold, k));
      rAny10[arm].push(recallAnyAtK(ranks[arm], gold, 10));
      frac10[arm].push(fracGoldAtK(ranks[arm], gold, 10));
      ndcg10[arm].push(ndcgAtK(ranks[arm], gold, 10));
    }
    denseAllDesc.push(recallAllAtK(denseRankDesc, gold, 10));
    strata.push(stratumOf(q.answer_session_ids.length));
  }

  const perStratum = (v: number[]): Record<string, { n: number; mean: number }> => {
    const acc: Record<string, { n: number; s: number }> = {};
    strata.forEach((t, i) => { (acc[t] ??= { n: 0, s: 0 }).n += 1; acc[t]!.s += v[i]!; });
    return Object.fromEntries(Object.entries(acc).sort().map(([t, { n, s }]) => [t, { n, mean: s / n }]));
  };
  const clusters = all.map((_, i) => String(i));
  const zeros = all.map(() => 0);

  console.log('');
  for (const arm of armNames) {
    const ci = clusteredBootstrap(rAll[arm][10]!, zeros, clusters, 10000, 20260909);
    console.log(`${arm.padEnd(11)} recall_ALL@10 = ${mean(rAll[arm][10]!).toFixed(4)} CI[${ci.lo.toFixed(4)},${ci.hi.toFixed(4)}]  recall_ALL@5 = ${mean(rAll[arm][5]!).toFixed(4)}  recall_any@10 = ${mean(rAny10[arm]).toFixed(4)}  frac_gold@10 = ${mean(frac10[arm]).toFixed(4)}  nDCG@10 = ${mean(ndcg10[arm]).toFixed(4)}`);
  }

  const h1 = clusteredBootstrap(rAll['DENSE+BM25'][10]!, rAll['DENSE-FLAT'][10]!, clusters, 10000, 20260909);
  let b = 0; let c = 0;
  for (let i = 0; i < all.length; i++) { const f = rAll['DENSE+BM25'][10]![i]!; const d = rAll['DENSE-FLAT'][10]![i]!; if (f === 1 && d === 0) b += 1; else if (f === 0 && d === 1) c += 1; }
  const verdict = h1.lo > 0 ? 'ABOVE 0' : h1.hi < 0 ? 'BELOW 0' : 'SPANS 0';
  console.log('');
  console.log(`H1  DENSE+BM25 - DENSE-FLAT recall_ALL@10 = ${h1.delta >= 0 ? '+' : ''}${h1.delta.toFixed(4)} CI[${h1.lo.toFixed(4)},${h1.hi.toFixed(4)}] ${verdict}`);
  console.log(`    McNemar discordant: fused-only=${b}, dense-only=${c}`);
  const ptF = perStratum(rAll['DENSE+BM25'][10]!); const ptD = perStratum(rAll['DENSE-FLAT'][10]!);
  const stratDelta = Object.fromEntries(Object.keys(ptF).map((t) => [t, ptF[t]!.mean - ptD[t]!.mean]));
  const allPositive = Object.values(stratDelta).every((d) => d > 0);
  console.log(`    per-stratum DENSE-FLAT recall_ALL@10: ${JSON.stringify(ptD)}`);
  console.log(`    per-stratum DENSE+BM25 recall_ALL@10: ${JSON.stringify(ptF)}`);
  console.log(`    per-stratum H1 delta: ${JSON.stringify(Object.fromEntries(Object.entries(stratDelta).map(([t, d]) => [t, Number(d.toFixed(4))])))}  all-positive=${allPositive}`);
  const tieDelta = Math.abs(mean(rAll['DENSE-FLAT'][10]!) - mean(denseAllDesc));
  console.log(`    tie-break sensitivity |asc-desc| DENSE recall_ALL@10 = ${tieDelta.toFixed(4)}${tieDelta > 0.02 ? '  >>> FRAGILE' : ''}`);
  const denseAll10 = mean(rAll['DENSE-FLAT'][10]!);
  const saturated = denseAll10 >= 0.98;
  console.log(`\n[diag] DENSE-FLAT recall_ALL@10 = ${denseAll10.toFixed(4)}  frac_gold@10 = ${mean(frac10['DENSE-FLAT']).toFixed(4)}  => ${saturated ? 'SATURATED (>=0.98) — escalate benchmark (doc 43 §8)' : 'HAS HEADROOM (<0.98) — I2 is a live task'}`);
  const demonstrated = h1.lo > 0 && allPositive;
  console.log(`=== H1 ${demonstrated ? 'DEMONSTRATED (CI>0 AND all strata positive)' : verdict === 'SPANS 0' ? 'NULL (CI spans 0)' : verdict} ===`);

  const result = {
    benchmark: 'longmemeval-i2-multihop', path: 'B (session-as-document)',
    prereg: 'docs/architecture/single-graph/43-longmemeval-i2-multihop-prereg.md',
    timestamp: new Date().toISOString(), n: all.length, limit: LIMIT || null,
    metric: 'session recall_ALL@k (every gold session in top-k)',
    embed_convention: `nomic asymmetric; dense unit=${UNIT_CHARS}/${UNIT_OVERLAP}-char chunk, session=MAX; bm25 over whole turns`,
    dense_flat_recall_all_at_10: denseAll10, saturated,
    arms: Object.fromEntries(armNames.map((arm) => [arm, {
      recall_all_at_10: mean(rAll[arm][10]!), recall_all_at_5: mean(rAll[arm][5]!),
      recall_any_at_10: mean(rAny10[arm]), frac_gold_at_10: mean(frac10[arm]), ndcg_at_10: mean(ndcg10[arm]),
      per_stratum_recall_all_at_10: perStratum(rAll[arm][10]!),
    }])),
    h1_fused_minus_dense_recall_all_at_10: { delta: h1.delta, ci: [h1.lo, h1.hi], verdict, mcnemar_fused_only: b, mcnemar_dense_only: c, per_stratum_delta: stratDelta, all_strata_positive: allPositive, demonstrated },
    tiebreak_dense_recall_all_at_10_delta: tieDelta,
  };
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const tag = LIMIT ? `-smoke${LIMIT}` : '';
  const outPath = join(RESULTS_DIR, `${new Date().toISOString().slice(0, 10)}-i2-multihop${tag}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${outPath}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
