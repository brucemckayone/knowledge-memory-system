/**
 * cronqa-flat-baseline.ts — nmemo-asf.7 (Phase 3). The TIME-BLIND dense-retrieval FLOOR
 * for I3 on CronQuestions, pre-registered in docs/architecture/single-graph/
 * 40-cronqa-flat-baseline-prereg.md (frozen; do not deviate). Embeds the NL question and
 * ranks candidate answer entities by cosine(question, entity-name) — NO temporal info.
 * This is the number the time-AWARE arm (nmemo-asf.8, over the doc-39 substrate) must beat.
 * Deterministic + free (nomic-embed-text via Ollama through ml :8000). No Claude.
 *
 * Reuses retrieval-eval/core.ts (mulberry32, dot, rankByScore, mean, clusteredBootstrap)
 * + VectorStore (content-keyed embed cache). Reads the entity-answer cut produced by
 * benchmarks/cronqa/prep_flat_baseline.py. Run from platform/ (embed service must be up):
 *   DATABASE_URL=... ML_SERVICES_URL=http://localhost:8000 EMBED_MODEL=nomic-embed-text \
 *     QDRANT_URL=http://localhost:6335 QDRANT_COLLECTION=cognitive_test NODE_ENV=test \
 *     npx tsx src/test/tools/cronqa-flat-baseline.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32, dot, rankByScore, mean, clusteredBootstrap } from './retrieval-eval/core.js';
import { VectorStore } from './retrieval-eval/vector-store.js';

const REPO = 'C:/Users/bruce.mckay/dev/nmemo';
const CUT = `${REPO}/benchmarks/cronqa/flat-baseline-entity-questions.json`;
const CACHE_DIR = `${REPO}/benchmarks/cronqa`;
const FROZEN = `${CACHE_DIR}/flat-baseline-frozen.json`;   // empty; VectorStore needs a frozen path
const WRITABLE = `${CACHE_DIR}/flat-baseline-embed-cache.json`;
const RESULTS_DIR = `${REPO}/benchmarks/results/cronqa/runs`;

const SEED = 20260908;
const SAMPLE = 2000;
const UNDERPOWERED_MIN = 500;

interface CutQ { uniq_id: number; bucket: string; nl: string; fallback: boolean; answer_qids: string[]; answer_names: string[] }

/** Fisher-Yates over a copy, driven by mulberry32(seed) — the frozen sample (doc 40). */
function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
  const a = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

