# Work Packet W30: Community Detection

**Status:** Ready to Implement  
**Dependencies:** W18 (Apache AGE Graph)  
**Estimated Time:** 3-4 hours

---

## Objective

Implement community detection on the knowledge graph to identify clusters of related entities. These communities enable better context retrieval and insight generation.

---

## Research Reference

From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 305-333:
- Graph-based community detection
- Leiden algorithm for clustering
- Community-aware search

---

## Implementation

### Community Detection Service

Create `platform/src/services/communities.ts`:

```typescript
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

export interface Community {
  id: string;
  name: string;
  entityIds: string[];
  size: number;
  coherence: number;
  createdAt: Date;
}

export interface CommunityMember {
  entityId: string;
  entityName: string;
  entityType: string;
  centralityScore: number;
}

/**
 * Detect communities using Louvain-like algorithm
 */
export async function detectCommunities(
  minSize: number = 3
): Promise<Community[]> {
  // Use Apache AGE for graph traversal
  const result = await db.execute(sql`
    SELECT * FROM cypher('knowledge_graph', $$
      MATCH (e:Entity)-[r]-(neighbor:Entity)
      WITH e, collect(DISTINCT neighbor) as neighbors
      RETURN e.entity_id as entity_id, 
             e.name as name,
             e.type as type,
             size(neighbors) as degree
      ORDER BY degree DESC
    $$) as (entity_id agtype, name agtype, type agtype, degree agtype)
  `);
  
  // Build adjacency for community detection
  const adjacency = await buildAdjacencyMatrix();
  
  // Simple community detection (Louvain-inspired)
  const communities = louvainCommunities(adjacency, minSize);
  
  // Store communities
  for (const community of communities) {
    await storeCommunity(community);
  }
  
  return communities;
}

/**
 * Build adjacency matrix from graph
 */
async function buildAdjacencyMatrix(): Promise<Map<string, Set<string>>> {
  const result = await db.execute(sql`
    SELECT * FROM cypher('knowledge_graph', $$
      MATCH (a:Entity)-[r]-(b:Entity)
      RETURN a.entity_id as source, b.entity_id as target
    $$) as (source agtype, target agtype)
  `);
  
  const adjacency = new Map<string, Set<string>>();
  
  for (const row of result.rows) {
    const source = String(row.source).replace(/"/g, '');
    const target = String(row.target).replace(/"/g, '');
    
    if (!adjacency.has(source)) adjacency.set(source, new Set());
    if (!adjacency.has(target)) adjacency.set(target, new Set());
    
    adjacency.get(source)!.add(target);
    adjacency.get(target)!.add(source);
  }
  
  return adjacency;
}

/**
 * Simple Louvain-inspired community detection
 */
function louvainCommunities(
  adjacency: Map<string, Set<string>>,
  minSize: number
): Community[] {
  // Initial assignment: each node in its own community
  const communityMap = new Map<string, string>();
  const communities = new Map<string, Set<string>>();
  
  let communityId = 0;
  for (const node of adjacency.keys()) {
    const id = `community-${communityId++}`;
    communityMap.set(node, id);
    communities.set(id, new Set([node]));
  }
  
  // Iterate to optimize modularity
  let improved = true;
  let iterations = 0;
  const maxIterations = 10;
  
  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;
    
    for (const [node, neighbors] of adjacency) {
      const currentCommunity = communityMap.get(node)!;
      
      // Count neighbors in each community
      const neighborCommunities = new Map<string, number>();
      for (const neighbor of neighbors) {
        const nCommunity = communityMap.get(neighbor)!;
        neighborCommunities.set(
          nCommunity,
          (neighborCommunities.get(nCommunity) || 0) + 1
        );
      }
      
      // Find best community
      let bestCommunity = currentCommunity;
      let bestCount = neighborCommunities.get(currentCommunity) || 0;
      
      for (const [comm, count] of neighborCommunities) {
        if (count > bestCount) {
          bestCommunity = comm;
          bestCount = count;
        }
      }
      
      // Move if beneficial
      if (bestCommunity !== currentCommunity) {
        communities.get(currentCommunity)!.delete(node);
        communities.get(bestCommunity)!.add(node);
        communityMap.set(node, bestCommunity);
        improved = true;
      }
    }
  }
  
  // Convert to Community objects
  const result: Community[] = [];
  for (const [id, members] of communities) {
    if (members.size >= minSize) {
      result.push({
        id,
        name: `Community ${result.length + 1}`,
        entityIds: Array.from(members),
        size: members.size,
        coherence: calculateCoherence(members, adjacency),
        createdAt: new Date(),
      });
    }
  }
  
  return result;
}

/**
 * Calculate community coherence (internal edge density)
 */
function calculateCoherence(
  members: Set<string>,
  adjacency: Map<string, Set<string>>
): number {
  let internalEdges = 0;
  const possibleEdges = members.size * (members.size - 1) / 2;
  
  for (const member of members) {
    const neighbors = adjacency.get(member) || new Set();
    for (const neighbor of neighbors) {
      if (members.has(neighbor)) {
        internalEdges++;
      }
    }
  }
  
  // Each edge counted twice
  internalEdges /= 2;
  
  return possibleEdges > 0 ? internalEdges / possibleEdges : 0;
}

/**
 * Store community in database
 */
async function storeCommunity(community: Community): Promise<void> {
  await db.execute(sql`
    INSERT INTO communities (id, name, entity_ids, size, coherence, created_at)
    VALUES (
      ${community.id},
      ${community.name},
      ${JSON.stringify(community.entityIds)},
      ${community.size},
      ${community.coherence},
      ${community.createdAt}
    )
    ON CONFLICT (id) DO UPDATE
    SET entity_ids = EXCLUDED.entity_ids,
        size = EXCLUDED.size,
        coherence = EXCLUDED.coherence,
        created_at = EXCLUDED.created_at
  `);
}

/**
 * Get community members with details
 */
export async function getCommunityMembers(
  communityId: string
): Promise<CommunityMember[]> {
  const community = await db.execute(sql`
    SELECT entity_ids FROM communities WHERE id = ${communityId}
  `);
  
  if (community.rows.length === 0) return [];
  
  const entityIds = JSON.parse(community.rows[0].entity_ids);
  
  // Get entity details with centrality
  const members: CommunityMember[] = [];
  for (const entityId of entityIds) {
    const entity = await db.execute(sql`
      SELECT canonical_name, entity_type FROM entities WHERE id = ${entityId}
    `);
    
    if (entity.rows.length > 0) {
      const degree = await getEntityDegree(entityId);
      members.push({
        entityId,
        entityName: entity.rows[0].canonical_name,
        entityType: entity.rows[0].entity_type,
        centralityScore: degree,
      });
    }
  }
  
  return members.sort((a, b) => b.centralityScore - a.centralityScore);
}

/**
 * Get entity degree (connection count)
 */
async function getEntityDegree(entityId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT * FROM cypher('knowledge_graph', $$
      MATCH (e:Entity {entity_id: '${sql.raw(entityId)}'})-[r]-()
      RETURN count(r) as degree
    $$) as (degree agtype)
  `);
  
  return result.rows.length > 0 ? parseInt(String(result.rows[0].degree)) : 0;
}
```

### Schema Addition

Create `platform/src/db/migrations/009_communities.sql`:

```sql
CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_ids JSONB NOT NULL DEFAULT '[]',
  size INTEGER NOT NULL DEFAULT 0,
  coherence REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_communities_size ON communities(size DESC);
