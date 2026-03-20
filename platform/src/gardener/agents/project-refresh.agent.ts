/**
 * Project Refresh Agent (W45)
 *
 * Periodic KARMA agent that refreshes project associations
 * from community detection results.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { detectProjects } from '../../services/project-association.js';
import { AgentError } from '../errors.js';

export const projectRefreshAgent: GardenerAgent = {
  name: 'project-refresh',
  tier: 'periodic',

  async execute(context: AgentContext): Promise<JobResult> {
    const { log } = context;

    try {
      log('Refreshing project associations from communities...');
      const created = await detectProjects();
      log(`Created ${created} new project associations`);

      return {
        success: true,
        outputs: { projectsCreated: created },
        metrics: { confidence: 1.0, itemsProcessed: created },
      };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(`Project refresh failed: ${error}`, true, error);
    }
  },
};
