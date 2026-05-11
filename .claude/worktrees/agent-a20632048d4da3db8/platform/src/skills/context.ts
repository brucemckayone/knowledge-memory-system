import type { Envelope } from '../types/envelope.js';
import type { SkillContext, SkillServices } from './types.js';
import { config } from '../config.js';
import { embed, transcribe } from '../services/ml.js';
import { storeMemory, searchMemories } from '../services/qdrant.js';
import { db } from '../db/index.js';
import { getQueue } from '../queue/index.js';

/**
 * Create a skill context for processing an envelope
 * This provides all services and utilities needed by skills
 */
export function createSkillContext(envelope: Envelope): SkillContext {
  const services: SkillServices = {
    ml: { embed, transcribe },
    qdrant: { storeMemory, searchMemories },
    db,
    boss: getQueue(),
  };

  return {
    envelope,
    config,
    services,
    log: (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
      const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '📋';
      const tracePrefix = envelope.trace_id.slice(0, 8);
      console.log(`${prefix} [${tracePrefix}] ${message}`);
    },
  };
}
