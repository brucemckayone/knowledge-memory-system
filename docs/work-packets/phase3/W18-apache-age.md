# Work Packet W18: Apache AGE Graph

**Status:** ⚠️ Partial (infrastructure done, service underutilized)
**Dependencies:** W16 (Entity Schema), W17 (Bi-Temporal Facts)  
**Estimated Time:** 3-4 hours

---

## Objective

Install and configure Apache AGE (A Graph Extension for PostgreSQL) to enable Cypher graph queries alongside SQL. This creates the graph layer for entity relationships and enables graph traversal for knowledge discovery.

---

## Research Reference

From [GARDENER_RESEARCH.md](../../research/gardener-research.md) lines 295-333:
- Apache AGE is recommended for PostgreSQL integration
- Cypher queries can be combined with SQL
- Community detection uses graph structure

---

## Installation

### Step 1: Install Apache AGE Extension

For Docker-based PostgreSQL, update `docker-compose.yml`:

```yaml
postgres:
  # Use AGE-enabled image or build custom
  build:
    context: ./docker/postgres
    dockerfile: Dockerfile
  # ... rest of config
```

Create `docker/postgres/Dockerfile`:

```dockerfile
FROM postgres:16-alpine

# Install build dependencies
RUN apk add --no-cache \
    build-base \
    git \
    clang15 \
    llvm15

# Clone and build AGE
RUN git clone https://github.com/apache/age.git /tmp/age && \
    cd /tmp/age && \
    make PG_CONFIG=/usr/local/bin/pg_config install

# Cleanup
RUN rm -rf /tmp/age && \
    apk del build-base git clang15 llvm15
```

### Step 2: Initialize Extension

Create `platform/src/db/migrations/005_apache_age.sql`:

```sql
-- Enable Apache AGE
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';

-- Set search path to include AGE
SET search_path = ag_catalog, "$user", public;

-- Create knowledge graph
SELECT create_graph('knowledge_graph');

-- Verify installation
SELECT * FROM ag_catalog.ag_graph WHERE name = 'knowledge_graph';
```

---

## Graph Schema

### Entity Nodes

```sql
-- Create entity node from PostgreSQL entity
SELECT * FROM cypher('knowledge_graph', $$
    CREATE (e:Entity {
        entity_id: $id,
        name: $name,
        type: $type,
        properties: $properties
    })
    RETURN e
$$, ARRAY[$1, $2, $3, $4::jsonb]) as (e agtype);
```

### Relationship Edges

```sql
-- Create relationship edge from fact
SELECT * FROM cypher('knowledge_graph', $$
    MATCH (s:Entity {entity_id: $subject_id}), (o:Entity {entity_id: $object_id})
    CREATE (s)-[r:$predicate {
        fact_id: $fact_id,
        valid_at: $valid_at,
        confidence: $confidence
    }]->(o)
    RETURN r
$$, ARRAY[$1, $2, $3, $4, $5, $6]) as (r agtype);
```

### Memory Links

```sql
-- Link memory to entities it mentions
SELECT * FROM cypher('knowledge_graph', $$
    MATCH (e:Entity {entity_id: $entity_id})
    CREATE (m:Memory {memory_id: $memory_id})
    CREATE (m)-[:MENTIONS {
        mention_text: $mention_text,
        confidence: $confidence
    }]->(e)
    RETURN m
$$, ARRAY[$1, $2, $3, $4]) as (m agtype);
```

---

## TypeScript Service

Create `platform/src/services/graph.ts`:

