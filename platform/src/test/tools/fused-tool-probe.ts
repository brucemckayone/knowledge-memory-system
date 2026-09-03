/**
 * fused-tool-probe.ts — nmemo-asf.4 (Phase 1.3): DETERMINISTIC proof that the PROVEN
 * two-signal fusion (recallEntitiesFused, nmemo-u8j.1) is wired as an MCP read tool
 * `recall_entities_fused`, reachable by the reasoning-agent surface, and corpus-scoped.
 * No LLM / no Claude — calls the real MCP dispatch entry `handleToolCall` with the
 * production env carrier (MNEMO_AGENT_ACTOR + MNEMO_CORPUS_ID), the same path the MCP
 * transport uses. It does NOT re-litigate the fusion science (banked as nmemo-u8j.1);
 * it proves the tool RUNS through the agent surface and honours the corpus.
 *
 * Fixture (scratch corpora, self-cleaning): corpus A holds a NAME-signal entity (name
 * matches the query) and a FACT-signal entity (opaque name, but a fact whose source
 * text matches the query -> fact_embedding hit); corpus B holds a same-concept decoy.
 * A corpus-A tool call must return both A entities (name hit + fact hit, both provenance
 * fields present across the set) and NONE of B; a corpus-B call must return B's decoy
 * and neither A entity. Run from platform/:
 *
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test EMBED_MODEL=nomic-embed-text \
 *     npx tsx src/test/tools/fused-tool-probe.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { createEntity } from '../../services/entities.js';
import { createFact } from '../../services/facts.js';
import { handleToolCall } from '../../services/causal-agent.js';

const A = '_fuse_probe_a';
const B = '_fuse_probe_b';

interface FusedRow {
  id: string;
  canonicalName: string;
  entityType: string;
  corpusId: string;
  nameSimilarity: number | null;
  factSimilarity: number | null;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

/** Call the tool exactly as the MCP transport does: no context arg, env is the carrier. */
async function callTool(query: string, corpusId: string): Promise<FusedRow[]> {
  process.env.MNEMO_AGENT_ACTOR = 'reasoning_agent';
  process.env.MNEMO_CORPUS_ID = corpusId;
  const raw = await handleToolCall('recall_entities_fused', { query, limit: 10 });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`tool did not return an array: ${raw.slice(0, 200)}`);
  return parsed as FusedRow[];
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
  const query = 'graph neural network message passing on molecular graphs';

  console.log(`[fused-tool-probe] run=${run}`);
  await cleanup(); // in case a prior run died mid-way

  try {
    // NAME-signal entity in A: canonical name matches the query.
    const aName = await createEntity({ name: `Graph Neural Network Message Passing ZZ${run}`, type: 'concept', corpusId: A });
    // FACT-signal entity in A: opaque name, but a fact whose source text matches the query.
    const aFact = await createEntity({ name: `ZZFuseOpaqueSubject ${run}`, type: 'concept', corpusId: A });
    const aFactObj = await createEntity({ name: `ZZFuseOpaqueObject ${run}`, type: 'concept', corpusId: A });
    await createFact({
      subjectEntityId: aFact.id, predicate: 'describes', objectEntityId: aFactObj.id,
      sourceText: 'A method for graph neural network message passing over molecular graphs.',
      corpusId: A, actor: 'graph_agent', confidence: 1.0,
    });
    // Same-concept DECOY in corpus B (different name so createEntity does not dedup to A).
    const bName = await createEntity({ name: `Graph Neural Network Message Passing ZZB${run}`, type: 'concept', corpusId: B });

    // === corpus A: the tool runs through the agent surface and returns fused, scoped results ===
    const resA = await callTool(query, A);
    assert(resA.length > 0, 'recall_entities_fused reachable via handleToolCall(reasoning_agent) and returns results');
    assert(resA.every((e) => e.corpusId === A), 'every result is corpus A (scoping)');
    const idsA = new Set(resA.map((e) => e.id));
    assert(idsA.has(aName.id), 'result includes the NAME-signal entity');
    assert(idsA.has(aFact.id), 'result includes the FACT-signal entity (fusion recovered it via its fact)');
    assert(!idsA.has(bName.id), 'result excludes the corpus-B decoy');
    assert(resA.some((e) => e.nameSimilarity !== null), 'the name signal is live (>=1 hit with nameSimilarity)');
    assert(resA.some((e) => e.factSimilarity !== null), 'the fact signal is live (>=1 hit with factSimilarity)');
    const aFactRow = resA.find((e) => e.id === aFact.id)!;
    assert(aFactRow.factSimilarity !== null, 'the FACT-signal entity carries a factSimilarity (surfaced by the fact leg)');

    // === corpus B: same call scoped to B returns the decoy only ===
    const resB = await callTool(query, B);
    const idsB = new Set(resB.map((e) => e.id));
    assert(resB.every((e) => e.corpusId === B), 'every result is corpus B (scoping)');
    assert(idsB.has(bName.id), 'corpus-B call returns the B decoy');
    assert(!idsB.has(aName.id) && !idsB.has(aFact.id), 'corpus-B call returns NEITHER A entity');

    console.log('\n[fused-tool-probe] RESULT: PASS — recall_entities_fused runs through the MCP agent surface, fuses name + fact signals, and stays inside the invocation corpus.');
  } finally {
    delete process.env.MNEMO_AGENT_ACTOR;
    delete process.env.MNEMO_CORPUS_ID;
    await cleanup();
    const left = (await db.execute(sql`
      SELECT (SELECT count(*) FROM public.entities WHERE corpus_id IN (${A}, ${B})) AS entities,
             (SELECT count(*) FROM public.facts WHERE corpus_id IN (${A}, ${B})) AS facts,
             (SELECT count(*) FROM public.causal_events WHERE corpus_id IN (${A}, ${B})) AS events
    `)) as unknown as Array<{ entities: number; facts: number; events: number }>;
    console.log(`[fused-tool-probe] cleanup: leftover entities=${left[0]!.entities} facts=${left[0]!.facts} events=${left[0]!.events} (all must be 0)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
