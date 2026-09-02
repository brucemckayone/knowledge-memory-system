/**
 * citation-probe.ts — nmemo-asf.2 (doc 35 §5 step 1d): DETERMINISTIC proof of the
 * per-claim citation surface + the transitive round-trip
 * fact -> proof_fragment_ids -> source_document. No LLM / no Claude / no Qdrant.
 * Builds a fact + its fragments + fact_units via the real writers, then calls
 * getFactCitation() and asserts the whole chain resolves to the source with the
 * right char span. Scratch corpus '_prov_probe', self-cleaning. Run:
 *
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test EMBED_MODEL=nomic-embed-text \
 *     npx tsx src/test/tools/citation-probe.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { splitIntoUnits, mapFactToUnits, recordFragments, sourceDocumentId } from '../../pipeline.js';
import { createEntity } from '../../services/entities.js';
import { createFact } from '../../services/facts.js';
import { getFactCitation } from '../../services/provenance.js';

const CORPUS = '_prov_probe';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main(): Promise<void> {
  const run = randomUUID().slice(0, 8);
  const sourceId = randomUUID();
  const memoryId = randomUUID(); // parent window id
  const content =
    `Alan Turing formulated the concept of the universal machine in 1936, which underpins modern computing. ` +
    `He later worked at Bletchley Park on cryptanalysis of the Enigma cipher.`;
  const span = 'Alan Turing formulated the concept of the universal machine';
  const units = splitIntoUnits(content);
  const expectedDocId = sourceDocumentId(CORPUS, sourceId);

  console.log(`[citation-probe] run=${run} memoryId=${memoryId} sourceId=${sourceId} units=${units.length}`);

  try {
    // fragments (source_document + window + units)
    await recordFragments(memoryId, content, units, { corpusId: CORPUS, sourceId, contentType: 'prose' });

    // a fact with the verbatim span + fact_units linking to the unit fragment(s)
    const subj = await createEntity({ name: `ZZCiteTuring_${run}`, type: 'person', corpusId: CORPUS });
    const obj = await createEntity({ name: `ZZCiteUniversalMachine_${run}`, type: 'concept', corpusId: CORPUS });
    const factId = await createFact({
      subjectEntityId: subj.id, predicate: 'formulated', objectEntityId: obj.id,
      sourceText: span, sourceMemoryId: memoryId, corpusId: CORPUS, actor: 'graph_agent', confidence: 1.0,
    });
    const links = mapFactToUnits(memoryId, content, span, units);
    for (const l of links) {
      await db.execute(sql`
        INSERT INTO public.fact_units (fact_id, unit_point_id, char_start, char_end, match_kind)
        VALUES (${factId}::uuid, ${l.unitPointId}, ${l.charStart}, ${l.charEnd}, ${l.matchKind})
        ON CONFLICT DO NOTHING
      `);
    }

    // === the citation surface + transitive round-trip ===
    const cite = await getFactCitation(factId);
    assert(cite.sources.length === 1, `citation has 1 supporting source (got ${cite.sources.length})`);
    assert(cite.sources[0]!.memoryId === memoryId, 'citation source.memoryId == the window id');
    assert(cite.sources[0]!.sourceText === span, 'citation source.sourceText == the verbatim span');

    assert(cite.fragments.length >= 1, `citation resolved >=1 proof fragment (got ${cite.fragments.length})`);
    assert(cite.fragments.every((f) => f.matchKind === 'offset_overlap'), 'all proof fragments are offset_overlap');
    assert(cite.fragments.every((f) => f.kind === 'unit' && f.parentId === memoryId),
      'every proof fragment is a unit whose parent is the window');
    assert(cite.fragments.every((f) => f.sourceDocumentId === expectedDocId && f.corpusId === CORPUS),
      'every proof fragment resolves transitively to the SAME source_document (right corpus)');
    assert(cite.fragments.every((f) => f.externalSourceId === sourceId),
      'source_document.external_source_id == the ingested sourceId (round-trip to source)');

    // char-span round-trip: the fact span lies within the union of proof-fragment offsets
    const spanStart = content.indexOf(span);
    const spanEnd = spanStart + span.length;
    const minStart = Math.min(...cite.fragments.map((f) => f.charStart ?? Infinity));
    const maxEnd = Math.max(...cite.fragments.map((f) => f.charEnd ?? -Infinity));
    assert(minStart <= spanStart && maxEnd >= spanEnd, 'proof-fragment offsets cover the fact span');
    assert(content.slice(minStart, maxEnd).includes(span), 'text at the resolved offsets contains the verbatim span');

    console.log('\n[citation-probe] RESULT: PASS — getFactCitation resolves fact -> fact_sources + proof fragments -> source_document, with correct offsets and transitive source round-trip.');
  } finally {
    await db.execute(sql`DELETE FROM public.causal_edges WHERE cause_event_id IN (SELECT id FROM public.causal_events WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS})) OR effect_event_id IN (SELECT id FROM public.causal_events WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS}))`);
    await db.execute(sql`DELETE FROM public.fact_history WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS})`);
    await db.execute(sql`DELETE FROM public.causal_events WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS})`);
    await db.execute(sql`DELETE FROM public.facts WHERE corpus_id = ${CORPUS}`); // CASCADE -> fact_sources, fact_units
    await db.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${CORPUS}`);
    await db.execute(sql`DELETE FROM public.source_document WHERE corpus_id = ${CORPUS}`); // CASCADE -> fragment
    const left = (await db.execute(sql`
      SELECT (SELECT count(*) FROM public.facts WHERE corpus_id = ${CORPUS}) AS facts,
             (SELECT count(*) FROM public.entities WHERE corpus_id = ${CORPUS}) AS entities,
             (SELECT count(*) FROM public.source_document WHERE corpus_id = ${CORPUS}) AS docs
    `)) as unknown as Array<{ facts: number; entities: number; docs: number }>;
    console.log(`[citation-probe] cleanup: leftover facts=${left[0]!.facts} entities=${left[0]!.entities} docs=${left[0]!.docs} (all must be 0)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
