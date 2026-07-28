/**
 * doc 34 §6 step 1 — build a REAL per-corpus entity+fact graph via the production
 * extraction path, so the multi-hop concept question (concept → entity → fact → entity
 * → source) is testable at all. Prior to this every experiment ran on flat, factless
 * entity lists.
 *
 * Uses ingestBatch(mode:'epoch', corpusId) — the single-writer propose→promote path, now
 * corpus-scoped. NOT a bespoke writer: the point is to exercise the real pipeline.
 *
 * Resumable: a ledger of ingested doc ids per corpus is kept beside the artifacts, so a
 * crashed or interrupted run re-runs only what is missing.
 *
 * Run (cognitive_test, alongside the doc-20 concept graph). NODE_ENV=test SKIPS dotenv
 * (config.ts:4), so QDRANT_URL/ML_SERVICES_URL must be passed explicitly or they fall back
 * to :6333/:8000 defaults and Qdrant refuses the connection:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     QDRANT_URL=http://localhost:6335 ML_SERVICES_URL=http://localhost:8000 \
 *     NODE_ENV=test npx tsx src/test/tools/corpus-graph-ingest.ts --corpus=A --limit=6
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ingestBatch } from '../../pipeline.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '../../../../docs/architecture/cross-corpus-audit');
const OUT = join(DOCS, 'multihop-artifacts');

/** Corpus ids are stable and meaningful — they appear in every downstream query. */
const CORPORA = {
  A: { file: 'convergence-artifacts/corpus-A.json', corpusId: 'arxiv-nlp' },
  B: { file: 'convergence-artifacts/corpus-B.json', corpusId: 'arxiv-cv' },
} as const;

interface Doc { id: string; title: string; abstract: string }

function arg(name: string, dflt?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

function rows(r: unknown): Array<Record<string, unknown>> {
  return r as unknown as Array<Record<string, unknown>>;
}

async function graphStats(corpusId: string): Promise<{ entities: number; facts: number }> {
  const e = rows(await db.execute(sql`SELECT count(*)::int AS n FROM public.entities WHERE corpus_id = ${corpusId}`));
  const f = rows(await db.execute(sql`SELECT count(*)::int AS n FROM public.facts WHERE corpus_id = ${corpusId}`));
  return { entities: e[0]!.n as number, facts: f[0]!.n as number };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const which = (arg('corpus', 'A') ?? 'A').toUpperCase() as keyof typeof CORPORA;
  if (!CORPORA[which]) throw new Error(`--corpus must be A or B, got '${which}'`);
  const { file, corpusId } = CORPORA[which];
  const limit = Number(arg('limit', '0'));
  const batchSize = Number(arg('batch', '10'));
  const concurrency = Number(arg('concurrency', '4'));

  const docs: Doc[] = JSON.parse(readFileSync(join(DOCS, file), 'utf8'));
  const ledgerPath = join(OUT, `ingest-ledger-${corpusId}.json`);
  const done: string[] = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : [];
  const doneSet = new Set(done);

  let todo = docs.filter((d) => !doneSet.has(d.id));
  if (limit > 0) todo = todo.slice(0, limit);

  const before = await graphStats(corpusId);
  // Ledger/DB drift guard. Wiping the corpus in SQL without clearing the ledger would
  // silently SKIP those docs, leaving them absent from the graph with no error — exactly
  // the kind of quiet inconsistency that has cost this project whole runs. Cheap check:
  // a non-empty ledger with an empty corpus is always drift.
  if (doneSet.size > 0 && before.entities === 0) {
    throw new Error(
      `ledger/DB drift: ledger claims ${doneSet.size} doc(s) ingested for '${corpusId}' but the corpus ` +
        `has 0 entities. Delete ${ledgerPath} to re-ingest from scratch.`,
    );
  }
  console.log(
    `[${corpusId}] corpus=${which} docs=${docs.length} already=${doneSet.size} todo=${todo.length} ` +
      `batch=${batchSize} concurrency=${concurrency} | before: ${before.entities} entities, ${before.facts} facts`,
  );
  if (todo.length === 0) { console.log('nothing to do'); return; }

  // Batched epochs rather than one 147-chunk epoch: keeps each planPromotion bounded and
  // makes the run resumable at batch granularity.
  for (let i = 0; i < todo.length; i += batchSize) {
    const slice = todo.slice(i, i + batchSize);
    const chunks = slice.map((d) => `${d.title}. ${d.abstract}`);
    const t0 = Date.now();
    try {
      const res = await ingestBatch(chunks, {
        mode: 'epoch',
        corpusId,
        concurrency,
        contentType: 'prose',
        source: `${corpusId}:batch${Math.floor(i / batchSize)}`,
      });
      const ents = res.results.reduce((s, r) => s + r.entities.length, 0);
      const fcts = res.results.reduce((s, r) => s + r.facts.length, 0);
      for (const d of slice) doneSet.add(d.id);
      writeFileSync(ledgerPath, JSON.stringify([...doneSet], null, 2));
      const st = await graphStats(corpusId);
      console.log(
        `  batch ${Math.floor(i / batchSize) + 1}: ${slice.length} docs → ${ents} entities, ${fcts} facts ` +
          `(+${((Date.now() - t0) / 1000).toFixed(0)}s) | corpus now ${st.entities} entities / ${st.facts} facts`,
      );
    } catch (err) {
      // Fail loud but keep the ledger honest — this batch is NOT marked done, so a re-run retries it.
      console.error(`  batch ${Math.floor(i / batchSize) + 1} FAILED (not marked done): ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  const after = await graphStats(corpusId);
  console.log(
    `[${corpusId}] done. ${after.entities} entities (+${after.entities - before.entities}), ` +
      `${after.facts} facts (+${after.facts - before.facts}); ledger=${doneSet.size}/${docs.length}`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
