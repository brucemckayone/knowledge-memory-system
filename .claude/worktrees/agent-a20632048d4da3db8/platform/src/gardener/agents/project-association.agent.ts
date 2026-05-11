/**
 * Project Association Agent (W45)
 *
 * KARMA agent that associates incoming memories with detected projects.
 * Called as part of the realtime pipeline after entity extraction.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { associateMemory } from '../../services/project-association.js';
import { AgentError } from '../errors.js';

export const projectAssociationAgent: GardenerAgent = {
  name: 'project-association',
  tier: 'realtime',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log } = context;
    const payload = job.data as {
      memoryId?: string;
      entityIds?: string[];
      tags?: string[];
    };

    if (!payload.memoryId) {
      return { success: true, outputs: { skipped: true, reason: 'no_memory_id' }, metrics: { confidence: 1.0, itemsProcessed: 0 } };
    }

    try {
      const result = await associateMemory(
        payload.memoryId,
        payload.entityIds || [],
        payload.tags || [],
      );

      if (result.projectId) {
        log(`Associated memory ${payload.memoryId.slice(0, 8)} with project ${result.projectId.slice(0, 8)}${result.ambiguous ? ' (ambiguous)' : ''}`);
      }

      return {
        success: true,
        outputs: {
          projectId: result.projectId,
          ambiguous: result.ambiguous,
        },
        metrics: { confidence: result.ambiguous ? 0.5 : 0.9, itemsProcessed: 1 },
      };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(`Project association failed: ${error}`, true, error);
    }
  },
};
