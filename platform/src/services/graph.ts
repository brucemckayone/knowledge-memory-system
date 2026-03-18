/**
 * Graph Service
 *
 * Interfaces with Apache AGE for Cypher queries on the knowledge graph.
 * Provides neighbor discovery and graph traversal.
 */

import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

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

    const result = await db.execute(sql`
      SELECT * FROM cypher('knowledge_graph', $$ ${sql.raw(cypherQuery)} $$)
      as (id agtype, name agtype, type agtype)
    `);

    return (result as unknown as { rows: Array<{ id: string; name: string; type: string }> }).rows.map(row => ({
      entityId: String(row.id).replace(/"/g, ''),
      name: String(row.name).replace(/"/g, ''),
      type: String(row.type).replace(/"/g, ''),
    }));
  } catch (error) {
    console.error('Failed to find connected entities:', error);
    return [];
  }
}
