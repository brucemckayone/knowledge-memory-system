/**
 * Integration tests: detectAgedOrphans (bead nmemo-yh2)
 *
 * Aged orphan detection — entities with mentions but zero facts, older than a
 * configurable age threshold. The query lives in graph-meta.ts and runs
 * against the pre-computed entity_meta table (updateEntityMeta() maintains
 * fact_count / mention_count / first_mentioned_at on the pipeline hot path).
 *
 * Acceptance criteria pinned here:
 *   - fact_count > 0 entities are NOT returned (they aren't orphans).
 *   - mention_count = 0 entities are NOT returned (no mentions ⇒ not an orphan).
 *   - first_mentioned_at within the threshold window is NOT returned (too young
 *     — might gain facts on next chunk).
 *   - Threshold is configurable per call.
 *   - Result rows include entity name + type + age in minutes.
 *   - Ordering is by first_mentioned_at ASC (oldest orphans first).
 *   - Limit caps the result set.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  deleteFromTables,
} from '../setup.js';
import {
  detectAgedOrphans,
  DEFAULT_ORPHAN_AGE_THRESHOLD_MIN,
  DEFAULT_ORPHAN_LIMIT,
} from '../../services/graph-meta.js';

async function cleanSlate(): Promise<void> {
  // entity_meta has a CASCADE FK on entities, so wiping entities clears it.
  // We still wipe explicitly to be defensive against snapshot leakage.
  await testDb`DELETE FROM public.entity_meta`;
  await deleteFromTables({
    tables: ['fact_history', 'memory_entities', 'facts', 'entities'],
    acknowledgeGlobal: true,
  });
}

/**
 * Seed entity_meta directly with controlled fact_count / mention_count /
 * first_mentioned_at. Bypasses updateEntityMeta() so the test owns the input
 * shape — the orphan detector is what we're pinning here, not the upsert.
 */
async function seedMeta(opts: {
  canonicalName: string;
  entityType?: string;
  factCount: number;
  mentionCount: number;
  /** Minutes ago — first_mentioned_at = NOW() - this many minutes. */
  ageMin: number;
}): Promise<string> {
  const e = await createTestEntity({
    canonicalName: opts.canonicalName,
    entityType: opts.entityType ?? 'thing',
  });
  await testDb`
    INSERT INTO public.entity_meta (
      entity_id, mention_count, source_memory_count, fact_count,
      first_mentioned_at, last_mentioned_at, updated_at
    ) VALUES (
      ${e.id}::uuid,
      ${opts.mentionCount},
      ${opts.mentionCount},
      ${opts.factCount},
      NOW() - (${opts.ageMin}::int * INTERVAL '1 minute'),
      NOW() - (${opts.ageMin}::int * INTERVAL '1 minute'),
      NOW()
    )
  `;
  return e.id;
}

