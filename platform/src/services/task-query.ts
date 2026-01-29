/**
 * Task Query Service
 *
 * Natural language interface for querying tasks with knowledge graph awareness.
 *
 * This service provides LLM-native task querying that can:
 * - Parse natural language queries ("what work tasks are urgent this week?")
 * - Leverage knowledge graph for entity-based filtering
 * - Rank tasks by multi-area urgency
 * - Return formatted natural language responses
 *
 * Design Philosophy: Backend-first, unconstrained design.
 * The query interface is primary - UI (Telegram, web, voice) is just one view.
 */

import { db } from '../db/index.js';
import { tasks, memoryEntities, entities } from '../db/schema.js';
import { eq, and, or, desc, gte, lte, sql, inArray } from 'drizzle-orm';

/**
 * Parsed query filters
 */
export interface QueryFilters {
  query: string;
  area?: 'work' | 'family' | 'personal' | 'shopping' | 'home';
  urgency?: 'high' | 'medium' | 'low';
  timeframe?: 'today' | 'tomorrow' | 'this_week' | 'this_month' | 'overdue';
  entities?: string[]; // Entity names to filter by
  status?: 'pending' | 'completed';
  limit?: number;
}

/**
 * Task with entity information
 */
export interface TaskWithEntities {
  id: string;
  content: string;
  priority: string;
  status: string;
  dueDate: Date | null;
  createdAt: Date;
  completedAt: Date | null;
  relatedEntities: Array<{
    name: string;
    type: string;
  }>;
}

/**
 * Query result
 */
export interface TaskQueryResult {
  response: string; // Natural language response
  tasks: TaskWithEntities[];
  filters_applied: QueryFilters;
  total_matched: number;
}

/**
 * Parse natural language query into structured filters
 *
 * This uses pattern matching for common query patterns.
 * In production, this would call an LLM for more robust parsing.
 */
function parseQuery(query: string): QueryFilters {
  const lower = query.toLowerCase();
  const filters: QueryFilters = {
    query,
    status: 'pending',
    limit: 10,
  };

  // Parse urgency
  if (lower.includes('urgent') || lower.includes('important') || lower.includes('asap') || lower.includes('critical')) {
    filters.urgency = 'high';
  } else if (lower.includes('low priority') || lower.includes('eventually')) {
    filters.urgency = 'low';
  }

  // Parse timeframe
  const now = new Date();
  if (lower.includes('today')) {
    filters.timeframe = 'today';
  } else if (lower.includes('tomorrow')) {
    filters.timeframe = 'tomorrow';
  } else if (lower.includes('this week') || lower.includes('week')) {
    filters.timeframe = 'this_week';
  } else if (lower.includes('this month') || lower.includes('month')) {
    filters.timeframe = 'this_month';
  } else if (lower.includes('overdue') || lower.includes('late') || lower.includes('past due')) {
    filters.timeframe = 'overdue';
  }

  // Parse life area (simplified - in production would use entity mapping)
  if (lower.includes('work') || lower.includes('office') || lower.includes('job') || lower.includes('project')) {
    filters.area = 'work';
  } else if (lower.includes('family') || lower.includes('wife') || lower.includes('husband') || lower.includes('kid') || lower.includes('parent')) {
    filters.area = 'family';
  } else if (lower.includes('personal')) {
    filters.area = 'personal';
  } else if (lower.includes('shop') || lower.includes('grocery') || lower.includes('buy')) {
    filters.area = 'shopping';
  } else if (lower.includes('home') || lower.includes('house')) {
    filters.area = 'home';
  }

  return filters;
}

/**
 * Build date range filter based on timeframe
 */
function buildTimeframeFilter(timeframe?: string) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const weekEnd = new Date(today);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const monthEnd = new Date(today);
  monthEnd.setMonth(monthEnd.getMonth() + 1);

  switch (timeframe) {
    case 'today':
      return and(
        gte(tasks.dueDate, today),
        lte(tasks.dueDate, tomorrow)
      );
    case 'tomorrow':
      return and(
        gte(tasks.dueDate, tomorrow),
        lte(tasks.dueDate, weekEnd)
      );
    case 'this_week':
      return and(
        gte(tasks.dueDate, today),
        lte(tasks.dueDate, weekEnd)
      );
    case 'this_month':
      return and(
        gte(tasks.dueDate, today),
        lte(tasks.dueDate, monthEnd)
      );
    case 'overdue':
      return and(
        sql`${tasks.dueDate} < ${now}`,
        eq(tasks.status, 'pending')
      );
    default:
      return undefined;
  }
}

/**
 * Query tasks based on filters
 */
async function queryTasks(filters: QueryFilters): Promise<TaskWithEntities[]> {
  const conditions = [];

  // Status filter
  if (filters.status) {
    conditions.push(eq(tasks.status, filters.status));
  }

  // Priority filter (urgency)
  if (filters.urgency) {
    conditions.push(eq(tasks.priority, filters.urgency));
  }

  // Timeframe filter
  const timeframeFilter = buildTimeframeFilter(filters.timeframe);
  if (timeframeFilter) {
    conditions.push(timeframeFilter);
  }

  // Build the where clause
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Query tasks
  const taskList = await db
    .select()
    .from(tasks)
    .where(whereClause)
    .orderBy(desc(tasks.dueDate), desc(tasks.createdAt))
    .limit(filters.limit || 10);

  // For each task, fetch related entities from memory_entities
  const tasksWithEntities: TaskWithEntities[] = [];

  for (const task of taskList) {
    // Get entities linked to this task via memoryId
    const entityLinks = await db
      .select({
        entityId: memoryEntities.entityId,
      })
      .from(memoryEntities)
      .where(eq(memoryEntities.memoryId, task.memoryId!));

    // Fetch entity details
    const entityIds = entityLinks.map(e => e.entityId);
    const relatedEntities = entityIds.length > 0
      ? await db
        .select({
          canonicalName: entities.canonicalName,
          entityType: entities.entityType,
        })
        .from(entities)
        .where(inArray(entities.id, entityIds))
      : [];

    tasksWithEntities.push({
      id: task.id,
      content: task.content,
      priority: task.priority,
      status: task.status,
      dueDate: task.dueDate,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      relatedEntities: relatedEntities.map(e => ({
        name: e.canonicalName,
        type: e.entityType,
      })),
    });
  }

  return tasksWithEntities;
}

