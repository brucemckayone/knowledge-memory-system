/**
 * neighbourhood-profile-corpus-probe.ts — nmemo-bju + NEW-1: DETERMINISTIC proof that
 * the two MCP handlers fixed in this pass (`get_neighbourhood_profile`, whose seven
 * reads dropped the corpus scope entirely, and `project_trajectory`, which dropped it
 * while its sibling `trace_causes` kept it) now honour context.corpusId.
 *
 * Read-only and LLM-free: no ML service, no Qdrant, no writes. It discovers its own
 * target from the live graph (the richest entity in the most-populated corpus, plus a
 * fact in that corpus with outgoing causal edges) and compares three invocation
 * corpora against it:
 *
 *   - FOREIGN corpus  -> must return nothing (entity null, zero facts/neighbours/events)
 *   - the OWN corpus  -> must return the same rows as an unscoped read
 *   - corpusId = null -> unchanged cross-corpus behaviour (what the pre-fix handler
 *                        returned for EVERY corpus)
 *
 * The foreign-corpus expectation is the acceptance criterion: before the fix the profile
 * returned the entity's own-corpus rows no matter which corpus the harness injected, so
 * an agent scoped to corpus B read corpus A's neighbourhood. Run from platform/:
 *
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     npx tsx src/test/tools/neighbourhood-profile-corpus-probe.ts
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { handleToolCall, type ToolCallContext } from '../../services/causal-agent.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

function ctx(corpusId: string | null): ToolCallContext {
  return { agent: 'reasoning_agent', reasoningReportId: null, corpusId };
}

async function profile(entityId: string, corpusId: string | null) {
  const raw = await handleToolCall('get_neighbourhood_profile', { entity_id: entityId }, ctx(corpusId));
  const p = JSON.parse(raw) as {
    entity: { canonicalName: string } | null;
    factsAsSubject: unknown[];
    factsAsObject: unknown[];
    neighbours: unknown[];
    causalEvents: number;
    causalEdges: number;
    sourceMemoryCount: number;
    meta: unknown;
  };
  return {
    name: p.entity?.canonicalName ?? null,
    facts: p.factsAsSubject.length + p.factsAsObject.length,
    neighbours: p.neighbours.length,
    events: p.causalEvents,
    edges: p.causalEdges,
    mentions: p.sourceMemoryCount,
    hasMeta: p.meta !== null,
  };
}

async function trajectoryNodes(factId: string, corpusId: string | null): Promise<number> {
  const raw = await handleToolCall('project_trajectory', { fact_id: factId }, ctx(corpusId));
  return (JSON.parse(raw) as { chain: unknown[] }).chain.length;
}

async function main(): Promise<void> {
  // 1. Pick the target: the entity with the most causal events in the corpus that has
  //    the most causal events, and a fact in that corpus with outgoing causal edges.
  const target = (await db.execute(sql`
    SELECT ce.subject_entity_id AS entity_id, ce.corpus_id
    FROM public.causal_events ce
    WHERE ce.subject_entity_id IS NOT NULL
    GROUP BY 1, 2
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `)) as unknown as Array<{ entity_id: string; corpus_id: string }>;
  const own = target[0];
  if (!own) throw new Error('no corpus-stamped causal events in this database — nothing to probe');

  const foreignRows = (await db.execute(sql`
    SELECT corpus_id FROM public.entities
    WHERE corpus_id <> ${own.corpus_id}
    GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1
  `)) as unknown as Array<{ corpus_id: string }>;
  const foreign = foreignRows[0]?.corpus_id;
  if (!foreign) throw new Error('only one corpus in this database — cross-corpus leak is not observable');

  const factRows = (await db.execute(sql`
    SELECT ce.fact_id
    FROM public.causal_events ce
    JOIN public.causal_edges e ON e.cause_event_id = ce.id AND e.expired_at IS NULL
    WHERE ce.corpus_id = ${own.corpus_id} AND ce.fact_id IS NOT NULL
    GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1
  `)) as unknown as Array<{ fact_id: string }>;
  const factId = factRows[0]?.fact_id;

  console.log(`target entity ${own.entity_id} in corpus '${own.corpus_id}'; foreign corpus '${foreign}'`);

  // 2. get_neighbourhood_profile (NEW-1): all seven reads.
  const unscoped = await profile(own.entity_id, null);
  console.log(`  unscoped profile: ${JSON.stringify(unscoped)}`);
  assert(unscoped.name !== null, 'unscoped profile finds the entity (fixture sanity)');
  assert(unscoped.facts > 0 && unscoped.events > 0, 'unscoped profile returns facts and causal events');

  const ownScoped = await profile(own.entity_id, own.corpus_id);
  assert(
    JSON.stringify(ownScoped) === JSON.stringify(unscoped),
    `profile scoped to its own corpus '${own.corpus_id}' is identical to the unscoped read`,
  );

  const foreignScoped = await profile(own.entity_id, foreign);
  console.log(`  foreign profile:  ${JSON.stringify(foreignScoped)}`);
  assert(foreignScoped.name === null, `profile scoped to '${foreign}' does not return the '${own.corpus_id}' entity`);
  assert(foreignScoped.facts === 0, 'no foreign-corpus facts (getEntityFacts + facts-as-object)');
  assert(foreignScoped.neighbours === 0, 'no foreign-corpus neighbours (findConnectedEntities)');
  assert(foreignScoped.events === 0 && foreignScoped.edges === 0, 'no foreign-corpus causal history');
  assert(foreignScoped.mentions === 0, 'no foreign-corpus memory mentions (memory_entities via entities join)');
  assert(!foreignScoped.hasMeta, 'no foreign-corpus entity_meta (entity_meta via entities join)');

  // 3. project_trajectory (nmemo-bju): the one-line sibling asymmetry.
  if (factId) {
    const ownNodes = await trajectoryNodes(factId, own.corpus_id);
    const foreignNodes = await trajectoryNodes(factId, foreign);
    console.log(`  project_trajectory nodes: own=${ownNodes} foreign=${foreignNodes}`);
    assert(ownNodes > 0, `project_trajectory walks the chain inside '${own.corpus_id}'`);
    assert(foreignNodes === 0, `project_trajectory scoped to '${foreign}' returns no '${own.corpus_id}' chain`);
  } else {
    console.log('  skip project_trajectory: no fact with outgoing causal edges in this corpus');
  }

  console.log('PROBE PASS');
}

await main();
process.exit(0);
