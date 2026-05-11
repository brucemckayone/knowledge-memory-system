/**
 * Validator
 *
 * Compares actual results against ground truth and calculates metrics.
 */

import type { CollectedResults } from './result-collector.js';
import type { ScenarioGroundTruth } from './ground-truth.js';

/**
 * Validation result for entities
 */
export interface EntityValidation {
  totalExpected: number;
  totalActual: number;
  truePositives: number; // Correctly extracted
  falsePositives: number; // Incorrectly extracted
  falseNegatives: number; // Missed entities
  precision: number;
  recall: number;
  f1Score: number;
  /** Entity-specific details */
  details: EntityValidationDetail[];
}

export interface EntityValidationDetail {
  expectedName: string;
  expectedType: string;
  actualFound: boolean;
  actualName?: string;
  actualType?: string;
  aliasesMatched?: string[];
}

/**
 * Validation result for facts
 */
export interface FactValidation {
  totalExpected: number;
  totalActual: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1Score: number;
  details: FactValidationDetail[];
}

export interface FactValidationDetail {
  subjectEntity: string;
  predicate: string;
  expectedObject: string;
  actualObject?: string;
  match: boolean;
}

/**
 * Validation result for tasks
 */
export interface TaskValidation {
  totalExpected: number;
  totalActual: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1Score: number;
  details: TaskValidationDetail[];
}

export interface TaskValidationDetail {
  expectedContent: string;
  actualContent?: string;
  match: boolean;
}

/**
 * Overall validation metrics
 */
export interface ValidationMetrics {
  entities: EntityValidation;
  facts: FactValidation;
  tasks: TaskValidation;
  overallF1: number;
}

/**
 * Fuzzy match entity names (handles case, punctuation, slight variations)
 */
function fuzzyMatchEntities(expected: string, actual: string): boolean {
  const normalize = (str: string) =>
    str.toLowerCase().replace(/[^a-z0-9]/g, '');

  return normalize(expected) === normalize(actual);
}

/**
 * Find actual entity by name (with fuzzy matching)
 */
function findEntityByName(name: string, actualEntities: CollectedResults['entities']): CollectedResults['entities'][0] | undefined {
  // Try exact match first
  let found = actualEntities.find(e => e.canonicalName === name);
  if (found) return found;

  // Try fuzzy match
  found = actualEntities.find(e => fuzzyMatchEntities(name, e.canonicalName));
  if (found) return found;

  // Try aliases
  for (const entity of actualEntities) {
    if (entity.aliases.some(alias => fuzzyMatchEntities(name, alias))) {
      return entity;
    }
  }

  return undefined;
}

/**
 * Validate entity extraction
 */
export function validateEntities(
  groundTruth: ScenarioGroundTruth,
  actualResults: CollectedResults
): EntityValidation {
  const expected = groundTruth.expectedEntities;
  const actual = actualResults.entities;

  const details: EntityValidationDetail[] = [];
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  // Check each expected entity
  for (const expEntity of expected) {
    const found = findEntityByName(expEntity.name, actual);

    details.push({
      expectedName: expEntity.name,
      expectedType: expEntity.type,
      actualFound: !!found,
      actualName: found?.canonicalName,
      actualType: found?.entityType,
      aliasesMatched: found?.aliases,
    });

    if (found) {
      truePositives++;
    } else {
      falseNegatives++;
    }
  }

  // Count false positives (entities found but not expected)
  const expectedNames = new Set(expected.map(e => e.name.toLowerCase()));
  for (const actEntity of actual) {
    const nameLower = actEntity.canonicalName.toLowerCase();
    if (!expectedNames.has(nameLower) && !findEntityByName(actEntity.canonicalName, expected.map(e => ({ id: '', canonicalName: e.name, entityType: e.type, aliases: e.aliases || [], createdAt: new Date() })))) {
      falsePositives++;
    }
  }

  const precision = truePositives + falsePositives > 0
    ? truePositives / (truePositives + falsePositives)
    : 0;

  const recall = truePositives + falseNegatives > 0
    ? truePositives / (truePositives + falseNegatives)
    : 0;

  const f1Score = precision + recall > 0
    ? 2 * (precision * recall) / (precision + recall)
    : 0;

  return {
    totalExpected: expected.length,
    totalActual: actual.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1Score,
    details,
  };
}

/**
 * Validate fact extraction
 */
