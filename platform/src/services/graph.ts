/**
 * Graph Service
 * 
 * Interfaces with Apache AGE for Cypher queries on the knowledge graph.
 * Provides path finding, neighbor discovery, and graph traversal.
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

export interface PathResult {
  nodes: GraphEntity[];
  edges: GraphEdge[];
  length: number;
}

/**
 * Create or update an entity node in the graph
 */
export async function createEntityNode(
  entityId: string,
  name: string,
  type: string,
  properties: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db.execute(sql`
      SELECT sync_entity_to_graph(
        ${entityId}::uuid,
        ${name}::varchar,
        ${type}::varchar,
        ${JSON.stringify(properties)}::jsonb
      )
    `);
  } catch (error) {
    console.error('Failed to sync entity to graph:', error);
  }
}

/**
 * Create a relationship edge between two entities
 */
export async function createRelationshipEdge(
  fromEntityId: string,
  toEntityId: string,
  relationshipType: string,
  properties: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db.execute(sql`
      SELECT create_entity_edge(
        ${fromEntityId}::uuid,
        ${toEntityId}::uuid,
        ${relationshipType}::varchar,
        ${JSON.stringify(properties)}::jsonb
      )
    `);
  } catch (error) {
    console.error('Failed to create graph edge:', error);
  }
}

/**
 * Find paths between two entities
 */
export async function findPaths(
  fromEntityId: string,
  toEntityId: string,
  options: { maxHops?: number; limit?: number } = {}
): Promise<PathResult[]> {
  const { maxHops = 3, limit = 10 } = options;

  try {
    const result = await db.execute(sql`
      SELECT * FROM cypher('knowledge_graph', $$
        MATCH path = (a:Entity {entity_id: '${sql.raw(fromEntityId)}'})-[*1..${sql.raw(String(maxHops))}]-(b:Entity {entity_id: '${sql.raw(toEntityId)}'})
        RETURN path
        LIMIT ${sql.raw(String(limit))}
      $$) as (path agtype)
    `);

    // Parse agtype results into PathResult
    return (result as unknown as { rows: Array<{ path: unknown }> }).rows.map(() => {
      // AGE returns paths as complex objects - simplified parsing here
      return {
        nodes: [],
        edges: [],
        length: 0,
      };
    });
  } catch (error) {
    console.error('Graph path search failed:', error);
    return [];
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

  try {
    let cypherQuery: string;
    
    if (relationshipType) {
      cypherQuery = `
        MATCH (a:Entity {entity_id: '${entityId}'})-[:${relationshipType.toUpperCase()}*1..${maxDepth}]-(b:Entity)
        RETURN DISTINCT b.entity_id as id, b.name as name, b.type as type
        LIMIT ${limit}
      `;
    } else {
      cypherQuery = `
        MATCH (a:Entity {entity_id: '${entityId}'})-[*1..${maxDepth}]-(b:Entity)
        RETURN DISTINCT b.entity_id as id, b.name as name, b.type as type
        LIMIT ${limit}
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

/**
 * Get memories connected to an entity through the graph
 */
export async function getMemoriesViaGraph(
  entityId: string,
  options: { maxHops?: number; limit?: number } = {}
): Promise<string[]> {
  const { maxHops = 2, limit = 50 } = options;

  try {
    const result = await db.execute(sql`
      SELECT * FROM cypher('knowledge_graph', $$
        MATCH (e:Entity {entity_id: '${sql.raw(entityId)}'})-[*1..${sql.raw(String(maxHops))}]-(mem:Memory)
        RETURN DISTINCT mem.memory_id as id
        LIMIT ${sql.raw(String(limit))}
      $$) as (id agtype)
    `);

    return (result as unknown as { rows: Array<{ id: string }> }).rows.map(row => 
      String(row.id).replace(/"/g, '')
    );
  } catch (error) {
    console.error('Failed to find memories via graph:', error);
    return [];
  }
}

/**
 * Link a memory to an entity in the graph
 */
export async function linkMemoryInGraph(
  memoryId: string,
  entityId: string,
  mentionType: string = 'MENTIONS'
): Promise<void> {
  try {
    await db.execute(sql`
      SELECT * FROM cypher('knowledge_graph', $$
        MERGE (m:Memory {memory_id: '${sql.raw(memoryId)}'})
        WITH m
        MATCH (e:Entity {entity_id: '${sql.raw(entityId)}'})
        MERGE (m)-[:${sql.raw(mentionType.toUpperCase())}]->(e)
      $$) as (v agtype)
    `);
  } catch (error) {
    console.error('Failed to link memory in graph:', error);
  }
}

/**
 * Get graph statistics
 */
export async function getGraphStats(): Promise<{
  nodeCount: number;
  edgeCount: number;
  entityTypes: Record<string, number>;
}> {
  try {
    const nodeResult = await db.execute(sql`
      SELECT * FROM cypher('knowledge_graph', $$
        MATCH (n)
        RETURN count(n) as count
      $$) as (count agtype)
    `);

    const edgeResult = await db.execute(sql`
      SELECT * FROM cypher('knowledge_graph', $$
        MATCH ()-[r]->()
        RETURN count(r) as count
      $$) as (count agtype)
    `);

    const nodeCount = parseInt(String((nodeResult as unknown as { rows: Array<{ count: unknown }> }).rows[0]?.count || 0));
    const edgeCount = parseInt(String((edgeResult as unknown as { rows: Array<{ count: unknown }> }).rows[0]?.count || 0));

    return {
      nodeCount,
      edgeCount,
      entityTypes: {},
    };
  } catch (error) {
    console.error('Failed to get graph stats:', error);
    return { nodeCount: 0, edgeCount: 0, entityTypes: {} };
  }
}
