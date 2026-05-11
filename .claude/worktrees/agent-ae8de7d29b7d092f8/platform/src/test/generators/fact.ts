/**
 * Fact Generator
 *
 * Generates realistic fact test data with predicates, temporal information,
 * and optional supersession chains.
 */

import { randomEmbedding, normalizeVector } from '../setup.js';

// Predicate definitions with exclusivity
export const PREDICATES = {
  // Exclusive predicates (only one can be active at a time)
  works_at: { exclusive: true, objectType: 'company', description: 'Employment' },
  has_role: { exclusive: true, objectType: null, description: 'Job title' },
  located_in: { exclusive: false, objectType: 'place', description: 'Location' },
  reports_to: { exclusive: true, objectType: 'person', description: 'Reporting structure' },

  // Non-exclusive predicates
  works_on: { exclusive: false, objectType: 'project', description: 'Project assignment' },
  knows: { exclusive: false, objectType: 'person', description: 'Personal connection' },
  manages: { exclusive: false, objectType: 'person', description: 'Management' },
  part_of: { exclusive: false, objectType: null, description: 'Membership' },
  uses: { exclusive: false, objectType: 'concept', description: 'Technology usage' },
  attended: { exclusive: false, objectType: 'event', description: 'Event attendance' },
  created: { exclusive: false, objectType: 'project', description: 'Creation' },
  founded: { exclusive: false, objectType: 'company', description: 'Founding' },
} as const;

export type PredicateType = keyof typeof PREDICATES;

export interface GeneratedFact {
  subjectEntityId: string;
  predicate: PredicateType;
  objectEntityId?: string;
  objectValue?: string;
  validAt?: Date;
  invalidAt?: Date;
  confidence: number;
  sourceText: string;
  embedding: number[];
}

export interface FactGeneratorOptions {
  predicate?: PredicateType;
  validAt?: Date;
  invalidAt?: Date;
  confidence?: number;
  withEmbedding?: boolean;
}

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomDate(daysAgo: number = 365): Date {
  const now = Date.now();
  const pastMs = daysAgo * 24 * 60 * 60 * 1000;
  return new Date(now - Math.random() * pastMs);
}

/**
 * Generate a single fact
 */
export function generateFact(
  subjectEntityId: string,
  objectEntityIdOrValue: string | null,
  options: FactGeneratorOptions = {}
): GeneratedFact {
  const predicates = Object.keys(PREDICATES) as PredicateType[];
  const predicate = options.predicate ?? randomElement(predicates);
  const predicateInfo = PREDICATES[predicate];

  // Determine if object is entity ID or value
  const isObjectEntity = predicateInfo.objectType !== null && objectEntityIdOrValue !== null;

  // Generate source text
  const sourceTexts: Record<PredicateType, string> = {
    works_at: 'works at',
    has_role: 'has the role of',
    located_in: 'is located in',
    reports_to: 'reports to',
    works_on: 'is working on',
    knows: 'knows',
    manages: 'manages',
    part_of: 'is part of',
    uses: 'uses',
    attended: 'attended',
    created: 'created',
    founded: 'founded',
  };

  return {
    subjectEntityId,
    predicate,
    objectEntityId: isObjectEntity ? objectEntityIdOrValue! : undefined,
    objectValue: !isObjectEntity ? objectEntityIdOrValue || undefined : undefined,
    validAt: options.validAt ?? randomDate(365),
    invalidAt: options.invalidAt,
    confidence: options.confidence ?? (0.7 + Math.random() * 0.3),
    sourceText: `Subject ${sourceTexts[predicate]} object`,
    embedding: options.withEmbedding !== false ? normalizeVector(randomEmbedding()) : [],
  };
}

/**
 * Generate a fact chain (A works_at B, then A works_at C)
 * Returns facts in chronological order with proper supersession
 */
export function generateFactSupersessionChain(
  subjectEntityId: string,
  objectEntityIds: string[],
  predicate: PredicateType = 'works_at'
): GeneratedFact[] {
  const facts: GeneratedFact[] = [];
  const now = Date.now();
  const intervalMs = 90 * 24 * 60 * 60 * 1000; // 90 days between changes

  objectEntityIds.forEach((objectId, index) => {
    const validAt = new Date(now - (objectEntityIds.length - index) * intervalMs);
    const invalidAt = index < objectEntityIds.length - 1
      ? new Date(now - (objectEntityIds.length - index - 1) * intervalMs)
      : undefined;

    facts.push(generateFact(subjectEntityId, objectId, {
      predicate,
      validAt,
      invalidAt,
      confidence: 0.9,
    }));
  });

  return facts;
}

