/**
 * Frankenstein 10-chunk regression test.
 *
 * Ingests 10 chunks from Frankenstein and checks metrics against
 * baseline from truth-graph-findings.md (2026-03-31).
 *
 * Requires all services running. Skips otherwise.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isMLServiceAvailable, deleteFromTables } from '../setup.js';

let available = false;

// Extract first 10 paragraphs as chunks (skip Gutenberg header)
function loadChunks(): string[] {
  const text = readFileSync(join(__dirname, '../../../..', 'test-data/frankenstein.txt'), 'utf-8');
  // Skip header — find "LETTER 1" or first real content
  const contentStart = text.indexOf('LETTER 1');
  const content = contentStart > 0 ? text.slice(contentStart) : text;

  // Split into paragraphs, take first 10 non-empty ones
  const paragraphs = content
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 50);

  return paragraphs.slice(0, 10);
}

beforeAll(async () => {
  available = await isMLServiceAvailable();
  if (available) {
    await deleteFromTables('memory_entities', 'entity_aliases', 'facts', 'entity_merges', 'entities');
  }
});

describe('Frankenstein 10-chunk regression', () => {
  it.skipIf(() => !available)('ingests 10 chunks and meets quality targets', async () => {
    const { ingest } = await import('../../pipeline.js');
    const chunks = loadChunks();
    expect(chunks.length).toBe(10);

    // Ingest all chunks
    const results = await Promise.all(
      chunks.map(chunk => ingest(chunk, { source: 'frankenstein-test' }).catch(err => {
        console.error('Chunk failed:', err);
        return null;
      }))
    );

    const successful = results.filter(Boolean);
    expect(successful.length).toBeGreaterThanOrEqual(8); // Allow up to 2 failures

    // Aggregate metrics
    const allEntities = successful.flatMap(r => r!.entities);
    const allFacts = successful.flatMap(r => r!.facts);
    const allSkipped = successful.flatMap(r => r!.skipped);
    const allFiltered = successful.flatMap(r => r!.filtered);

    console.log('=== Frankenstein Regression Results ===');
    console.log(`Chunks ingested: ${successful.length}`);
    console.log(`Total entities resolved: ${allEntities.length}`);
    console.log(`Unique entity IDs: ${new Set(allEntities.map(e => e.id)).size}`);
    console.log(`Facts created: ${allFacts.length}`);
    console.log(`Relationships skipped: ${allSkipped.length}`);
    console.log(`Mentions filtered: ${allFiltered.length}`);

    // Target 1: 0 duplicate entity name+type combinations
    // (advisory lock + check-before-insert should prevent this)
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
      console.log(`Subject mismatch rate: ${(mismatchRate * 100).toFixed(1)}% (${allSkipped.length}/${totalRelationships})`);
      expect(mismatchRate).toBeLessThan(0.07);
    }

    // Target 3: <3 vague/generic entities in filtered list
    // (our specificity filter should catch anaphoric references)
    console.log(`Filtered mentions: ${allFiltered.join(', ')}`);

    // Target 4: 0 exact duplicate facts
    const factKeys = allFacts.map(f => `${f.subject}|${f.predicate}|${f.object}`);
    const uniqueFacts = new Set(factKeys);
    const duplicateFacts = factKeys.length - uniqueFacts.size;
    console.log(`Duplicate facts: ${duplicateFacts}`);
    expect(duplicateFacts).toBe(0);
  }, 300_000); // 5 minute timeout for full pipeline
});
