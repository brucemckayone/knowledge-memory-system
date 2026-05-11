/**
 * Result Collector
 *
 * Queries PostgreSQL and Qdrant to collect actual results
 * from message processing.
 */

import { db } from '../../db/index.js';
import { entities, facts, tasks } from '../../db/schema.js';
import { qdrant, COLLECTIONS } from '../../services/qdrant.js';
import { eq, sql, desc } from 'drizzle-orm';

/**
 * Collected benchmark results
 */
export interface CollectedResults {
  /** Messages that were injected */
  injectedMessages: number;
  /** Entities created in database */
  entities: EntityResult[];
  /** Facts created in database */
  facts: FactResult[];
  /** Tasks created in database */
  tasks: TaskResult[];
  /** Memories stored in Qdrant */
  memories: MemoryResult[];
  /** Timestamp when collection started */
  collectionTime: Date;
}

export interface EntityResult {
  id: string;
  canonicalName: string;
  entityType: string;
  aliases: string[];
  createdAt: Date;
}

export interface FactResult {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectValue: string | null;
  validAt: Date | null;
  invalidAt: Date | null;
  createdAt: Date;
}

export interface TaskResult {
  id: string;
  content: string;
  status: string;
  priority: string;
  dueDate: Date | null;
  createdAt: Date;
}

export interface MemoryResult {
  id: string;
  type: string;
  content: string;
  summary: string;
  createdAt: Date;
  metadata: Record<string, any>;
}

/**
 * Collect all results from databases
 */
export async function collectResults(options: {
  /** Only collect results after this timestamp */
  afterTimestamp?: Date;
  /** Maximum memories to fetch from Qdrant */
  maxMemories?: number;
} = {}): Promise<CollectedResults> {
  console.log('📊 Collecting results from databases...');

  const collectionTime = new Date();

  // Collect entities
  console.log('   🔍 Collecting entities...');
  const entityRows = await db
    .select()
    .from(entities)
    .orderBy(desc(entities.createdAt));

  // Collect facts
  console.log('   🔍 Collecting facts...');
  const factRows = await db
    .select()
    .from(facts)
    .orderBy(desc(facts.createdAt));

  // Collect tasks
  console.log('   🔍 Collecting tasks...');
  const taskRows = await db
    .select()
    .from(tasks)
    .orderBy(desc(tasks.createdAt));

  // Filter by timestamp if provided
  const filteredEntities = options.afterTimestamp
    ? entityRows.filter(row => row.createdAt >= options.afterTimestamp!)
    : entityRows;
  const filteredFacts = options.afterTimestamp
    ? factRows.filter(row => row.createdAt >= options.afterTimestamp!)
    : factRows;
  const filteredTasks = options.afterTimestamp
    ? taskRows.filter(row => row.createdAt >= options.afterTimestamp!)
    : taskRows;

  // Collect memories from Qdrant
  console.log('   🔍 Collecting memories from Qdrant...');
  const qdrantResults = await qdrant.scroll(COLLECTIONS.MEMORIES, {
    limit: options.maxMemories || 1000,
    with_payload: true,
    with_vector: false,
  });

  const memories = (qdrantResults.points || []).map(point => ({
    id: point.id as string,
    type: (point.payload as any).type || 'unknown',
    content: (point.payload as any).content || '',
    summary: (point.payload as any).summary || '',
    createdAt: new Date((point.payload as any).created_at || Date.now()),
    metadata: point.payload as Record<string, any>,
  }));

  // Filter by timestamp if provided
  const filteredMemories = options.afterTimestamp
    ? memories.filter(m => m.createdAt >= options.afterTimestamp!)
    : memories;

  console.log(`✅ Collection complete:`);
  console.log(`   📚 Entities: ${filteredEntities.length}`);
  console.log(`   🔗 Facts: ${filteredFacts.length}`);
  console.log(`   📋 Tasks: ${filteredTasks.length}`);
  console.log(`   💭 Memories: ${filteredMemories.length}`);

  return {
    injectedMessages: 0, // Will be set by caller
    entities: filteredEntities.map(row => ({
      id: row.id,
      canonicalName: row.canonicalName,
      entityType: row.entityType,
      aliases: [], // Will be populated from entityAliases table if needed
      createdAt: row.createdAt,
    })),
    facts: filteredFacts.map(row => ({
      id: row.id,
      subjectEntityId: row.subjectEntityId,
      predicate: row.predicate,
      objectValue: row.objectValue,
      validAt: row.validAt,
      invalidAt: row.invalidAt,
      createdAt: row.createdAt,
    })),
    tasks: filteredTasks.map(row => ({
      id: row.id,
      content: row.content,
      status: row.status,
      priority: row.priority || 'medium',
      dueDate: row.dueDate,
      createdAt: row.createdAt,
    })),
    memories: filteredMemories,
    collectionTime,
  };
}

/**
 * Get database stats for comparison
 */
export async function getDatabaseStats(): Promise<{
  entityCount: number;
  factCount: number;
  taskCount: number;
  memoryCount: number;
}> {
  // Count entities
  const [entityResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(entities);

  // Count facts
  const [factResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(facts);

  // Count tasks
  const [taskResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks);

  // Count memories from Qdrant
  const collectionInfo = await qdrant.getCollection(COLLECTIONS.MEMORIES);
  const memoryCount = collectionInfo.points_count || 0;

  return {
    entityCount: entityResult?.count || 0,
    factCount: factResult?.count || 0,
    taskCount: taskResult?.count || 0,
    memoryCount,
  };
}

/**
 * Get entity by name (for validation)
 */
export async function getEntityByName(name: string): Promise<EntityResult | null> {
  const results = await db
    .select()
    .from(entities)
    .where(eq(entities.canonicalName, name))
    .limit(1);

  if (results.length === 0) return null;

  const row = results[0];
  if (!row) return null;

  return {
    id: row.id,
    canonicalName: row.canonicalName,
    entityType: row.entityType,
    aliases: [],
    createdAt: row.createdAt,
  };
}

/**
 * Get facts for an entity
 */
export async function getFactsForEntity(entityId: string): Promise<FactResult[]> {
  const results = await db
    .select()
    .from(facts)
    .where(eq(facts.subjectEntityId, entityId));

  return results.map(row => ({
    id: row.id,
    subjectEntityId: row.subjectEntityId,
    predicate: row.predicate,
    objectValue: row.objectValue,
    validAt: row.validAt,
    invalidAt: row.invalidAt,
    createdAt: row.createdAt,
  }));
}

/**
 * Get pending tasks
 */
export async function getPendingTasks(): Promise<TaskResult[]> {
  const results = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, 'pending'));

  return results.map(row => ({
    id: row.id,
    content: row.content,
    status: row.status,
    priority: row.priority || 'medium',
    dueDate: row.dueDate,
    createdAt: row.createdAt,
  }));
}