```typescript
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

export interface GraphEntity {
  entityId: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface GraphPath {
  nodes: GraphEntity[];
  edges: Array<{
    predicate: string;
    factId: string;
    confidence: number;
  }>;
  totalHops: number;
}

/**
 * Create entity node in graph
 */
export async function createEntityNode(entity: GraphEntity): Promise<void> {
  await db.execute(sql`
    SELECT * FROM cypher('knowledge_graph', $$
      CREATE (e:Entity {
        entity_id: '${sql.raw(entity.entityId)}',
        name: '${sql.raw(entity.name)}',
        type: '${sql.raw(entity.type)}'
      })
    $$) as (e agtype)
  `);
}

/**
 * Create relationship edge in graph
 */
export async function createRelationshipEdge(
  subjectId: string,
  objectId: string,
  predicate: string,
  factId: string,
  confidence: number
): Promise<void> {
  await db.execute(sql`
    SELECT * FROM cypher('knowledge_graph', $$
      MATCH (s:Entity {entity_id: '${sql.raw(subjectId)}'}),
            (o:Entity {entity_id: '${sql.raw(objectId)}'})
      CREATE (s)-[r:${sql.raw(predicate.toUpperCase())} {
        fact_id: '${sql.raw(factId)}',
        confidence: ${confidence}
      }]->(o)
    $$) as (r agtype)
  `);
}

/**
 * Find paths between two entities
 */
export async function findPaths(
  sourceEntityId: string,
  targetEntityId: string,
  maxHops: number = 3
): Promise<GraphPath[]> {
  const result = await db.execute(sql`
    SELECT * FROM cypher('knowledge_graph', $$
      MATCH path = (s:Entity {entity_id: '${sql.raw(sourceEntityId)}'})
                   -[*1..${maxHops}]->
                   (t:Entity {entity_id: '${sql.raw(targetEntityId)}'})
      RETURN path
      LIMIT 10
    $$) as (path agtype)
  `);
  
  return parsePaths(result.rows);
}

/**
 * Find entities connected to source
 */
export async function findConnectedEntities(
  entityId: string,
  hops: number = 2
): Promise<GraphEntity[]> {
  const result = await db.execute(sql`
    SELECT * FROM cypher('knowledge_graph', $$
      MATCH (s:Entity {entity_id: '${sql.raw(entityId)}'})
            -[*1..${hops}]->
            (e:Entity)
      WHERE e.entity_id <> '${sql.raw(entityId)}'
      RETURN DISTINCT e.entity_id, e.name, e.type
      LIMIT 50
    $$) as (entity_id agtype, name agtype, type agtype)
  `);
  
  return result.rows.map((row: any) => ({
    entityId: String(row.entity_id).replace(/"/g, ''),
    name: String(row.name).replace(/"/g, ''),
    type: String(row.type).replace(/"/g, ''),
    properties: {},
  }));
}

/**
 * Get entity neighborhood (for visualization)
 */
export async function getEntityNeighborhood(
  entityId: string,
  depth: number = 1
): Promise<{ nodes: GraphEntity[]; edges: any[] }> {
  const nodesResult = await db.execute(sql`
    SELECT * FROM cypher('knowledge_graph', $$
      MATCH path = (s:Entity {entity_id: '${sql.raw(entityId)}'})
                   -[*1..${depth}]-(e:Entity)
      UNWIND nodes(path) as node
      RETURN DISTINCT node.entity_id, node.name, node.type
    $$) as (entity_id agtype, name agtype, type agtype)
  `);
  
  const edgesResult = await db.execute(sql`
    SELECT * FROM cypher('knowledge_graph', $$
      MATCH (s:Entity {entity_id: '${sql.raw(entityId)}'})
            -[r*1..${depth}]-(e:Entity)
      UNWIND r as rel
      RETURN DISTINCT startNode(rel).entity_id as source,
                      endNode(rel).entity_id as target,
                      type(rel) as predicate
    $$) as (source agtype, target agtype, predicate agtype)
  `);
  
  return {
    nodes: nodesResult.rows.map((row: any) => ({
      entityId: String(row.entity_id).replace(/"/g, ''),
      name: String(row.name).replace(/"/g, ''),
      type: String(row.type).replace(/"/g, ''),
      properties: {},
    })),
    edges: edgesResult.rows.map((row: any) => ({
      source: String(row.source).replace(/"/g, ''),
      target: String(row.target).replace(/"/g, ''),
      predicate: String(row.predicate).replace(/"/g, ''),
    })),
  };
}

function parsePaths(rows: any[]): GraphPath[] {
  // Parse AGE path format to our structure
  return rows.map(row => ({
    nodes: [],
    edges: [],
    totalHops: 0,
  }));
}
```

---

## Sync Service

Create `platform/src/services/graph-sync.ts`:

```typescript
import { db } from '../db/index.js';
import { entities, facts } from '../db/schema.js';
import { eq, isNull } from 'drizzle-orm';
import { createEntityNode, createRelationshipEdge } from './graph.js';

/**
 * Sync all entities to graph
 */
export async function syncEntitiesToGraph(): Promise<number> {
  const allEntities = await db.select().from(entities);
  
  for (const entity of allEntities) {
    try {
      await createEntityNode({
        entityId: entity.id,
        name: entity.canonicalName,
        type: entity.entityType,
        properties: entity.properties as Record<string, unknown>,
      });
    } catch (error) {
      // Node may already exist
      console.warn(`Entity node ${entity.id} may already exist:`, error);
    }
  }
  
  return allEntities.length;
}

/**
 * Sync all facts to graph as edges
 */
export async function syncFactsToGraph(): Promise<number> {
  const allFacts = await db
    .select()
    .from(facts)
    .where(isNull(facts.expiredAt));
  
  let synced = 0;
  for (const fact of allFacts) {
    if (!fact.objectEntityId) continue;  // Skip literal facts
    
    try {
      await createRelationshipEdge(
        fact.subjectEntityId,
        fact.objectEntityId,
        fact.predicate,
        fact.id,
        fact.confidence || 1.0
      );
      synced++;
    } catch (error) {
      console.warn(`Fact edge ${fact.id} may already exist:`, error);
    }
  }
  
  return synced;
}

/**
 * Full sync (for initial setup or repair)
 */
export async function fullGraphSync(): Promise<{ entities: number; facts: number }> {
  const entityCount = await syncEntitiesToGraph();
  const factCount = await syncFactsToGraph();
  
  console.log(`Graph sync complete: ${entityCount} entities, ${factCount} facts`);
  
  return { entities: entityCount, facts: factCount };
}
```

---

## Verification

### Automated Tests

```bash
# Create platform/src/services/__tests__/graph.test.ts
import { createEntityNode } from '../graph.js';
import { describe, it, expect } from 'vitest';

describe('Graph Service', () => {
  it('should create node via age', async () => {
    // Mock DB execution
  });
});
```

### Manual Verification
```bash
# Test graph creation
psql -d cognitive -c "SELECT * FROM ag_catalog.ag_graph;"

# Test Cypher query
psql -d cognitive -c "
  SELECT * FROM cypher('knowledge_graph', \$\$
    MATCH (e:Entity)
    RETURN e.name, e.type
    LIMIT 5
  \$\$) as (name agtype, type agtype);
"
```

---

## Acceptance Criteria

- [ ] Apache AGE Docker image builds
- [ ] Extension installed successfully
- [ ] `knowledge_graph` graph created
- [ ] Entity nodes can be created
- [ ] Relationship edges can be created
- [ ] `findPaths()` returns paths
- [ ] `findConnectedEntities()` works
- [ ] Sync service populates graph
- [ ] Cypher queries execute via TypeScript

---

## Next Packet

- [W19: Hybrid Retrieval](./W19-hybrid-retrieval.md) - Combine vector + graph search