export function validateFacts(
  groundTruth: ScenarioGroundTruth,
  actualResults: CollectedResults
): FactValidation {
  const expected = groundTruth.expectedFacts;
  const actual = actualResults.facts;

  const details: FactValidationDetail[] = [];
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  // Check each expected fact
  for (const expFact of expected) {
    // Find subject entity
    const subjectEntity = findEntityByName(expFact.subjectEntity, actualResults.entities);

    // Look for matching facts
    const matchingFact = subjectEntity
      ? actual.find(f =>
          f.subjectEntityId === subjectEntity.id &&
          f.predicate === expFact.predicate &&
          f.objectValue === expFact.object
        )
      : undefined;

    details.push({
      subjectEntity: expFact.subjectEntity,
      predicate: expFact.predicate,
      expectedObject: expFact.object,
      actualObject: matchingFact?.objectValue || undefined,
      match: !!matchingFact,
    });

    if (matchingFact) {
      truePositives++;
    } else {
      falseNegatives++;
    }
  }

  // Count false positives
  const expectedKeys = new Set(expected.map(f => `${f.subjectEntity}-${f.predicate}-${f.object}`));
  for (const actFact of actual) {
    const key = `${actFact.subjectEntityId}-${actFact.predicate}-${actFact.objectValue}`;
    if (!expectedKeys.has(key)) {
      falsePositives++;
    }
  }

  const precision = truePositives + falsePositives > 0
    ? truePositives / (truePositives + falsePositives)
    : 0;

  const recall = truePositives + falseNegatives > 0
    ? truePositives / (truePositives + falseNegatives)
    : 0;

  const f1Score = precision + recall > 0
    ? 2 * (precision * recall) / (precision + recall)
    : 0;

  return {
    totalExpected: expected.length,
    totalActual: actual.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1Score,
    details,
  };
}

/**
 * Validate task extraction
 */
export function validateTasks(
  groundTruth: ScenarioGroundTruth,
  actualResults: CollectedResults
): TaskValidation {
  const expected = groundTruth.expectedTasks;
  const actual = actualResults.tasks;

  const details: TaskValidationDetail[] = [];
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  // Check each expected task
  for (const expTask of expected) {
    // Look for matching task (fuzzy match on content)
    const matchingTask = actual.find(t =>
      t.content.toLowerCase().includes(expTask.content.toLowerCase()) ||
      expTask.content.toLowerCase().includes(t.content.toLowerCase())
    );

    details.push({
      expectedContent: expTask.content,
      actualContent: matchingTask?.content,
      match: !!matchingTask,
    });

    if (matchingTask) {
      truePositives++;
    } else {
      falseNegatives++;
    }
  }

  // Count false positives
  const expectedContents = new Set(expected.map(t => t.content.toLowerCase()));
  for (const actTask of actual) {
    if (!expectedContents.has(actTask.content.toLowerCase())) {
      falsePositives++;
    }
  }

  const precision = truePositives + falsePositives > 0
    ? truePositives / (truePositives + falsePositives)
    : 0;

  const recall = truePositives + falseNegatives > 0
    ? truePositives / (truePositives + falseNegatives)
    : 0;

  const f1Score = precision + recall > 0
    ? 2 * (precision * recall) / (precision + recall)
    : 0;

  return {
    totalExpected: expected.length,
    totalActual: actual.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1Score,
    details,
  };
}

/**
 * Validate all aspects of benchmark results
 */
export function validateResults(
  groundTruth: ScenarioGroundTruth,
  actualResults: CollectedResults
): ValidationMetrics {
  console.log('📊 Validating results against ground truth...');

  const entityValidation = validateEntities(groundTruth, actualResults);
  const factValidation = validateFacts(groundTruth, actualResults);
  const taskValidation = validateTasks(groundTruth, actualResults);

  // Calculate overall F1 (weighted average)
  const totalWeight = entityValidation.totalExpected + factValidation.totalExpected + taskValidation.totalExpected;
  const overallF1 = totalWeight > 0
    ? (entityValidation.f1Score * entityValidation.totalExpected +
        factValidation.f1Score * factValidation.totalExpected +
        taskValidation.f1Score * taskValidation.totalExpected) / totalWeight
    : 0;

  console.log('✅ Validation complete:');
  console.log(`   📚 Entities: P=${entityValidation.precision.toFixed(2)} R=${entityValidation.recall.toFixed(2)} F1=${entityValidation.f1Score.toFixed(2)}`);
  console.log(`   🔗 Facts: P=${factValidation.precision.toFixed(2)} R=${factValidation.recall.toFixed(2)} F1=${factValidation.f1Score.toFixed(2)}`);
  console.log(`   📋 Tasks: P=${taskValidation.precision.toFixed(2)} R=${taskValidation.recall.toFixed(2)} F1=${taskValidation.f1Score.toFixed(2)}`);
  console.log(`   📊 Overall F1: ${overallF1.toFixed(3)}`);

  return {
    entities: entityValidation,
    facts: factValidation,
    tasks: taskValidation,
    overallF1,
  };
}
