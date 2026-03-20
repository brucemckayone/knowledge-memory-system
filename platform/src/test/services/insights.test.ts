/**
 * Insight Generation Service Tests (W31)
 *
 * Tests insight persistence, retrieval, and dismissal.
 * ML service is not tested here — generateInsights requires
 * an LLM call; we test the DB layer directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, createTestEntity, deleteFromTables, randomUUID } from '../setup.js';
import {
  persistInsights,
  getActiveInsights,
  dismissInsight,
  type GeneratedInsight,
} from '../../services/insights.js';

describe('Insight Generation', () => {
  it('exports expected functions', () => {
    expect(typeof persistInsights).toBe('function');
    expect(typeof getActiveInsights).toBe('function');
    expect(typeof dismissInsight).toBe('function');
  });
});

describe('Insight Generation Agent', () => {
  it('has correct name and tier', async () => {
    const { insightGenerationAgent } = await import('../../gardener/agents/insight-generation.agent.js');
    expect(insightGenerationAgent.name).toBe('generate-insights');
    expect(insightGenerationAgent.tier).toBe('periodic');
  });
});

describe('Insight persistence', () => {
  beforeEach(async () => {
    await deleteFromTables('insights', 'communities', 'entities');
  });

  async function seedCommunity(): Promise<{ communityId: string; entityIds: string[] }> {
    const e1 = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const e2 = await createTestEntity({ canonicalName: 'Acme', entityType: 'company' });
    const communityId = randomUUID();
    await testDb`
      INSERT INTO communities (id, name, entity_ids, coherence_score, size)
      VALUES (${communityId}::uuid, 'Test Community', ARRAY[${e1.id}::uuid, ${e2.id}::uuid], 0.8, 2)
    `;
    return { communityId, entityIds: [e1.id, e2.id] };
  }

  it('persistInsights writes and getActiveInsights reads back', async () => {
    const { communityId, entityIds } = await seedCommunity();

    const insights: GeneratedInsight[] = [
      {
        communityId,
        insightType: 'connection',
        title: 'Alice works at Acme',
        body: 'Alice and Acme appear frequently together.',
        entityIds,
        confidence: 0.85,
      },
    ];

    const count = await persistInsights(insights);
    expect(count).toBe(1);

    const active = await getActiveInsights();
    expect(active.length).toBeGreaterThanOrEqual(1);

    const found = active.find(i => i.title === 'Alice works at Acme');
    expect(found).toBeDefined();
    expect(found!.insightType).toBe('connection');
    expect(found!.confidence).toBeCloseTo(0.85, 1);
    expect(found!.dismissedAt).toBeNull();
  });

  it('dismissInsight excludes from getActiveInsights', async () => {
    const { communityId, entityIds } = await seedCommunity();

    await persistInsights([
      {
        communityId,
        insightType: 'pattern',
        title: 'To be dismissed',
        body: 'This insight will be dismissed.',
        entityIds,
        confidence: 0.5,
      },
      {
        communityId,
        insightType: 'action',
        title: 'Should remain',
        body: 'This insight stays active.',
        entityIds,
        confidence: 0.7,
      },
    ]);

    const before = await getActiveInsights();
    const target = before.find(i => i.title === 'To be dismissed')!;
    expect(target).toBeDefined();

    await dismissInsight(target.id);

    const after = await getActiveInsights();
    const titles = after.map(i => i.title);
    expect(titles).not.toContain('To be dismissed');
    expect(titles).toContain('Should remain');
  });

  it('getActiveInsights respects limit', async () => {
    const { communityId, entityIds } = await seedCommunity();

    const batch: GeneratedInsight[] = Array.from({ length: 5 }, (_, i) => ({
      communityId,
      insightType: 'trend',
      title: `Insight ${i}`,
      body: `Body ${i}`,
      entityIds,
      confidence: 0.5,
    }));
    await persistInsights(batch);

    const limited = await getActiveInsights(2);
    expect(limited.length).toBe(2);
  });
});
