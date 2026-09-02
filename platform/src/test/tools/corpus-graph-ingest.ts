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
  // prereg-24 (nmemo-u8j.3): new-domain generalization corpus — arXiv q-bio abstracts.
  C: { file: 'convergence-artifacts/corpus-C.json', corpusId: 'qbio' },
} as const;

interface Doc { id: string; title: string; abstract: string }

function arg(name: string, dflt?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

function rows(r: unknown): Array<Record<string, unknown>> {
  return r as unknown as Array<Record<string, unknown>>;
}

/**
 * Snapshot paper attribution for ONE just-completed batch, immediately.
 *
 * This must happen per batch, not at the end of the run. Two facts force it:
 *   1. `runEpochBatch` returns ONE aggregated ExtractResult per epoch — the pipeline says so
 *      itself ("Per-chunk attribution is gone (promotion is epoch-wide)") — so a batch of 10
 *      papers yields batch-level, not paper-level, attribution.
 *   2. `cleanupAbandonedStaging()` runs on EVERY epoch batch and deletes staging older than
 *      STAGING_TTL_MS (default 1 HOUR). Consumed staging is therefore garbage-collected
 *      mid-run — an earlier design that read it after the fact was relying on a transient
 *      window and silently lost corpus A's provenance.
 *
 * Here chunk_index → paper needs no Qdrant lookup or content matching: this harness built the
 * slice, so it knows the mapping exactly. Facts are matched to canonical rows by the reasoning
 * text promotion copies into `facts.source_text`; a fact whose matches disagree on the paper is
 * EXCLUDED rather than attributed to several, so a stale row can never mis-attribute.
 */
async function snapshotAttribution(
  corpusId: string,
  sourceId: string,
  slice: Doc[],
): Promise<{ facts: number; entities: number; excluded: number }> {
  const chunkToPaper = new Map<number, string>(slice.map((d, i) => [i, d.id]));

  const r = rows(await db.execute(sql`
    SELECT f.id::text AS fact_id,
           f.subject_entity_id::text AS subj,
           f.object_entity_id::text AS obj,
           s.chunk_index AS chunk_index
    FROM public.facts f
    JOIN public.staging_proposed_facts s ON s.reasoning = f.source_text
    WHERE f.corpus_id = ${corpusId} AND s.source_id = ${sourceId}::uuid
  `));

  const candidates = new Map<string, Set<string>>();
  const endpoints = new Map<string, Array<string | null>>();
  for (const row of r) {
    const paper = chunkToPaper.get(Number(row.chunk_index));
    if (!paper) continue;
    const fid = row.fact_id as string;
    const set = candidates.get(fid) ?? new Set<string>();
    set.add(paper);
    candidates.set(fid, set);
    endpoints.set(fid, [row.subj as string | null, row.obj as string | null]);
  }

  const path = join(OUT, `attribution-${corpusId}.json`);
  const acc: { paperToEntities: Record<string, string[]>; factToPaper: Record<string, string> } =
    existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { paperToEntities: {}, factToPaper: {} };

  let excluded = 0, factsAdded = 0;
  const touchedEntities = new Set<string>();
  for (const [fid, papers] of candidates) {
    if (papers.size > 1) { excluded += 1; continue; }
    const paper = [...papers][0]!;
    acc.factToPaper[fid] = paper;
    factsAdded += 1;
    const list = new Set(acc.paperToEntities[paper] ?? []);
    for (const e of endpoints.get(fid) ?? []) {
      if (!e) continue;
      list.add(e);
      touchedEntities.add(e);
    }
    acc.paperToEntities[paper] = [...list].sort();
  }
  writeFileSync(path, JSON.stringify(acc, null, 2));
  return { facts: factsAdded, entities: touchedEntities.size, excluded };
}

async function graphStats(corpusId: string): Promise<{ entities: number; facts: number }> {
  const e = rows(await db.execute(sql`SELECT count(*)::int AS n FROM public.entities WHERE corpus_id = ${corpusId}`));
  const f = rows(await db.execute(sql`SELECT count(*)::int AS n FROM public.facts WHERE corpus_id = ${corpusId}`));
  return { entities: e[0]!.n as number, facts: f[0]!.n as number };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const which = (arg('corpus', 'A') ?? 'A').toUpperCase() as keyof typeof CORPORA;
  if (!CORPORA[which]) throw new Error(`--corpus must be one of ${Object.keys(CORPORA).join('/')}, got '${which}'`);
  // --corpusId overrides the default id so the SAME source documents can be
  // ingested into a fresh graph without touching an existing one. The ledger and
  // attribution artifacts are already keyed by corpusId, so a new id gets its own
  // resumable ledger automatically. Used by the description-aligned retrieval
  // pre-registration (single-graph/02) to build dal-nlp / dal-cv beside the
  // original arxiv-nlp / arxiv-cv graphs.
  const { file, corpusId: defaultCorpusId } = CORPORA[which];
  const corpusId = arg('corpusId', defaultCorpusId)!;
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

      // BEFORE marking done: capture paper attribution while this batch's staging is fresh.
      // If this throws, the batch is not marked done and the whole run stops — attribution is
      // load-bearing for the doc-35 measurement, so a graph without it is worse than no graph.
      const attr = await snapshotAttribution(corpusId, res.sourceId, slice);

      for (const d of slice) doneSet.add(d.id);
      writeFileSync(ledgerPath, JSON.stringify([...doneSet], null, 2));
      const st = await graphStats(corpusId);
      console.log(
        `  batch ${Math.floor(i / batchSize) + 1}: ${slice.length} docs → ${ents} entities, ${fcts} facts ` +
          `(+${((Date.now() - t0) / 1000).toFixed(0)}s) | corpus now ${st.entities} entities / ${st.facts} facts ` +
          `| attributed ${attr.facts} facts / ${attr.entities} entities (excluded ${attr.excluded})`,
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