/**
 * Generate contradictory facts for conflict resolution testing
 */
export interface ContradictionPair {
  fact1: GeneratedFact;
  fact2: GeneratedFact;
  contradictionType: 'antonym' | 'numeric' | 'temporal' | 'negation';
}

export function generateContradiction(
  subjectEntityId: string,
  type: 'antonym' | 'numeric' | 'temporal' | 'negation',
  objectEntityId1?: string,
  objectEntityId2?: string
): ContradictionPair {
  switch (type) {
    case 'antonym': {
      // Same subject, same exclusive predicate, different objects
      return {
        fact1: generateFact(subjectEntityId, objectEntityId1 || 'company-1', {
          predicate: 'works_at',
          validAt: new Date(),
          confidence: 0.9,
        }),
        fact2: generateFact(subjectEntityId, objectEntityId2 || 'company-2', {
          predicate: 'works_at',
          validAt: new Date(),
          confidence: 0.85,
        }),
        contradictionType: 'antonym',
      };
    }

    case 'numeric': {
      // Same subject, different numeric values
      return {
        fact1: generateFact(subjectEntityId, null, {
          predicate: 'has_role',
          validAt: new Date(),
          confidence: 0.9,
        }),
        fact2: generateFact(subjectEntityId, null, {
          predicate: 'has_role',
          validAt: new Date(),
          confidence: 0.85,
        }),
        contradictionType: 'numeric',
      };
    }

    case 'temporal': {
      // Overlapping valid periods for exclusive predicate
      const now = new Date();
      const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const twoMonthsAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

      return {
        fact1: generateFact(subjectEntityId, objectEntityId1 || 'company-1', {
          predicate: 'works_at',
          validAt: twoMonthsAgo,
          invalidAt: undefined, // Still active
          confidence: 0.9,
        }),
        fact2: generateFact(subjectEntityId, objectEntityId2 || 'company-2', {
          predicate: 'works_at',
          validAt: oneMonthAgo, // Overlaps with fact1
          confidence: 0.85,
        }),
        contradictionType: 'temporal',
      };
    }

    case 'negation': {
      // Positive vs negative assertion
      return {
        fact1: generateFact(subjectEntityId, objectEntityId1 || 'project-1', {
          predicate: 'works_on',
          validAt: new Date(),
          confidence: 0.9,
        }),
        fact2: {
          ...generateFact(subjectEntityId, objectEntityId1 || 'project-1', {
            predicate: 'works_on',
            validAt: new Date(),
            confidence: 0.85,
          }),
          sourceText: 'Subject no longer works on project',
          objectValue: 'NOT_' + (objectEntityId1 || 'project-1'),
        },
        contradictionType: 'negation',
      };
    }
  }
}

/**
 * Generate a relationship graph of facts between entities
 */
export function generateFactGraph(
  entityIds: string[],
  edgeCount: number
): GeneratedFact[] {
  const facts: GeneratedFact[] = [];
  const nonExclusivePredicates: PredicateType[] = ['works_on', 'knows', 'manages', 'uses'];

  for (let i = 0; i < edgeCount; i++) {
    const subjectIdx = Math.floor(Math.random() * entityIds.length);
    let objectIdx = Math.floor(Math.random() * entityIds.length);

    // Avoid self-references
    while (objectIdx === subjectIdx) {
      objectIdx = Math.floor(Math.random() * entityIds.length);
    }

    facts.push(generateFact(
      entityIds[subjectIdx]!,
      entityIds[objectIdx]!,
      { predicate: randomElement(nonExclusivePredicates) }
    ));
  }

  return facts;
}

/**
 * Generate facts valid at a specific point in time
 */
export function generateHistoricalFacts(
  subjectEntityId: string,
  objectEntityIds: string[],
  asOfDate: Date
): GeneratedFact[] {
  const facts: GeneratedFact[] = [];
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;

  objectEntityIds.forEach((objectId, index) => {
    const validAt = new Date(asOfDate.getTime() - (index + 1) * (oneYearMs / objectEntityIds.length));
    const invalidAt = index > 0
      ? new Date(asOfDate.getTime() - index * (oneYearMs / objectEntityIds.length))
      : undefined;

    facts.push(generateFact(subjectEntityId, objectId, {
      predicate: 'works_at',
      validAt,
      invalidAt,
    }));
  });

  return facts;
}