CREATE INDEX idx_communities_coherence ON communities(coherence DESC);
```

### Agent Registration

Create `platform/src/gardener/agents/community-agent.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { detectCommunities } from '../../services/communities.js';

export const communityAgent: GardenerAgent<{}, { communitiesFound: number }> = {
  name: 'community-detection',
  tier: 'background',
  
  async process(
    job: {},
    context: AgentContext
  ): Promise<AgentResult<{ communitiesFound: number }>> {
    const startTime = Date.now();
    
    try {
      const communities = await detectCommunities(3);
      
      context.logger.info(`Detected ${communities.length} communities`);
      
      return {
        success: true,
        data: { communitiesFound: communities.length },
        metrics: {
          durationMs: Date.now() - startTime,
          communities: communities.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metrics: { durationMs: Date.now() - startTime },
      };
    }
  },
};
```

---

## Verification

### Automated Tests
Run simple unit tests for communities.

```bash
# Create platform/src/services/__tests__/communities.test.ts
import { detectCommunities } from '../communities.js';
import { describe, it, expect } from 'vitest';

describe('Community Detection', () => {
  it('should detect communities', async () => {
     // Mock graph query result
     // Run detection
  });
});
```

### Manual Verification
```bash
# Run community detection
curl -X POST http://localhost:3001/api/gardener/queue \
  -H "Content-Type: application/json" \
  -d '{"agent": "community-detection", "job": {}}'

# View communities
psql -d cognitive -c "SELECT name, size, coherence FROM communities ORDER BY size DESC;"
```

---

## Acceptance Criteria

- [ ] Adjacency matrix built from graph
- [ ] Communities detected via Louvain algorithm
- [ ] Communities stored in database
- [ ] Coherence calculated correctly
- [ ] Members retrievable with centrality
- [ ] Nightly schedule configured

---

## Next Packet

- [W31: Insight Generation](./W31-insight-generation.md) - Generate insights from communities