/**
 * Format tasks as natural language response
 */
function formatResponse(tasks: TaskWithEntities[], filters: QueryFilters): string {
  if (tasks.length === 0) {
    return `No tasks found matching your criteria.`;
  }

  let response = '';

  // Add summary
  const areaText = filters.area ? `${filters.area} ` : '';
  const urgencyText = filters.urgency ? `${filters.urgency} priority ` : '';
  const timeframeText = filters.timeframe ? filters.timeframe.replace('_', ' ') : '';

  response += `Found ${tasks.length} ${areaText}${urgencyText}tasks`;
  if (timeframeText) {
    response += ` for ${timeframeText}`;
  }
  response += ':\n\n';

  // Group by priority for better readability
  const highPriority = tasks.filter(t => t.priority === 'high');
  const mediumPriority = tasks.filter(t => t.priority === 'medium');
  const lowPriority = tasks.filter(t => t.priority === 'low');

  if (highPriority.length > 0) {
    response += '🔴 **Urgent**\n';
    highPriority.forEach((task, i) => {
      response += `  - ${task.content}`;
      if (task.dueDate) {
        response += ` (${formatDueDate(task.dueDate)})`;
      }
      if (task.relatedEntities.length > 0) {
        response += ` [${task.relatedEntities.map(e => e.name).join(', ')}]`;
      }
      response += '\n';
    });
    response += '\n';
  }

  if (mediumPriority.length > 0) {
    response += '🟡 **Medium Priority**\n';
    mediumPriority.forEach((task, i) => {
      response += `  - ${task.content}`;
      if (task.dueDate) {
        response += ` (${formatDueDate(task.dueDate)})`;
      }
      if (task.relatedEntities.length > 0) {
        response += ` [${task.relatedEntities.map(e => e.name).join(', ')}]`;
      }
      response += '\n';
    });
    response += '\n';
  }

  if (lowPriority.length > 0) {
    response += '🟢 **Low Priority**\n';
    lowPriority.forEach((task, i) => {
      response += `  - ${task.content}`;
      if (task.dueDate) {
        response += ` (${formatDueDate(task.dueDate)})`;
      }
      if (task.relatedEntities.length > 0) {
        response += ` [${task.relatedEntities.map(e => e.name).join(', ')}]`;
      }
      response += '\n';
    });
  }

  return response;
}

/**
 * Format due date for display
 */
function formatDueDate(date: Date): string {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (date.toDateString() === now.toDateString()) {
    return `today ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  if (date.toDateString() === tomorrow.toDateString()) {
    return `tomorrow ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });
}

/**
 * Main query function - natural language task queries
 *
 * @param query - Natural language query like "what work tasks are urgent this week?"
 * @returns Structured result with natural language response
 */
export async function queryTasksNatural(query: string): Promise<TaskQueryResult> {
  // Parse query into filters
  const filters = parseQuery(query);

  // Query database
  const tasks = await queryTasks(filters);

  // Format response
  const response = formatResponse(tasks, filters);

  return {
    response,
    tasks,
    filters_applied: filters,
    total_matched: tasks.length,
  };
}

/**
 * Simple task listing with smart grouping
 *
 * This is used by the /tasks command for basic listing.
 * For complex queries, use queryTasksNatural().
 */
export async function listPendingTasks(limit: number = 10): Promise<{
  tasks: TaskWithEntities[];
  grouped: {
    high: TaskWithEntities[];
    medium: TaskWithEntities[];
    low: TaskWithEntities[];
  };
}> {
  const taskList = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, 'pending'))
    .orderBy(desc(tasks.priority), desc(tasks.dueDate), desc(tasks.createdAt))
    .limit(limit);

  const tasksWithEntities: TaskWithEntities[] = [];

  for (const task of taskList) {
    // Get entities linked to this task via memoryId
    const entityLinks = await db
      .select({
        entityId: memoryEntities.entityId,
      })
      .from(memoryEntities)
      .where(eq(memoryEntities.memoryId, task.memoryId!));

    // Fetch entity details
    const entityIds = entityLinks.map(e => e.entityId);
    const relatedEntities = entityIds.length > 0
      ? await db
        .select({
          canonicalName: entities.canonicalName,
          entityType: entities.entityType,
        })
        .from(entities)
        .where(inArray(entities.id, entityIds))
      : [];

    tasksWithEntities.push({
      id: task.id,
      content: task.content,
      priority: task.priority,
      status: task.status,
      dueDate: task.dueDate,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      relatedEntities: relatedEntities.map(e => ({
        name: e.canonicalName,
        type: e.entityType,
      })),
    });
  }

  return {
    tasks: tasksWithEntities,
    grouped: {
      high: tasksWithEntities.filter(t => t.priority === 'high'),
      medium: tasksWithEntities.filter(t => t.priority === 'medium'),
      low: tasksWithEntities.filter(t => t.priority === 'low'),
    },
  };
}
