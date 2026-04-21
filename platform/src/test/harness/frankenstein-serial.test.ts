/**
 * Frankenstein 10-chunk SERIAL baseline test.
 *
 * Ingests the same 10 chunks as the parallel test but sequentially,
 * preserving document order. This establishes the "correct" graph
 * and quantifies divergence from the parallel test.
 *
 * Requires all services running.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { testDb, isMLServiceAvailable, skipCtx, deleteFromTables } from '../setup.js';

function loadChunks(): string[] {
  const text = readFileSync(join(__dirname, '../../../..', 'test-data/frankenstein.txt'), 'utf-8');
  const contentStart = text.indexOf('LETTER 1');
  const content = contentStart > 0 ? text.slice(contentStart) : text;

  return content
    .split(/\r?\n\r?\n+/)
    .map(p => p.replace(/\r/g, '').trim())
    .filter(p => p.length > 50)
    .slice(0, 10);
}

describe('Frankenstein 10-chunk serial baseline', () => {
  beforeAll(async (ctx) => {
    if (!await isMLServiceAvailable()) skipCtx(ctx);
    await deleteFromTables('memory_entities', 'entity_aliases', 'causal_edges', 'causal_events', 'causal_patterns', 'facts', 'entity_merges', 'entities');
  });

  it('ingests 10 chunks sequentially and meets quality targets', async () => {
    const { ingest } = await import('../../pipeline.js');
    const chunks = loadChunks();
    expect(chunks.length).toBe(10);

    // Ingest sequentially — preserving document order
    const results: Awaited<ReturnType<typeof ingest>>[] = [];
    const errors: { index: number; error: string }[] = [];

    for (let i = 0; i < chunks.length; i++) {
      console.log(`\n>>> CHUNK ${i}/${chunks.length - 1} START <<<`);
      try {
        const result = await ingest(chunks[i]!, { source: `frankenstein-serial-test/chunk-${i}` });
        console.log(`>>> CHUNK ${i}/${chunks.length - 1} DONE <<<`);
        results.push(result);
      } catch (err: any) {
        console.error(`>>> CHUNK ${i}/${chunks.length - 1} FAILED: ${err?.message} <<<`);
        errors.push({ index: i, error: err?.message ?? String(err) });
      }
    }
    console.log('\n>>> ALL CHUNKS COMPLETE <<<');

    if (errors.length > 0) {
      console.error(`${errors.length} chunks failed:`, errors);
    }
    expect(results.length).toBeGreaterThanOrEqual(8);

    const allEntities = results.flatMap(r => r.entities);
    const allFacts = results.flatMap(r => r.facts);
    const allSkipped = results.flatMap(r => r.skipped);
    const allFiltered = results.flatMap(r => r.filtered);

    // --- Graph snapshot ---

    // Entity snapshot
    const entityMap = new Map<string, Set<string>>();
    for (const e of allEntities) {
      const key = `${e.canonicalName.toLowerCase()}|${e.entityType}`;
      if (!entityMap.has(key)) entityMap.set(key, new Set());
      entityMap.get(key)!.add(e.id);
    }
    const uniqueEntityIds = new Set(allEntities.map(e => e.id));
    const entitySnapshot = [...new Set(allEntities.map(e => `${e.canonicalName} [${e.entityType}]`))].sort();

    // Fact snapshot
    const factKeys = allFacts.map(f => `${f.subject}|${f.predicate}|${f.object}`);
    const uniqueFacts = new Set(factKeys);
    const factSnapshot = allFacts.map(f => ({
      subject: f.subject,
      predicate: f.predicate,
      object: f.object,
      confidence: f.confidence,
    }));

    // Causal events snapshot (query DB directly)
    const causalEvents = await testDb`
      SELECT id, fact_id, transition_type, subject_entity_id, predicate, delta_confidence
      FROM public.causal_events
      ORDER BY occurred_at
    `;
    const causalTransitionTypes = causalEvents.map((e: any) => e.transition_type);

    // --- Log results ---
    console.log('\n=== Frankenstein Serial Baseline Results ===');
    console.log(`Chunks ingested: ${results.length}/${chunks.length}`);
    console.log(`Errors: ${errors.length}`);
    console.log(`Entities resolved: ${allEntities.length}`);
    console.log(`Unique entity IDs: ${uniqueEntityIds.size}`);
    console.log(`Facts created: ${allFacts.length}`);
    console.log(`Unique facts: ${uniqueFacts.size}`);
    console.log(`Relationships skipped: ${allSkipped.length}`);
    console.log(`Mentions filtered: ${allFiltered.length}`);
    console.log(`Causal events: ${causalEvents.length}`);
    if (causalTransitionTypes.length > 0) {
      const typeCounts: Record<string, number> = {};
      for (const t of causalTransitionTypes) {
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      }
      console.log(`Causal transition types:`, typeCounts);
    }

    console.log('\n--- Entity Snapshot ---');
    for (const e of entitySnapshot) console.log(`  ${e}`);

    console.log('\n--- Fact Snapshot (first 30) ---');
    for (const f of factSnapshot.slice(0, 30)) {
      console.log(`  ${f.subject} --[${f.predicate}]--> ${f.object} (conf: ${f.confidence})`);
    }
    console.log(`  ... (${factSnapshot.length} total)`);

    // Causal reasoning now runs inline inside the unified graph agent — no
    // per-chunk causal payload on the ingest result. Summarise the emitted
    // causal_events instead.
    console.log('\n--- Causal events emitted ---');
    console.log(`  total: ${causalEvents.length}`);

    // --- Quality targets (same as parallel test) ---

    // Target 1: 0 duplicate entity name+type combinations
    const duplicateNames = [...entityMap.values()].filter(ids => ids.size > 1);
    console.log(`\n--- Quality Targets ---`);
    console.log(`Duplicate entity name+type combos: ${duplicateNames.length}`);
    expect(duplicateNames.length).toBe(0);

    // Target 2: <7% relationship subject mismatch
    const totalRelationships = allFacts.length + allSkipped.length;
    if (totalRelationships > 0) {
      const mismatchRate = allSkipped.length / totalRelationships;
      console.log(`Subject mismatch rate: ${(mismatchRate * 100).toFixed(1)}%`);
      expect(mismatchRate).toBeLessThan(0.07);
    }

    // Target 3: 0 exact duplicate facts
    const duplicateFacts = factKeys.length - uniqueFacts.size;
    console.log(`Duplicate facts: ${duplicateFacts}`);
    expect(duplicateFacts).toBe(0);

    // Target 4: No FK violations (serial should produce zero)
    // If we got here with no errors, FK integrity held.
    // Double-check causal_events FK integrity directly
    const fkOrphans = await testDb`
      SELECT ce.id FROM public.causal_events ce
      LEFT JOIN public.facts f ON ce.fact_id = f.id
      WHERE ce.fact_id IS NOT NULL AND f.id IS NULL
    `;
    console.log(`Causal FK orphans: ${fkOrphans.length}`);
    expect(fkOrphans.length).toBe(0);

    console.log('\n=== Serial Baseline Complete ===');
  }, 600_000);
});
