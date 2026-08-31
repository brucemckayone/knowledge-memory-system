/**
 * Held-out mention retrieval — the harness for TWO frozen pre-registrations:
 *
 *   docs/architecture/single-graph/02-prereg-description-aligned-retrieval.md
 *     ARM-NAME (bare-name entity vectors) vs ARM-DESC (name+description vectors)
 *
 *   docs/architecture/single-graph/04-prereg-hybrid-bm25-rrf.md
 *     VEC vs BM25 vs retrieved-set RRF vs full-ranking RRF
 *
 * ONE task, one query set, one oracle, so the two are directly comparable. Read
 * both documents before changing anything here: they are frozen, and this file
 * is meant to implement them exactly rather than improve on them.
 *
 * TASK (doc 02 section 4). A query pair is (entity e, document d) where e is
 * attributed to d, e is attributed to at least 2 documents, and d is NOT e's
 * first-attributing document. The held-out constraint is the non-tautology guard:
 * an entity's description is authored at mint time, i.e. in the epoch of its
 * first attribution, so restricting queries to LATER-attributing documents means
 * the description was not written from the query text.
 *
 * "First-attributing document" is resolved by INGEST ORDER, read from the
 * resumable ingest ledger, not by dict order in the attribution artifact.
 *
 * ORACLE. Ground truth by construction from per-document attribution. No LLM, no
 * external oracle, and specifically no embedding-correlated oracle.
 *
 * RANKING. Exact cosine in-process over the full entity set - deliberately NOT
 * through the HNSW index, because post-filtered HNSW recall is itself a variable
 * on this branch (migration 058) and an approximate index must not move a
 * headline.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     NODE_ENV=test npx tsx src/test/tools/desc-aligned-recall.ts --corpora=dal-nlp,dal-cv
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { rawQuery } from '../../db/raw.js';
import { ml } from '../../services/ml-client.js';
import { entityEmbedTextFor } from '../../services/embed-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');

function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG — the bootstrap must be reproducible. Math.random() is not.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------
function normalise(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  return v.map((x) => x / n);
}
/** Dot product of two ALREADY-NORMALISED vectors = cosine similarity. */
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

// ---------------------------------------------------------------------------
// BM25 (doc 04: k1 = 1.2, b = 0.75, standard defaults, FIXED - not tuned)
// ---------------------------------------------------------------------------
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Lowercase, split on non-alphanumerics. No stemming, no stopword list - stated
 *  in the pre-registration so it cannot be quietly changed. */
