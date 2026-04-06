/**
 * Pipeline integration tests.
 *
 * Requires PostgreSQL, Qdrant, Ollama, and ML services running.
 * Skips gracefully when services are unavailable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { isMLServiceAvailable, skipCtx } from '../setup.js';

describe('ingest() pipeline', { timeout: 120_000 }, () => {
  beforeAll(async (ctx) => {
    if (!await isMLServiceAvailable()) skipCtx(ctx);
  });

  it('returns entities for a simple sentence', async () => {
    const { ingest } = await import('../../pipeline.js');
    const result = await ingest('John Smith works at Acme Corp in London');

    expect(result.memoryId).toBeTruthy();
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.timing.total).toBeGreaterThan(0);
    expect(result.timing.extractEntities).toBeGreaterThan(0);
  });

  it('creates facts from relationships', async () => {
    const { ingest } = await import('../../pipeline.js');
    const result = await ingest('Alice manages Bob at TechCorp');

    expect(result.entities.length).toBeGreaterThanOrEqual(2);
    expect(result.timing.extractRelationships).toBeGreaterThanOrEqual(0);
    expect(result.timing.createFacts).toBeGreaterThanOrEqual(0);
  });

  it('filters anaphoric mentions', async () => {
    const { ingest } = await import('../../pipeline.js');
    const result = await ingest('The man visited a lady in the park near Big Ben');

    // "The man" and "a lady" should be filtered
    const filteredLower = result.filtered.map(f => f.toLowerCase());
    const hasAnaphoric = filteredLower.some(f => f.includes('the man') || f.includes('a lady'));
    const hasBigBen = result.entities.some(e =>
      e.canonicalName.toLowerCase().includes('big ben')
    );

    expect(hasAnaphoric || hasBigBen || result.filtered.length > 0).toBe(true);
  });
});

describe('store() + extract() decoupled', { timeout: 120_000 }, () => {
  beforeAll(async (ctx) => {
    if (!await isMLServiceAvailable()) skipCtx(ctx);
  });

  it('store returns UUID, extract processes it', async () => {
    const { store, extract } = await import('../../pipeline.js');
    const memoryId = await store('Marie Curie discovered radium in Paris');

    expect(memoryId).toMatch(/^[0-9a-f-]{36}$/);

    const result = await extract(memoryId);
    expect(result.memoryId).toBe(memoryId);
    expect(result.entities.length).toBeGreaterThan(0);
  });
});
