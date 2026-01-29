import type { Envelope } from '../types/envelope.js';
import type { SkillContext } from '../skills/types.js';
import { addEnrichment } from '../core/envelope-factory.js';
import { extractTaskSkill } from '../skills/core/extract-task.skill.js';
import { createTaskSkill } from '../skills/core/create-task.skill.js';
import { embedSkill } from '../skills/core/embed.skill.js';
import { storeMemorySkill } from '../skills/core/store-memory.skill.js';
import { getController } from '../gardener/controller.js';
import { ensureContextMapping } from '../services/context-mapping.js';
import { checkDuplicate } from '../services/task-deduplication.js';
import { createDependencies, resolveDependencyByReference } from '../services/task-dependencies.js';
import { detectTemporalConflicts } from '../services/task-conflicts.js';
import { db } from '../db/index.js';
import { tasks } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';

export interface ProcessTaskResult {
  success: boolean;
  task_id?: string;
  action?: string;
  due_date?: string | null;
  priority?: string;
  error?: string;
  filtered?: boolean; // True if task was filtered by quality gate
  duplicate?: boolean; // True if task was a duplicate
  subtask_count?: number; // Number of subtasks created
  has_conflicts?: boolean; // True if conflicts were detected
}

// Quality thresholds (must match skill)
const MIN_CONFIDENCE = 0.6;
const MIN_CONTENT_LENGTH = 10;

/**
 * Process a message classified as a task
 *
 * Enhanced flow:
 * 1. Extract Task (with enhanced context and decomposition)
 * 2. Quality Gate (confidence and content checks)
 * 3. Context Mapping
 * 4. Duplicate Check (including semantic similarity)
 * 5. Create Task with subtasks
 * 6. Create Dependencies
 * 7. Detect Conflicts
 * 8. Generate Embedding
 * 9. Store Memory
 * 10. Queue for KARMA pipeline
 */
