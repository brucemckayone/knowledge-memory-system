/**
 * Entity Extraction Agent
 *
 * KARMA agent that extracts entities from memories and links them to the graph.
 */

import type { AgentContext, JobResult, GardenerAgent, GardenerJob } from '../controller.js';
import { ml, MlClientError } from '../../services/ml-client.js';
import { linkEntitiesToMemory } from '../../services/entities.js';
import { PayloadError, MlServiceError, AgentError } from '../errors.js';

export const entityExtractionAgent: GardenerAgent = {
  name: 'extract-entities',
  tier: 'realtime',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log } = context;
    const payload = job.data as { memoryId: string; content: string; type?: string };

    if (!payload.memoryId || !payload.content) {
      throw new PayloadError('Missing required fields: memoryId, content');
    }

    log(`Extracting entities from memory ${payload.memoryId.slice(0, 8)}...`);

    try {
      const data = await ml.extractEntities(payload.content);

      const entities = data.entities || [];
      log(`Found ${entities.length} entities`);

      if (entities.length === 0) {
        return {
          success: true,
          metrics: { confidence: 1.0, itemsProcessed: 0 },
        };
      }

      // Link entities to memory — returns resolved entity details
      const linkedEntities = await linkEntitiesToMemory(payload.memoryId, entities, payload.content);
      log(`Linked ${linkedEntities.length} entities to memory`);

      // Queue relationship extraction if we have enough entities
      const nextJobs: GardenerJob[] = [];
      if (linkedEntities.length >= 2) {
        nextJobs.push({
          type: 'gardener:relationships',
          tier: 'frequent',
          payload: {
            memoryId: payload.memoryId,
            content: payload.content,
            entities: linkedEntities,
          },
        });
        log('Queued relationship extraction');
      }

      return {
        success: true,
        nextJobs: nextJobs.length > 0 ? nextJobs : undefined,
        outputs: {
          entitiesFound: entities.length,
          entitiesLinked: linkedEntities.length,
        },
        metrics: {
          confidence: entities.reduce((sum, e) => sum + (e.confidence || 0.8), 0) / entities.length,
          itemsProcessed: linkedEntities.length,
        },
      };

    } catch (error) {
      if (error instanceof MlClientError) {
        throw new MlServiceError('Entity extraction ML failure', error);
      }
      if (error instanceof AgentError) throw error;
      throw new AgentError(`Entity extraction failed: ${error}`, true, error);
    }
  },
};
