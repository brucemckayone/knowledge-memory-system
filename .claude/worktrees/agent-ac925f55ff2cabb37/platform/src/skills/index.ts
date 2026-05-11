// Types
export * from './types.js';

// Registry
export { registry } from './registry.js';

// Context
export { createSkillContext } from './context.js';

// Core skills
import { embedSkill } from './core/embed.skill.js';
import { storeMemorySkill } from './core/store-memory.skill.js';
import { transcribeSkill } from './core/transcribe.skill.js';
import { classifySkill } from './core/classify.skill.js';
import { extractUrlSkill } from './core/extract-url.skill.js';
import { fetchWebpageSkill } from './core/fetch-webpage.skill.js';
import { summarizeSkill } from './core/summarize.skill.js';
import { extractTaskSkill } from './core/extract-task.skill.js';
import { createTaskSkill } from './core/create-task.skill.js';
import { registry } from './registry.js';

/**
 * Register all core skills
 * Call this on application startup
 */
export function registerCoreSkills(): void {
  // Phase 1 skills
  registry.register(embedSkill);
  registry.register(storeMemorySkill);
  registry.register(transcribeSkill);

  // Phase 2 skills
  registry.register(classifySkill);
  registry.register(extractUrlSkill);
  registry.register(fetchWebpageSkill);
  registry.register(summarizeSkill);
  registry.register(extractTaskSkill);
  registry.register(createTaskSkill);

  console.log('✅ Core skills registered');
  console.log(`   Available: ${registry.list().map(s => s.name).join(', ')}`);
}

// Export individual skills for direct use
export {
  // Phase 1
  embedSkill,
  storeMemorySkill,
  transcribeSkill,
  // Phase 2
  classifySkill,
  extractUrlSkill,
  fetchWebpageSkill,
  summarizeSkill,
  extractTaskSkill,
  createTaskSkill,
};
