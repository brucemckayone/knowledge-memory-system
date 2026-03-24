/**
 * Graph Service
 *
 * Interfaces with Apache AGE for Cypher queries on the knowledge graph.
 * Provides neighbor discovery and graph traversal.
 */

import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

/** Strip agtype quoting from Apache AGE Cypher results */
function stripAgtype(value: unknown): string {
  return String(value).replace(/"/g, '');
}

/** Execute a Cypher query and return typed rows */
async function executeCypher<T>(
  query: string,
  columns: string
): Promise<T[]> {
  const result = await db.execute(sql`
    SELECT * FROM cypher('knowledge_graph', $$ ${sql.raw(query)} $$)
    as (${sql.raw(columns)})
  `);
  return result as unknown as T[];
}

export interface GraphEntity {
  entityId: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface GraphEdge {
  fromEntityId: string;
  toEntityId: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface GraphPath {
  nodes: GraphEntity[];
  edges: GraphEdge[];
  length: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELATIONSHIP_TYPE_RE = /^[A-Z_]{1,64}$/;

/**
 * Get all edges in the knowledge graph (optionally filtered by type)
 */
export async function getAllEdges(
  options: { relationshipType?: string; limit?: number } = {}
): Promise<GraphEdge[]> {
  const { relationshipType, limit = 500 } = options;
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 5000));

  try {
    let cypherQuery: string;

    if (relationshipType) {
      const safeType = relationshipType.toUpperCase();
      if (!RELATIONSHIP_TYPE_RE.test(safeType)) {
        throw new Error('Invalid relationshipType: must contain only A-Z and underscores (max 64 chars)');
      }
      cypherQuery = `
        MATCH (a:Entity)-[r:${safeType}]->(b:Entity)
        RETURN a.entity_id as from_id, b.entity_id as to_id, type(r) as rel_type
        LIMIT ${safeLimit}
      `;
    } else {
      cypherQuery = `
        MATCH (a:Entity)-[r]->(b:Entity)
        RETURN a.entity_id as from_id, b.entity_id as to_id, type(r) as rel_type
        LIMIT ${safeLimit}
      `;
    }

    const rows = await executeCypher<{ from_id: string; to_id: string; rel_type: string }>(
      cypherQuery, 'from_id agtype, to_id agtype, rel_type agtype'
    );

    return rows.map(row => ({
      fromEntityId: stripAgtype(row.from_id),
      toEntityId: stripAgtype(row.to_id),
      type: stripAgtype(row.rel_type),
    }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid ')) throw error;
    console.error('Failed to get all edges:', error);
    return [];
  }
}

/**
 * Get degree counts (number of edges) for entities
 */
export async function getEntityDegrees(
  entityIds?: string[]
): Promise<Map<string, number>> {
  const degrees = new Map<string, number>();

  try {
    let cypherQuery: string;

    if (entityIds && entityIds.length > 0) {
      // Validate all IDs
      for (const id of entityIds) {
        if (!UUID_RE.test(id)) {
          throw new Error(`Invalid entityId: ${id}`);
        }
      }
      const idList = entityIds.map(id => `'${id}'`).join(', ');
      cypherQuery = `
        MATCH (a:Entity)
        WHERE a.entity_id IN [${idList}]
        OPTIONAL MATCH (a)-[r]-()
        RETURN a.entity_id as id, count(r) as degree
      `;
    } else {
      cypherQuery = `
        MATCH (a:Entity)
        OPTIONAL MATCH (a)-[r]-()
        RETURN a.entity_id as id, count(r) as degree
      `;
    }

    const rows = await executeCypher<{ id: string; degree: string }>(
      cypherQuery, 'id agtype, degree agtype'
    );

    for (const row of rows) {
      const entityId = stripAgtype(row.id);
      const degree = parseInt(stripAgtype(row.degree), 10);
      degrees.set(entityId, degree);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid ')) throw error;
    console.error('Failed to get entity degrees:', error);
  }

  return degrees;
}

/**
 * Get a subgraph around a set of seed entities
 */
export async function getSubgraph(
  seedEntityIds: string[],
  options: { maxDepth?: number; limit?: number } = {}
): Promise<{ nodes: GraphEntity[]; edges: GraphEdge[] }> {
  const { maxDepth = 2, limit = 200 } = options;
  const safeDepth = Math.max(1, Math.min(Math.floor(maxDepth), 5));
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));

  // Validate all seed IDs
  for (const id of seedEntityIds) {
    if (!UUID_RE.test(id)) {
      throw new Error(`Invalid entityId: ${id}`);
    }
  }

  if (seedEntityIds.length === 0) {
    return { nodes: [], edges: [] };
  }

  try {
    const idList = seedEntityIds.map(id => `'${id}'`).join(', ');

    // Get nodes
    const nodeQuery = `
      MATCH (a:Entity)
      WHERE a.entity_id IN [${idList}]
      OPTIONAL MATCH (a)-[*1..${safeDepth}]-(b:Entity)
      WITH collect(DISTINCT a) + collect(DISTINCT b) AS all_nodes
      UNWIND all_nodes AS n
      RETURN DISTINCT n.entity_id as id, n.name as name, n.type as type
      LIMIT ${safeLimit}
    `;

    const nodeRows = await executeCypher<{ id: string; name: string; type: string }>(
      nodeQuery, 'id agtype, name agtype, type agtype'
    );

    const nodes: GraphEntity[] = nodeRows
      .filter(row => row.id != null)
      .map(row => ({
        entityId: stripAgtype(row.id),
        name: stripAgtype(row.name),
        type: stripAgtype(row.type),
      }));

    const nodeIds = new Set(nodes.map(n => n.entityId));

    // Get edges between discovered nodes
    const edgeQuery = `
      MATCH (a:Entity)-[r]->(b:Entity)
      WHERE a.entity_id IN [${[...nodeIds].map(id => `'${id}'`).join(', ')}]
        AND b.entity_id IN [${[...nodeIds].map(id => `'${id}'`).join(', ')}]
      RETURN a.entity_id as from_id, b.entity_id as to_id, type(r) as rel_type
      LIMIT ${safeLimit}
    `;

    const edgeRows = await executeCypher<{ from_id: string; to_id: string; rel_type: string }>(
      edgeQuery, 'from_id agtype, to_id agtype, rel_type agtype'
    );

    const edges: GraphEdge[] = edgeRows.map(row => ({
      fromEntityId: stripAgtype(row.from_id),
      toEntityId: stripAgtype(row.to_id),
      type: stripAgtype(row.rel_type),
    }));

    return { nodes, edges };
  } catch (error) {
    console.error('Failed to get subgraph:', error);
    return { nodes: [], edges: [] };
  }
}

/**
 * Find entities connected to a given entity
 */
export async function findConnectedEntities(
  entityId: string,
  options: { relationshipType?: string; maxDepth?: number; limit?: number } = {}
): Promise<GraphEntity[]> {
  const { relationshipType, maxDepth = 1, limit = 50 } = options;

  // Validate inputs to prevent Cypher injection
  if (!UUID_RE.test(entityId)) {
    throw new Error('Invalid entityId: must be a valid UUID');
  }

  const safeDepth = Math.max(1, Math.min(Math.floor(maxDepth), 5));
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));

  try {
    let cypherQuery: string;

    if (relationshipType) {
      const safeType = relationshipType.toUpperCase();
      if (!RELATIONSHIP_TYPE_RE.test(safeType)) {
        throw new Error('Invalid relationshipType: must contain only A-Z and underscores (max 64 chars)');
      }
      cypherQuery = `
        MATCH (a:Entity {entity_id: '${entityId}'})-[:${safeType}*1..${safeDepth}]-(b:Entity)
        RETURN DISTINCT b.entity_id as id, b.name as name, b.type as type
        LIMIT ${safeLimit}
      `;
    } else {
      cypherQuery = `
        MATCH (a:Entity {entity_id: '${entityId}'})-[*1..${safeDepth}]-(b:Entity)
        RETURN DISTINCT b.entity_id as id, b.name as name, b.type as type
        LIMIT ${safeLimit}
      `;
    }

    const rows = await executeCypher<{ id: string; name: string; type: string }>(
      cypherQuery, 'id agtype, name agtype, type agtype'
    );

    return rows.map(row => ({
      entityId: stripAgtype(row.id),
      name: stripAgtype(row.name),
      type: stripAgtype(row.type),
    }));
  } catch (error) {
    console.error('Failed to find connected entities:', error);
    return [];
  }
}
