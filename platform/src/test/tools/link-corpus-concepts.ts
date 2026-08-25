/**
 * Concept-link the ingested arXiv entities into the shared `_concepts` super-graph
 * (doc 34 §7.2 step 1).
 *
 * For every entity in each corpus, extract the concepts it belongs to and stage an
 * exhibits/addresses bridge to a resolved concept node. Two deliberate choices:
 *
 *  - **Relation carries DIRECTION, not semantics.** Corpus A uses `exhibits`, corpus B
 *    `addresses`, so the shipped `recallConceptCandidates` JOIN and the multi-hop primitive
 *    both work unchanged on a symmetric corpus pair (doc 19 D-C4 already makes the relation
 *    the side discriminator).
 *  - **Shared-vocabulary window.** doc 34 §2 measured what blind extraction plus a
 *    trigram-0.4 name merge costs: only 4 of 104 concepts were touched by both sides. Here
 *    the extractor is shown the nearest existing labels and asked to reuse them verbatim —
 *    the docs 25-27 conform mechanism, owed since doc-20 §13(d). The window is built ONLY
 *    from concepts already linked to these corpora: `_concepts` is global and still holds the
 *    104 C++ concepts from doc-20, which would otherwise pollute an ML-paper vocabulary.
 *
 * Concept embeddings are backfilled as concepts appear (the documented `.22` backfill never
 * landed — doc 34 §1 found 0 of 104 embedded), which is what makes the window
 * nearest-neighbour rather than arbitrary.
 *
 * Resumable via a per-corpus ledger of entity ids.
 *
 * CONCURRENCY, and what it costs the measurement (user decision, 2026-08-25). Strictly
 * serial this is one LLM call per entity over ~2,680 entities: 3-6h and several
 * session-limit interruptions. `--concurrency` runs N calls in flight instead. The
 * population, the per-entity prompt and the one-call-per-entity accounting are all
 * UNCHANGED; the single difference is that an entity's shared-vocabulary window cannot see
 * concepts minted by the N-1 calls running beside it, so label reuse is marginally LOWER
 * than strictly serial would give. That biases the run AGAINST the concept layer, which is
 * the safe direction for the quantity under test, and it is recorded here rather than left
 * to be discovered in the artifacts. Default 6 matches the ML service's LLM worker pool.
 *
 * Run: cd platform && DATABASE_URL=...cognitive_test QDRANT_URL=http://localhost:6335 \
 *   ML_SERVICES_URL=http://localhost:8000 NODE_ENV=test \
 *   npx tsx src/test/tools/link-corpus-concepts.ts --corpus=A [--limit=N] [--concurrency=6]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { extractAndLinkConcepts, CONCEPT_CORPUS } from '../../services/concept-extraction.js';
import { ml } from '../../services/ml-client.js';
import { mapWithConcurrency, withRetry, isRetryableAgentError } from '../../services/concurrency.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA = {
  A: { corpusId: 'arxiv-nlp', relation: 'exhibits' as const },
  B: { corpusId: 'arxiv-cv', relation: 'addresses' as const },
};
const WINDOW = 100;

function arg(name: string, dflt?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
function rows(r: unknown): Array<Record<string, unknown>> {
  return r as unknown as Array<Record<string, unknown>>;
}

/**
 * Retry predicate for one linking call. `isRetryableAgentError` covers 503 backpressure and
 * the flaky `claude -p` subprocess (`rc=1`), and correctly refuses to retry a session limit.
 * It does NOT cover an ML client TIMEOUT: `generateJson` aborts at 60s and ml-client rethrows
 * the AbortError as `ML /chat failed (0): Request timed out` without retrying it. Observed
 * calls average ~24s, so a slow tail call is ordinary variance — and it killed a run at
 * 44/1218 entities. Retrying re-issues the SAME call for the SAME entity, so the
 * one-call-per-entity accounting is unchanged.
 *
 * Kept local to this harness on purpose: `isRetryableAgentError` is shared production code
 * whose scope (agent-subprocess flakiness) is deliberate, and broadening it as a side effect
 * of a test harness's needs would change retry behaviour for every caller.
 */
function isRetryableLinkError(err: unknown): boolean {
  if (isRetryableAgentError(err)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /request timed out/i.test(msg);
}
function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Concepts already linked to EITHER arXiv corpus, with embeddings — the window candidates. */
async function loadArxivConcepts(): Promise<Array<{ id: string; name: string; vec: number[] | null }>> {
  return rows(await db.execute(sql`
    SELECT DISTINCT c.id::text AS id, c.canonical_name AS name, c.embedding::text AS emb
    FROM public.entities c
    JOIN public.bridge_edges be ON be.b_ref = c.id AND be.expired_at IS NULL
    WHERE c.corpus_id = ${CONCEPT_CORPUS}
      AND be.source_corpus_id IN ('arxiv-nlp', 'arxiv-cv')
  `)).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    vec: r.emb ? (JSON.parse(r.emb as string) as number[]) : null,
  }));
}

