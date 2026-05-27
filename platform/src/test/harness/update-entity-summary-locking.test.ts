/**
 * nmemo-2yv.55 — update_entity_summary optimistic locking via
 * summary_updated_at precondition
 *
 * Locks the concurrent-write contract:
 *   - With a stale expected_summary_updated_at, the handler returns
 *     {updated:false, reason:'stale_write', current_summary,
 *     current_summary_updated_at} and does NOT mutate the row.
 *   - With expected_summary_updated_at omitted entirely, the handler
 *     writes unconditionally (back-compat) and logs a race-unsafe warning.
 *   - With a matching expected_summary_updated_at, the handler writes and
 *     bumps summary_updated_at to a fresh NOW().
 *   - First-ever write (no row yet, or legacy row with NULL summary_updated_at)
 *     succeeds with any value of expected_summary_updated_at (including null).
 *   - Two concurrent calls with the same expected_summary_updated_at — one
 *     succeeds, the other reports stale_write (integration race).
 *   - Read-side surfaces (query_entity_facts, search_entity_aliases,
 *     get_neighbourhood_profile) emit summary_updated_at so the agent can
 *     thread it back through expected_summary_updated_at.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { testDb, createTestEntity } from '../setup.js';
import { handleToolCall } from '../../services/causal-agent.js';
import { db } from '../../db/index.js';
import { entityMeta, entityAliases } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

describe('nmemo-2yv.55: update_entity_summary optimistic locking', () => {
  let entityId: string;

  beforeAll(async () => {
    const entity = await createTestEntity({
      canonicalName: '2yv.55 Locking Test Entity',
      entityType: 'person',
    });
    entityId = entity.id;
  });

  afterAll(async () => {
    await db.delete(entityMeta).where(eq(entityMeta.entityId, entityId)).catch(() => {});
    await db.delete(entityAliases).where(eq(entityAliases.entityId, entityId)).catch(() => {});
    await testDb.unsafe(`DELETE FROM entities WHERE id = '${entityId}'`).catch(() => {});
  });

  beforeEach(async () => {
    // Reset summary state at the start of each test so timestamps are
    // deterministic.
    await db.delete(entityMeta).where(eq(entityMeta.entityId, entityId));
  });

  it('first-ever write (no row yet) succeeds when expected_summary_updated_at is null', async () => {
    const result = await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'First summary, no prior state.',
      expected_summary_updated_at: null,
    });
    expect(JSON.parse(result)).toEqual({ updated: true });

    const rows = await db
      .select({ summary: entityMeta.summary, summaryUpdatedAt: entityMeta.summaryUpdatedAt })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, entityId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.summary).toBe('First summary, no prior state.');
    expect(rows[0]!.summaryUpdatedAt).toBeInstanceOf(Date);
  });

  it('first-ever write succeeds with a non-null expected value (NULL row matches any expected)', async () => {
    // Seed a row with summary_updated_at = NULL (legacy row pre-.52).
    await testDb`
      INSERT INTO entity_meta (entity_id, summary, summary_updated_at)
      VALUES (${entityId}, 'Legacy summary with NULL timestamp', NULL)
    `;
    const result = await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Fresh summary from a caller that supplied a stale guess.',
      expected_summary_updated_at: '2020-01-01T00:00:00.000Z',
    });
    expect(JSON.parse(result)).toEqual({ updated: true });

    const rows = await db
      .select({ summary: entityMeta.summary, summaryUpdatedAt: entityMeta.summaryUpdatedAt })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, entityId));
    expect(rows[0]!.summary).toBe('Fresh summary from a caller that supplied a stale guess.');
    expect(rows[0]!.summaryUpdatedAt).toBeInstanceOf(Date);
  });

  it('matching expected_summary_updated_at writes and bumps the timestamp', async () => {
    // Seed an initial summary.
    await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Initial summary.',
      expected_summary_updated_at: null,
    });
    const seeded = await db
      .select({ summaryUpdatedAt: entityMeta.summaryUpdatedAt })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, entityId));
    const seededTs = seeded[0]!.summaryUpdatedAt!.toISOString();

    // Drizzle's postgres-js timestamp column serialises a JS Date without
    // ms — DB stores second-precision (regardless of the timestamptz column
    // microsecond capacity). Wait a full second so the bumped timestamp is
    // in a different second and the comparison is unambiguous.
    await new Promise(r => setTimeout(r, 1100));

    const result = await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Updated summary with the right expected ts.',
      expected_summary_updated_at: seededTs,
    });
    expect(JSON.parse(result)).toEqual({ updated: true });

    const updated = await db
      .select({ summary: entityMeta.summary, summaryUpdatedAt: entityMeta.summaryUpdatedAt })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, entityId));
    expect(updated[0]!.summary).toBe('Updated summary with the right expected ts.');
    expect(updated[0]!.summaryUpdatedAt!.getTime()).toBeGreaterThan(
      new Date(seededTs).getTime(),
    );
  });

  it('stale expected_summary_updated_at is rejected with structured error and does not mutate', async () => {
    // Seed.
    await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Canonical seeded summary.',
      expected_summary_updated_at: null,
    });
    const seeded = await db
      .select({ summary: entityMeta.summary, summaryUpdatedAt: entityMeta.summaryUpdatedAt })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, entityId));
    const seededSummary = seeded[0]!.summary!;
    const seededTs = seeded[0]!.summaryUpdatedAt!.toISOString();

    // Now attempt a stale write with a fake-old expected timestamp.
    const result = await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'This write should be rejected.',
      expected_summary_updated_at: '2020-01-01T00:00:00.000Z',
    });
    const parsed = JSON.parse(result);
    expect(parsed.updated).toBe(false);
    expect(parsed.reason).toBe('stale_write');
    expect(parsed.current_summary).toBe(seededSummary);
    expect(parsed.current_summary_updated_at).toBe(seededTs);

    // Row is unchanged.
    const after = await db
      .select({ summary: entityMeta.summary, summaryUpdatedAt: entityMeta.summaryUpdatedAt })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, entityId));
    expect(after[0]!.summary).toBe(seededSummary);
    expect(after[0]!.summaryUpdatedAt!.toISOString()).toBe(seededTs);
  });

  it('null expected_summary_updated_at against a row WITH a timestamp is treated as stale', async () => {
    // Seed.
    await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Existing summary with timestamp.',
      expected_summary_updated_at: null,
    });

    const result = await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Attempted overwrite with null expected.',
      expected_summary_updated_at: null,
    });
    const parsed = JSON.parse(result);
    expect(parsed.updated).toBe(false);
    expect(parsed.reason).toBe('stale_write');
    expect(typeof parsed.current_summary_updated_at).toBe('string');
  });

  it('omitted expected_summary_updated_at writes unconditionally (back-compat) and logs a warning', async () => {
    // Seed.
    await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Will be overwritten by back-compat caller.',
      expected_summary_updated_at: null,
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await handleToolCall('update_entity_summary', {
        entity_id: entityId,
        summary: 'Back-compat overwrite.',
      });
      expect(JSON.parse(result)).toEqual({ updated: true });
      expect(warnSpy).toHaveBeenCalled();
      const warningText = warnSpy.mock.calls.map(c => String(c[0])).join(' | ');
      expect(warningText).toMatch(/race-unsafe/i);
      expect(warningText).toContain(entityId);
    } finally {
      warnSpy.mockRestore();
    }

    const rows = await db
      .select({ summary: entityMeta.summary })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, entityId));
    expect(rows[0]!.summary).toBe('Back-compat overwrite.');
  });

  it('two concurrent writes sharing the same expected_summary_updated_at — one succeeds, one reports stale_write', async () => {
    // Seed a baseline summary so both racers see the same expected ts.
    await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Baseline before race.',
      expected_summary_updated_at: null,
    });
    const seeded = await db
      .select({ summaryUpdatedAt: entityMeta.summaryUpdatedAt })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, entityId));
    const sharedExpected = seeded[0]!.summaryUpdatedAt!.toISOString();

    // Fire both writes "concurrently". Note: handleToolCall serialises write
    // tools via the dispatcher's write queue, so logically the second
    // arrives after the first commits — exactly the race we're protecting
    // against. The precondition must reject the second attempt.
    const [a, b] = await Promise.all([
      handleToolCall('update_entity_summary', {
        entity_id: entityId,
        summary: 'Racer A wrote first.',
        expected_summary_updated_at: sharedExpected,
      }),
      handleToolCall('update_entity_summary', {
        entity_id: entityId,
        summary: 'Racer B (loser) should NOT land.',
        expected_summary_updated_at: sharedExpected,
      }),
    ]);

    const results = [JSON.parse(a), JSON.parse(b)];
    const winners = results.filter(r => r.updated === true);
    const losers = results.filter(r => r.updated === false);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0]!.reason).toBe('stale_write');
    expect(typeof losers[0]!.current_summary_updated_at).toBe('string');

    // The row contains exactly the winner's content.
    const finalRow = await db
      .select({ summary: entityMeta.summary })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, entityId));
    expect(['Racer A wrote first.', 'Racer B (loser) should NOT land.']).toContain(finalRow[0]!.summary);
    // Crucially, only one of them landed.
    const losersSummary = 'Racer B (loser) should NOT land.';
    const winnersSummary = 'Racer A wrote first.';
    if (finalRow[0]!.summary === winnersSummary) {
      // First call won; B is the loser.
      expect(losers[0]).toBe(results[1]);
    } else if (finalRow[0]!.summary === losersSummary) {
      // Second call won (it commit-ordered first); A is the loser.
      expect(losers[0]).toBe(results[0]);
    }
  });

  it('read-side surfaces emit summary_updated_at so the agent can thread it back', async () => {
    // Seed a summary and an alias so the read-side tools find this entity.
    await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Surface test seed.',
      expected_summary_updated_at: null,
    });
    await handleToolCall('add_entity_alias', {
      entity_id: entityId,
      alias: '2yv55 surface test alias',
      alias_type: 'reference',
    });

    // query_entity_facts
    const qefRaw = await handleToolCall('query_entity_facts', { entity_id: entityId });
    const qef = JSON.parse(qefRaw);
    expect(typeof qef.summary_updated_at).toBe('string');
    expect(qef.summary_updated_at.length).toBeGreaterThan(10);

    // search_entity_aliases
    const seaRaw = await handleToolCall('search_entity_aliases', {
      query: '2yv55 surface test',
    });
    const sea = JSON.parse(seaRaw) as Array<{ entityId: string; summary_updated_at: string | null }>;
    const ours = sea.find(m => m.entityId === entityId);
    expect(ours).toBeDefined();
    expect(typeof ours!.summary_updated_at).toBe('string');

    // get_neighbourhood_profile
    const gnpRaw = await handleToolCall('get_neighbourhood_profile', {
      entity_id: entityId,
    });
    const gnp = JSON.parse(gnpRaw);
    expect(typeof gnp.summary_updated_at).toBe('string');

    // The three reads should all agree on the same ts (the row hasn't
    // moved between calls).
    expect(qef.summary_updated_at).toBe(ours!.summary_updated_at);
    expect(qef.summary_updated_at).toBe(gnp.summary_updated_at);
  });

  it('agent can thread summary_updated_at from a read back into a safe update', async () => {
    // Seed.
    await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Initial.',
      expected_summary_updated_at: null,
    });

    // Read.
    const readRaw = await handleToolCall('query_entity_facts', { entity_id: entityId });
    const observedTs = JSON.parse(readRaw).summary_updated_at as string;
    expect(typeof observedTs).toBe('string');

    // Thread it back into a safe update.
    const upd = await handleToolCall('update_entity_summary', {
      entity_id: entityId,
      summary: 'Threaded update — should succeed.',
      expected_summary_updated_at: observedTs,
    });
    expect(JSON.parse(upd)).toEqual({ updated: true });
  });
});
