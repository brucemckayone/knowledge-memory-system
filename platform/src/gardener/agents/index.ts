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

// Phase 5 Agents
import { contradictionScannerAgent } from './contradiction-scanner.agent.js';
import { communityDetectionAgent } from './community-detection.agent.js';
import { insightGenerationAgent } from './insight-generation.agent.js';
import { briefingAgent } from './briefing.agent.js';

// Phase 6 Agents
import { vaultWriterAgent } from './vault-writer.agent.js';
import { projectAssociationAgent } from './project-association.agent.js';
import { projectRefreshAgent } from './project-refresh.agent.js';

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

// Phase 5 exports
export { contradictionScannerAgent } from './contradiction-scanner.agent.js';
export { communityDetectionAgent } from './community-detection.agent.js';
export { insightGenerationAgent } from './insight-generation.agent.js';
export { briefingAgent } from './briefing.agent.js';

// Phase 6 exports
export { vaultWriterAgent } from './vault-writer.agent.js';
export { projectAssociationAgent } from './project-association.agent.js';
export { projectRefreshAgent } from './project-refresh.agent.js';

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

  // Phase 5: Scheduled Scanning
  contradictionScannerAgent,
  communityDetectionAgent,
  insightGenerationAgent,
  briefingAgent,

  // Phase 6: Obsidian Write-back & Project Association
  vaultWriterAgent,
  projectAssociationAgent,
  projectRefreshAgent,
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
