/**
 * Ground Truth Definitions
 *
 * Defines expected results for benchmark scenarios.
 * Used for validation and metric calculation.
 */

import type { BenchmarkMessage } from '../utils/message-factory.js';

/**
 * Expected entity extraction
 */
export interface ExpectedEntity {
  name: string;
  type: 'person' | 'organization' | 'location' | 'concept';
  aliases?: string[];
  confidence?: number;
}

/**
 * Expected fact extraction
 */
export interface ExpectedFact {
  subjectEntity: string; // Entity name
  predicate: string;
  object: string;
  objectType?: 'entity' | 'literal' | 'date';
  confidence?: number;
}

/**
 * Expected task creation
 */
export interface ExpectedTask {
  content: string;
  priority?: 'high' | 'medium' | 'low';
  hasDueDate?: boolean;
}

/**
 * Expected memory storage
 */
export interface ExpectedMemory {
  type: 'thought' | 'link' | 'question' | 'task';
  contentType: 'text' | 'link' | 'voice';
  contentContains: string[]; // Keywords that should be in summary/content
}

/**
 * Ground truth for a scenario
 */
export interface ScenarioGroundTruth {
  scenarioName: string;
  description: string;

  /** Expected entities to be extracted */
  expectedEntities: ExpectedEntity[];

  /** Expected facts to be created */
  expectedFacts: ExpectedFact[];

  /** Expected tasks to be created */
  expectedTasks: ExpectedTask[];

  /** Expected memories to be stored */
  expectedMemories: ExpectedMemory[];

  /** Special validation rules */
  validationRules?: {
    /** Entity deduplication: these should be merged */
    deduplicatedEntities?: Array<{ canonical: string; aliases: string[] }>;

    /** Temporal tracking: facts should have proper timestamps */
    temporalFacts?: Array<{
      factKey: string;
      shouldSupersede?: string; // Should invalidate previous fact
    }>;

    /** Conflict detection: these should be flagged as conflicting */
    conflictingFacts?: Array<{
      fact1: string;
      fact2: string;
      conflictType: 'contradiction' | 'mutually_exclusive';
    }>;
  };
}

/**
 * Ground truth for deduplication scenario
 */
export const DEDUPLICATION_GROUND_TRUTH: ScenarioGroundTruth = {
  scenarioName: 'deduplication',
  description: 'Test entity deduplication across multiple name variations',

  expectedEntities: [
    {
      name: 'John Smith',
      type: 'person',
      aliases: ['John', 'Jon', 'J. Smith', 'Johnny'],
    },
    {
      name: 'Acme Corporation',
      type: 'organization',
      aliases: ['Acme Corp', 'Acme'],
    },
  ],

  expectedFacts: [
    {
      subjectEntity: 'John Smith',
      predicate: 'works_for',
      object: 'Acme Corporation',
      objectType: 'entity',
    },
    {
      subjectEntity: 'John Smith',
      predicate: 'mentioned',
      object: 'Kubernetes',
      objectType: 'literal',
    },
  ],

  expectedTasks: [],
  expectedMemories: [],

  validationRules: {
    deduplicatedEntities: [
      {
        canonical: 'John Smith',
        aliases: ['Jon', 'J. Smith', 'Johnny'],
      },
      {
        canonical: 'Acme Corporation',
        aliases: ['Acme Corp', 'Acme'],
      },
    ],
  },
};

/**
 * Ground truth for temporal tracking scenario
 */
export const TEMPORAL_TRACKING_GROUND_TRUTH: ScenarioGroundTruth = {
  scenarioName: 'temporal-tracking',
  description: 'Test fact supersession for career progression',

  expectedEntities: [
    {
      name: 'Jane Doe',
      type: 'person',
    },
  ],

  expectedFacts: [
    {
      subjectEntity: 'Jane Doe',
      predicate: 'role',
      object: 'Senior Developer',
      objectType: 'literal',
    },
  ],

  expectedTasks: [],
  expectedMemories: [],

  validationRules: {
    temporalFacts: [
      {
        factKey: 'Jane Doe-role',
        // The "Senior Developer" fact should supersede "Developer"
      },
    ],
  },
};

/**
 * Ground truth for conflict detection scenario
 */
