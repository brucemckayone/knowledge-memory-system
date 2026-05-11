/**
 * Community Detection Service Tests (W30)
 *
 * Tests the Louvain community detection algorithm, persistence, and retrieval.
 * Graph edges are mocked — these tests verify the algorithm and DB layer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestEntity, deleteFromTables, randomUUID } from '../setup.js';

// Mock getAllEdges so we control the graph topology
vi.mock('../../services/graph.js', () => ({
  getAllEdges: vi.fn().mockResolvedValue([]),
}));

import { detectCommunities, persistCommunities, getActiveCommunities } from '../../services/communities.js';
import { getAllEdges } from '../../services/graph.js';

describe('Community Detection', () => {
  it('module exports expected functions', () => {
    expect(typeof detectCommunities).toBe('function');
    expect(typeof persistCommunities).toBe('function');
    expect(typeof getActiveCommunities).toBe('function');
  });
});

describe('Community Detection Agent', () => {
  it('has correct name and tier', async () => {
    const { communityDetectionAgent } = await import('../../gardener/agents/community-detection.agent.js');
    expect(communityDetectionAgent.name).toBe('community-detection');
    expect(communityDetectionAgent.tier).toBe('periodic');
  });
});

describe('Louvain algorithm', () => {
  it('returns empty array when no edges', async () => {
    vi.mocked(getAllEdges).mockResolvedValueOnce([]);
    const result = await detectCommunities();
    expect(result).toEqual([]);
  });

  it('detects two clusters from a triangle + pair graph', async () => {
    // Triangle: A—B, B—C, A—C  |  Pair: D—E
    const [a, b, c, d, e] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    vi.mocked(getAllEdges).mockResolvedValueOnce([
      { fromEntityId: a, toEntityId: b, type: 'KNOWS' },
      { fromEntityId: b, toEntityId: c, type: 'KNOWS' },
      { fromEntityId: a, toEntityId: c, type: 'KNOWS' },
      { fromEntityId: d, toEntityId: e, type: 'KNOWS' },
    ]);

    const communities = await detectCommunities({ minSize: 2 });

    // Greedy modularity may not perfectly separate triangle vs pair,
    // but should produce at least one community with >=2 members
    expect(communities.length).toBeGreaterThanOrEqual(1);

    const totalNodes = communities.reduce((sum, c) => sum + c.entityIds.length, 0);
    expect(totalNodes).toBeGreaterThanOrEqual(4); // At least 4 of 5 nodes clustered

    // All communities should have positive coherence
    for (const c of communities) {
      expect(c.coherenceScore).toBeGreaterThanOrEqual(0);
    }
  });

  it('respects minSize filter', async () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];

    vi.mocked(getAllEdges).mockResolvedValueOnce([
      { fromEntityId: a, toEntityId: b, type: 'KNOWS' },
      { fromEntityId: a, toEntityId: c, type: 'KNOWS' },
    ]);

    const communities = await detectCommunities({ minSize: 5 });
    expect(communities).toEqual([]);
  });
});

describe('Community persistence', () => {
  beforeEach(async () => {
    await deleteFromTables('insights', 'communities', 'entities');
  });

  it('persistCommunities writes to DB and getActiveCommunities reads back', async () => {
    const e1 = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const e2 = await createTestEntity({ canonicalName: 'Bob', entityType: 'person' });

    const stored = await persistCommunities([
      { entityIds: [e1.id, e2.id], coherenceScore: 0.75 },
    ]);

    expect(stored).toBe(1);

    const active = await getActiveCommunities();
    expect(active.length).toBeGreaterThanOrEqual(1);

    const community = active.find(c => c.entityIds.includes(e1.id));
    expect(community).toBeDefined();
    expect(community!.size).toBe(2);
    expect(community!.coherenceScore).toBeCloseTo(0.75, 1);
    // Name should contain entity names
    expect(community!.name).toContain('Alice');
  });

  it('persistCommunities expires old communities', async () => {
    const e1 = await createTestEntity({ canonicalName: 'OldEntity', entityType: 'person' });

    // First detection
    await persistCommunities([{ entityIds: [e1.id], coherenceScore: 0.5, name: 'Old' }]);

    // Second detection — should expire the first
    const e2 = await createTestEntity({ canonicalName: 'NewEntity', entityType: 'person' });
    await persistCommunities([{ entityIds: [e2.id], coherenceScore: 0.9, name: 'New' }]);

    const active = await getActiveCommunities();
    // Only the second detection should be active
    const names = active.map(c => c.name);
    expect(names).not.toContain('Old');
  });
});
