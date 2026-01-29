/**
 * Pattern Analyzer Agent
 *
 * Background agent that detects patterns in user behavior:
 * - Topic clusters (entities that frequently co-occur)
 * - Temporal patterns (when user does certain tasks)
 * - Recurring tasks (tasks that happen repeatedly)
 * - Preference updates (calibrate urgency, priorities)
 *
 * Phase 5: Task Processing Pipeline Enhancements
 */

import type { GardenerAgent, AgentContext, JobResult } from '../controller.js';
import { db } from '../../db/index.js';
import { tasks, userPreferences } from '../../db/schema.js';
import { eq, and, gte, desc, sql } from 'drizzle-orm';
import { extractEntities } from '../../services/ml.js';
import { updatePreference } from '../../services/preferences.js';

interface PatternAnalyzerPayload {
  contextId?: string;
  userId?: string;
  timeRange?: { start: Date; end: Date };
  patternType?: 'topics' | 'temporal' | 'recurring' | 'all';
}

interface DetectedPattern {
  type: string;
  description: string;
  confidence: number;
  data: any;
}

export const patternAnalyzerAgent: GardenerAgent = {
  name: 'pattern-analyzer',
  tier: 'periodic', // Run every hour by default

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log } = context;
    const payload = job.data as PatternAnalyzerPayload;

    log('Starting pattern analysis...');

    const startTime = Date.now();
    const patterns: DetectedPattern[] = [];

    try {
      // Analyze different pattern types
      if (!payload.patternType || payload.patternType === 'all' || payload.patternType === 'topics') {
        const topicPatterns = await analyzeTopicPatterns(payload.contextId, log);
        patterns.push(...topicPatterns);
      }

      if (!payload.patternType || payload.patternType === 'all' || payload.patternType === 'temporal') {
        const temporalPatterns = await analyzeTemporalPatterns(payload.userId, log);
        patterns.push(...temporalPatterns);
      }

      if (!payload.patternType || payload.patternType === 'all' || payload.patternType === 'recurring') {
        const recurringPatterns = await analyzeRecurringTasks(payload.contextId, log);
        patterns.push(...recurringPatterns);
      }

      const duration = Date.now() - startTime;
      log(`Pattern analysis complete: ${patterns.length} patterns detected (${duration}ms)`);

      return {
        success: true,
        outputs: {
          patternsDetected: patterns.length,
          patternTypes: patterns.map(p => p.type),
          patterns: patterns.slice(0, 10), // Include top 10 for inspection
        },
        metrics: {
          confidence: patterns.length > 0 ? 0.8 : 0.5,
          itemsProcessed: patterns.length,
        },
      };

    } catch (error) {
      log(`Pattern analysis failed: ${error}`, 'error');
      return { success: true, error: String(error) };
    }
  },
};

/**
 * Analyze topic patterns (entity clusters in tasks)
 */
async function analyzeTopicPatterns(
  contextId: string | undefined,
  log: (msg: string) => void
): Promise<DetectedPattern[]> {
  const patterns: DetectedPattern[] = [];

  // Get recent tasks
  const recentTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        contextId ? eq(tasks.contextId, contextId) : sql`1=1`,
        eq(tasks.status, 'pending'),
        gte(tasks.createdAt, sql`NOW() - INTERVAL '7 days'`)
      )
    )
    .orderBy(desc(tasks.createdAt))
    .limit(50);

  if (recentTasks.length < 3) {
    log('Not enough tasks for topic pattern analysis');
    return patterns;
  }

  // Extract entities from all tasks
  const entityCounts = new Map<string, number>();
  const entityTasks = new Map<string, string[]>();

  for (const task of recentTasks) {
    try {
      const result = await extractEntities(task.content);
      const entities = result.data || [];
      for (const entity of entities) {
        const key = (entity as any).mention?.toLowerCase() || (entity as any).name?.toLowerCase();
        if (!key) continue;

        entityCounts.set(key, (entityCounts.get(key) || 0) + 1);
        if (!entityTasks.has(key)) {
          entityTasks.set(key, []);
        }
        entityTasks.get(key)!.push(task.id);
      }
    } catch (error) {
      // Continue on entity extraction errors
      log(`Entity extraction failed for task ${task.id}: ${error}`);
    }
  }

  // Find entities that appear in 3+ tasks
  for (const [entity, count] of entityCounts.entries()) {
    if (count >= 3) {
      patterns.push({
        type: 'topic_cluster',
        description: `"${entity}" appears in ${count} tasks`,
        confidence: Math.min(count / 10, 1.0),
        data: {
          entity,
          taskCount: count,
          taskIds: entityTasks.get(entity),
        },
      });

      // Store as preference if contextId is available
      if (contextId) {
        // Use contextId as userId proxy (could be improved with actual user mapping)
        await updatePreference(contextId, `topic_cluster_${entity}`, {
          entity,
          frequency: count,
          relatedTasks: entityTasks.get(entity),
        }, 0.6);
      }
    }
  }

  log(`Detected ${patterns.length} topic clusters`);
  return patterns;
}

