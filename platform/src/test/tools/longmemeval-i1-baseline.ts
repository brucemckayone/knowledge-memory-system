/**
 * longmemeval-i1-baseline.ts — nmemo-asf.13 (Phase 4, I1 "local"). PATH B.
 *
 * The real-query I1 floor on LongMemEval_S, pre-registered in
 * docs/architecture/single-graph/42-longmemeval-i1-local-prereg.md (FROZEN; do
 * not deviate). Session-as-document retrieval per-question over its own haystack.
 * Three arms: DENSE-FLAT, BM25-FLAT, DENSE+BM25 (retrieved-set RRF-60).
 *
 * Retrieval convention (doc 42 §3, smoke-corrected): DENSE embeds 256-char/64
 * sliding-window CHUNKS of each turn (replicating pipeline.ts splitIntoUnits —
 * whole-turn embedding blows nomic's ~2048-token context) with the nomic
 * asymmetric prefixes (search_document / search_query, nmemo-1cp). Session dense
 * score = MAX over its chunks. BM25 is over whole turns (no token cap). Both legs
 * aggregate to a session score; H1 is compared at session level. Primary metric =
 * session recall_any@10.
 *
 * Deterministic + Claude-free (nomic-embed-text via Ollama through ml :8000). No
 * Claude, no DB writes — cognitive_test and _cronqa are untouched.
 *
 * Embed cache is an APPEND-ONLY BINARY store (i1-vecs.bin = Float32 vectors,
 * i1-keys.jsonl = one JSON-escaped key per line) — a single JSON.stringify of
 * ~363k×768 vectors overflows V8's ~512MB max string length. Resumable: re-run
 * and it skips already-embedded chunks. Bump the heap for the key index:
 *   NODE_OPTIONS=--max-old-space-size=6144
 *
 * Run from platform/ (embed up):
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *   ML_SERVICES_URL=http://localhost:8000 EMBED_MODEL=nomic-embed-text \
 *   NODE_ENV=test NODE_OPTIONS=--max-old-space-size=6144 \
 *   [LME_LIMIT=5] [EMBED_CONCURRENCY=8] \
 *     npx tsx src/test/tools/longmemeval-i1-baseline.ts
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dot, normalise, rankByScore, mean, buildBm25, bm25Scores, clusteredBootstrap } from './retrieval-eval/core.js';
import { reciprocalRankFusion, RRF_K_DEFAULT } from '../../services/fusion.js';
import { ml, SEARCH_DOCUMENT_PREFIX, SEARCH_QUERY_PREFIX } from '../../services/ml-client.js';

const REPO = 'C:/Users/bruce.mckay/dev/nmemo';
const CUT = `${REPO}/benchmarks/longmemeval/i1-local-cut.json`;
const VECS = `${REPO}/benchmarks/longmemeval/i1-vecs.bin`;
const KEYS = `${REPO}/benchmarks/longmemeval/i1-keys.jsonl`;
const RESULTS_DIR = `${REPO}/benchmarks/results/longmemeval/runs`;

const LIMIT = process.env.LME_LIMIT ? Number(process.env.LME_LIMIT) : 0; // 0 = full subset
const CONCURRENCY = process.env.EMBED_CONCURRENCY ? Number(process.env.EMBED_CONCURRENCY) : 8;
const UNIT_CHARS = 256;   // doc 42 §3 smoke-correction: focused-unit regime validated on LME (nmemo-1cp)
const UNIT_OVERLAP = 64;
const KS = [5, 10] as const;

interface Turn { content: string; has_answer: boolean }
interface Session { session_id: string; turns: Turn[] }
interface CutQ { question_id: string; question_type: string; question: string; answer_session_ids: string[]; haystack: Session[] }

/**
 * Append-only binary vector store. Vectors live in a Float32Array (off-heap-ish,
 * ~1.1GB at 363k×768) so we never build a giant JSON string. `flush` appends only
 * the vectors/keys added since the last flush, so persistence cost is O(new), not
 * O(total). Resumable: load rebuilds the index from the .bin + .jsonl on disk.
 */
