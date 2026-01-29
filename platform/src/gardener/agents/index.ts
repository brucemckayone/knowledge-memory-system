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
import { ingestionAgent } from './ingestion.agent.js';
import { readerAgent } from './reader.agent.js';
import { summarizerAgent } from './summarizer.agent.js';
import { relationshipAgent } from './relationship.agent.js';
import { schemaAlignmentAgent } from './schema-alignment.agent.js';
import { evaluatorAgent } from './evaluator.agent.js';

// Phase 5 Agents
import { patternAnalyzerAgent } from './pattern-analyzer.agent.js';

// Phase 3 exports
export { entityExtractionAgent } from './entity-extraction.agent.js';
export { conflictResolutionAgent } from './conflict-resolution.agent.js';

// Phase 4 exports
export { ingestionAgent } from './ingestion.agent.js';
export { readerAgent } from './reader.agent.js';
export { summarizerAgent } from './summarizer.agent.js';
export { relationshipAgent } from './relationship.agent.js';
export { schemaAlignmentAgent } from './schema-alignment.agent.js';
export { evaluatorAgent } from './evaluator.agent.js';

// Phase 5 exports
export { patternAnalyzerAgent } from './pattern-analyzer.agent.js';

/**
 * All agents in registration order
 */
export const allAgents = [
  // Phase 4: Core Pipeline (W22 → W23 → W24)
  ingestionAgent,
  readerAgent,
  summarizerAgent,

  // Phase 3: Entity & Conflict (W25, W28)
  entityExtractionAgent,
  conflictResolutionAgent,

  // Phase 4: Knowledge Graph (W26 → W27)
  relationshipAgent,
  schemaAlignmentAgent,

  // Phase 4: Quality (W29)
  evaluatorAgent,

  // Phase 5: Pattern Learning (Periodic)
  patternAnalyzerAgent,
];

/**
 * Register all agents with the Gardener controller
 */
export function registerAgents(): void {
  const controller = getController();

  for (const agent of allAgents) {
    controller.registerAgent(agent);
  }

  console.log(`✅ Registered ${allAgents.length} KARMA agents (Phase 3 + 4 + 5)`);
}
