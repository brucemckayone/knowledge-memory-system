import type { Skill, SkillContext, SkillResult } from './types.js';

/**
 * Registry for all available skills
 * Provides registration, lookup, and execution with error handling
 */
class SkillRegistry {
  private skills: Map<string, Skill> = new Map();

  /**
   * Register a skill
   * @throws Error if skill name already registered
   */
  register<TInput, TOutput>(skill: Skill<TInput, TOutput>): void {
    if (this.skills.has(skill.name)) {
      throw new Error(`Skill '${skill.name}' already registered`);
    }
    this.skills.set(skill.name, skill as unknown as Skill);
    console.log(`📦 Registered skill: ${skill.name} v${skill.version}`);
  }

  /**
   * Get a skill by name
   * @throws Error if skill not found
   */
  get<TInput, TOutput>(name: string): Skill<TInput, TOutput> {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`Skill '${name}' not found`);
    }
    return skill as Skill<TInput, TOutput>;
  }

  /**
   * Check if a skill exists
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * List all registered skills
   */
  list(): Array<{ name: string; description: string; version: string }> {
    return Array.from(this.skills.values()).map(s => ({
      name: s.name,
      description: s.description,
      version: s.version,
    }));
  }

  /**
   * Execute a skill by name with error handling and timing
   */
  async execute<TInput, TOutput>(
    skillName: string,
    input: TInput,
    context: SkillContext
  ): Promise<SkillResult<TOutput>> {
    const start = Date.now();
    const skill = this.get<TInput, TOutput>(skillName);

    try {
      context.log(`Executing skill: ${skillName}`);
      const data = await skill.execute(input, context);
      const duration_ms = Date.now() - start;
      context.log(`Skill completed: ${skillName} (${duration_ms}ms)`);
      return {
        success: true,
        data,
        duration_ms,
      };
    } catch (error) {
      context.log(`Skill failed: ${skillName} - ${error}`, 'error');
      return {
        success: false,
        error: String(error),
        duration_ms: Date.now() - start,
      };
    }
  }
}

// Singleton instance
export const registry = new SkillRegistry();