class VecCache {
  private dim = 0;
  private cap = 1 << 16;
  private buf = new Float32Array(this.cap * 1); // resized once dim is known
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
      const totalFloats = raw.byteLength / 4;
      const dim = n > 0 ? Math.floor(totalFloats / n) : 0;
      if (n > 0 && dim > 0 && dim * n * 4 === raw.byteLength) {
        c.dim = dim; c.cap = Math.max(1 << 16, n); c.buf = new Float32Array(c.cap * dim);
        const f = new Float32Array(raw.buffer, raw.byteOffset, n * dim);
        c.buf.set(f, 0);
        c.len = n; c.persisted = n;
        for (let i = 0; i < n; i++) { const k = JSON.parse(keyLines[i]!) as string; c.index.set(k, i); c.keys.push(k); }
        console.log(`  cache load: ${n} vectors (dim ${dim}) from disk`);
      } else {
        console.log(`  cache load: SKIPPED (keys ${n}, bytes ${raw.byteLength}, inferred dim ${dim} inconsistent) — starting fresh`);
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
    nb.set(this.buf.subarray(0, this.len * this.dim));
    this.buf = nb;
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
    const bytes = Buffer.from(this.buf.buffer, this.persisted * this.dim * 4, (this.len - this.persisted) * this.dim * 4);
    appendFileSync(VECS, bytes);
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

/** Concurrent, resumable embed of prefixed keys into the binary cache. */
async function embedConcurrent(keys: Set<string>, cache: VecCache): Promise<void> {
  const missing = [...keys].filter((k) => !cache.has(k));
  if (missing.length === 0) { console.log(`embed: 0 missing (have ${cache.size()})`); return; }
  console.log(`embedding ${missing.length} texts (concurrency ${CONCURRENCY}) -> ${VECS}`);
  const t0 = Date.now();
  let done = 0; let idx = 0;
  const results = new Array<number[] | null>(missing.length).fill(null);
  // embed into a results buffer concurrently; commit to the cache single-threaded
  // between flush windows so add() ordering and the binary append stay consistent.
  const flushEvery = 2000;
  let committed = 0;
  const commitReady = (): void => {
    while (committed < missing.length && results[committed] !== null) {
      cache.add(missing[committed]!, results[committed]!);
      results[committed] = null; // free
      committed += 1;
      if (committed % flushEvery === 0) {
        cache.flush();
        const rate = committed / ((Date.now() - t0) / 1000);
        console.log(`  ${committed}/${missing.length}  (${rate.toFixed(1)}/s)`);
      }
    }
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      const my = idx++;
      if (my >= missing.length) return;
      const { vector } = await ml.embed(missing[my]!);
      if (!vector || vector.length === 0) throw new Error(`empty embedding for: ${missing[my]!.slice(0, 60)}`);
      results[my] = normalise(vector);
      done += 1;
      commitReady();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  commitReady();
  cache.flush();
  console.log(`  embedded ${done} in ${((Date.now() - t0) / 1000).toFixed(0)}s (cache ${cache.size()})`);
}

function recallAnyAtK(ranking: number[], gold: Set<number>, k: number): number {
  return ranking.slice(0, k).some((i) => gold.has(i)) ? 1 : 0;
}
function ndcgAtK(ranking: number[], gold: Set<number>, k: number): number {
  let dcg = 0;
  for (let r = 0; r < Math.min(k, ranking.length); r++) if (gold.has(ranking[r]!)) dcg += 1 / Math.log2(r + 2);
  let idcg = 0;
  for (let r = 0; r < Math.min(k, gold.size); r++) idcg += 1 / Math.log2(r + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

async function main(): Promise<void> {
  let all = JSON.parse(readFileSync(CUT, 'utf8')) as CutQ[];
  console.log(`[lme-i1] loaded ${all.length} I1 questions from cut`);
  if (LIMIT > 0) { all = all.slice(0, LIMIT); console.log(`[lme-i1] LME_LIMIT=${LIMIT} -> ${all.length} questions (SMOKE)`); }

  let unresolved = 0;
  for (const q of all) {
    const ids = new Set(q.haystack.map((s) => s.session_id));
    for (const a of q.answer_session_ids) if (!ids.has(a)) unresolved += 1;
  }
  if (unresolved > 0) { console.log(`=== INVALID: ${unresolved} gold ids unresolved ===`); process.exit(1); }
  console.log(`gold-session resolvability: 0 unresolved (OK)`);

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
  const sRecall: Record<Arm, Record<number, number[]>> = {
    'DENSE-FLAT': { 5: [], 10: [] }, 'BM25-FLAT': { 5: [], 10: [] }, 'DENSE+BM25': { 5: [], 10: [] },
  };
  const sNdcg: Record<Arm, number[]> = { 'DENSE-FLAT': [], 'BM25-FLAT': [], 'DENSE+BM25': [] };
  const turnRecall10: number[] = [];
  const denseRecall10Desc: number[] = [];
  const types: string[] = [];
  // diagnostics for the recall@10-ceiling check (doc 42 §6 kill condition)
  const haystackSizes: number[] = [];
  const goldDenseRank: number[] = []; // 1-based rank of the (single) gold session in DENSE
  const goldFusedRank: number[] = [];

  for (const q of all) {
    const qv = cache.get(qKey(q.question))!;
    const goldSess = new Set<number>();
    q.haystack.forEach((s, i) => { if (q.answer_session_ids.includes(s.session_id)) goldSess.add(i); });

    const nSess = q.haystack.length;
    const denseSess = new Array<number>(nSess).fill(-Infinity);
    const bm25Sess = new Array<number>(nSess).fill(0);
    const turnDense: number[] = [];
    const turnHasAnswer: boolean[] = [];
    const turnContents: string[] = [];

    q.haystack.forEach((s, si) => {
      for (const t of s.turns) {
        let best = -Infinity;
        for (const c of splitUnits(t.content)) { const v = cache.get(docKey(c))!; const d = dot(qv as unknown as number[], v as unknown as number[]); if (d > best) best = d; }
        turnDense.push(best);
        turnHasAnswer.push(t.has_answer);
        turnContents.push(t.content);
        if (best > denseSess[si]!) denseSess[si] = best;
      }
    });

    const bm25idx = buildBm25(turnContents);
    const bm25Turn = bm25Scores(bm25idx, q.question);
    let ti = 0;
    q.haystack.forEach((s, si) => {
      for (let j = 0; j < s.turns.length; j++) { if (bm25Turn[ti]! > bm25Sess[si]!) bm25Sess[si] = bm25Turn[ti]!; ti += 1; }
    });

    const denseRank = rankByScore(denseSess);
    const bm25Rank = rankByScore(bm25Sess, 0);
    const denseRankDesc = denseSess.map((_, i) => i).filter((i) => denseSess[i]! > -Infinity)
      .sort((a, b) => (denseSess[b]! - denseSess[a]!) || (b - a));
    const fused = reciprocalRankFusion([denseRank, bm25Rank], { k: RRF_K_DEFAULT, tieBreak: (a, b) => a - b });

    for (const k of KS) {
      sRecall['DENSE-FLAT'][k]!.push(recallAnyAtK(denseRank, goldSess, k));
      sRecall['BM25-FLAT'][k]!.push(recallAnyAtK(bm25Rank, goldSess, k));
      sRecall['DENSE+BM25'][k]!.push(recallAnyAtK(fused, goldSess, k));
    }
    sNdcg['DENSE-FLAT'].push(ndcgAtK(denseRank, goldSess, 10));
    sNdcg['BM25-FLAT'].push(ndcgAtK(bm25Rank, goldSess, 10));
    sNdcg['DENSE+BM25'].push(ndcgAtK(fused, goldSess, 10));
    denseRecall10Desc.push(recallAnyAtK(denseRankDesc, goldSess, 10));

    const goldTurns = new Set<number>();
    turnHasAnswer.forEach((h, i) => { if (h) goldTurns.add(i); });
    turnRecall10.push(recallAnyAtK(rankByScore(turnDense), goldTurns, 10));

    haystackSizes.push(nSess);
    const gd = denseRank.findIndex((i) => goldSess.has(i));
    goldDenseRank.push(gd < 0 ? Infinity : gd + 1);
    const gf = fused.findIndex((i) => goldSess.has(i));
    goldFusedRank.push(gf < 0 ? Infinity : gf + 1);

    types.push(q.question_type);
  }

  const perType = (v: number[]): Record<string, { n: number; mean: number }> => {
    const acc: Record<string, { n: number; s: number }> = {};
    types.forEach((t, i) => { (acc[t] ??= { n: 0, s: 0 }).n += 1; acc[t]!.s += v[i]!; });
    return Object.fromEntries(Object.entries(acc).map(([t, { n, s }]) => [t, { n, mean: s / n }]));
  };
  const clusters = all.map((_, i) => String(i));
  const zeros = all.map(() => 0);

  console.log('');
  for (const arm of armNames) {
    const r10 = mean(sRecall[arm][10]!); const r5 = mean(sRecall[arm][5]!); const nd = mean(sNdcg[arm]);
    const ci10 = clusteredBootstrap(sRecall[arm][10]!, zeros, clusters, 10000, 20260908);
    console.log(`${arm.padEnd(11)} sess recall@10 = ${r10.toFixed(4)} CI[${ci10.lo.toFixed(4)},${ci10.hi.toFixed(4)}]  recall@5 = ${r5.toFixed(4)}  nDCG@10 = ${nd.toFixed(4)}`);
  }
  console.log(`turn-level DENSE recall@10 = ${mean(turnRecall10).toFixed(4)}`);

  const h1 = clusteredBootstrap(sRecall['DENSE+BM25'][10]!, sRecall['DENSE-FLAT'][10]!, clusters, 10000, 20260908);
  let b = 0; let c = 0;
  for (let i = 0; i < all.length; i++) {
    const f = sRecall['DENSE+BM25'][10]![i]!; const d = sRecall['DENSE-FLAT'][10]![i]!;
    if (f === 1 && d === 0) b += 1; else if (f === 0 && d === 1) c += 1;
  }
  const verdict = h1.lo > 0 ? 'ABOVE 0' : h1.hi < 0 ? 'BELOW 0' : 'SPANS 0';
  console.log('');
  console.log(`H1  DENSE+BM25 - DENSE-FLAT recall@10 = ${h1.delta >= 0 ? '+' : ''}${h1.delta.toFixed(4)} CI[${h1.lo.toFixed(4)},${h1.hi.toFixed(4)}] ${verdict}`);
  console.log(`    McNemar discordant: fused-only=${b}, dense-only=${c}`);
  const ptFused = perType(sRecall['DENSE+BM25'][10]!); const ptDense = perType(sRecall['DENSE-FLAT'][10]!);
  const perTypeDelta = Object.fromEntries(Object.keys(ptFused).map((t) => [t, ptFused[t]!.mean - ptDense[t]!.mean]));
  const allPositive = Object.values(perTypeDelta).every((d) => d > 0);
  console.log(`    per-type DENSE+BM25 recall@10: ${JSON.stringify(ptFused)}`);
  console.log(`    per-type DENSE-FLAT recall@10: ${JSON.stringify(ptDense)}`);
  console.log(`    per-type H1 delta: ${JSON.stringify(Object.fromEntries(Object.entries(perTypeDelta).map(([t, d]) => [t, Number(d.toFixed(4))])))}  all-positive=${allPositive}`);
  const tieDelta = Math.abs(mean(sRecall['DENSE-FLAT'][10]!) - mean(denseRecall10Desc));
  console.log(`    tie-break sensitivity |asc-desc| DENSE recall@10 = ${tieDelta.toFixed(4)}${tieDelta > 0.02 ? '  >>> FRAGILE' : ''}`);
  const demonstrated = h1.lo > 0 && allPositive;
  console.log(`\n=== H1 ${demonstrated ? 'DEMONSTRATED (CI>0 AND all types positive)' : verdict === 'SPANS 0' ? 'NULL (CI spans 0)' : verdict} ===`);

  // --- diagnostics: recall@10-ceiling check (doc 42 §6) ---
  const hs = [...haystackSizes].sort((a, b) => a - b);
  const bucket = (ranks: number[]): Record<string, number> => {
    const acc = { '1': 0, '2-5': 0, '6-10': 0, '11-20': 0, '>20': 0, 'miss': 0 };
    for (const r of ranks) {
      if (!Number.isFinite(r)) acc.miss += 1; else if (r === 1) acc['1'] += 1; else if (r <= 5) acc['2-5'] += 1;
      else if (r <= 10) acc['6-10'] += 1; else if (r <= 20) acc['11-20'] += 1; else acc['>20'] += 1;
    }
    return acc;
  };
  console.log(`\n[diag] haystack sizes: min ${hs[0]} median ${hs[Math.floor(hs.length / 2)]} max ${hs[hs.length - 1]}  (candidates per question)`);
  console.log(`[diag] random-baseline recall@10 ~= ${(mean(haystackSizes.map((n) => Math.min(10, n) / n))).toFixed(3)} (uniform, 1 gold)`);
  console.log(`[diag] gold DENSE rank buckets: ${JSON.stringify(bucket(goldDenseRank))}`);
  console.log(`[diag] gold FUSED rank buckets: ${JSON.stringify(bucket(goldFusedRank))}`);

  const result = {
    benchmark: 'longmemeval-i1-local', path: 'B (session-as-document)',
    prereg: 'docs/architecture/single-graph/42-longmemeval-i1-local-prereg.md',
    timestamp: new Date().toISOString(), n: all.length, limit: LIMIT || null,
    embed_convention: `nomic asymmetric (search_document/search_query, nmemo-1cp); dense unit = ${UNIT_CHARS}/${UNIT_OVERLAP}-char chunk (splitIntoUnits), session=MAX; bm25 over whole turns`,
    arms: Object.fromEntries(armNames.map((arm) => [arm, {
      sess_recall_at_10: mean(sRecall[arm][10]!), sess_recall_at_5: mean(sRecall[arm][5]!),
      ndcg_at_10: mean(sNdcg[arm]), per_type_recall_at_10: perType(sRecall[arm][10]!),
    }])),
    turn_recall_at_10_dense: mean(turnRecall10),
    h1_fused_minus_dense_recall_at_10: { delta: h1.delta, ci: [h1.lo, h1.hi], verdict, mcnemar_fused_only: b, mcnemar_dense_only: c, per_type_delta: perTypeDelta, all_types_positive: allPositive, demonstrated },
    tiebreak_dense_recall_at_10_delta: tieDelta,
  };
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const tag = LIMIT ? `-smoke${LIMIT}` : '';
  const outPath = join(RESULTS_DIR, `${new Date().toISOString().slice(0, 10)}-i1-local${tag}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${outPath}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