describe('detectAgedOrphans (nmemo-yh2)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('returns aged orphans matching fact_count=0 AND mention_count>0 AND age > threshold', async () => {
    const orphanId = await seedMeta({
      canonicalName: 'OrphanA',
      factCount: 0,
      mentionCount: 3,
      ageMin: 120, // 2h old
    });

    const orphans = await detectAgedOrphans({ thresholdMin: 60 });

    expect(orphans.length).toBe(1);
    expect(orphans[0]!.entityId).toBe(orphanId);
    expect(orphans[0]!.canonicalName).toBe('OrphanA');
    expect(orphans[0]!.entityType).toBe('thing');
    expect(orphans[0]!.mentionCount).toBe(3);
    expect(orphans[0]!.ageMinutes).toBeGreaterThan(60);
  });

  it('does NOT return entities with fact_count > 0', async () => {
    await seedMeta({
      canonicalName: 'HasFact',
      factCount: 1, // not an orphan
      mentionCount: 2,
      ageMin: 120,
    });

    const orphans = await detectAgedOrphans({ thresholdMin: 60 });
    expect(orphans.length).toBe(0);
  });

  it('does NOT return entities with mention_count = 0', async () => {
    await seedMeta({
      canonicalName: 'NoMentions',
      factCount: 0,
      mentionCount: 0, // never mentioned — not really an orphan
      ageMin: 120,
    });

    const orphans = await detectAgedOrphans({ thresholdMin: 60 });
    expect(orphans.length).toBe(0);
  });

  it('does NOT return entities younger than the threshold', async () => {
    await seedMeta({
      canonicalName: 'YoungOrphan',
      factCount: 0,
      mentionCount: 2,
      ageMin: 30, // 30 min — below the 60-min threshold
    });

    const orphans = await detectAgedOrphans({ thresholdMin: 60 });
    expect(orphans.length).toBe(0);
  });

  it('threshold is per-call configurable — lower threshold returns younger orphans', async () => {
    await seedMeta({
      canonicalName: 'TenMinOrphan',
      factCount: 0,
      mentionCount: 1,
      ageMin: 10,
    });

    const strict = await detectAgedOrphans({ thresholdMin: 60 });
    expect(strict.length).toBe(0);

    const loose = await detectAgedOrphans({ thresholdMin: 5 });
    expect(loose.length).toBe(1);
    expect(loose[0]!.canonicalName).toBe('TenMinOrphan');
  });

  it('orders results by first_mentioned_at ASC (oldest first)', async () => {
    await seedMeta({ canonicalName: 'Mid', factCount: 0, mentionCount: 1, ageMin: 90 });
    await seedMeta({ canonicalName: 'Old', factCount: 0, mentionCount: 1, ageMin: 240 });
    await seedMeta({ canonicalName: 'Recent', factCount: 0, mentionCount: 1, ageMin: 65 });

    const orphans = await detectAgedOrphans({ thresholdMin: 60 });
    expect(orphans.length).toBe(3);
    expect(orphans.map(o => o.canonicalName)).toEqual(['Old', 'Mid', 'Recent']);
    // Oldest age first.
    expect(orphans[0]!.ageMinutes).toBeGreaterThan(orphans[1]!.ageMinutes);
    expect(orphans[1]!.ageMinutes).toBeGreaterThan(orphans[2]!.ageMinutes);
  });

  it('limit caps the result set', async () => {
    for (let i = 0; i < 5; i++) {
      await seedMeta({
        canonicalName: `Orphan-${i}`,
        factCount: 0,
        mentionCount: 1,
        ageMin: 100 + i,
      });
    }

    const limited = await detectAgedOrphans({ thresholdMin: 60, limit: 2 });
    expect(limited.length).toBe(2);
  });

  it('default threshold matches DEFAULT_ORPHAN_AGE_THRESHOLD_MIN (60 min)', async () => {
    // Sanity: exported constant lines up with the WHERE-clause default.
    expect(DEFAULT_ORPHAN_AGE_THRESHOLD_MIN).toBe(60);
    // Exported limit is non-zero so callers without a limit get a bounded query.
    expect(DEFAULT_ORPHAN_LIMIT).toBeGreaterThan(0);

    // Seed one aged orphan; call with no options and confirm it surfaces.
    await seedMeta({
      canonicalName: 'DefaultThresholdOrphan',
      factCount: 0,
      mentionCount: 1,
      ageMin: DEFAULT_ORPHAN_AGE_THRESHOLD_MIN + 30,
    });

    const orphans = await detectAgedOrphans();
    expect(orphans.length).toBe(1);
    expect(orphans[0]!.canonicalName).toBe('DefaultThresholdOrphan');
  });

  it('integrates with real fact creation — adding a fact drops the orphan flag', async () => {
    // End-to-end shape: an entity starts as an aged orphan (fact_count=0), we
    // insert a fact and re-run updateEntityMeta(), and the orphan disappears.
    const { updateEntityMeta } = await import('../../services/graph-meta.js');

    const subject = await seedMeta({
      canonicalName: 'WasOrphan',
      factCount: 0,
      mentionCount: 2,
      ageMin: 120,
    });

    const before = await detectAgedOrphans({ thresholdMin: 60 });
    expect(before.map(o => o.entityId)).toContain(subject);

    // Create an object entity and a fact between the two.
    const object = await createTestEntity({ canonicalName: 'Object', entityType: 'thing' });
    await createTestFact({
      subjectEntityId: subject,
      predicate: 'relates_to',
      objectEntityId: object.id,
    });

    // Re-sync meta. updateEntityMeta recomputes fact_count from active facts.
    await updateEntityMeta([subject]);

    const after = await detectAgedOrphans({ thresholdMin: 60 });
    expect(after.map(o => o.entityId)).not.toContain(subject);
  });
});
