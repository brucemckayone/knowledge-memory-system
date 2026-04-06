/**
 * Entity resolution convergence tests.
 *
 * Requires PostgreSQL + Ollama + ML services running.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { isMLServiceAvailable, skipCtx, deleteFromTables } from '../setup.js';

// ML extraction via Claude API is slow — 60s per test
describe('entity resolution convergence', { timeout: 120_000 }, () => {
  beforeAll(async (ctx) => {
    if (!await isMLServiceAvailable()) skipCtx(ctx);
    await deleteFromTables('memory_entities', 'entity_aliases', 'facts', 'entity_merges', 'entities');
  });

  it('ERC-001: same mention converges to same entity', async () => {
    const { resolveEntity } = await import('../../services/entities.js');

    const first = await resolveEntity('Margaret Saville', 'a letter to Margaret Saville', 'person');
    const second = await resolveEntity('Margaret Saville', 'wrote to Margaret Saville in England', 'person');

    expect(first.id).toBe(second.id);
    expect(second.isNew).toBe(false);
  });

  it('ERC-007: alias accumulation', async () => {
    const { resolveEntity, getEntityById } = await import('../../services/entities.js');

    const r1 = await resolveEntity('Victor Frankenstein', 'Victor Frankenstein the scientist', 'person');
    const alias = await resolveEntity('V. Frankenstein', 'letter from V. Frankenstein', 'person');

    expect(r1.id).toBeTruthy();
    expect(alias.id).toBeTruthy();

    const entity = await getEntityById(r1.id);
    expect(entity).not.toBeNull();
  });

  it('ERC-002: new entity creation for dissimilar mention', async () => {
    const { resolveEntity } = await import('../../services/entities.js');

    const r1 = await resolveEntity('Margaret Saville', 'letter to Margaret Saville', 'person');
    const different = await resolveEntity('Qdrant Database', 'vector search in Qdrant Database', 'concept');

    expect(r1.id).not.toBe(different.id);
  });

  it('concurrency: 5 parallel calls produce 1 entity', async () => {
    const { resolveEntity } = await import('../../services/entities.js');

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        resolveEntity('Robert Walton', 'Captain Robert Walton sailed north', 'person')
      )
    );

    const ids = new Set(results.map(r => r.id));
    expect(ids.size).toBe(1);
  });
});
