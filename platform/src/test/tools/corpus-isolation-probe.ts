/**
 * corpus-isolation-probe.ts — nmemo-asf.3 (Phase 1.2): DETERMINISTIC proof that the
 * corpus-scoped reasoning READ helpers isolate one corpus from another on the live
 * Postgres read path. No LLM / no Claude — calls each helper directly.
 *
 * Fixture: two scratch corpora (_iso_probe_a / _iso_probe_b) each holding a 3-entity
 * chain alpha->beta->gamma with two facts (alpha influences beta, beta influences
 * gamma). The alpha pair shares an IDENTICAL name + embedding across corpora, so a
 * vector search matches both equally and only the corpus filter can separate them.
 * The fact->causal-event mirror (now corpus-stamped, nmemo-asf.3) yields one 'created'
 * event per fact; a within-corpus causal edge (event1 -> event2) makes traceCauses
 * walk a real chain, and a deliberate CROSS-CORPUS poison edge (B's event1 -> A's
 * event2) tests that the recursive parent filter refuses to leak the other corpus.
 *
 * Asserts, for each helper: corpusId=A returns ONLY A rows, corpusId=B refuses A rows,
 * and (where the helper supports it) corpusId=null returns both / the poison leaks —
 * proving the filter, not the data shape, is what isolates.
 *
 * findSimilarEntities has NO cross-corpus mode (it defaults corpusId to 'default'), so
 * it is tested A->only-A / B->only-B instead of the null=both form. The recall_via_graph
 * graph leg is traverseFromEntities (covered here); its flat search + rerank fetch are
 * Qdrant = OUT OF SCOPE for this pass. Scratch corpora self-clean. Run from platform/:
 *
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test EMBED_MODEL=nomic-embed-text \
 *     npx tsx src/test/tools/corpus-isolation-probe.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { createFact, getEntityFacts } from '../../services/facts.js';
import { findConnectedEntities, traverseFromEntities } from '../../services/graph.js';
import { findSimilarEntities } from '../../services/entities.js';
import { getEntityCausalHistory, traceCauses } from '../../services/causal.js';

const A = '_iso_probe_a';
const B = '_iso_probe_b';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

function randomUnitVec(dim = 768): number[] {
  const v = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

async function insertEntity(id: string, name: string, corpus: string, vec: number[]): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.entities (id, canonical_name, entity_type, corpus_id, embedding)
    VALUES (${id}::uuid, ${name}, 'concept', ${corpus}, ${sql.raw(`'[${vec.join(',')}]'::vector`)})
  `);
}

async function createdEventId(factId: string): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT id FROM public.causal_events
    WHERE fact_id = ${factId}::uuid AND transition_type = 'created'
    ORDER BY created_at LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error(`no created causal_event for fact ${factId}`);
  return rows[0].id;
}

async function eventCorpus(eventId: string): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT corpus_id FROM public.causal_events WHERE id = ${eventId}::uuid
  `)) as unknown as Array<{ corpus_id: string }>;
  return rows[0]!.corpus_id;
}

async function insertEdge(causeId: string, effectId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.causal_edges
      (cause_event_id, effect_event_id, extraction_method, reasoning, source_references, initial_strength, strength)
    VALUES (${causeId}::uuid, ${effectId}::uuid, 'test', 'iso-probe synthetic edge', '[]'::jsonb, 0.9, 0.9)
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM public.causal_edges
    WHERE cause_event_id IN (SELECT id FROM public.causal_events WHERE corpus_id IN (${A}, ${B}))
       OR effect_event_id IN (SELECT id FROM public.causal_events WHERE corpus_id IN (${A}, ${B}))
  `);
  await db.execute(sql`DELETE FROM public.fact_history WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id IN (${A}, ${B}))`);
  await db.execute(sql`DELETE FROM public.causal_events WHERE corpus_id IN (${A}, ${B})`);
  await db.execute(sql`DELETE FROM public.facts WHERE corpus_id IN (${A}, ${B})`);
  await db.execute(sql`DELETE FROM public.entities WHERE corpus_id IN (${A}, ${B})`);
}

async function main(): Promise<void> {
  const run = randomUUID().slice(0, 8);
  const alphaName = `ZZIsoAlpha_${run}`;
  const betaName = `ZZIsoBeta_${run}`;
  const gammaName = `ZZIsoGamma_${run}`;
  // Identical embedding for the alpha pair so vector search matches both corpora equally.
  const vecAlpha = randomUnitVec();
  const vecBeta = randomUnitVec();
  const vecGamma = randomUnitVec();

  const ids = {
    aAlpha: randomUUID(), aBeta: randomUUID(), aGamma: randomUUID(),
    bAlpha: randomUUID(), bBeta: randomUUID(), bGamma: randomUUID(),
  };

  console.log(`[corpus-isolation-probe] run=${run}`);

  // Pre-clean in case a prior run died mid-way.
  await cleanup();

  try {
    // --- entities: same names + (for alpha) same vector across A and B ---
    await insertEntity(ids.aAlpha, alphaName, A, vecAlpha);
    await insertEntity(ids.aBeta, betaName, A, vecBeta);
    await insertEntity(ids.aGamma, gammaName, A, vecGamma);
    await insertEntity(ids.bAlpha, alphaName, B, vecAlpha);
    await insertEntity(ids.bBeta, betaName, B, vecBeta);
    await insertEntity(ids.bGamma, gammaName, B, vecGamma);

    // --- facts (the mirror stamps each created event with the fact's corpus) ---
    const factA1 = await createFact({ subjectEntityId: ids.aAlpha, predicate: 'influences', objectEntityId: ids.aBeta, sourceText: 'a alpha influences beta', corpusId: A, actor: 'graph_agent', confidence: 1.0 });
    const factA2 = await createFact({ subjectEntityId: ids.aBeta, predicate: 'influences', objectEntityId: ids.aGamma, sourceText: 'a beta influences gamma', corpusId: A, actor: 'graph_agent', confidence: 1.0 });
    const factB1 = await createFact({ subjectEntityId: ids.bAlpha, predicate: 'influences', objectEntityId: ids.bBeta, sourceText: 'b alpha influences beta', corpusId: B, actor: 'graph_agent', confidence: 1.0 });
    const factB2 = await createFact({ subjectEntityId: ids.bBeta, predicate: 'influences', objectEntityId: ids.bGamma, sourceText: 'b beta influences gamma', corpusId: B, actor: 'graph_agent', confidence: 1.0 });

    const evA1 = await createdEventId(factA1);
    const evA2 = await createdEventId(factA2);
    const evB1 = await createdEventId(factB1);
    await createdEventId(factB2); // exists; not referenced below

    // === 0. mirror fix: events are stamped with the FACT's corpus, not 'default' ===
    assert((await eventCorpus(evA1)) === A, `mirror stamped A's created event corpus_id = A (was the 'default' bug)`);
    assert((await eventCorpus(evB1)) === B, `mirror stamped B's created event corpus_id = B`);

    // within-corpus chain edges + a cross-corpus POISON edge into A's chain
    await insertEdge(evA1, evA2);            // A: event1 -> event2 (traceCauses(A2) reaches A1)
    await insertEdge(evB1, evA2);            // POISON: B's event1 -> A's event2

    // === 1. getEntityFacts (facts.corpus_id) ===
    const gefA = await getEntityFacts(ids.aAlpha, { corpusId: A });
    assert(gefA.length === 1 && gefA[0]!.id === factA1, 'getEntityFacts(Aalpha, A) -> the A fact only');
    const gefWrong = await getEntityFacts(ids.aAlpha, { corpusId: B });
    assert(gefWrong.length === 0, 'getEntityFacts(Aalpha, B) -> no rows (A fact refused under B scope)');
    const gefNull = await getEntityFacts(ids.aAlpha, { corpusId: null });
    assert(gefNull.length === 1 && gefNull[0]!.id === factA1, 'getEntityFacts(Aalpha, null) -> the A fact (unscoped)');

    // === 2. traverseFromEntities / findConnectedEntities (facts.corpus_id in the CTE) ===
    const travA = await traverseFromEntities([ids.aAlpha], { maxHops: 2, corpusId: A });
    const travAIds = new Set(travA.map((n) => n.entityId));
    assert(travAIds.has(ids.aBeta) && travAIds.has(ids.aGamma), 'traverse(Aalpha, A) reaches Abeta + Agamma');
    assert(![ids.bBeta, ids.bGamma].some((id) => travAIds.has(id)), 'traverse(Aalpha, A) reaches NO B entity');
    const travWrong = await traverseFromEntities([ids.aAlpha], { maxHops: 2, corpusId: B });
    assert(travWrong.length === 0, 'traverse(Aalpha, B) -> empty (A edges refused under B scope)');

    const fcA = await findConnectedEntities(ids.aAlpha, { maxDepth: 2, corpusId: A });
    const fcAIds = new Set(fcA.map((n) => n.entityId));
    assert(fcAIds.has(ids.aBeta), 'findConnectedEntities(Aalpha, A) includes Abeta');
    assert(![ids.bBeta, ids.bGamma].some((id) => fcAIds.has(id)), 'findConnectedEntities(Aalpha, A) includes NO B entity');
    const fcWrong = await findConnectedEntities(ids.aAlpha, { maxDepth: 2, corpusId: B });
    assert(fcWrong.length === 0, 'findConnectedEntities(Aalpha, B) -> empty');

    // === 3. findSimilarEntities (entities.corpus_id; identical vector in both corpora) ===
    const simA = await findSimilarEntities(vecAlpha, { corpusId: A, threshold: 0.9, limit: 20 });
    const simAIds = new Set(simA.map((e) => e.id));
    assert(simAIds.has(ids.aAlpha), 'findSimilarEntities(vecAlpha, A) returns Aalpha (cos 1.0)');
    assert(!simAIds.has(ids.bAlpha), 'findSimilarEntities(vecAlpha, A) does NOT return Balpha (identical vector, other corpus)');
    const simB = await findSimilarEntities(vecAlpha, { corpusId: B, threshold: 0.9, limit: 20 });
    const simBIds = new Set(simB.map((e) => e.id));
    assert(simBIds.has(ids.bAlpha) && !simBIds.has(ids.aAlpha), 'findSimilarEntities(vecAlpha, B) returns Balpha only');

    // === 4. getEntityCausalHistory (causal_events.corpus_id — relies on the mirror fix) ===
    const chA = await getEntityCausalHistory(ids.aAlpha, { corpusId: A });
    assert(chA.events.length >= 1 && chA.events.every((e) => e.subjectEntityId === ids.aAlpha), 'getEntityCausalHistory(Aalpha, A) -> A events');
    const chWrong = await getEntityCausalHistory(ids.aAlpha, { corpusId: B });
    assert(chWrong.events.length === 0, 'getEntityCausalHistory(Aalpha, B) -> no events (would leak if mirror unstamped)');
    const chNull = await getEntityCausalHistory(ids.aAlpha, { corpusId: null });
    assert(chNull.events.length >= 1, 'getEntityCausalHistory(Aalpha, null) -> events (unscoped)');

    // === 5. traceCauses (base + recursive parent filter; the poison edge is the leak test) ===
    const tcA = await traceCauses(factA2, { corpusId: A, maxDepth: 5 });
    const tcAEvents = new Set(tcA.map((n) => n.event.id));
    assert(tcAEvents.has(evA2) && tcAEvents.has(evA1), 'traceCauses(factA2, A) walks A2 -> A1');
    assert(!tcAEvents.has(evB1), 'traceCauses(factA2, A) does NOT include B1 (cross-corpus poison edge refused)');
    const tcNull = await traceCauses(factA2, { corpusId: null, maxDepth: 5 });
    const tcNullEvents = new Set(tcNull.map((n) => n.event.id));
    assert(tcNullEvents.has(evB1), 'traceCauses(factA2, null) DOES include B1 via the poison edge (proves the filter is what blocked it)');
    const tcWrong = await traceCauses(factA2, { corpusId: B, maxDepth: 5 });
    assert(tcWrong.length === 0, 'traceCauses(factA2, B) -> empty (base fact refused under B scope)');

    console.log('\n[corpus-isolation-probe] RESULT: PASS — every scoped reasoning read helper isolates the corpus (entity/fact/traversal/vector/causal), and the fact->causal mirror stamps the right corpus.');
  } finally {
    await cleanup();
    const left = (await db.execute(sql`
      SELECT (SELECT count(*) FROM public.entities WHERE corpus_id IN (${A}, ${B})) AS entities,
             (SELECT count(*) FROM public.facts WHERE corpus_id IN (${A}, ${B})) AS facts,
             (SELECT count(*) FROM public.causal_events WHERE corpus_id IN (${A}, ${B})) AS events
    `)) as unknown as Array<{ entities: number; facts: number; events: number }>;
    console.log(`[corpus-isolation-probe] cleanup: leftover entities=${left[0]!.entities} facts=${left[0]!.facts} events=${left[0]!.events} (all must be 0)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
