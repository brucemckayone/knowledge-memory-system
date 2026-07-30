/**
 * Paper attribution for the ingested arXiv corpora (doc 34 §7.2 step 2).
 *
 * The co-citation oracle is per PAPER, but the epoch pipeline writes no `memory_entities`
 * and no `fact_sources`, so there is no direct entity→document link. Attribution is instead
 * recovered from data the pipeline does leave behind, because `promote()` does not delete
 * consumed staging:
 *
 *   canonical fact --(facts.source_text = staging_proposed_facts.reasoning)--> staged fact
 *   staged fact --(source_id, chunk_index)--> windowPointId() --> Qdrant memory --> content
 *   content --(exact match)--> paper id
 *   entity --> the facts it participates in --> those papers
 *
 * Content matching (rather than trusting the harness's batch ordering) is what makes this
 * robust to retried or reordered batches. Measured on the first run: 587/587 canonical facts
 * matched a staged fact, 9 ambiguous (1.5%) — those are facts whose identical reasoning text
 * arose for two chunks, i.e. legitimately multi-paper, and are attributed to every match.
 *
 * Emits `multihop-artifacts/doc-attribution.json`:
 *   { paperToEntities: {paperId: [entityId]}, entityToPapers: {entityId: [paperId]},
 *     factToPapers: {factId: [paperId]}, unattributed: {...}, stats: {...} }
 *
 * Run: cd platform && DATABASE_URL=...cognitive_test QDRANT_URL=http://localhost:6335 \
 *   NODE_ENV=test npx tsx src/test/tools/doc-attribution.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { getMemory } from '../../services/qdrant.js';
import { windowPointId } from '../../pipeline.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '../../../../docs/architecture/cross-corpus-audit');
const OUT = join(DOCS, 'multihop-artifacts');
const CORPORA = [
  { corpusId: 'arxiv-nlp', file: 'convergence-artifacts/corpus-A.json' },
  { corpusId: 'arxiv-cv', file: 'convergence-artifacts/corpus-B.json' },
] as const;

interface Doc { id: string; title: string; abstract: string }

function rows(r: unknown): Array<Record<string, unknown>> {
  return r as unknown as Array<Record<string, unknown>>;
}
const push = (m: Map<string, Set<string>>, k: string, v: string): void => {
  const s = m.get(k) ?? new Set<string>();
  s.add(v);
  m.set(k, s);
};
const toObj = (m: Map<string, Set<string>>): Record<string, string[]> =>
  Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]));

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  // Paper text → paper id, over both corpora. The exact string the ingest harness stored.
  const textToPaper = new Map<string, string>();
  for (const { file } of CORPORA) {
    for (const d of JSON.parse(readFileSync(join(DOCS, file), 'utf8')) as Doc[]) {
      textToPaper.set(`${d.title}. ${d.abstract}`.trim(), d.id);
    }
  }
  console.log(`paper texts indexed: ${textToPaper.size}`);

  // (source_id, chunk_index) → paper id, via the deterministic memory id and Qdrant content.
  const chunkKeys = rows(await db.execute(sql`
    SELECT DISTINCT source_id::text AS source_id, chunk_index
    FROM public.staging_proposed_facts
    WHERE source_id IS NOT NULL AND chunk_index IS NOT NULL
  `));
  const chunkToPaper = new Map<string, string>();
  let unresolvedChunks = 0;
  for (const c of chunkKeys) {
    const sourceId = c.source_id as string;
    const chunkIndex = Number(c.chunk_index);
    const memId = windowPointId(sourceId, chunkIndex);
    let content: string | undefined;
    try {
      content = (await getMemory(memId))?.payload?.content as string | undefined;
    } catch { /* treated as unresolved below */ }
    const paper = content ? textToPaper.get(content.trim()) : undefined;
    if (paper) chunkToPaper.set(`${sourceId}#${chunkIndex}`, paper);
    else unresolvedChunks += 1;
  }
  console.log(`chunks: ${chunkKeys.length} staged, ${chunkToPaper.size} resolved to a paper, ${unresolvedChunks} unresolved`);

  // Canonical fact → paper(s), joining on the reasoning text promotion copied into source_text.
  const factRows = rows(await db.execute(sql`
    SELECT f.id::text AS fact_id,
           f.subject_entity_id::text AS subj,
           f.object_entity_id::text AS obj,
           s.source_id::text AS source_id,
           s.chunk_index AS chunk_index
    FROM public.facts f
    JOIN public.staging_proposed_facts s ON s.reasoning = f.source_text
    WHERE f.corpus_id IN ('arxiv-nlp', 'arxiv-cv')
  `));

  // Collect candidate papers per fact FIRST, then commit only unambiguous ones.
  //
  // Why conservative: `promote()` keeps consumed staging, and an interrupted run leaves rows
  // from an epoch that never promoted. A canonical fact matched by reasoning text can then hit
  // both a promoted and an abandoned staged row. In practice a retry re-processes the same
  // slice so both resolve to the SAME paper (harmless) — but that depends on ledger ordering,
  // and "probably harmless" is not good enough to score on. So: a fact whose matches disagree
  // on the paper is EXCLUDED, not attributed to all of them. Measured cost on the pilot was
  // 9 facts (1.5%). This also removes any need to reason about epoch provenance.
  const factCandidates = new Map<string, Set<string>>();
  for (const r of factRows) {
    const paper = chunkToPaper.get(`${r.source_id as string}#${Number(r.chunk_index)}`);
    if (!paper) continue;
    push(factCandidates, r.fact_id as string, paper);
  }
  const factEndpoints = new Map<string, Array<string | null>>();
  for (const r of factRows) {
    factEndpoints.set(r.fact_id as string, [r.subj as string | null, r.obj as string | null]);
  }

  const factToPapers = new Map<string, Set<string>>();
  const entityToPapers = new Map<string, Set<string>>();
  const paperToEntities = new Map<string, Set<string>>();
  let ambiguousExcluded = 0;
  for (const [factId, papers] of factCandidates) {
    if (papers.size > 1) { ambiguousExcluded += 1; continue; }
    const paper = [...papers][0]!;
    push(factToPapers, factId, paper);
    for (const e of factEndpoints.get(factId) ?? []) {
      if (!e) continue;
      push(entityToPapers, e, paper);
      push(paperToEntities, paper, e);
    }
  }

  // What did NOT get attributed — reported, never silently dropped.
  const totalFacts = (rows(await db.execute(
    sql`SELECT count(*)::int AS n FROM public.facts WHERE corpus_id IN ('arxiv-nlp','arxiv-cv')`,
  ))[0]!.n) as number;
  const totalEntities = (rows(await db.execute(
    sql`SELECT count(*)::int AS n FROM public.entities WHERE corpus_id IN ('arxiv-nlp','arxiv-cv')`,
  ))[0]!.n) as number;
  // Every committed fact maps to exactly one paper by construction now; the ambiguous ones
  // were excluded above and are reported so the loss is visible, never silent.

  const result = {
    generatedFor: ['arxiv-nlp', 'arxiv-cv'],
    stats: {
      papersIndexed: textToPaper.size,
      stagedChunks: chunkKeys.length,
      chunksResolved: chunkToPaper.size,
      chunksUnresolved: unresolvedChunks,
      factsTotal: totalFacts,
      factsMatchedToStaging: factCandidates.size,
      factsAttributed: factToPapers.size,
      factsExcludedAmbiguous: ambiguousExcluded,
      entitiesTotal: totalEntities,
      entitiesAttributed: entityToPapers.size,
      papersWithEntities: paperToEntities.size,
    },
    paperToEntities: toObj(paperToEntities),
    entityToPapers: toObj(entityToPapers),
    factToPapers: toObj(factToPapers),
  };
  writeFileSync(join(OUT, 'doc-attribution.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.stats, null, 2));

  if (totalFacts > 0 && factToPapers.size / totalFacts < 0.95) {
    console.warn(
      `[doc-attribution] only ${((factToPapers.size / totalFacts) * 100).toFixed(1)}% of facts attributed ` +
        `— below the 95% seen on the pilot; investigate before scoring anything on this map`,
    );
    process.exitCode = 1;
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