export async function processTask(
  envelope: Envelope,
  context: SkillContext
): Promise<ProcessTaskResult> {
  const content = envelope.raw.content || '';

  try {
    // Step 1: Enhanced task extraction with context
    context.log('Step 1: Enhanced task extraction');
    const extractStart = Date.now();

    // Get conversation context for better extraction
    const contextMessages = await getRecentContextMessages(
      envelope.origin.context.conversation_id,
      5 // last 5 messages
    );

    // Get existing tasks in this context
    const existingTasks = await getPendingTasksInContext(
      envelope.origin.context.conversation_id
    );

    // Get user preferences
    const userId = envelope.origin.sender.id;
    const userPreferences = await getUserPreferences(userId);

    const extracted = await extractTaskSkill.execute({
      text: content,
      contextMessages,
      existingTasks,
      userPreferences,
      useEnhanced: true,
    }, context);

    addEnrichment(envelope, 'extract_task', {
      action: extracted.action,
      due_date: extracted.due_date,
      priority: extracted.priority,
      confidence: extracted.confidence,
      rejection_reason: extracted.rejection_reason,
      is_composite: extracted.is_composite,
      subtask_count: extracted.subtasks?.length || 0,
      has_dependencies: extracted.dependencies && extracted.dependencies.length > 0,
      has_conflicts: extracted.detected_conflicts && extracted.detected_conflicts.length > 0,
    }, extractStart);

    // Step 1.5: Quality gate - check if task was rejected
    if (!extracted.action || extracted.action.length < MIN_CONTENT_LENGTH) {
      context.log(`Task blocked: low quality (action: "${extracted.action}", rejection: ${extracted.rejection_reason || 'unknown'})`);
      envelope.routing.status = 'filtered';

      return {
        success: false,
        error: extracted.rejection_reason || 'Task filtered: insufficient content or not a valid task',
        filtered: true,
      };
    }

    // Step 1.6: Quality gate - check confidence threshold
    if (extracted.confidence < MIN_CONFIDENCE) {
      context.log(`Task blocked: low confidence (${extracted.confidence} < ${MIN_CONFIDENCE})`);
      envelope.routing.status = 'filtered';

      return {
        success: false,
        error: `Task filtered: confidence too low (${extracted.confidence} < ${MIN_CONFIDENCE})`,
        filtered: true,
      };
    }

    // Step 2: Context mapping
    const contextUUID = await ensureContextMapping(
      envelope.origin.platform,
      envelope.origin.context.conversation_id,
      envelope.origin.context.conversation_name
    );

    // Step 3: Enhanced duplicate check with semantic similarity
    context.log('Step 3: Checking for duplicates (including semantic)');
    const duplicateCheckStart = Date.now();

    // Generate embedding for semantic check
    const embedResultForDuplication = await embedSkill.execute({ text: content }, context);

    const duplicateCheck = await checkDuplicate(
      extracted.action,
      contextUUID,
      embedResultForDuplication.vector
    );

    addEnrichment(envelope, 'duplicate_check', {
      is_duplicate: duplicateCheck.isDuplicate,
      method: duplicateCheck.existingTask?.method,
      similarity: duplicateCheck.existingTask?.similarity,
    }, duplicateCheckStart);

    if (duplicateCheck.isDuplicate && duplicateCheck.existingTask) {
      context.log(
        `Duplicate detected: "${duplicateCheck.existingTask.content}" ` +
        `(similarity: ${duplicateCheck.existingTask.similarity.toFixed(2)}, ` +
        `method: ${duplicateCheck.existingTask.method})`
      );
      envelope.routing.status = 'duplicate';

      return {
        success: false,
        error: `Duplicate task (${duplicateCheck.existingTask.method}): "${duplicateCheck.existingTask.content}" ` +
                `(similarity: ${(duplicateCheck.existingTask.similarity * 100).toFixed(0)}%)`,
        duplicate: true,
      };
    }

    // Step 4: Resolve dependency references to task IDs
    let resolvedDependencies: Array<{
      taskId: string;
      dependsOnTaskId: string;
      dependencyType: 'blocking' | 'prerequisite' | 'related';
      confidence: number;
    }> = [];

    if (extracted.dependencies && extracted.dependencies.length > 0) {
      context.log(`Step 4: Resolving ${extracted.dependencies.length} dependencies`);

      for (const dep of extracted.dependencies) {
        const resolvedId = await resolveDependencyByReference(contextUUID, dep.reference);

        if (resolvedId) {
          // We'll add the taskId after creating the task
          resolvedDependencies.push({
            taskId: '', // Placeholder
            dependsOnTaskId: resolvedId,
            dependencyType: dep.type as 'blocking' | 'prerequisite' | 'related',
            confidence: dep.confidence,
          });
          context.log(`Resolved dependency: "${dep.reference}" -> ${resolvedId}`);
        } else {
          context.log(`Could not resolve dependency reference: "${dep.reference}"`, 'warn');
        }
      }
    }

    // Step 5: Create task with subtasks
    context.log('Step 5: Creating enhanced task');
    const createStart = Date.now();

    const taskResult = await createTaskSkill.execute({
      action: extracted.action,
      due_date: extracted.due_date,
      priority: extracted.priority,
      context_id: contextUUID,
      memory_id: envelope.trace_id,
      subtasks: extracted.subtasks,
      estimated_duration_minutes: extracted.estimated_duration_minutes,
      duration_confidence: extracted.duration_confidence,
      decomposition_reasoning: extracted.reasoning,
      suggestions: extracted.suggestions,
    }, context);

    addEnrichment(envelope, 'create_task', {
      task_id: taskResult.task_id,
      subtask_count: taskResult.subtask_ids?.length || 0,
    }, createStart);

    // Step 6: Create dependencies now that we have the task ID
    if (resolvedDependencies.length > 0) {
      context.log(`Step 6: Creating ${resolvedDependencies.length} dependencies`);

      for (const dep of resolvedDependencies) {
        dep.taskId = taskResult.task_id;
      }

      const createdDeps = await createDependencies(resolvedDependencies);

      addEnrichment(envelope, 'create_dependencies', {
        count: createdDeps.length,
        dependency_ids: createdDeps.map(d => d.id),
      }, Date.now());
    }

    // Step 7: Detect and record conflicts
    let conflicts: any[] = [];
    if (extracted.due_date) {
      context.log('Step 7: Checking for conflicts');
      const dueDate = new Date(extracted.due_date);
      const detectedConflicts = await detectTemporalConflicts(
        taskResult.task_id,
        dueDate,
        contextUUID
      );

      conflicts = detectedConflicts.map(c => ({
        type: c.conflictType,
        severity: c.severity,
        description: c.description,
      }));

      if (conflicts.length > 0) {
        addEnrichment(envelope, 'conflicts', {
          count: conflicts.length,
          conflicts,
        }, Date.now());

        context.log(`Detected ${conflicts.length} conflicts`);
      }
    }

    // Step 8: Generate embedding (reuse if already done for duplicate check)
    context.log('Step 8: Embedding');
    const embedStart = Date.now();

    // We already generated the embedding for duplicate check, reuse it
    addEnrichment(envelope, 'embed', {
      vector: embedResultForDuplication.vector,
      model: embedResultForDuplication.model,
    }, embedStart);

    // Step 9: Store memory
    context.log('Step 9: Storing memory');
    const storeStart = Date.now();
    await storeMemorySkill.execute({
      id: envelope.trace_id,
      vector: embedResultForDuplication.vector,
      type: 'task',
      content: content,
      summary: extracted.action,
      tags: [
        extracted.priority,
        'task',
        extracted.is_composite ? 'composite' : 'simple',
        ...(extracted.is_composite ? ['decomposed'] : [])
      ],
      metadata: {
        task_id: taskResult.task_id,
        action: extracted.action,
        due_date: extracted.due_date,
        priority: extracted.priority,
        confidence: extracted.confidence,
        is_composite: extracted.is_composite,
        subtask_count: taskResult.subtask_ids?.length || 0,
        has_dependencies: resolvedDependencies.length > 0,
        has_conflicts: conflicts.length > 0,
        estimated_duration_minutes: extracted.estimated_duration_minutes,
      },
    }, context);

    addEnrichment(envelope, 'store', { memory_id: envelope.trace_id }, storeStart);

    // Step 10: Queue for KARMA pipeline
    try {
      const controller = getController();
      await controller.enqueue({
        type: 'gardener:ingestion',
        tier: 'realtime',
        payload: {
          memoryId: envelope.trace_id,
          content: content,
          type: 'task',
          source: envelope.origin.platform,
          metadata: {
            task_id: taskResult.task_id,
            action: extracted.action,
            due_date: extracted.due_date,
            priority: extracted.priority,
            is_composite: extracted.is_composite,
            subtask_count: taskResult.subtask_ids?.length || 0,
          },
        },
      });
    } catch (error) {
      // Non-fatal: gardener processing can catch up later
      context.log(`Failed to queue gardener job: ${error}`, 'warn');
    }

    envelope.routing.status = 'completed';

    return {
      success: true,
      task_id: taskResult.task_id,
      action: extracted.action,
      due_date: extracted.due_date,
      priority: extracted.priority,
      subtask_count: taskResult.subtask_ids?.length,
      has_conflicts: conflicts.length > 0,
    };

  } catch (error) {
    context.log(`Task processing failed: ${error}`, 'error');
    envelope.routing.status = 'failed';
    return { success: false, error: String(error) };
  }
}