async function backfillConceptEmbeddings(ids: string[]): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const r = rows(await db.execute(
      sql`SELECT canonical_name AS name FROM public.entities WHERE id = ${id}::uuid AND embedding IS NULL`,
    ));
    if (r.length === 0) continue;
    const { vector: vec } = await ml.embed(r[0]!.name as string);
    await db.execute(sql`
      UPDATE public.entities SET embedding = ${sql.raw(`'[${vec.join(',')}]'::vector`)} WHERE id = ${id}::uuid
    `);
    n += 1;
  }
  return n;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const which = (arg('corpus', 'A') ?? 'A').toUpperCase() as keyof typeof CORPORA;
  if (!CORPORA[which]) throw new Error(`--corpus must be A or B, got '${which}'`);
  const { corpusId, relation } = CORPORA[which];
  const limit = Number(arg('limit', '0'));
  const concurrency = Math.max(1, Number(arg('concurrency', '6')));

  const entities = rows(await db.execute(sql`
    SELECT id::text AS id, canonical_name AS name, coalesce(description, '') AS description,
           embedding::text AS emb
    FROM public.entities WHERE corpus_id = ${corpusId} ORDER BY canonical_name
  `));
  if (entities.length === 0) throw new Error(`no entities in '${corpusId}' — run corpus-graph-ingest first`);

  const ledgerPath = join(OUT, `concept-ledger-${corpusId}.json`);
  const done = new Set<string>(existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : []);
  let todo = entities.filter((e) => !done.has(e.id as string));
  if (limit > 0) todo = todo.slice(0, limit);
  console.log(
    `[${corpusId}] entities=${entities.length} already=${done.size} todo=${todo.length} ` +
      `relation=${relation} concurrency=${concurrency}`,
  );

  let vocab = await loadArxivConcepts();
  let linked = 0, empty = 0, completed = 0;

  await mapWithConcurrency(todo, concurrency, async (e) => {
    const name = e.name as string;
    const text = (e.description as string) ? `${name}. ${e.description as string}` : name;

    // Nearest existing labels by embedding; falls back to the most recent when vectors are
    // absent. This is whatever vocabulary snapshot is current when the call starts — see the
    // header note on what concurrency costs the window.
    const eVec = e.emb ? (JSON.parse(e.emb as string) as number[]) : null;
    const snapshot = vocab;
    const withVec = snapshot.filter((v) => v.vec);
    const window = (eVec && withVec.length > 0)
      ? withVec.map((v) => ({ v, s: cosine(eVec, v.vec!) })).sort((a, b) => b.s - a.s).slice(0, WINDOW).map((x) => x.v.name)
      : snapshot.slice(0, WINDOW).map((v) => v.name);

    // Retry transient ML backpressure, flaky subprocesses and slow-tail timeouts. A session
    // limit is NOT retryable, so the run fails loud with every finished entity still recorded
    // in the ledger.
    const res = await withRetry(() => extractAndLinkConcepts({
      elementEntityId: e.id as string,
      corpusId,
      side: 'entity',
      relation,
      name,
      text,
      vocabulary: window,
    }), { retries: 4, isRetryable: isRetryableLinkError, baseDelayMs: 500 });

    if (res.labels.length === 0) empty += 1;
    linked += res.linked;
    await backfillConceptEmbeddings(res.conceptIds);

    // writeFileSync from an async callback is atomic against the other in-flight workers:
    // Node is single-threaded, so no interleaved ledger write is possible.
    done.add(e.id as string);
    writeFileSync(ledgerPath, JSON.stringify([...done], null, 2));

    completed += 1;
    // Refresh the window on a completion counter rather than a loop index — one query per 10
    // finished entities, the same cadence the serial version used.
    if (completed % 10 === 0) vocab = await loadArxivConcepts();
    if (completed % 20 === 0) {
      console.log(`  ${completed}/${todo.length} entities | vocab=${vocab.length} | bridges=${linked} | empty=${empty}`);
    }
  });

  const finalVocab = await loadArxivConcepts();
  const bridgeCount = rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM public.bridge_edges
    WHERE source_corpus_id = ${corpusId} AND relation = ${relation} AND expired_at IS NULL
  `))[0]!.n;
  console.log(
    `[${corpusId}] done. bridges=${bridgeCount}, arXiv concept vocab=${finalVocab.length}, ` +
      `entities with no concepts=${empty}/${todo.length}`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
