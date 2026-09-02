/**
 * promote-probe.ts — nmemo-asf.2 (doc 35 §5 step 1b): DETERMINISTIC proof that
 * the EPOCH path (promote()) now stamps per-fact provenance — source_memory_id +
 * a fact_sources row — derived from the staged (source_id, chunk_index) via
 * windowPointId. No LLM / no Claude: it hand-seeds staging (the propose() step's
 * output) and calls the real promote() directly. Scratch corpus '_prov_probe',
 * self-cleaning. Run:
 *
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test EMBED_MODEL=nomic-embed-text \
 *     npx tsx src/test/tools/promote-probe.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { promote } from '../../services/promotion.js';
import { windowPointId } from '../../services/point-ids.js';
import { getFactSources } from '../../services/facts.js';

const CORPUS = '_prov_probe';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main(): Promise<void> {
  const run = randomUUID().slice(0, 8);
  const epochId = randomUUID();
  const handle = randomUUID();
  const sourceId = randomUUID(); // source_id is a UUID column (matches ingestBatch's opts.sourceId ?? randomUUID())
  const chunkIndex = 0;
  const reasoning = `Probe fact reasoning ${run}`;
  const expectedWindowId = windowPointId(sourceId, chunkIndex);

  console.log(`[promote-probe] run=${run} epoch=${epochId.slice(0, 8)} expectedWindowId=${expectedWindowId}`);

  try {
    // --- seed staging = what a propose() pass would have written ---
    await db.execute(sql`
      INSERT INTO public.staging_proposed_entities (handle, epoch_id, source_id, name, entity_type, summary)
      VALUES (${handle}::uuid, ${epochId}::uuid, ${sourceId}::uuid, ${'ZZEpochProbe_' + run}, 'person', 'a probe subject')
    `);
    await db.execute(sql`
      INSERT INTO public.staging_proposed_facts
        (epoch_id, source_id, subject_handle, predicate, object_value, valid_at, undated, chunk_index, confidence, reasoning)
      VALUES (${epochId}::uuid, ${sourceId}::uuid, ${handle}::uuid, 'works_at', 'ProbeCorp',
              ${'2026-01-01T00:00:00Z'}, false, ${chunkIndex}, 0.9, ${reasoning})
    `);

    // --- run the real deterministic promotion into the scratch corpus ---
    await promote(epochId, { corpusId: CORPUS });

    // === the fact was promoted with provenance ===
    const factRows = (await db.execute(sql`
      SELECT id, source_memory_id, predicate, source_text
      FROM public.facts WHERE corpus_id = ${CORPUS}
    `)) as unknown as Array<{ id: string; source_memory_id: string | null; predicate: string; source_text: string | null }>;
    assert(factRows.length === 1, `exactly 1 fact promoted into ${CORPUS} (got ${factRows.length})`);
    const fact = factRows[0]!;
    assert(fact.source_memory_id === expectedWindowId,
      'facts.source_memory_id == windowPointId(source_id, chunk_index) (was NULL on the epoch path before)');

    // === fact_sources row written by promote() ===
    const sources = await getFactSources(fact.id);
    assert(sources.length === 1, `fact_sources has exactly 1 row (got ${sources.length})`);
    assert(sources[0]!.memoryId === expectedWindowId, 'fact_sources.memory_id == the reconstructed window id');
    assert(sources[0]!.sourceText === reasoning, 'fact_sources.source_text == the staged reasoning (epoch path)');

    console.log('\n[promote-probe] RESULT: PASS — the epoch path now stamps source_memory_id + a fact_sources row from the staged (source_id, chunk_index). NULL-provenance epoch bug fixed.');
  } finally {
    // cleanup: causal mirror + history (NO ACTION) before facts (CASCADE -> fact_sources/units), then entities + staging.
    await db.execute(sql`DELETE FROM public.causal_edges WHERE cause_event_id IN (SELECT id FROM public.causal_events WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS})) OR effect_event_id IN (SELECT id FROM public.causal_events WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS}))`);
    await db.execute(sql`DELETE FROM public.fact_history WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS})`);
    await db.execute(sql`DELETE FROM public.causal_events WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id = ${CORPUS})`);
    await db.execute(sql`DELETE FROM public.facts WHERE corpus_id = ${CORPUS}`);
    await db.execute(sql`DELETE FROM public.entities WHERE corpus_id = ${CORPUS}`);
    await db.execute(sql`DELETE FROM public.staging_proposed_facts WHERE epoch_id = ${epochId}::uuid`);
    await db.execute(sql`DELETE FROM public.staging_proposed_entities WHERE epoch_id = ${epochId}::uuid`);
    const left = (await db.execute(sql`
      SELECT (SELECT count(*) FROM public.facts WHERE corpus_id = ${CORPUS}) AS facts,
             (SELECT count(*) FROM public.entities WHERE corpus_id = ${CORPUS}) AS entities,
             (SELECT count(*) FROM public.staging_proposed_facts WHERE epoch_id = ${epochId}::uuid) AS staged
    `)) as unknown as Array<{ facts: number; entities: number; staged: number }>;
    console.log(`[promote-probe] cleanup: leftover facts=${left[0]!.facts} entities=${left[0]!.entities} staged=${left[0]!.staged} (all must be 0)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