/**
 * Get recent context messages for better task extraction
 * Queries Qdrant for recent messages in the conversation
 */
async function getRecentContextMessages(conversationId: string, limit: number): Promise<string[]> {
  // TODO: Query Qdrant for recent messages in this conversation
  // For now, return empty array
  // Implementation would depend on how message history is stored
  return [];
}

/**
 * Get pending tasks in a context
 */
async function getPendingTasksInContext(conversationId: string): Promise<Array<{ content: string; id?: string }>> {
  // For context-scoped deduplication, we need the deterministic context UUID
  // This is a placeholder - the actual implementation would use the context mapping
  // For now, return empty array
  return [];
}

/**
 * Get user preferences for personalized task extraction
 */
async function getUserPreferences(userId: string): Promise<Record<string, any>> {
  // TODO: Query user_preferences table
  // For now, return empty object
  return {};
}

/**
 * Format due date for display
 */
export function formatDueDate(isoDate: string | null | undefined): string {
  if (!isoDate) return 'No deadline';

  try {
    const date = new Date(isoDate);
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Check if today
    if (date.toDateString() === now.toDateString()) {
      return `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    // Check if tomorrow
    if (date.toDateString() === tomorrow.toDateString()) {
      return `Tomorrow at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    // Otherwise show full date
    return date.toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoDate;
  }
}