function tokenise(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

interface Bm25Index {
  docTokens: string[][];
  docLen: number[];
  avgLen: number;
  df: Map<string, number>;
  n: number;
}

function buildBm25(docs: string[]): Bm25Index {
  const docTokens = docs.map(tokenise);
  const docLen = docTokens.map((t) => t.length);
  const avgLen = docLen.reduce((s, x) => s + x, 0) / Math.max(1, docLen.length);
  const df = new Map<string, number>();
  for (const toks of docTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { docTokens, docLen, avgLen, df, n: docs.length };
}

/** BM25 score of every document against a query. Returns raw scores; a score of
 *  0 means the document shares no query term, i.e. BM25 did not retrieve it. */
function bm25Scores(idx: Bm25Index, query: string): number[] {
  const qTerms = tokenise(query);
  const tf: Array<Map<string, number>> = idx.docTokens.map((toks) => {
    const m = new Map<string, number>();
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });
  const scores = new Array<number>(idx.n).fill(0);
  const seen = new Set<string>();
  for (const q of qTerms) {
    if (seen.has(q)) continue; // a repeated query term contributes once
    seen.add(q);
    const n_q = idx.df.get(q);
    if (!n_q) continue;
    const idf = Math.log(1 + (idx.n - n_q + 0.5) / (n_q + 0.5));
    for (let d = 0; d < idx.n; d++) {
      const f = tf[d]!.get(q);
      if (!f) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (idx.docLen[d]! / idx.avgLen));
      scores[d] = scores[d]! + idf * ((f * (BM25_K1 + 1)) / denom);
    }
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Ranking + fusion
// ---------------------------------------------------------------------------
/** Indices ordered by score desc, ties broken by index asc so ranking is
 *  deterministic. Only entries with score > minScore are considered RETRIEVED. */
function rankByScore(scores: number[], minScore = -Infinity): number[] {
  const idx = scores.map((_, i) => i).filter((i) => scores[i]! > minScore);
  idx.sort((a, b) => (scores[b]! - scores[a]!) || (a - b));
  return idx;
}

/**
 * Retrieved-set RRF (canonical Cormack 2009). Each arm contributes
 * 1/(K + rank) ONLY for items it actually retrieved, and nothing for items it
 * did not. This is the variant doc 22 found post-hoc and never pre-registered.
 */
function rrfRetrievedSet(rankings: number[][], K: number, universe: number): number[] {
  const score = new Array<number>(universe).fill(0);
  for (const ranking of rankings) {
    for (let r = 0; r < ranking.length; r++) {
      score[ranking[r]!] = score[ranking[r]!]! + 1 / (K + r + 1);
    }
  }
  return score;
}

/**
 * Full-ranking RRF: every arm ranks every candidate, so a sparse arm assigns
 * fabricated tail ranks. Doc 22's PRE-REGISTERED variant, which failed. Included
 * so the retrieved-set/full-ranking distinction is measured, not asserted.
 */
function rrfFullRanking(rankings: number[][], K: number, universe: number): number[] {
  const score = new Array<number>(universe).fill(0);
  for (const ranking of rankings) {
    const rankOf = new Array<number>(universe).fill(ranking.length);
    for (let r = 0; r < ranking.length; r++) rankOf[ranking[r]!] = r;
    for (let i = 0; i < universe; i++) score[i] = score[i]! + 1 / (K + rankOf[i]! + 1);
  }
  return score;
}

// ---------------------------------------------------------------------------
// Metrics + paired bootstrap
// ---------------------------------------------------------------------------
interface PerQuery { hit1: number; hit5: number; hit10: number; rr: number }

function scoreQuery(ranking: number[], targetIdx: number): PerQuery {
  const pos = ranking.indexOf(targetIdx); // 0-based
  const rank = pos < 0 ? Infinity : pos + 1;
  return {
    hit1: rank <= 1 ? 1 : 0,
    hit5: rank <= 5 ? 1 : 0,
    hit10: rank <= 10 ? 1 : 0,
    rr: rank === Infinity ? 0 : 1 / rank,
  };
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/** Paired bootstrap CI of (armA - armB), resampling QUERY PAIRS. 10,000
 *  resamples, seeded - doc 02 section "Bar" and doc 04 section 5. */
function pairedBootstrapCI(
  a: number[],
  b: number[],
  resamples = 10_000,
  seed = 20260831,
): { delta: number; lo: number; hi: number } {
  const n = a.length;
  const delta = mean(a) - mean(b);
  if (n === 0) return { delta: NaN, lo: NaN, hi: NaN };
  const rnd = mulberry32(seed);
  const deltas: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rnd() * n);
      sa += a[j]!;
      sb += b[j]!;
    }
    deltas.push(sa / n - sb / n);
  }
  deltas.sort((x, y) => x - y);
  return {
    delta,
    lo: deltas[Math.floor(0.025 * resamples)]!,
    hi: deltas[Math.floor(0.975 * resamples) - 1]!,
  };
}

function verdict(lo: number, hi: number): string {
  if (lo > 0) return 'DEMONSTRATED (CI entirely above 0)';
  if (hi < 0) return 'HARMS (CI entirely below 0)';
  return 'TIE — not demonstrated (CI spans 0)';
}

// ---------------------------------------------------------------------------
// Embedding with an on-disk cache (a re-run must not re-embed)
// ---------------------------------------------------------------------------
type Cache = Record<string, number[]>;

async function embedAll(texts: string[], cachePath: string): Promise<Map<string, number[]>> {
  const cache: Cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  const out = new Map<string, number[]>();
  let fresh = 0;
  for (const t of texts) {
    if (cache[t]) {
      out.set(t, cache[t]!);
      continue;
    }
    const { vector } = await ml.embed(t);
    if (!vector || vector.length === 0) throw new Error(`empty embedding for: ${t.slice(0, 80)}`);
    const nv = normalise(vector);
    cache[t] = nv;
    out.set(t, nv);
    fresh += 1;
    if (fresh % 200 === 0) {
      writeFileSync(cachePath, JSON.stringify(cache));
      console.log(`   embedded ${fresh} fresh / ${texts.length} total`);
    }
  }
  writeFileSync(cachePath, JSON.stringify(cache));
  console.log(`   embeddings: ${texts.length} texts (${fresh} fresh, ${texts.length - fresh} cached)`);
  return out;
}

// ---------------------------------------------------------------------------
interface Doc { id: string; title: string; abstract: string }
interface QueryPair { entityId: string; docId: string; corpusId: string }

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const corpora = arg('corpora', 'dal-nlp,dal-cv').split(',').map((s) => s.trim()).filter(Boolean);
  const docFileFor: Record<string, string> = { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json' };

  console.log(`corpora: ${corpora.join(', ')}`);
  console.log('');

  // ---- 1. Query pairs, per the frozen task definition --------------------
  const allPairs: QueryPair[] = [];
  const docsById = new Map<string, Doc>();
  const entitiesByCorpus = new Map<string, Array<{ id: string; name: string; description: string | null }>>();
  let multiAttributedTotal = 0;

  for (const corpusId of corpora) {
    const attrPath = join(ARC, `attribution-${corpusId}.json`);
    const ledgerPath = join(ARC, `ingest-ledger-${corpusId}.json`);
    if (!existsSync(attrPath) || !existsSync(ledgerPath)) {
      console.error(`missing artifacts for ${corpusId} (${attrPath})`);
      process.exit(1);
    }
    const attr = JSON.parse(readFileSync(attrPath, 'utf8')) as {
      paperToEntities: Record<string, string[]>;
    };
    // Ingest order defines "first-attributing". The ledger is appended per batch.
    const order: string[] = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const orderIdx = new Map(order.map((id, i) => [id, i]));

    const docs: Doc[] = JSON.parse(readFileSync(join(CORPORA_DIR, docFileFor[corpusId]!), 'utf8'));
    for (const d of docs) docsById.set(d.id, d);

    const entToPapers = new Map<string, string[]>();
    for (const [paper, ents] of Object.entries(attr.paperToEntities)) {
      for (const e of ents) {
        const list = entToPapers.get(e) ?? [];
        list.push(paper);
        entToPapers.set(e, list);
      }
    }

    for (const [entityId, papers] of entToPapers) {
      const uniq = [...new Set(papers)].filter((p) => docsById.has(p) && orderIdx.has(p));
      if (uniq.length < 2) continue; // held-out constraint needs >= 2 attributions
      multiAttributedTotal += 1;
      uniq.sort((a, b) => orderIdx.get(a)! - orderIdx.get(b)!);
      // Drop the FIRST-attributing document: its text is where the description
      // was authored, so scoring on it would be tautological for ARM-DESC.
      for (const docId of uniq.slice(1)) allPairs.push({ entityId, docId, corpusId });
    }

    const rows = await rawQuery<{ id: string; name: string; description: string | null }>(sql`
      SELECT id::text AS id, canonical_name AS name, description
      FROM public.entities WHERE corpus_id = ${corpusId} ORDER BY id
    `);
    entitiesByCorpus.set(corpusId, rows);
    console.log(`${corpusId}: ${rows.length} entities, ${order.length} docs ingested`);
  }

  console.log('');
  console.log(`multi-attributed entities: ${multiAttributedTotal}`);
  console.log(`QUERY PAIRS (n): ${allPairs.length}`);

  // ---- 2. Kill conditions (doc 02 section 6, doc 04 section 7) -----------
  const killed: string[] = [];
  if (allPairs.length < 100) {
    killed.push(`UNDERPOWERED: n = ${allPairs.length} < 100 query pairs. No verdict (doc 02 section 6).`);
  }
  for (const corpusId of corpora) {
    const rows = entitiesByCorpus.get(corpusId)!;
    const withDesc = rows.filter((r) => (r.description ?? '').trim().length > 0).length;
    const cov = rows.length ? withDesc / rows.length : 0;
    console.log(`${corpusId}: description coverage ${(cov * 100).toFixed(1)}% (${withDesc}/${rows.length})`);
    if (cov < 0.5) killed.push(`VOID: ${corpusId} description coverage ${(cov * 100).toFixed(1)}% < 50%.`);
  }

  // ---- 3. Diagnostics: description informativeness (doc 02 section 5) ----
  for (const corpusId of corpora) {
    const rows = entitiesByCorpus.get(corpusId)!.filter((r) => (r.description ?? '').trim());
    const lens = rows.map((r) => r.description!.trim().length);
    const overlaps = rows.map((r) => {
      const nameToks = new Set(tokenise(r.name));
      const descToks = new Set(tokenise(r.description!));
      const inter = [...nameToks].filter((t) => descToks.has(t)).length;
      const union = new Set([...nameToks, ...descToks]).size;
      return union ? inter / union : 0;
    });
    console.log(
      `${corpusId}: description mean ${mean(lens).toFixed(0)} chars, ` +
      `mean token-Jaccard vs name ${mean(overlaps).toFixed(3)} ` +
      `(high overlap => a null result means UNINFORMATIVE descriptions, not a failed lever)`,
    );
  }

  if (killed.length > 0) {
    console.log('');
    console.log('=== KILL CONDITIONS TRIPPED — reporting, NOT banking ===');
    for (const k of killed) console.log(`  ${k}`);
    console.log('');
    console.log('Diagnostics above stand; no arm comparison is computed.');
    process.exit(0);
  }

  // ---- 4. Embed both arms + the queries ----------------------------------
  const nameTexts = new Set<string>();
  const descTexts = new Set<string>();
  for (const corpusId of corpora) {
    for (const e of entitiesByCorpus.get(corpusId)!) {
      nameTexts.add(entityEmbedTextFor(e.name, e.description, 'name'));
      descTexts.add(entityEmbedTextFor(e.name, e.description, 'name_description'));
    }
  }
  const queryTexts = new Set<string>();
  for (const p of allPairs) {
    const d = docsById.get(p.docId)!;
    queryTexts.add(`${d.title} ${d.abstract}`);
  }
  console.log('');
  console.log('embedding (cached on disk; a re-run does not re-embed)');
  const embeds = await embedAll(
    [...new Set([...nameTexts, ...descTexts, ...queryTexts])],
    join(OUT, 'embed-cache.json'),
  );

  // ---- 4b. Vector divergence + query truncation ---------------------------
  //
  // Both required unconditionally by doc 02 section 5, and divergence is ALSO
  // kill condition 2 (VOID below 90%). Added after auditing the harness against
  // the frozen pre-registration, which is what that audit step is for: without
  // it, a run where the two arms were nearly identical vectors would have
  // reported a tie as if it meant something about the lever.
  let diverged = 0;
  let comparedVectors = 0;
  for (const corpusId of corpora) {
    for (const e of entitiesByCorpus.get(corpusId)!) {
      const nv = embeds.get(entityEmbedTextFor(e.name, e.description, 'name'))!;
      const dv = embeds.get(entityEmbedTextFor(e.name, e.description, 'name_description'))!;
      comparedVectors += 1;
      if (dot(nv, dv) < 0.999) diverged += 1;
    }
  }
  const divergence = comparedVectors ? diverged / comparedVectors : 0;
  console.log('');
  console.log(
    `vector divergence: ${(divergence * 100).toFixed(1)}% of ${comparedVectors} entities have ` +
    `cosine(name, name+description) < 0.999`,
  );
  if (divergence < 0.9) {
    killed.push(
      `VOID: vector divergence ${(divergence * 100).toFixed(1)}% < 90% — the two arms are not ` +
      'meaningfully different vectors (doc 02 kill condition 2).',
    );
  }

  // nomic-embed-text's context is 2048 tokens. There is no tokeniser here, so
  // this is a CHARACTER-BASED estimate at ~4 chars/token — deliberately
  // conservative, and reported as an estimate rather than a count. The model
  // truncates silently, so a query over the limit is scored on a prefix.
  const NOMIC_TOKEN_LIMIT = 2048;
  const CHARS_PER_TOKEN = 4;
  const charBudget = NOMIC_TOKEN_LIMIT * CHARS_PER_TOKEN;
  const qLens = [...queryTexts].map((t) => t.length);
  const overBudget = qLens.filter((l) => l > charBudget).length;
  console.log(
    `query text length: mean ${mean(qLens).toFixed(0)} chars, max ${Math.max(...qLens)}; ` +
    `${overBudget}/${qLens.length} exceed the ~${charBudget}-char estimate of nomic's ` +
    `${NOMIC_TOKEN_LIMIT}-token limit (silent truncation)`,
  );

  if (killed.length > 0) {
    console.log('');
    console.log('=== KILL CONDITIONS TRIPPED — reporting, NOT banking ===');
    for (const k of killed) console.log(`  ${k}`);
    process.exit(0);
  }

  // ---- 5. Score every arm, per corpus ------------------------------------
  const arms = ['ARM-NAME', 'ARM-DESC', 'BM25', 'RRF-60', 'RRF-FULL-60'] as const;
  const perQuery: Record<string, PerQuery[]> = {};
  for (const a of arms) perQuery[a] = [];
  const rrfByK: Record<number, PerQuery[]> = { 10: [], 30: [], 60: [], 100: [] };
  const overlaps: number[] = [];
  const bm25RetrievedSizes: number[] = [];

  for (const corpusId of corpora) {
    const ents = entitiesByCorpus.get(corpusId)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const nameVecs = ents.map((e) => embeds.get(entityEmbedTextFor(e.name, e.description, 'name'))!);
    const descVecs = ents.map((e) => embeds.get(entityEmbedTextFor(e.name, e.description, 'name_description'))!);
    // doc 04: both retrieval arms see the SAME entity text, so the comparison is
    // of the retrieval function and not of a text difference.
    const bm25 = buildBm25(ents.map((e) => entityEmbedTextFor(e.name, e.description, 'name_description')));

    for (const p of allPairs.filter((q) => q.corpusId === corpusId)) {
      const target = idxOf.get(p.entityId);
      if (target === undefined) continue; // entity not in this corpus's rows
      const d = docsById.get(p.docId)!;
      const qv = embeds.get(`${d.title} ${d.abstract}`)!;

      const nameRank = rankByScore(nameVecs.map((v) => dot(qv, v)));
      const descRank = rankByScore(descVecs.map((v) => dot(qv, v)));
      const bScores = bm25Scores(bm25, `${d.title} ${d.abstract}`);
      const bRank = rankByScore(bScores, 0); // score > 0 => actually retrieved
      bm25RetrievedSizes.push(bRank.length);

      perQuery['ARM-NAME']!.push(scoreQuery(nameRank, target));
      perQuery['ARM-DESC']!.push(scoreQuery(descRank, target));
      perQuery['BM25']!.push(scoreQuery(bRank, target));

      // doc 04's VEC arm is the graph as built = the description arm.
      for (const K of [10, 30, 60, 100]) {
        const fused = rrfRetrievedSet([descRank, bRank], K, ents.length);
        rrfByK[K]!.push(scoreQuery(rankByScore(fused, 0), target));
      }
      perQuery['RRF-60']!.push(rrfByK[60]![rrfByK[60]!.length - 1]!);
      const full = rrfFullRanking([descRank, bRank], 60, ents.length);
      perQuery['RRF-FULL-60']!.push(scoreQuery(rankByScore(full), target));

      const topA = new Set(descRank.slice(0, 10));
      const topB = new Set(bRank.slice(0, 10));
      const inter = [...topA].filter((x) => topB.has(x)).length;
      const uni = new Set([...topA, ...topB]).size;
      overlaps.push(uni ? inter / uni : 0);
    }
  }

  const n = perQuery['ARM-NAME']!.length;
  console.log('');
  console.log(`scored ${n} query pairs`);
  console.log('');
  console.log('| arm | R@1 | R@5 | R@10 | MRR |');
  console.log('|-----|-----|-----|------|-----|');
  for (const a of arms) {
    const q = perQuery[a]!;
    console.log(
      `| ${a} | ${mean(q.map((x) => x.hit1)).toFixed(3)} | ${mean(q.map((x) => x.hit5)).toFixed(3)} ` +
      `| ${mean(q.map((x) => x.hit10)).toFixed(3)} | ${mean(q.map((x) => x.rr)).toFixed(3)} |`,
    );
  }

  // ---- 6. The two pre-registered headlines -------------------------------
  console.log('');
  console.log('=== doc 02 HEADLINE: ARM-DESC minus ARM-NAME, Recall@10 ===');
  const d02 = pairedBootstrapCI(
    perQuery['ARM-DESC']!.map((x) => x.hit10),
    perQuery['ARM-NAME']!.map((x) => x.hit10),
  );
  console.log(`delta ${d02.delta.toFixed(4)}  95% CI [${d02.lo.toFixed(4)}, ${d02.hi.toFixed(4)}]  n=${n}`);
  console.log(`VERDICT: ${verdict(d02.lo, d02.hi)}`);

  console.log('');
  console.log('=== doc 04 HEADLINE: RRF-60 minus max(VEC, BM25), Recall@10 ===');
  const vecR10 = mean(perQuery['ARM-DESC']!.map((x) => x.hit10));
  const bmR10 = mean(perQuery['BM25']!.map((x) => x.hit10));
  const betterName = vecR10 >= bmR10 ? 'ARM-DESC' : 'BM25';
  console.log(`better single arm = ${betterName} (VEC ${vecR10.toFixed(3)} vs BM25 ${bmR10.toFixed(3)})`);
  const d04 = pairedBootstrapCI(
    perQuery['RRF-60']!.map((x) => x.hit10),
    perQuery[betterName]!.map((x) => x.hit10),
  );
  console.log(`delta ${d04.delta.toFixed(4)}  95% CI [${d04.lo.toFixed(4)}, ${d04.hi.toFixed(4)}]  n=${n}`);
  console.log(`VERDICT: ${verdict(d04.lo, d04.hi)}`);

  console.log('');
  console.log('=== K-robustness (doc 04 section 5, REQUIRED) ===');
  for (const K of [10, 30, 60, 100]) {
    console.log(`  RRF K=${K}: R@10 ${mean(rrfByK[K]!.map((x) => x.hit10)).toFixed(3)}`);
  }

  console.log('');
  console.log('=== diagnostics ===');
  console.log(`  arm top-10 overlap (mean Jaccard): ${mean(overlaps).toFixed(3)}` +
    (mean(overlaps) > 0.9 ? '  >>> KILL: arms near-identical, no fusion conclusion' : ''));
  console.log(`  BM25 retrieved-set size: mean ${mean(bm25RetrievedSizes).toFixed(1)}, ` +
    `queries retrieving <10: ${bm25RetrievedSizes.filter((x) => x < 10).length}/${bm25RetrievedSizes.length}`);
  for (const a of arms) {
    const zero = perQuery[a]!.filter((x) => x.rr === 0).length;
    console.log(`  ${a} zero-recall queries: ${zero}/${n}`);
  }

  // ---- 7. Single-pair sensitivity (doc 04 section 7) ---------------------
  const rrf10 = perQuery['RRF-60']!.map((x) => x.hit10);
  const base = perQuery[betterName]!.map((x) => x.hit10);
  let maxSwing = 0;
  for (let i = 0; i < n; i++) {
    const a = rrf10.filter((_, j) => j !== i);
    const b = base.filter((_, j) => j !== i);
    maxSwing = Math.max(maxSwing, Math.abs((mean(a) - mean(b)) - d04.delta));
  }
  console.log(`  max headline swing from dropping ONE query pair: ${maxSwing.toFixed(4)}` +
    (maxSwing > 0.02 ? '  >>> MARGIN-FRAGILE (doc 04 section 7)' : ''));

  const artifact = {
    corpora, n, multiAttributedTotal,
    arms: Object.fromEntries(arms.map((a) => [a, {
      r1: mean(perQuery[a]!.map((x) => x.hit1)),
      r5: mean(perQuery[a]!.map((x) => x.hit5)),
      r10: mean(perQuery[a]!.map((x) => x.hit10)),
      mrr: mean(perQuery[a]!.map((x) => x.rr)),
    }])),
    doc02: d02, doc04: { betterArm: betterName, ...d04 },
    kRobustness: Object.fromEntries([10, 30, 60, 100].map((K) => [K, mean(rrfByK[K]!.map((x) => x.hit10))])),
    diagnostics: { meanArmOverlap: mean(overlaps), meanBm25RetrievedSize: mean(bm25RetrievedSizes), maxSinglePairSwing: maxSwing },
  };
  writeFileSync(join(OUT, 'desc-aligned-recall-results.json'), JSON.stringify(artifact, null, 2));
  console.log('');
  console.log(`artifact written: ${join(OUT, 'desc-aligned-recall-results.json')}`);
  process.exit(0);
}

main();