async function main(): Promise<void> {
  const all = JSON.parse(readFileSync(CUT, 'utf8')) as CutQ[];
  console.log(`[cronqa-flat-baseline] loaded ${all.length} entity-answer questions`);

  // Frozen sample: seeded shuffle in file order, take SAMPLE.
  const sample = seededShuffle(all, SEED).slice(0, SAMPLE);
  if (sample.length < UNDERPOWERED_MIN) {
    console.log(`=== VOID: underpowered n=${sample.length} < ${UNDERPOWERED_MIN} ===`);
    process.exit(1);
  }
  console.log(`sample n=${sample.length} (seed ${SEED})`);

  // Candidate universe = union of gold answer QIDs across the sample; qid -> name.
  const qidName = new Map<string, string>();
  for (const q of sample) q.answer_qids.forEach((qid, i) => { if (!qidName.has(qid)) qidName.set(qid, q.answer_names[i] ?? qid); });
  const candQids = [...qidName.keys()];
  const candNames = candQids.map((q) => qidName.get(q)!);
  console.log(`|candidates| = ${candQids.length}`);

  // Embed candidate names (entity convention: raw, writable-first) + question NL (raw).
  if (!existsSync(FROZEN)) writeFileSync(FROZEN, '{}');
  const store = VectorStore.load(FROZEN, WRITABLE);
  console.log(`embed cache: frozen ${store.frozenSize}, writable ${store.writableSize}`);
  await store.ensureEmbedded(new Set(candNames), true);
  await store.ensureEmbedded(new Set(sample.map((q) => q.nl)), true);

  const candVecs = candNames.map((n) => store.getEntity(n));
  const candIdxOfQid = new Map(candQids.map((q, i) => [q, i]));

  // Score every question against the candidate universe (cosine = dot of L2-normed).
  const hit1: number[] = []; const rec10: number[] = [];
  const hit1Desc: number[] = [];
  const buckets: string[] = [];
  let leak = 0;
  for (const q of sample) {
    const qv = store.getEntity(q.nl); // both caches normalised; getEntity = writable-first
    const scores = candVecs.map((v) => dot(qv, v));
    const goldIdx = new Set(q.answer_qids.map((qid) => candIdxOfQid.get(qid)!).filter((i) => i !== undefined));
    const ranked = rankByScore(scores);                        // index-asc tie-break (frozen)
    // index-DESC tie-break, for the tie-break-sensitivity control (doc 40 §4).
    const rankedDesc = scores.map((_, i) => i).sort((a, b) => (scores[b]! - scores[a]!) || (b - a));
    hit1.push(goldIdx.has(ranked[0]!) ? 1 : 0);
    hit1Desc.push(goldIdx.has(rankedDesc[0]!) ? 1 : 0);
    rec10.push(ranked.slice(0, 10).some((i) => goldIdx.has(i)) ? 1 : 0);
    buckets.push(q.bucket);
    const nlLower = q.nl.toLowerCase();
    if (q.answer_names.some((n) => n && nlLower.includes(n.toLowerCase()))) leak += 1;
  }

  const perBucket = (v: number[]): Record<string, { n: number; mean: number }> => {
    const acc: Record<string, { n: number; s: number }> = {};
    buckets.forEach((b, i) => { (acc[b] ??= { n: 0, s: 0 }).n += 1; acc[b]!.s += v[i]!; });
    return Object.fromEntries(Object.entries(acc).map(([b, { n, s }]) => [b, { n, mean: s / n }]));
  };

  const clusters = sample.map((_, i) => String(i));
  const zeros = hit1.map(() => 0);
  const h1CI = clusteredBootstrap(hit1, zeros, clusters);
  const r10CI = clusteredBootstrap(rec10, zeros, clusters);
  const tieDelta = Math.abs(mean(hit1) - mean(hit1Desc));

  console.log('');
  console.log(`Hits@1    = ${mean(hit1).toFixed(4)}  CI[${h1CI.lo.toFixed(4)},${h1CI.hi.toFixed(4)}]`);
  console.log(`Recall@10 = ${mean(rec10).toFixed(4)}  CI[${r10CI.lo.toFixed(4)},${r10CI.hi.toFixed(4)}]`);
  console.log(`per-bucket Hits@1: ${JSON.stringify(perBucket(hit1))}`);
  console.log(`per-bucket Recall@10: ${JSON.stringify(perBucket(rec10))}`);
  console.log(`leakage (NL contains a gold answer name): ${(leak / sample.length * 100).toFixed(1)}%`);
  console.log(`tie-break sensitivity |asc-desc| Hits@1 = ${tieDelta.toFixed(4)}${tieDelta > 0.02 ? '  >>> FRAGILE' : ''}`);

  const result = {
    benchmark: 'cronqa-flat-baseline',
    cut: 'test / answer_type=entity / seeded n=2000',
    prereg: 'docs/architecture/single-graph/40-cronqa-flat-baseline-prereg.md',
    timestamp: new Date().toISOString(),
    seed: SEED,
    n: sample.length,
    candidates: candQids.length,
    arm: 'NAME (dense question vs entity-name, nomic-embed-text)',
    scores: {
      hits_at_1: mean(hit1), hits_at_1_ci: [h1CI.lo, h1CI.hi],
      recall_at_10: mean(rec10), recall_at_10_ci: [r10CI.lo, r10CI.hi],
      per_bucket_hits_at_1: perBucket(hit1),
      per_bucket_recall_at_10: perBucket(rec10),
    },
    leakage_rate: leak / sample.length,
    tiebreak_hits_at_1_delta: tieDelta,
    notes: 'Time-BLIND floor for I3. The as-of temporal arm (nmemo-asf.8) must beat this on the temporal buckets.',
  };
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `${new Date().toISOString().slice(0, 10)}-flat-baseline.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${outPath}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
