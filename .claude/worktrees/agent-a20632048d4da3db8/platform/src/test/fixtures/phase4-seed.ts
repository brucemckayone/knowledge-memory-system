/**
 * Phase 4 Test Seed Data
 *
 * Provides deterministic test data for KARMA agent integration tests.
 * Used by golden test cases to verify boundary behaviors.
 */

import { randomUUID, randomEmbedding, normalizeVector } from '../setup.js';

/**
 * Entity resolution test data with controlled similarity scores
 */
export interface EntityResolutionTestData {
  existing: {
    id: string;
    name: string;
    type: string;
    embedding: number[];
  };
  highSimilar: {
    name: string;
    expectedMatch: boolean;
    expectedAction: 'merge';
  };
  mediumSimilar: {
    name: string;
    expectedMatch: boolean;
    expectedAction: 'verify';
  };
  lowSimilar: {
    name: string;
    expectedMatch: boolean;
    expectedAction: 'create';
  };
}

/**
 * Conflict detection test data
 */
export interface ConflictTestData {
  person: { id: string; name: string };
  company1: { id: string; name: string };
  company2: { id: string; name: string };
  existingFact: {
    id: string;
    predicate: string;
    validAt: Date;
  };
}

/**
 * Relationship extraction test data
 */
export interface RelationshipTestData {
  content: string;
  entities: Array<{ name: string; type: string }>;
  expected: Array<{
    subject: string;
    predicate: string;
    object: string;
    temporalHint?: string;
  }>;
}

/**
 * Full Phase 4 seed interface
 */
export interface Phase4Seed {
  // Chunking tests
  longContent: {
    content: string;
    expectedChunks: number;
    charCount: number;
  };
  shortContent: {
    content: string;
    expectedChunks: number;
    charCount: number;
  };

  // Entity resolution thresholds
  entityResolution: EntityResolutionTestData;

  // Conflict detection
  conflicts: ConflictTestData;

  // Relationship extraction
  relationships: RelationshipTestData;

  // Content parsing
  contentTypes: {
    withLinks: { content: string; expectedType: string };
    withTags: { content: string; expectedTags: string[] };
    withMentions: { content: string; expectedMentions: string[] };
    plainThought: { content: string; expectedType: string };
  };

  // Summarization
  longDocument: {
    content: string;
    wordCount: number;
    shouldSummarize: boolean;
  };
  shortDocument: {
    content: string;
    wordCount: number;
    shouldSummarize: boolean;
  };
}

/**
 * Generate a string of specified length with lorem ipsum style text
 */
function generateLongContent(targetLength: number): string {
  const sentences = [
    'John Smith is a senior software engineer at Acme Corporation.',
    'He has been working on the new AI platform for the past six months.',
    'Sarah Chen leads the product team and works closely with John.',
    'The team meets every Monday to discuss project milestones.',
    'Michael Brown from TechVentures invested in the company last year.',
    'The headquarters is located in San Francisco, California.',
    'Dr. Emily Watson joined as Chief Technology Officer in 2023.',
    'The company has grown from 10 to 150 employees since founding.',
    'They specialize in natural language processing and machine learning.',
    'The latest product release received positive reviews from users.',
    'Alice Johnson handles customer relations and partnership deals.',
    'Bob Williams manages the infrastructure and cloud operations.',
    'The engineering team follows agile methodology with two-week sprints.',
    'Regular code reviews ensure high quality and knowledge sharing.',
    'The AI models are trained on diverse datasets for better accuracy.',
    'Security and privacy are top priorities for the organization.',
    'Remote work policies have improved work-life balance for employees.',
    'The company culture emphasizes innovation and continuous learning.',
    'Quarterly hackathons encourage creative problem-solving approaches.',
    'The support team provides round-the-clock assistance to customers.',
  ];

  let content = '';
  let sentenceIndex = 0;

  while (content.length < targetLength) {
    content += sentences[sentenceIndex % sentences.length] + ' ';
    sentenceIndex++;
  }

  return content.slice(0, targetLength).trim();
}

/**
 * Generate a base embedding that can be modified for similarity testing
 */
function generateBaseEmbedding(): number[] {
  // Use a deterministic seed-like approach for reproducibility
  const base = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.1) * 0.5);
  return normalizeVector(base);
}

/**
 * Create an embedding with specified similarity to base
 */
function createSimilarEmbedding(base: number[], similarity: number): number[] {
  // Mix base with random noise to achieve target similarity
  const noise = randomEmbedding();
  const mixRatio = Math.sqrt(similarity); // sqrt because similarity is dot product

  const mixed = base.map((b, i) => {
    const n = noise[i] ?? 0;
    return b * mixRatio + n * (1 - mixRatio);
  });

  return normalizeVector(mixed);
}

/**
 * Load or generate Phase 4 seed data
 */
