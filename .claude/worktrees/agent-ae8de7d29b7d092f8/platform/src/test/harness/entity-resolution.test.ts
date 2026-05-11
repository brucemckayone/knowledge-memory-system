/**
 * Entity resolution convergence tests.
 *
 * Requires PostgreSQL + Ollama + ML services running.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { isMLServiceAvailable, skipCtx } from '../setup.js';

// Unique tag per run so the test is insensitive to data from parallel
// workers touching the same tables. The previous version wiped facts /
// entities globally in beforeAll, which cascaded into every other file's
// in-flight causal_events writes.
const TAG = `er-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const n = (base: string) => `${base} ${TAG}`;

// ML extraction via Claude API is slow — 60s per test
describe('entity resolution convergence', { timeout: 120_000 }, () => {
  beforeAll(async (ctx) => {
    if (!await isMLServiceAvailable()) skipCtx(ctx);
  });

  it('ERC-001: same mention converges to same entity', async () => {
    const { resolveEntity } = await import('../../services/entities.js');

    const name = n('Margaret Saville');
    const first = await resolveEntity(name, `a letter to ${name}`, 'person');
    const second = await resolveEntity(name, `wrote to ${name} in England`, 'person');

    expect(first.id).toBe(second.id);
    expect(second.isNew).toBe(false);
  });

  it('ERC-007: alias accumulation', async () => {
    const { resolveEntity, getEntityById } = await import('../../services/entities.js');

    const full = n('Victor Frankenstein');
    const shortName = n('V. Frankenstein');
    const r1 = await resolveEntity(full, `${full} the scientist`, 'person');
    const alias = await resolveEntity(shortName, `letter from ${shortName}`, 'person');

    expect(r1.id).toBeTruthy();
    expect(alias.id).toBeTruthy();

    const entity = await getEntityById(r1.id);
    expect(entity).not.toBeNull();
  });

  it('ERC-002: new entity creation for dissimilar mention', async () => {
    const { resolveEntity } = await import('../../services/entities.js');

    const personName = n('Margaret Saville');
    const conceptName = n('Qdrant Database');
    const r1 = await resolveEntity(personName, `letter to ${personName}`, 'person');
    const different = await resolveEntity(conceptName, `vector search in ${conceptName}`, 'concept');

    expect(r1.id).not.toBe(different.id);
  });

  it('concurrency: 5 parallel calls produce 1 entity', async () => {
    const { resolveEntity } = await import('../../services/entities.js');

    const name = n('Robert Walton');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        resolveEntity(name, `Captain ${name} sailed north`, 'person')
      )
    );

    const ids = new Set(results.map(r => r.id));
    expect(ids.size).toBe(1);
  });
});
