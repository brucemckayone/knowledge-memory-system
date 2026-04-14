/**
 * Frankenstein 10-chunk regression test.
 *
 * Requires all services running.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isMLServiceAvailable, skipCtx, deleteFromTables } from '../setup.js';

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

describe('Frankenstein 10-chunk regression', () => {
  beforeAll(async (ctx) => {
    if (!await isMLServiceAvailable()) skipCtx(ctx);
    await deleteFromTables('memory_entities', 'entity_aliases', 'causal_edges', 'causal_events', 'causal_patterns', 'facts', 'entity_merges', 'entities');
  });

  it('ingests 10 chunks and meets quality targets', async () => {
    const { ingest } = await import('../../pipeline.js');
    const chunks = loadChunks();
    expect(chunks.length).toBe(10);

    // Ingest sequentially — temporal order matters for entity resolution,
    // fact dedup, and causal graph integrity.
    const results: Awaited<ReturnType<typeof ingest>>[] = [];
    const failures: { index: number; error: string }[] = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        const result = await ingest(chunks[i]!, { source: `frankenstein-test/chunk-${i}` });
        results.push(result);
      } catch (err: any) {
        failures.push({ index: i, error: err?.message ?? String(err) });
      }
    }
    if (failures.length > 0) {
      console.error(`${failures.length} chunks failed:`, failures);
    }

    expect(results.length).toBeGreaterThanOrEqual(8);

    const allEntities = results.flatMap(r => r.entities);
    const allFacts = results.flatMap(r => r.facts);
    const allSkipped = results.flatMap(r => r.skipped);
    const allFiltered = results.flatMap(r => r.filtered);

    console.log('=== Frankenstein Regression Results ===');
    console.log(`Chunks ingested: ${results.length}`);
    console.log(`Entities resolved: ${allEntities.length}`);
    console.log(`Unique entity IDs: ${new Set(allEntities.map(e => e.id)).size}`);
    console.log(`Facts created: ${allFacts.length}`);
    console.log(`Relationships skipped: ${allSkipped.length}`);
    console.log(`Mentions filtered: ${allFiltered.length}`);

    // Target 1: 0 duplicate entity name+type combinations
    const entityMap = new Map<string, Set<string>>();
    for (const e of allEntities) {
      const key = `${e.canonicalName.toLowerCase()}|${e.entityType}`;
      if (!entityMap.has(key)) entityMap.set(key, new Set());
      entityMap.get(key)!.add(e.id);
    }
    const duplicateNames = [...entityMap.values()].filter(ids => ids.size > 1);
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
    const factKeys = allFacts.map(f => `${f.subject}|${f.predicate}|${f.object}`);
    const uniqueFacts = new Set(factKeys);
    const duplicateFacts = factKeys.length - uniqueFacts.size;
    console.log(`Duplicate facts: ${duplicateFacts}`);
    expect(duplicateFacts).toBe(0);
  }, 300_000);
});
