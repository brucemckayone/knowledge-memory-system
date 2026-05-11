/**
 * Benchmark Configuration
 *
 * Defines presets for different scales, timespans, and scenarios.
 * All configurations produce realistic message distributions.
 */

export interface BenchmarkConfig {
  /** Total number of messages to generate */
  messageCount: number;
  /** Timespan for temporal distribution */
  timespan: TemporalTimespan;
  /** Injection rate (messages/second) - 0 for unlimited */
  injectionRate: number;
  /** Maximum concurrent workers */
  maxConcurrency: number;
  /** Whether to use LLM for quality assessment */
  enableLLMAssessment: boolean;
  /** Whether to generate detailed HTML report */
  generateReport: boolean;
  /** Random seed for deterministic generation */
  randomSeed?: number;
}

export type TemporalTimespan =
  | '1week'
  | '1month'
  | '3months'
  | '6months'
  | '1year';

export type DatasetScale = 'light' | 'medium' | 'heavy';

/**
 * Scale presets - defines message volume
 */
export const SCALE_PRESETS: Record<DatasetScale, Omit<BenchmarkConfig, 'timespan'>> = {
  light: {
    messageCount: 100,
    injectionRate: 10,
    maxConcurrency: 2,
    enableLLMAssessment: true,
    generateReport: true,
  },
  medium: {
    messageCount: 500,
    injectionRate: 50,
    maxConcurrency: 4,
    enableLLMAssessment: true,
    generateReport: true,
  },
  heavy: {
    messageCount: 2000,
    injectionRate: 100,
    maxConcurrency: 8,
    enableLLMAssessment: false, // Skip for speed
    generateReport: true,
  },
};

/**
 * Timespan presets - defines temporal distribution in days
 */
export const TIMESPAN_DAYS: Record<TemporalTimespan, number> = {
  '1week': 7,
  '1month': 30,
  '3months': 90,
  '6months': 180,
  '1year': 365,
};

/**
 * Scenario-specific configurations
 */
export const SCENARIO_CONFIGS: Record<string, Partial<BenchmarkConfig>> = {
  // Quality benchmarks
  'entity-extraction': {
    messageCount: 50,
    injectionRate: 10,
    enableLLMAssessment: true,
  },
  'deduplication': {
    messageCount: 30,
    injectionRate: 5,
    enableLLMAssessment: true,
  },
  'fact-extraction': {
    messageCount: 80,
    injectionRate: 10,
    enableLLMAssessment: true,
  },
  'temporal-tracking': {
    messageCount: 60,
    injectionRate: 10,
    enableLLMAssessment: true,
  },
  'task-extraction': {
    messageCount: 40,
    injectionRate: 10,
    enableLLMAssessment: true,
  },

  // Edge cases
  'conflicts': {
    messageCount: 20,
    injectionRate: 5,
    enableLLMAssessment: true,
  },
  'complex-relationships': {
    messageCount: 50,
    injectionRate: 10,
    enableLLMAssessment: true,
  },
  'ambiguous-references': {
    messageCount: 30,
    injectionRate: 5,
    enableLLMAssessment: true,
  },
  'cross-context-entities': {
    messageCount: 40,
    injectionRate: 10,
    enableLLMAssessment: true,
  },

  // Stress tests
  'high-volume': {
    messageCount: 5000,
    injectionRate: 200,
    maxConcurrency: 16,
    enableLLMAssessment: false,
  },
  'concurrent-threads': {
    messageCount: 1000,
    injectionRate: 100,
    maxConcurrency: 10,
    enableLLMAssessment: false,
  },
  'complex-embeddings': {
    messageCount: 200,
    injectionRate: 20,
    enableLLMAssessment: false,
  },
};

/**
 * Build complete configuration from options
 */
export function buildConfig(options: {
  scale?: DatasetScale;
  timespan?: TemporalTimespan;
  scenario?: string;
  volume?: number;
  randomSeed?: number;
}): BenchmarkConfig {
  // Start with scale preset
  const scale = options.scale || 'medium';
  const baseConfig = SCALE_PRESETS[scale];

  // Override with scenario config if specified
  const scenarioOverride = options.scenario
    ? SCENARIO_CONFIGS[options.scenario] || {}
    : {};

  // Override with explicit volume if specified
  const volumeOverride = options.volume
    ? { messageCount: options.volume }
    : {};

  return {
    ...baseConfig,
    ...scenarioOverride,
    ...volumeOverride,
    timespan: options.timespan || '1month',
    randomSeed: options.randomSeed,
  };
}

/**
 * Benchmark execution options
 */
export interface BenchmarkOptions {
  /** Specific scenario to run */
  scenario?: string;
  /** Dataset scale */
  scale?: DatasetScale;
  /** Temporal timespan */
  timespan?: TemporalTimespan;
  /** Explicit message volume */
  volume?: number;
}

/**
 * Message type distribution for realistic datasets
 */
export const MESSAGE_TYPE_DISTRIBUTION = {
  text: 0.6,          // 60% regular text messages
  link: 0.15,         // 15% links to articles/content
  voice: 0.10,        // 10% voice notes (transcribed)
  question: 0.10,     // 10% questions
  task: 0.05,         // 5% action items/tasks
};

/**
 * Entity type distribution for realistic datasets
 */
export const ENTITY_TYPE_DISTRIBUTION = {
  person: 0.50,       // 50% people
  organization: 0.25, // 25% companies/organizations
  location: 0.15,     // 15% places
  concept: 0.10,      // 10% concepts/technologies
};
