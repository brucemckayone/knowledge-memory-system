import type { Envelope } from '../types/envelope.js';
import type { SkillContext } from '../skills/types.js';
import { addEnrichment } from '../core/envelope-factory.js';
import { extractTaskSkill } from '../skills/core/extract-task.skill.js';
import { createTaskSkill } from '../skills/core/create-task.skill.js';
import { embedSkill } from '../skills/core/embed.skill.js';
import { storeMemorySkill } from '../skills/core/store-memory.skill.js';
import { getController } from '../gardener/controller.js';
import { ensureContextMapping } from '../services/context-mapping.js';

export interface ProcessTaskResult {
  success: boolean;
  task_id?: string;
  action?: string;
  due_date?: string | null;
  priority?: string;
  error?: string;
}

/**
 * Process a message classified as a task
 * Flow: Extract Task -> Create in DB -> Embed -> Store Memory
 */
export async function processTask(
  envelope: Envelope,
  context: SkillContext
): Promise<ProcessTaskResult> {
  const content = envelope.raw.content || '';

  try {
    // Step 1: Extract task details
    context.log('Step 1: Extracting task details');
    const extractStart = Date.now();
    const extracted = await extractTaskSkill.execute({ text: content }, context);

    addEnrichment(envelope, 'extract_task', {
      action: extracted.action,
      due_date: extracted.due_date,
      priority: extracted.priority,
    }, extractStart);

    // Step 2: Ensure context mapping and create task in database
    context.log('Step 2: Creating task');
    const createStart = Date.now();

    // Generate deterministic UUID from platform:conversation_id
    const contextUUID = await ensureContextMapping(
      envelope.origin.platform,
      envelope.origin.context.conversation_id,
      envelope.origin.context.conversation_name
    );

    const taskResult = await createTaskSkill.execute({
      action: extracted.action,
      due_date: extracted.due_date,
      priority: extracted.priority,
      context_id: contextUUID,
      memory_id: envelope.trace_id,
    }, context);

    addEnrichment(envelope, 'create_task', {
      task_id: taskResult.task_id,
    }, createStart);

    // Step 3: Generate embedding
    context.log('Step 3: Embedding');
    const embedStart = Date.now();
    const embedResult = await embedSkill.execute({ text: content }, context);

    addEnrichment(envelope, 'embed', {
      vector: embedResult.vector,
      model: embedResult.model,
    }, embedStart);

    // Step 4: Store memory
    context.log('Step 4: Storing memory');
    const storeStart = Date.now();
    await storeMemorySkill.execute({
      id: envelope.trace_id,
      vector: embedResult.vector,
      type: 'task',
      content: content,
      summary: extracted.action,
      tags: [extracted.priority, 'task'],
      metadata: {
        task_id: taskResult.task_id,
        action: extracted.action,
        due_date: extracted.due_date,
        priority: extracted.priority,
      },
    }, context);

    addEnrichment(envelope, 'store', { memory_id: envelope.trace_id }, storeStart);

    // Queue for KARMA pipeline processing
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
    };

  } catch (error) {
    context.log(`Task processing failed: ${error}`, 'error');
    envelope.routing.status = 'failed';
    return { success: false, error: String(error) };
  }
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
