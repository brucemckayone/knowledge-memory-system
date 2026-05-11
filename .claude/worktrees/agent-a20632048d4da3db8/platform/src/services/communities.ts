/**
 * Community Detection Service (W30)
 *
 * Implements Louvain-style community detection on the entity graph.
 * Uses graph edges to cluster densely connected entities into communities.
 */

import { db } from '../db/index.js';
import { communities, entities } from '../db/schema.js';
import { inArray, sql } from 'drizzle-orm';
import { getAllEdges } from './graph.js';
import type { GraphEdge } from './graph.js';

export interface DetectedCommunity {
  entityIds: string[];
  coherenceScore: number;
  name?: string;
}

/**
 * Run community detection on the entity graph.
 *
 * Uses a simplified Louvain-style algorithm:
 * 1. Build adjacency from graph edges
 * 2. Greedy modularity optimization
 * 3. Filter out trivial clusters (size < 2)
 */
export async function detectCommunities(
  options: { minSize?: number; maxCommunities?: number } = {}
): Promise<DetectedCommunity[]> {
  const { minSize = 2, maxCommunities = 50 } = options;

  // Get all edges from the graph
  const edges = await getAllEdges({ limit: 5000 });
  if (edges.length === 0) return [];

  // Build adjacency list
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.fromEntityId)) adjacency.set(edge.fromEntityId, new Set());
    if (!adjacency.has(edge.toEntityId)) adjacency.set(edge.toEntityId, new Set());
    adjacency.get(edge.fromEntityId)!.add(edge.toEntityId);
    adjacency.get(edge.toEntityId)!.add(edge.fromEntityId);
  }

  const nodeIds = Array.from(adjacency.keys());
  const totalEdges = edges.length;

  // Initialize: each node in its own community
  const communityOf = new Map<string, number>();
  for (let i = 0; i < nodeIds.length; i++) {
    communityOf.set(nodeIds[i]!, i);
  }

  // Greedy modularity optimization (single pass)
  let improved = true;
  let iterations = 0;
  const maxIterations = 10;

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;

    for (const nodeId of nodeIds) {
      const currentCommunity = communityOf.get(nodeId)!;
      const neighbors = adjacency.get(nodeId) || new Set();

      // Calculate modularity gain for each neighbor's community
      let bestCommunity = currentCommunity;
      let bestGain = 0;

      const neighborCommunities = new Set<number>();
      for (const neighbor of neighbors) {
        neighborCommunities.add(communityOf.get(neighbor)!);
      }

      for (const targetCommunity of neighborCommunities) {
        if (targetCommunity === currentCommunity) continue;

        const gain = calculateModularityGain(
          nodeId, targetCommunity, communityOf, adjacency, totalEdges
        );

        if (gain > bestGain) {
          bestGain = gain;
          bestCommunity = targetCommunity;
        }
      }

      if (bestCommunity !== currentCommunity) {
        communityOf.set(nodeId, bestCommunity);
        improved = true;
      }
    }
  }

  // Group nodes by community
  const communityMap = new Map<number, string[]>();
  for (const [nodeId, community] of communityOf) {
    if (!communityMap.has(community)) communityMap.set(community, []);
    communityMap.get(community)!.push(nodeId);
  }

  // Filter and score communities
  const result: DetectedCommunity[] = [];
  for (const [, memberIds] of communityMap) {
    if (memberIds.length < minSize) continue;

    const coherence = calculateCoherence(memberIds, adjacency, edges);
    result.push({
      entityIds: memberIds,
      coherenceScore: coherence,
    });
  }

  // Sort by size descending, limit
  result.sort((a, b) => b.entityIds.length - a.entityIds.length);
  return result.slice(0, maxCommunities);
}

/**
 * Calculate modularity gain of moving a node to a target community.
 */
function calculateModularityGain(
  nodeId: string,
  targetCommunity: number,
  communityOf: Map<string, number>,
  adjacency: Map<string, Set<string>>,
  totalEdges: number,
): number {
  const neighbors = adjacency.get(nodeId) || new Set();
  const nodeDegree = neighbors.size;
  const m2 = 2 * totalEdges;

  // Count edges to target community
  let edgesToTarget = 0;
  let targetCommunityDegreeSum = 0;

  for (const [id, comm] of communityOf) {
    if (comm === targetCommunity) {
      targetCommunityDegreeSum += (adjacency.get(id)?.size || 0);
      if (neighbors.has(id)) edgesToTarget++;
    }
  }

  // Modularity gain formula
  return (edgesToTarget / totalEdges) - (targetCommunityDegreeSum * nodeDegree) / (m2 * m2);
}

/**
 * Calculate internal coherence of a community (ratio of internal edges to possible edges).
 */
function calculateCoherence(
  memberIds: string[],
  adjacency: Map<string, Set<string>>,
  _edges: GraphEdge[],
): number {
  if (memberIds.length < 2) return 0;

  const memberSet = new Set(memberIds);
  let internalEdges = 0;

  for (const id of memberIds) {
    const neighbors = adjacency.get(id) || new Set();
    for (const neighbor of neighbors) {
      if (memberSet.has(neighbor)) internalEdges++;
    }
  }

  // Each edge counted twice (undirected)
  internalEdges = Math.floor(internalEdges / 2);
  const possibleEdges = (memberIds.length * (memberIds.length - 1)) / 2;

  return possibleEdges > 0 ? internalEdges / possibleEdges : 0;
}

/**
 * Persist detected communities to the database, replacing previous detection.
 */
export async function persistCommunities(detected: DetectedCommunity[]): Promise<number> {
  // Expire old communities
  await db.execute(sql`
    UPDATE communities SET expires_at = NOW() WHERE expires_at IS NULL
  `);

  let stored = 0;
  for (const community of detected) {
    // Try to name the community from its largest/most central entity
    let name: string | undefined;
    if (community.entityIds.length > 0) {
      const topEntities = await db
        .select({ canonicalName: entities.canonicalName })
        .from(entities)
        .where(inArray(entities.id, community.entityIds.slice(0, 3)));
      name = topEntities.map(e => e.canonicalName).join(', ');
    }

    await db.insert(communities).values({
      name: name || `Community of ${community.entityIds.length}`,
      entityIds: community.entityIds,
      coherenceScore: community.coherenceScore,
      size: community.entityIds.length,
    });
    stored++;
  }

  return stored;
}

/**
 * Get active communities.
 */
export async function getActiveCommunities() {
  return db
    .select()
    .from(communities)
    .where(sql`expires_at IS NULL`)
    .orderBy(sql`size DESC`);
}
