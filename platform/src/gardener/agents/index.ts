/**
 * Gardener Agents Index
 *
 * Export and register all KARMA agents.
 */

import { getController } from '../controller.js';

// Phase 3 Agents
import { entityExtractionAgent } from './entity-extraction.agent.js';
import { conflictResolutionAgent } from './conflict-resolution.agent.js';

// Phase 4 Agents
import { readerAgent } from './reader.agent.js';
import { summarizerAgent } from './summarizer.agent.js';
import { relationshipAgent } from './relationship.agent.js';
import { schemaAlignmentAgent } from './schema-alignment.agent.js';

// Context Linking Agent
import { contextLinkerAgent } from './context-linker.agent.js';

// Phase 3 exports
export { entityExtractionAgent } from './entity-extraction.agent.js';
export { conflictResolutionAgent } from './conflict-resolution.agent.js';

// Phase 4 exports
export { readerAgent } from './reader.agent.js';
export { summarizerAgent } from './summarizer.agent.js';
export { relationshipAgent } from './relationship.agent.js';
export { schemaAlignmentAgent } from './schema-alignment.agent.js';

// Context linking export
export { contextLinkerAgent } from './context-linker.agent.js';

/**
 * All agents in registration order
 */
export const allAgents = [
  // Core Pipeline
  readerAgent,
  summarizerAgent,

  // Entity & Knowledge Graph
  entityExtractionAgent,
  relationshipAgent,

  // Maintenance
  conflictResolutionAgent,
  schemaAlignmentAgent,

  // Context Linking
  contextLinkerAgent,
];

/**
 * Register all agents with the Gardener controller
 */
export function registerAgents(): void {
  const controller = getController();

  for (const agent of allAgents) {
    controller.registerAgent(agent);
  }

  console.log(`✅ Registered ${allAgents.length} KARMA agents`);
}
