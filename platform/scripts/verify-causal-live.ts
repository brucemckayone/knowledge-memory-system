/**
 * E6 live verification (nmemo-vpz.6, criterion 4) — the REAL Haiku causal agent.
 *
 * Seeds a cross-chunk causality scenario on the runtime `cognitive` DB: one company
 * with a SETTLED funding event and a SETTLED relocation event (the shape promotion
 * mints, doc 41 §12 #5), where the relocation's source text says the funding LED TO
 * the move. Then drives runCausalPass() with the REAL invoker (no injected fake): it
 * pushes the settled scope to ML_SERVICES_URL/causal-agent (Claude Code, Haiku), the
 * agent records an edge via propose_causal_edge, and deterministic causal-promotion
 * disposes it into causal_edges — proving a cross-chunk funding->relocation edge is
 * created on SETTLED ids (criterion 4, first half).
 *
 * The second half of criterion 4 — zero `expired_but_cited` contradictions on a
 * corpus10 / corpus20 re-run — is a separate benchmark run, NOT this seeded scenario.
 *
 * Assertions are STRUCTURAL (an edge created between the two settled events, carrying
 * non-empty reasoning + source_references) so the proof survives model variation; the
 * funding->relocation DIRECTION is asserted because criterion 4 names it. TAG-scoped;
 * cleans up in a finally. Safe to re-run. COORDINATE before running against a shared graph.
 *
 * Run:  ML_SERVICES_URL=http://localhost:8001 npx tsx scripts/verify-causal-live.ts
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { runCausalPass } from '../src/services/causal-pass.js';
import type { PromotionResult } from '../src/services/promotion.js';
import { config } from '../src/config.js';

const TAG = 'CAUSLIVE';
const here = dirname(fileURLToPath(import.meta.url));

function log(msg: string): void {
  console.log(`[verify-causal] ${msg}`);
}

async function createEntity(name: string, type: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO public.entities (id, canonical_name, entity_type) VALUES (${id}::uuid, ${name}, ${type})`);
  return id;
}

async function createFact(subjectId: string, predicate: string, objectValue: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO public.facts (id, subject_entity_id, predicate, object_value, source_text, extraction_method)
    VALUES (${id}::uuid, ${subjectId}::uuid, ${predicate}, ${objectValue}, ${TAG + ':prior'}, 'llm')
  `);
  return id;
}

/** Insert a SETTLED causal event (the shape promotion mints, §12 #5). Returns its id. */
async function mintSettledEvent(
  subjectId: string,
  factId: string,
  predicate: string,
  sourceText: string,
  occurredAt: Date,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO public.causal_events (id, fact_id, transition_type, subject_entity_id, predicate, source_text, occurred_at)
    VALUES (${id}::uuid, ${factId}::uuid, 'created', ${subjectId}::uuid, ${predicate}, ${sourceText}, ${occurredAt})
  `);
  return id;
}

async function cleanup(): Promise<void> {
  const tagEnts = sql`SELECT id FROM public.entities WHERE canonical_name LIKE ${TAG + '%'}`;
  const tagEvents = sql`SELECT id FROM public.causal_events WHERE subject_entity_id IN (${tagEnts})`;
  const tagEdges = sql`SELECT id FROM public.causal_edges WHERE cause_event_id IN (${tagEvents}) OR effect_event_id IN (${tagEvents})`;
  // causal_edge_history has no on-delete (RESTRICT); edge_source_refs cascades.
  await db.execute(sql`DELETE FROM public.staging_causal_edges WHERE cause_event_id IN (${tagEvents}) OR effect_event_id IN (${tagEvents})`);
  await db.execute(sql`DELETE FROM public.causal_edge_history WHERE edge_id IN (${tagEdges})`);
  await db.execute(sql`DELETE FROM public.causal_edges WHERE id IN (${tagEdges})`);
  await db.execute(sql`DELETE FROM public.causal_events WHERE subject_entity_id IN (${tagEnts})`);
  await db.execute(sql`DELETE FROM public.fact_history WHERE fact_id IN (SELECT id FROM public.facts WHERE source_text LIKE ${TAG + '%'})`);
  await db.execute(sql`DELETE FROM public.facts WHERE source_text LIKE ${TAG + '%'}`);
  await db.execute(sql`DELETE FROM public.entities WHERE canonical_name LIKE ${TAG + '%'}`);
}

async function main(): Promise<void> {
  log(`config.ML_SERVICES_URL = ${config.ML_SERVICES_URL}  (must be :8001 for worktree Python)`);

  // 1. Apply migration 044 to the runtime DB (idempotent).
  const mig = readFileSync(join(here, '../src/db/migrations/044_causal_pass.sql'), 'utf-8');
  await db.execute(sql.raw(mig));
  log('migration 044 applied (staging_causal_edges + causal_edges.stale_citation present)');

  await cleanup(); // clear any residue from a prior run

  // --- Seed: one company, a settled funding event + a settled relocation event. The
  //     relocation's source text says the funding LED TO the move (triggers (a) +
  //     gives the agent the cross-event narrative to reason from). ---
  const helix = await createEntity(`${TAG} Helix Robotics`, 'organization');
  const fundFact = await createFact(helix, 'raised_round', 'Series B');
  const relocFact = await createFact(helix, 'headquartered_in', 'Austin');
  const funding = await mintSettledEvent(
    helix, fundFact, 'raised_round',
    'Helix Robotics closed a Series B funding round in Q1 2023.',
    new Date('2023-02-01'),
  );
  const relocation = await mintSettledEvent(
    helix, relocFact, 'headquartered_in',
    'The Series B round led to Helix Robotics relocating its headquarters to Austin to scale operations.',
    new Date('2023-06-01'),
  );

  const promotion = {
    epochId: randomUUID(),
    mintedCausalEventIds: [funding, relocation],
    insertedFactIds: [fundFact, relocFact],
    corroboratedFactIds: [],
    expiredFactIds: [],
    mergedAwayEntityIds: [],
    sameAsLinkIds: [],
    mintedEntityIds: {},
    plan: {} as PromotionResult['plan'],
  } as PromotionResult;

  log('seeded settled funding + relocation events; invoking runCausalPass() with the LIVE Haiku causal agent...');
  const res = await runCausalPass(promotion.epochId, promotion); // real invoker (no injected fake)

  // --- Read back what the agent staged + what causal-promotion disposed ---
  const staged = (await db.execute(sql`
    SELECT cause_event_id::text AS cause, effect_event_id::text AS effect, reasoning
    FROM public.staging_causal_edges WHERE epoch_id = ${promotion.epochId}::uuid
  `)) as unknown as Array<{ cause: string; effect: string; reasoning: string }>;

  const edges = (await db.execute(sql`
    SELECT id::text AS id, cause_event_id::text AS cause, effect_event_id::text AS effect,
           reasoning, jsonb_array_length(source_references) AS n_refs, stale_citation
    FROM public.causal_edges
    WHERE cause_event_id IN (${funding}::uuid, ${relocation}::uuid)
      AND effect_event_id IN (${funding}::uuid, ${relocation}::uuid)
      AND expired_at IS NULL
  `)) as unknown as Array<{
    id: string; cause: string; effect: string; reasoning: string; n_refs: number; stale_citation: boolean;
  }>;

  console.log('\n================ CAUSAL PASS (epoch ' + promotion.epochId.slice(0, 8) + ') ================');
  console.log(`  ran=${res.ran}  reasons=${res.decision.reasons.join('; ')}`);
  console.log(
    `  scopeSize=${res.scopeSize ?? 0}  staged=${staged.length}  ` +
      `promoted=${res.promotion?.created.length ?? 0}  dropped=${res.promotion?.dropped.length ?? 0}`,
  );
  for (const e of edges) {
    const dir =
      e.cause === funding && e.effect === relocation
        ? 'funding->relocation'
        : e.cause === relocation && e.effect === funding
          ? 'relocation->funding (REVERSE!)'
          : 'other';
    console.log(`  edge ${dir}: refs=${e.n_refs} stale=${e.stale_citation} reasoning="${(e.reasoning ?? '').slice(0, 90)}..."`);
  }

  // --- Assertions (criterion 4, first half): a funding->relocation edge was CREATED on SETTLED ids ---
  const problems: string[] = [];
  if (!res.ran) problems.push('causal pass did not run (no trigger fired) — expected (a) causal language ("led to") to fire');
  const forward = edges.find((e) => e.cause === funding && e.effect === relocation);
  const anyEdge = edges[0];
  if (!anyEdge) {
    problems.push('no causal edge created between the settled funding/relocation events');
  } else {
    if (!forward) problems.push('an edge exists but NOT funding->relocation (direction wrong)');
    if (!anyEdge.reasoning || anyEdge.reasoning.trim().length === 0) problems.push('promoted edge has empty reasoning (doc-01 invariant)');
    if (Number(anyEdge.n_refs) < 1) problems.push('promoted edge has no source_references (doc-01 invariant)');
  }

  console.log('\n================ RESULT ================');
  if (problems.length === 0) {
    console.log('PASS: the live Haiku causal agent proposed a cross-chunk funding->relocation edge on SETTLED');
    console.log('      event ids; causal-promotion created it with non-empty reasoning + source_references (criterion 4).');
  } else {
    console.log('FAIL:');
    for (const p of problems) console.log('  - ' + p);
  }

  await cleanup();
  log('cleaned up TAG-scoped seed data');
  if (problems.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('[verify-causal] ERROR', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end?.().catch(() => {});
  });
