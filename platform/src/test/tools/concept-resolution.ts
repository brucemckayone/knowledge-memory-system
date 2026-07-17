/**
 * Doc-17 concept-resolution harness (bead nmemo-uhp.19).
 *
 * Tests the linchpin of the emergent-concept architecture: does the embedding path
 * resolve the SAME mechanism expressed in DIFFERENT prose where keyword matching cannot
 * (Stage 1), and can a Haiku adjudicator resolve concept-equivalence — confirming true
 * matches AND rejecting hard near-misses — beating a best-in-hindsight cosine threshold
 * (Stage 2)?  Bars are frozen in docs/architecture/cross-corpus-audit/17-*.md.
 *
 * Anti-leak construction: three prose registers per mechanism, EACH authored by an
 * INDEPENDENT blind ml.generateJson call (separate /chat invocation, no shared context,
 * never shown the other registers, never told this is a matching test). The authored
 * prose is frozen to concept-authored.json for reproducibility + adversary audit.
 *
 * Run (from anywhere; absolute path so tsx resolves imports regardless of cwd):
 *   npx tsx C:/Users/bruce.mckay/dev/nmemo/platform/src/test/tools/concept-resolution.ts
 *   ... --reauthor   force re-authoring the registers (else load the frozen file)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ml } from '../../services/ml-client.js';

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data', 'concept-resolution');
const MECH_FILE = join(DATA, 'mechanisms.json');
const AUTHORED_FILE = join(DATA, 'concept-authored.json');
const RESULTS_FILE = join(DATA, 'concept-resolution-results.json');
const REAUTHOR = process.argv.includes('--reauthor');

type Register = 'normative' | 'advisory' | 'reference';
const REGISTERS: Register[] = ['normative', 'advisory', 'reference'];

interface Mechanism { id: string; near_miss: string; spec: string }
interface Corpus { registers: Record<Register, string>; mechanisms: Mechanism[] }

const corpus = JSON.parse(readFileSync(MECH_FILE, 'utf8')) as Corpus;
const MECHS = corpus.mechanisms;
const MECH_IDS = MECHS.map((m) => m.id);

// ---------- bounded-concurrency pool (reused pattern from floor-adjudicate.ts) ----------
async function mapPool<T, R>(items: T[], conc: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  return out;
}

// ---------- BM25 (textbook Okapi, doc-12 params, no tuning) ----------
const BM25_K1 = 1.2, BM25_B = 0.75;
const STOP = new Set(['the','a','an','of','to','is','are','be','that','this','it','its','and','or','not','no','in','on','at','by','for','with','as','from','into','than','then','so','if','when','which','while','has','have','had','was','were','been','will','shall','may','must','should','can','could','would','do','does','done','but','out','back','up','off','over','more','less','one','two','their','they','them','its','it','a','any','all','each','such','only','via','per','using','use','used']);
function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOP.has(t));
}
interface Bm25 { idf: Map<string, number>; docs: Map<string, { tf: Map<string, number>; len: number }>; avgdl: number }
function buildBm25(docTexts: Map<string, string>): Bm25 {
  const docs = new Map<string, { tf: Map<string, number>; len: number }>();
  const df = new Map<string, number>();
  let total = 0;
  for (const [id, text] of docTexts) {
    const toks = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    docs.set(id, { tf, len: toks.length });
    total += toks.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = docs.size;
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  return { idf, docs, avgdl: total / Math.max(1, N) };
}
function bm25Score(idx: Bm25, docId: string, queryTerms: Set<string>): number {
  const doc = idx.docs.get(docId);
  if (!doc) return 0;
  let s = 0;
  for (const t of queryTerms) {
    const tf = doc.tf.get(t);
    if (!tf) continue;
    const idf = idx.idf.get(t) ?? 0;
    s += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.len / idx.avgdl)));
  }
  return s;
}

// ---------- Stage 0: author the three registers (independent blind Haiku calls) ----------
interface Authored { [register: string]: { [mechId: string]: string } }

async function authorRegister(register: Register): Promise<Record<string, string>> {
  // The prompt is BLIND: it never mentions matching, embeddings, near-misses, the other
  // registers, or that these mechanisms will be compared. It only asks for prose in one
  // register's natural vocabulary. This is one standalone /chat call — no shared context
  // with the other registers.
  const specList = MECHS.map((m) => `- ${m.id}: ${m.spec}`).join('\n');
  const prompt = [
    `You are writing short technical descriptions of C++ resource-management behaviours.`,
    `Style for ALL of them: ${corpus.registers[register]}`,
    ``,
    `For each item below, write ONE or TWO sentences describing it in that style, in your`,
    `own natural vocabulary. Do NOT reuse the wording of the specification given; rephrase.`,
    `Do NOT mention rule numbers or standard names.`,
    ``,
    specList,
    ``,
    `Return a JSON object mapping each item id to its description string, e.g.`,
    `{"${MECH_IDS[0]}": "…", "${MECH_IDS[1]}": "…", …}. Include ALL ${MECH_IDS.length} ids.`,
  ].join('\n');
  const obj = await ml.generateJson<Record<string, string>>(prompt);
  const missing = MECH_IDS.filter((id) => typeof obj[id] !== 'string' || !obj[id].trim());
  if (missing.length) throw new Error(`register ${register} missing: ${missing.join(',')}`);
  return obj;
}

async function loadOrAuthor(): Promise<Authored> {
  if (!REAUTHOR && existsSync(AUTHORED_FILE)) {
    console.log('loaded frozen registers from concept-authored.json');
    return JSON.parse(readFileSync(AUTHORED_FILE, 'utf8')) as Authored;
  }
  console.log('authoring 3 registers via independent blind Haiku calls…');
  const authored: Authored = {};
  // Sequential (3 calls) — independence is per-call, order is irrelevant.
  for (const r of REGISTERS) authored[r] = await authorRegister(r);
  writeFileSync(AUTHORED_FILE, JSON.stringify(authored, null, 2));
  console.log('froze registers to concept-authored.json');
  return authored;
}

// ---------- description pool ----------
interface Desc { key: string; mech: string; register: Register; text: string; vec: number[] }

async function main() {
  const authored = await loadOrAuthor();

  // flat pool of 36 descriptions
  const pool: Desc[] = [];
  for (const m of MECHS) for (const r of REGISTERS) {
    pool.push({ key: `${m.id}::${r}`, mech: m.id, register: r, text: authored[r][m.id], vec: [] });
  }

  // embed all (raw ml.embed — identical treatment for a symmetric similarity task)
  console.log(`embedding ${pool.length} descriptions…`);
  await mapPool(pool, 6, async (d) => { const { vector } = await ml.embed(d.text); d.vec = vector; return null; });
  const bad = pool.filter((d) => !d.vec.length);
  if (bad.length) throw new Error(`empty embeddings: ${bad.map((d) => d.key).join(',')}`);

  const byKey = new Map(pool.map((d) => [d.key, d]));
  const cos = (a: Desc, b: Desc) => cosineSimilarity(a.vec, b.vec);

  // ---------- STAGE 1: recall (embedding vs BM25), gap partition ----------
  const bm = buildBm25(new Map(pool.map((d) => [d.key, d.text])));
  const qTokens = new Map(pool.map((d) => [d.key, new Set(tokenize(d.text))]));

  interface QResult { key: string; mech: string; embTop: string[]; bmTop: string[]; embR1: boolean; embR3: boolean; bmR1: boolean; bmR3: boolean; gap: boolean }
  const q1: QResult[] = pool.map((q) => {
    const others = pool.filter((d) => d.key !== q.key);
    const embRanked = [...others].sort((a, b) => cos(q, b) - cos(q, a)).map((d) => d.key);
    const bmRanked = [...others].sort((a, b) => bm25Score(bm, b.key, qTokens.get(q.key)!) - bm25Score(bm, a.key, qTokens.get(q.key)!)).map((d) => d.key);
    const isTrue = (k: string) => byKey.get(k)!.mech === q.mech;
    const embR1 = isTrue(embRanked[0]!);
    const embR3 = embRanked.slice(0, 3).some(isTrue);
    const bmR1 = isTrue(bmRanked[0]!);
    const bmR3 = bmRanked.slice(0, 3).some(isTrue);
    return { key: q.key, mech: q.mech, embTop: embRanked.slice(0, 3), bmTop: bmRanked.slice(0, 3), embR1, embR3, bmR1, bmR3, gap: !bmR1 };
  });

  const rate = (xs: QResult[], f: (q: QResult) => boolean) => xs.length ? xs.filter(f).length / xs.length : 0;
  const gapQ = q1.filter((q) => q.gap);
  const sharedQ = q1.filter((q) => !q.gap);
  const stage1 = {
    n: q1.length,
    embRecall1: rate(q1, (q) => q.embR1), embRecall3: rate(q1, (q) => q.embR3),
    bmRecall1: rate(q1, (q) => q.bmR1), bmRecall3: rate(q1, (q) => q.bmR3),
    gapCount: gapQ.length,
    embRecall1_gap: rate(gapQ, (q) => q.embR1), embRecall3_gap: rate(gapQ, (q) => q.embR3),
    embRecall1_shared: rate(sharedQ, (q) => q.embR1),
    void: gapQ.length < 6,
    // bars
    barGapPass: gapQ.length >= 6 && rate(gapQ, (q) => q.embR1) >= 0.70,
    barMarginPass: (rate(q1, (q) => q.embR1) - rate(q1, (q) => q.bmR1)) >= 0.30,
  };
  const stage1Pass = !stage1.void && stage1.barGapPass && stage1.barMarginPass;

  // ---------- STAGE 2: adjudicator vs cosine threshold ----------
  const combos: [Register, Register][] = [['normative', 'advisory'], ['normative', 'reference'], ['advisory', 'reference']];
  interface Pair { a: string; b: string; kind: 'true' | 'nearmiss' | 'far'; gt: boolean }
  const pairs: Pair[] = [];
  // TRUE: same mechanism, cross-register
  for (const m of MECHS) for (const [ra, rb] of combos) pairs.push({ a: `${m.id}::${ra}`, b: `${m.id}::${rb}`, kind: 'true', gt: true });
  // NEAR-MISS: mechanism vs its sibling, cross-register (dedup by unordered sibling pair)
  const seenSib = new Set<string>();
  for (const m of MECHS) {
    const sib = [m.id, m.near_miss].sort().join('|');
    if (seenSib.has(sib)) continue;
    seenSib.add(sib);
    for (const [ra, rb] of combos) pairs.push({ a: `${m.id}::${ra}`, b: `${m.near_miss}::${rb}`, kind: 'nearmiss', gt: false });
  }
  // FAR: mechanism i vs mechanism (i+5)%12 if not sibling/self, cross-register (1 combo each)
  for (let i = 0; i < MECHS.length; i++) {
    const m = MECHS[i]!, o = MECHS[(i + 5) % MECHS.length]!;
    if (o.id === m.id || o.id === m.near_miss) continue;
    const [ra, rb] = combos[i % combos.length]!;
    pairs.push({ a: `${m.id}::${ra}`, b: `${o.id}::${rb}`, kind: 'far', gt: false });
  }

  console.log(`adjudicating ${pairs.length} pairs (true ${pairs.filter((p) => p.kind === 'true').length}, near-miss ${pairs.filter((p) => p.kind === 'nearmiss').length}, far ${pairs.filter((p) => p.kind === 'far').length})…`);

  interface Judged extends Pair { same: boolean; reasoning: string; cos: number }
  let done = 0;
  const judged: Judged[] = await mapPool(pairs, 6, async (p) => {
    const A = byKey.get(p.a)!, B = byKey.get(p.b)!;
    const prompt = [
      `Here are two short technical descriptions of C++ behaviours.`,
      ``,
      `Description A: ${A.text}`,
      ``,
      `Description B: ${B.text}`,
      ``,
      `Do A and B describe the SAME underlying mechanism/defect, or DIFFERENT ones?`,
      `Judge by meaning, not wording. Return JSON: {"same": true|false, "reasoning": "one sentence"}.`,
    ].join('\n');
    let same = false, reasoning = '';
    try {
      const r = await ml.generateJson<{ same: boolean; reasoning: string }>(prompt);
      same = r.same === true; reasoning = String(r.reasoning ?? '');
    } catch (e) { reasoning = `ERROR ${(e as Error).message}`; }
    if (++done % 10 === 0) console.log(`  ${done}/${pairs.length} judged`);
    return { ...p, same, reasoning, cos: cosineSimilarity(A.vec, B.vec) };
  });

  // adjudicator confusion
  const conf = (xs: Judged[]) => {
    const tp = xs.filter((p) => p.gt && p.same).length;
    const fn = xs.filter((p) => p.gt && !p.same).length;
    const fp = xs.filter((p) => !p.gt && p.same).length;
    const tn = xs.filter((p) => !p.gt && !p.same).length;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const spec = fp + tn ? tn / (fp + tn) : 0;
    return { tp, fn, fp, tn, recall, spec, ba: (recall + spec) / 2 };
  };
  const adjAll = conf(judged);
  const adjNear = conf(judged.filter((p) => p.kind === 'nearmiss'));
  const adjFar = conf(judged.filter((p) => p.kind === 'far'));

  // best-in-hindsight cosine threshold on the SAME pairs
  const thresholds = [...new Set(judged.map((p) => p.cos))].sort((a, b) => a - b);
  let bestT = 0, bestBA = 0, bestNearSpec = 0;
  for (const t of thresholds) {
    const pred = (p: Judged) => p.cos >= t; // >= t => "same"
    const tp = judged.filter((p) => p.gt && pred(p)).length;
    const fn = judged.filter((p) => p.gt && !pred(p)).length;
    const fp = judged.filter((p) => !p.gt && pred(p)).length;
    const tn = judged.filter((p) => !p.gt && !pred(p)).length;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const spec = fp + tn ? tn / (fp + tn) : 0;
    const ba = (recall + spec) / 2;
    if (ba > bestBA) {
      bestBA = ba; bestT = t;
      const near = judged.filter((p) => p.kind === 'nearmiss');
      const nfp = near.filter((p) => pred(p)).length, ntn = near.filter((p) => !pred(p)).length;
      bestNearSpec = nfp + ntn ? ntn / (nfp + ntn) : 0;
    }
  }

  const stage2 = {
    nPairs: pairs.length,
    adjudicator: { all: adjAll, nearmiss: adjNear, far: adjFar },
    cosThreshold: { bestT, bestBA, bestNearSpec },
    barMarginPass: (adjAll.ba - bestBA) >= 0.10,
    barNearSpecPass: adjNear.spec >= 0.70,
  };
  const stage2Pass = stage2.barMarginPass && stage2.barNearSpecPass;

  // ---------- report ----------
  const out = { generatedFrom: 'concept-resolution.ts', stage1, stage2, stage1Pass, stage2Pass, q1, judged };
  writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));

  const pct = (x: number) => (x * 100).toFixed(0) + '%';
  console.log('\n=== STAGE 1: embedding vs BM25 recall (concept resolution across prose) ===');
  console.log(`  full set (n=${stage1.n}):  embedding R@1 ${pct(stage1.embRecall1)} R@3 ${pct(stage1.embRecall3)}  |  BM25 R@1 ${pct(stage1.bmRecall1)} R@3 ${pct(stage1.bmRecall3)}`);
  console.log(`  GAP subset (BM25 misses, n=${stage1.gapCount}):  embedding R@1 ${pct(stage1.embRecall1_gap)} R@3 ${pct(stage1.embRecall3_gap)}`);
  console.log(`  SHARED-vocab subset (n=${stage1.n - stage1.gapCount}):  embedding R@1 ${pct(stage1.embRecall1_shared)}`);
  console.log(`  bars: gap R@1>=70% -> ${stage1.barGapPass}   full margin>=+30pt -> ${stage1.barMarginPass}   void(<6 gap) -> ${stage1.void}`);
  console.log(`  STAGE 1: ${stage1.void ? 'VOID (no gap)' : stage1Pass ? 'PASS' : 'FAIL'}`);

  console.log('\n=== STAGE 2: adjudicator vs best-in-hindsight cosine threshold ===');
  const line = (n: string, c: ReturnType<typeof conf>) => `    ${n.padEnd(10)} rec ${pct(c.recall)} spec ${pct(c.spec)} BA ${c.ba.toFixed(3)} (tp${c.tp} fn${c.fn} fp${c.fp} tn${c.tn})`;
  console.log('  adjudicator:'); console.log(line('ALL', adjAll)); console.log(line('near-miss', adjNear)); console.log(line('far', adjFar));
  console.log(`  best cosine threshold: t=${bestT.toFixed(3)} BA ${bestBA.toFixed(3)} near-miss-spec ${pct(bestNearSpec)}`);
  console.log(`  bars: adj BA - cos BA >=+0.10 -> ${stage2.barMarginPass} (${(adjAll.ba - bestBA).toFixed(3)})   near-miss spec>=70% -> ${stage2.barNearSpecPass} (${pct(adjNear.spec)})`);
  console.log(`  STAGE 2: ${stage2Pass ? 'PASS' : 'FAIL'}`);
  console.log(`\nwrote ${RESULTS_FILE}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
