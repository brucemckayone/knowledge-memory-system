/**
 * Entity Extraction Agent
 *
 * KARMA agent that extracts entities from memories and links them to the graph.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { ml, MlClientError } from '../../services/ml-client.js';
import { linkEntitiesToMemory } from '../../services/entities.js';

export const entityExtractionAgent: GardenerAgent = {
  name: 'extract-entities',
  tier: 'realtime',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log } = context;
    const payload = job.data as { memoryId: string; content: string; type?: string };

    if (!payload.memoryId || !payload.content) {
      log('Missing required fields: memoryId, content', 'error');
      return { success: false };
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

      // Link entities to memory
      const linkedCount = await linkEntitiesToMemory(payload.memoryId, entities);
      log(`Linked ${linkedCount} entities to memory`);

      return {
        success: true,
        metrics: {
          confidence: entities.reduce((sum, e) => sum + (e.confidence || 0.8), 0) / entities.length,
          itemsProcessed: linkedCount,
        },
      };

    } catch (error) {
      if (error instanceof MlClientError) {
        log(`ML service error: ${error.message}`, 'warn');
        return { success: false };
      }
      log(`Entity extraction failed: ${error}`, 'error');
      return { success: false };
    }
  },
};
