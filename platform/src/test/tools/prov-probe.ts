/**
 * prov-probe.ts — nmemo-asf.2 (doc 35) step 1a: DETERMINISTIC proof that the
 * provenance/lineage substrate lights up once a fact carries a non-null
 * source_memory_id. No LLM, no Claude spend, no Qdrant writes.
 *
 * It exercises the REAL code:
 *   - createFact({ sourceMemoryId, corpusId }) -> recordFactSource -> fact_sources
 *   - splitIntoUnits + mapFactToUnits (the pure offset mapper extract() uses)
 *     -> fact_units, then asserts the char offsets round-trip back to the source
 *     span and the persisted unit ids equal the deterministic unitPointId().
 *
 * Everything is written under the scratch corpus '_prov_probe' and deleted in a
 * finally block (fact_history first — NO ACTION FK — then facts, which CASCADEs
 * fact_sources + fact_units, then entities). Run:
 *
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test EMBED_MODEL=nomic-embed-text \
 *     npx tsx src/test/tools/prov-probe.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { splitIntoUnits, mapFactToUnits, unitPointId } from '../../pipeline.js';
import { createEntity } from '../../services/entities.js';
import { createFact, getFactSources } from '../../services/facts.js';

const CORPUS = '_prov_probe';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main(): Promise<void> {
  const run = randomUUID().slice(0, 8);
  // A window with a clear, single-occurrence verbatim fact span.
  const content =
    `Ada Lovelace collaborated with Charles Babbage on the Analytical Engine during the 1840s. ` +
    `She is widely regarded as having written the first published algorithm intended for a machine. ` +
    `The Analytical Engine itself was never completed in her lifetime.`;
  const span = 'Ada Lovelace collaborated with Charles Babbage';
  const memoryId = randomUUID(); // stands in for the parent window point id

  console.log(`[prov-probe] run=${run} corpus=${CORPUS} memoryId=${memoryId}`);
  console.log(`[prov-probe] content.length=${content.length}, span found at index ${content.indexOf(span)}`);

  const createdFactIds: string[] = [];

  try {
    // --- create subject + object entities in the scratch corpus (globally-unique
    //     names so createEntity's global dedup can't hand us another corpus's row) ---
    const subj = await createEntity({ name: `ZZProbeAda_${run}`, type: 'person', corpusId: CORPUS });
    const obj = await createEntity({ name: `ZZProbeBabbage_${run}`, type: 'person', corpusId: CORPUS });
    assert(!subj.existed && !obj.existed, 'both probe entities were freshly minted');

    // --- create the fact WITH a non-null sourceMemoryId (what the §2 fix makes the
    //     agent path do) — this is the single link whose absence emptied the tables ---
    const factId = await createFact({
      subjectEntityId: subj.id,
      predicate: 'collaborated_with',
      objectEntityId: obj.id,
      sourceText: span,
      sourceMemoryId: memoryId,
      corpusId: CORPUS,
      actor: 'graph_agent',
      confidence: 1.0,
    });
    createdFactIds.push(factId);
    console.log(`[prov-probe] created fact ${factId}`);

    // === PROOF 1: fact_sources populated (real recordFactSource path) ===
    const sources = await getFactSources(factId);
    assert(sources.length === 1, `fact_sources has exactly 1 row (got ${sources.length})`);
    assert(sources[0]!.memoryId === memoryId, 'fact_sources.memory_id == the injected window id');
    assert(sources[0]!.sourceText === span, 'fact_sources.source_text == the verbatim span');

    // === PROOF 2: fact_units offsets round-trip (real mapFactToUnits) ===
    const units = splitIntoUnits(content);
    console.log(`[prov-probe] splitIntoUnits -> ${units.length} unit(s)`);
    const links = mapFactToUnits(memoryId, content, span, units);
    assert(links.length > 0, `mapFactToUnits returned >=1 link (got ${links.length})`);
    assert(
      links.every((l) => l.matchKind === 'offset_overlap'),
      'every link is offset_overlap (span located verbatim, not a window fallback)',
    );

    // persist them exactly as extract() does
    for (const l of links) {
      await db.execute(sql`
        INSERT INTO public.fact_units (fact_id, unit_point_id, char_start, char_end, match_kind)
        VALUES (${factId}::uuid, ${l.unitPointId}, ${l.charStart}, ${l.charEnd}, ${l.matchKind})
        ON CONFLICT DO NOTHING
      `);
    }

    const persisted = (await db.execute(sql`
      SELECT unit_point_id, char_start, char_end, match_kind
      FROM public.fact_units WHERE fact_id = ${factId}::uuid
      ORDER BY char_start
    `)) as unknown as Array<{ unit_point_id: string; char_start: number; char_end: number; match_kind: string }>;
    assert(persisted.length === links.length, `fact_units persisted all ${links.length} link(s)`);

    // deterministic id: each persisted unit id must equal unitPointId(memoryId, index)
    // for the unit whose [char_start,char_end) it records.
    for (const row of persisted) {
      const idx = units.findIndex((u) => u.charStart === row.char_start && u.charEnd === row.char_end);
      assert(idx >= 0, `persisted unit [${row.char_start},${row.char_end}) matches a real unit`);
      assert(
        row.unit_point_id === unitPointId(memoryId, idx),
        `unit_point_id == deterministic unitPointId(memoryId, ${idx})`,
      );
    }

    // span round-trip: the union of the persisted units' offset ranges must cover
    // the fact's source span within the window.
    const spanStart = content.indexOf(span);
    const spanEnd = spanStart + span.length;
    const cover = persisted.some((r) => r.char_start <= spanStart && r.char_end >= spanEnd) ||
      // or the span straddles adjacent units whose ranges are contiguous+overlapping
      (Math.min(...persisted.map((r) => r.char_start)) <= spanStart &&
        Math.max(...persisted.map((r) => r.char_end)) >= spanEnd);
    assert(cover, 'persisted unit offsets cover the fact source span (round-trip to source text)');
    const reconstructed = content.slice(
      Math.min(...persisted.map((r) => r.char_start)),
      Math.max(...persisted.map((r) => r.char_end)),
    );
    assert(reconstructed.includes(span), 'text sliced at the persisted offsets contains the verbatim span');

    console.log('\n[prov-probe] RESULT: PASS — fact_sources + fact_units both light up from a non-null source_memory_id, offsets round-trip to source.');
  } finally {
    // --- cleanup: exact scratch corpus only. Order matters: a DB trigger mirrors
    //     each new fact into causal_events (fact_id FK, NO ACTION) — this is why
    //     doc 33 saw "7299 causal events over 212 facts" on the churny default
    //     corpus. Drop the causal mirror (+ any edges, defensively) before facts. ---
    await db.execute(sql`DELETE FROM public.causal_edges WHERE cause_event_id IN (SELECT id FROM public.causal_events WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS})) OR effect_event_id IN (SELECT id FROM public.causal_events WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS}))`);
    await db.execute(sql`DELETE FROM public.fact_history WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS})`);
    await db.execute(sql`DELETE FROM public.causal_events WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS})`);
    await db.execute(sql`DELETE FROM public.facts WHERE corpus_id = ${CORPUS}`); // CASCADE -> fact_sources, fact_units
    await db.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${CORPUS}`);
    const left = (await db.execute(sql`
      SELECT (SELECT count(*) FROM public.facts WHERE corpus_id = ${CORPUS}) AS facts,
             (SELECT count(*) FROM public.entities WHERE corpus_id = ${CORPUS}) AS entities,
             (SELECT count(*) FROM public.fact_units fu JOIN public.facts f ON f.id = fu.fact_id WHERE f.corpus_id = ${CORPUS}) AS units
    `)) as unknown as Array<{ facts: number; entities: number; units: number }>;
    console.log(`[prov-probe] cleanup: leftover facts=${left[0]!.facts} entities=${left[0]!.entities} units=${left[0]!.units} (all must be 0)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