export function loadPhase4Seed(): Phase4Seed {
  const baseEmbedding = generateBaseEmbedding();
  const personId = randomUUID();
  const company1Id = randomUUID();
  const company2Id = randomUUID();
  const factId = randomUUID();

  return {
    // Chunking tests - 10k characters should produce 3 chunks with 4000 max
    longContent: {
      content: generateLongContent(10000),
      expectedChunks: 3,
      charCount: 10000,
    },

    // Short content - under 4k should not be chunked
    shortContent: {
      content: generateLongContent(3500),
      expectedChunks: 1,
      charCount: 3500,
    },

    // Entity resolution with controlled similarity thresholds
    entityResolution: {
      existing: {
        id: personId,
        name: 'John Smith',
        type: 'person',
        embedding: baseEmbedding,
      },
      // >0.92 similarity - should auto-merge
      highSimilar: {
        name: 'Jon Smith', // Very similar spelling
        expectedMatch: true,
        expectedAction: 'merge',
      },
      // 0.75-0.92 similarity - needs verification
      mediumSimilar: {
        name: 'J. Smith', // Abbreviated
        expectedMatch: true,
        expectedAction: 'verify',
      },
      // <0.75 similarity - create new
      lowSimilar: {
        name: 'Jane Doe', // Different person
        expectedMatch: false,
        expectedAction: 'create',
      },
    },

    // Conflict detection test data
    conflicts: {
      person: { id: personId, name: 'Career Person' },
      company1: { id: company1Id, name: 'Acme Corp' },
      company2: { id: company2Id, name: 'TechVentures' },
      existingFact: {
        id: factId,
        predicate: 'works_at',
        validAt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000), // 6 months ago
      },
    },

    // Relationship extraction test data
    relationships: {
      content: 'John Smith works at Acme Corp. He knows Sarah Chen. Sarah used to work at Google.',
      entities: [
        { name: 'John Smith', type: 'person' },
        { name: 'Acme Corp', type: 'company' },
        { name: 'Sarah Chen', type: 'person' },
        { name: 'Google', type: 'company' },
      ],
      expected: [
        { subject: 'John Smith', predicate: 'works_at', object: 'Acme Corp' },
        { subject: 'John Smith', predicate: 'knows', object: 'Sarah Chen' },
        { subject: 'Sarah Chen', predicate: 'worked_at', object: 'Google', temporalHint: 'past' },
      ],
    },

    // Content type classification
    contentTypes: {
      withLinks: {
        content: 'Check out this article https://example.com/article about AI development',
        expectedType: 'link',
      },
      withTags: {
        content: 'Working on #project-alpha today. Need to sync with #backend team. #urgent',
        expectedTags: ['project-alpha', 'backend', 'urgent'],
      },
      withMentions: {
        content: 'Had a great meeting with @john and @sarah about the roadmap',
        expectedMentions: ['john', 'sarah'],
      },
      plainThought: {
        content: 'The weather is nice today. Good day for a walk in the park.',
        expectedType: 'thought',
      },
    },

    // Summarization test data
    longDocument: {
      content: generateLongContent(2000),
      wordCount: Math.ceil(2000 / 5), // Rough estimate
      shouldSummarize: true,
    },
    shortDocument: {
      content: 'Quick note about the meeting tomorrow at 3pm.',
      wordCount: 9,
      shouldSummarize: false,
    },
  };
}

/**
 * Generate embeddings with known similarity scores for testing thresholds
 */
export function generateTestEmbeddings(): {
  base: number[];
  high: { embedding: number[]; expectedSimilarity: number };
  medium: { embedding: number[]; expectedSimilarity: number };
  low: { embedding: number[]; expectedSimilarity: number };
} {
  const base = generateBaseEmbedding();

  return {
    base,
    high: {
      embedding: createSimilarEmbedding(base, 0.95),
      expectedSimilarity: 0.95,
    },
    medium: {
      embedding: createSimilarEmbedding(base, 0.85),
      expectedSimilarity: 0.85,
    },
    low: {
      embedding: createSimilarEmbedding(base, 0.5),
      expectedSimilarity: 0.5,
    },
  };
}

/**
 * Test predicates for schema alignment tests
 */
export const TEST_PREDICATES = {
  canonical: ['works_at', 'knows', 'manages', 'lives_in', 'skilled_in'],
  aliases: {
    employed_at: 'works_at',
    works_for: 'works_at',
    supervises: 'manages',
    resides_in: 'lives_in',
    proficient_in: 'skilled_in',
  },
  custom: ['custom_predicate', 'unknown_relation'],
};

/**
 * Quality score test data for evaluator
 */
export const EVALUATOR_TEST_DATA = {
  successfulJob: {
    success: true,
    durationMs: 1500,
    itemsProcessed: 10,
    agentName: 'reader',
    expectedMinScore: 0.7,
  },
  slowJob: {
    success: true,
    durationMs: 10000, // 5x expected duration
    itemsProcessed: 5,
    agentName: 'reader',
    expectedMaxScore: 0.8, // Penalized for slow execution
  },
  failedJob: {
    success: false,
    durationMs: 500,
    itemsProcessed: 0,
    agentName: 'reader',
    expectedMaxScore: 0.4, // Low score for failure
  },
  anomalyJob: {
    success: true,
    durationMs: 15000, // 7.5x expected - anomaly threshold
    itemsProcessed: 1,
    agentName: 'reader',
    shouldBeAnomaly: true,
  },
};