export const CONFLICTS_GROUND_TRUTH: ScenarioGroundTruth = {
  scenarioName: 'conflicts',
  description: 'Test conflict detection for contradictory facts',

  expectedEntities: [
    {
      name: 'Bob Johnson',
      type: 'person',
    },
  ],

  expectedFacts: [
    // Only the most recent fact should be active
    {
      subjectEntity: 'Bob Johnson',
      predicate: 'location',
      object: 'San Francisco',
      objectType: 'literal',
    },
  ],

  expectedTasks: [],
  expectedMemories: [],

  validationRules: {
    conflictingFacts: [
      {
        fact1: 'Bob Johnson-location-New York',
        fact2: 'Bob Johnson-location-San Francisco',
        conflictType: 'contradiction',
      },
    ],
  },
};

/**
 * Ground truth for entity extraction scenario
 */
export const ENTITY_EXTRACTION_GROUND_TRUTH: ScenarioGroundTruth = {
  scenarioName: 'entity-extraction',
  description: 'Test accurate entity extraction from various content types',

  expectedEntities: [
    { name: 'Elon Musk', type: 'person' },
    { name: 'Tesla', type: 'organization' },
    { name: 'SpaceX', type: 'organization' },
    { name: 'Mars', type: 'location' },
    { name: 'Starship', type: 'concept' },
  ],

  expectedFacts: [
    {
      subjectEntity: 'Elon Musk',
      predicate: 'leads',
      object: 'Tesla',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Elon Musk',
      predicate: 'founded',
      object: 'SpaceX',
      objectType: 'entity',
    },
  ],

  expectedTasks: [],
  expectedMemories: [],
};

/**
 * Ground truth for task extraction scenario
 */
export const TASK_EXTRACTION_GROUND_TRUTH: ScenarioGroundTruth = {
  scenarioName: 'task-extraction',
  description: 'Test action item identification and extraction',

  expectedEntities: [],
  expectedFacts: [],

  expectedTasks: [
    {
      content: 'Review Kubernetes deployment logs',
      priority: 'high',
    },
    {
      content: 'Schedule team meeting',
      priority: 'medium',
    },
    {
      content: 'Update documentation',
      priority: 'low',
    },
  ],

  expectedMemories: [],
};

/**
 * Get ground truth for a scenario
 */
export function getGroundTruth(scenarioName: string): ScenarioGroundTruth | null {
  const truths: Record<string, ScenarioGroundTruth> = {
    'deduplication': DEDUPLICATION_GROUND_TRUTH,
    'temporal-tracking': TEMPORAL_TRACKING_GROUND_TRUTH,
    'conflicts': CONFLICTS_GROUND_TRUTH,
    'entity-extraction': ENTITY_EXTRACTION_GROUND_TRUTH,
    'task-extraction': TASK_EXTRACTION_GROUND_TRUTH,
  };

  return truths[scenarioName] || null;
}

/**
 * Generate ground truth from a set of messages
 *
 * This is used for dynamic scenarios where ground truth
 * is computed based on the generated messages themselves.
 */
export function generateGroundTruthFromMessages(
  scenarioName: string,
  messages: BenchmarkMessage[]
): ScenarioGroundTruth {
  return {
    scenarioName,
    description: `Ground truth generated from ${messages.length} messages`,

    // Extract expected entities from message metadata
    expectedEntities: messages
      .filter(m => m.benchmarkMetadata?.expectedEntities)
      .flatMap(m =>
        (m.benchmarkMetadata?.expectedEntities || []).map(name => ({
          name,
          type: 'person' as const, // Default, should be overridden
        }))
      ),

    // Extract expected facts from message metadata
    expectedFacts: [],

    // Extract expected tasks from message metadata
    expectedTasks: messages
      .filter(m => m.text?.toLowerCase().includes('remind me to'))
      .map(m => ({
        content: m.text?.replace(/remind me to/i, '').trim() || '',
      })),

    expectedMemories: messages.map(m => ({
      type: m.text?.startsWith('?') ? 'question' : 'thought',
      contentType: m.voice ? 'voice' : 'text',
      contentContains: [m.text?.slice(0, 20) || ''],
    })),
  };
}