/**
 * Analyze temporal patterns (when user does tasks)
 */
async function analyzeTemporalPatterns(
  userId: string | undefined,
  log: (msg: string) => void
): Promise<DetectedPattern[]> {
  const patterns: DetectedPattern[] = [];

  if (!userId) {
    log('No userId provided for temporal analysis');
    return patterns;
  }

  // Get completed tasks with timing
  const completedTasks = await db
    .select({
      hourBucket: sql`date_trunc('hour', ${tasks.completedAt})`,
      dayOfWeek: sql`extract('dow', ${tasks.completedAt})`,
      taskCount: sql`count(*)`,
      priority: tasks.priority,
      avgDuration: sql`avg(extract('epoch', ${tasks.completedAt} - ${tasks.createdAt}) / 60)`,
    })
    .from(tasks)
    .where(
      and(
        // For now, use contextId as userId proxy
        eq(tasks.contextId, userId as any),
        eq(tasks.status, 'completed'),
        gte(tasks.completedAt, sql`NOW() - INTERVAL '30 days'`)
      )
    )
    .groupBy(sql`date_trunc('hour', ${tasks.completedAt})`, sql`extract('dow', ${tasks.completedAt})`, tasks.priority)
    .having(sql`count(*) > 2`)
    .orderBy(sql`count(*) DESC`)
    .limit(20);

  // Analyze active hours
  const hourCounts = new Map<number, number>();
  for (const row of completedTasks) {
    const hour = new Date(row.hourBucket as Date).getHours();
    hourCounts.set(hour, (hourCounts.get(hour) || 0) + Number(row.taskCount));
  }

  // Find peak hours
  const sortedHours = Array.from(hourCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  if (sortedHours.length > 0) {
    patterns.push({
      type: 'active_hours',
      description: `Most active during: ${sortedHours.map(h => `${h[0]}:00`).join(', ')}`,
      confidence: 0.8,
      data: { hours: sortedHours.map(h => h[0]) },
    });

    // Update preference
    await updatePreference(userId, 'working_hours_peak', {
      hours: sortedHours.map(h => h[0]),
    }, 0.7);
  }

  log(`Detected ${patterns.length} temporal patterns`);
  return patterns;
}

/**
 * Analyze recurring tasks
 */
async function analyzeRecurringTasks(
  contextId: string | undefined,
  log: (msg: string) => void
): Promise<DetectedPattern[]> {
  const patterns: DetectedPattern[] = [];

  // Look for similar task descriptions using semantic search
  const recentTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        contextId ? eq(tasks.contextId, contextId) : sql`1=1`,
        gte(tasks.createdAt, sql`NOW() - INTERVAL '30 days'`)
      )
    )
    .orderBy(desc(tasks.createdAt))
    .limit(100);

  if (recentTasks.length < 5) {
    log('Not enough tasks for recurring pattern analysis');
    return patterns;
  }

  // Simple similarity check (group by first 3 words)
  const taskGroups = new Map<string, typeof recentTasks>();

  for (const task of recentTasks) {
    const normalized = task.content.toLowerCase().trim();
    const words = normalized.split(/\s+/);
    const key = words.slice(0, 3).join(' '); // Group by first 3 words

    if (!taskGroups.has(key)) {
      taskGroups.set(key, []);
    }
    taskGroups.get(key)!.push(task);
  }

  // Find groups with 3+ similar tasks
  for (const [key, tasks] of taskGroups.entries()) {
    if (tasks.length >= 3) {
      patterns.push({
        type: 'recurring_task',
        description: `"${tasks[0]!.content.slice(0, 30)}..." appears ${tasks.length} times`,
        confidence: tasks.length >= 5 ? 0.9 : 0.7,
        data: {
          taskTemplate: key,
          occurrences: tasks.length,
          taskIds: tasks.map(t => t.id),
          firstSeen: tasks[0]!.createdAt,
          lastSeen: tasks[tasks.length - 1]!.createdAt,
        },
      });
    }
  }

  log(`Detected ${patterns.length} recurring task patterns`);
  return patterns;
}
