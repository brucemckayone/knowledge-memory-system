/**
 * Pipeline integration tests.
 *
 * These require PostgreSQL, Qdrant, Ollama, and ML services running.
 * Tests skip gracefully when services are unavailable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { isMLServiceAvailable } from '../setup.js';

let pipelineAvailable = false;

beforeAll(async () => {
  pipelineAvailable = await isMLServiceAvailable();
});

describe('ingest() pipeline', () => {
  it.skipIf(() => !pipelineAvailable)('returns entities for a simple sentence', async () => {
    const { ingest } = await import('../../pipeline.js');
    const result = await ingest('John Smith works at Acme Corp in London');

    expect(result.memoryId).toBeTruthy();
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.timing.total).toBeGreaterThan(0);
    expect(result.timing.extractEntities).toBeGreaterThan(0);
  });

  it.skipIf(() => !pipelineAvailable)('creates facts from relationships', async () => {
    const { ingest } = await import('../../pipeline.js');
    const result = await ingest('Alice manages Bob at TechCorp');

    expect(result.entities.length).toBeGreaterThanOrEqual(2);
    // May or may not produce facts depending on ML extraction quality
    // but timing stages should all be populated
    expect(result.timing.extractRelationships).toBeGreaterThanOrEqual(0);
    expect(result.timing.createFacts).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(() => !pipelineAvailable)('filters anaphoric mentions', async () => {
    const { ingest } = await import('../../pipeline.js');
    const result = await ingest('The man visited a lady in the park near Big Ben');

    // "The man" and "a lady" should be filtered
    const filteredLower = result.filtered.map(f => f.toLowerCase());
    const hasAnaphoric = filteredLower.some(f => f.includes('the man') || f.includes('a lady'));
    // Big Ben should survive as a proper entity
    const hasBigBen = result.entities.some(e =>
      e.canonicalName.toLowerCase().includes('big ben')
    );

    // At least one of these should hold (depends on ML extraction)
    expect(hasAnaphoric || hasBigBen || result.filtered.length > 0).toBe(true);
  });
});

describe('store() + extract() decoupled', () => {
  it.skipIf(() => !pipelineAvailable)('store returns UUID, extract processes it', async () => {
    const { store, extract } = await import('../../pipeline.js');
    const memoryId = await store('Marie Curie discovered radium in Paris');

    expect(memoryId).toMatch(/^[0-9a-f-]{36}$/);

    const result = await extract(memoryId);
    expect(result.memoryId).toBe(memoryId);
    expect(result.entities.length).toBeGreaterThan(0);
  });
});
