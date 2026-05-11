import type { Envelope } from '../types/envelope.js';
import type { Config } from '../config.js';
import type PgBoss from 'pg-boss';

/**
 * Base skill interface
 * Every skill implements this contract for modularity and testability
 */
export interface Skill<TInput = unknown, TOutput = unknown> {
  /** Unique skill identifier */
  name: string;

  /** Human-readable description */
  description: string;

  /** Semantic version */
  version: string;

  /**
   * Execute the skill
   * @param input - Skill-specific input
   * @param context - Shared context with services
   * @returns Skill-specific output
   */
  execute(input: TInput, context: SkillContext): Promise<TOutput>;
}

/**
 * Context passed to every skill execution
 */
export interface SkillContext {
  /** Current envelope being processed */
  envelope: Envelope;

  /** Application configuration */
  config: Config;

  /** Shared services */
  services: SkillServices;

  /** Logging function with trace ID prefix */
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

/**
 * Services available to skills
 */
export interface SkillServices {
  /** ML service client */
  ml: {
    embed: (text: string) => Promise<{ vector: number[]; model: string; dimensions: number }>;
    transcribe: (url: string) => Promise<{ text: string; language: string; duration_ms: number }>;
  };

  /** Qdrant client */
  qdrant: {
    storeMemory: (memory: { id: string; vector: number[]; payload: Record<string, unknown> }) => Promise<void>;
    searchMemories: (vector: number[], options?: { limit?: number }) => Promise<Array<{ id: string | number; score: number; payload?: Record<string, unknown> | null }>>;
  };

  /** Database client (Drizzle) */
  db: unknown;

  /** Queue for scheduling jobs */
  boss: PgBoss;
}

/**
 * Result wrapper for skill execution
 */
export interface SkillResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  duration_ms: number;
}
