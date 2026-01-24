/**
 * Gardener Agents Index
 * 
 * Export and register all KARMA agents.
 */

import { getController } from '../controller.js';
import { entityExtractionAgent } from './entity-extraction.agent.js';
import { conflictResolutionAgent } from './conflict-resolution.agent.js';

export { entityExtractionAgent } from './entity-extraction.agent.js';
export { conflictResolutionAgent } from './conflict-resolution.agent.js';

/**
 * Register all agents with the Gardener controller
 */
export function registerAgents(): void {
  const controller = getController();
  
  controller.registerAgent(entityExtractionAgent);
  controller.registerAgent(conflictResolutionAgent);
  
  console.log('✅ Registered 2 KARMA agents (Phase 3)');
}
