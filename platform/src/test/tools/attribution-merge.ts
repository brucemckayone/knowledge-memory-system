/**
 * Build the single `doc-attribution.json` the doc-35 scorer reads, from the per-batch
 * attribution artifacts the ingest harness writes.
 *
 * WHY THIS EXISTS, and why `doc-attribution.ts` is not the path any more. That mapper
 * recovered attribution AFTER a run by reading consumed staging
 * (`facts.source_text = staging_proposed_facts.reasoning`). It validated at 587/587 — but
 * only because it was measured DURING a live run. `runEpochBatch` calls
 * `cleanupAbandonedStaging()` on every batch, deleting staging older than
 * `STAGING_TTL_MS` (default 1 hour), so the evidence that chain depends on is garbage
 * collected within the hour and corpus A's provenance was destroyed once. Attribution is
 * now captured per batch, at ingest time, before the batch is marked done
 * (`corpus-graph-ingest.ts`), which is the only paper-level provenance that survives — the
 * epoch path writes no `memory_entities` and no `fact_sources`.
 *
 * That leaves a pure shape difference, which is all this tool fixes. The ingest writes
 * `{paperToEntities, factToPaper}` per corpus; `multihop-score.ts` reads
 * `{stats, entityToPapers}`. Same information, inverted — no re-derivation, no LLM, no
 * inference. The scorer is left untouched on purpose: it encodes the frozen doc-35 bars.
 *
 * The 95% floor itself is NOT applied here — doc-35 §3 puts it in the scorer, which
 * exits non-zero below it. This tool only reports the rate so the number is visible
 * before the scoring run.
 *
 * Run: cd platform && DATABASE_URL=...cognitive_test NODE_ENV=test \
 *   npx tsx src/test/tools/attribution-merge.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '../../../../docs/architecture/cross-corpus-audit');
const OUT = join(DOCS, 'multihop-artifacts');
const CORPORA = ['arxiv-nlp', 'arxiv-cv'] as const;

interface IngestAttribution {
  paperToEntities: Record<string, string[]>;
  factToPaper: Record<string, string>;
}

function rows(r: unknown): Array<Record<string, unknown>> {
  return r as unknown as Array<Record<string, unknown>>;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  const paperToEntities = new Map<string, Set<string>>();
  const entityToPapers = new Map<string, Set<string>>();
  const factToPapers: Record<string, string[]> = {};
  const perCorpus: Record<string, { papers: number; facts: number; entities: number }> = {};

  for (const corpusId of CORPORA) {
    const path = join(OUT, `attribution-${corpusId}.json`);
    // Fail loud: a missing artifact means that corpus has no surviving provenance, and a
    // half-attributed map scored silently is the exact failure doc-35 §3 voids a run over.
    if (!existsSync(path)) throw new Error(`missing ${path} — ingest that corpus before merging`);
    const a = JSON.parse(readFileSync(path, 'utf8')) as IngestAttribution;

    const seen = new Set<string>();
    for (const [paper, ents] of Object.entries(a.paperToEntities)) {
      const set = paperToEntities.get(paper) ?? new Set<string>();
      for (const e of ents) {
        set.add(e);
        seen.add(e);
        const ps = entityToPapers.get(e) ?? new Set<string>();
        ps.add(paper);
        entityToPapers.set(e, ps);
      }
      paperToEntities.set(paper, set);
    }
    // The ingest artifact is fact→ONE paper by construction (a fact whose staged matches
    // disagree is excluded rather than attributed to several), so the array form the scorer's
    // sibling fields use is always a singleton here.
    for (const [fid, paper] of Object.entries(a.factToPaper)) factToPapers[fid] = [paper];
    perCorpus[corpusId] = {
      papers: Object.keys(a.paperToEntities).length,
      facts: Object.keys(a.factToPaper).length,
      entities: seen.size,
    };
  }

  // Denominators come from the DB, not from the artifacts — the honest total, so the floor is
  // computed against every canonical row rather than against the subset that happened to
  // attribute.
  const totalFacts = rows(await db.execute(
    sql`SELECT count(*)::int AS n FROM public.facts WHERE corpus_id IN ('arxiv-nlp','arxiv-cv')`,
  ))[0]!.n as number;
  const totalEntities = rows(await db.execute(
    sql`SELECT count(*)::int AS n FROM public.entities WHERE corpus_id IN ('arxiv-nlp','arxiv-cv')`,
  ))[0]!.n as number;

  const factsAttributed = Object.keys(factToPapers).length;
  const toObj = (m: Map<string, Set<string>>): Record<string, string[]> =>
    Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]));

  const result = {
    generatedFor: [...CORPORA],
    source: 'per-batch ingest capture (corpus-graph-ingest.ts), merged — NOT the post-hoc staging chain',
    stats: {
      factsTotal: totalFacts,
      factsAttributed,
      entitiesTotal: totalEntities,
      // An entity only attributes if it participates in an attributed fact. A fact-less
      // entity therefore lifts to no paper and contributes no pair to any arm — a real
      // coverage limit of every arm equally, reported rather than hidden.
      entitiesAttributed: entityToPapers.size,
      papersWithEntities: paperToEntities.size,
      perCorpus,
    },
    paperToEntities: toObj(paperToEntities),
    entityToPapers: toObj(entityToPapers),
    factToPapers,
  };

  writeFileSync(join(OUT, 'doc-attribution.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.stats, null, 2));
  const rate = totalFacts === 0 ? 0 : factsAttributed / totalFacts;
  console.log(`attribution rate ${(rate * 100).toFixed(2)}% (doc-35 §3 floor is 95%, enforced in multihop-score.ts)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
