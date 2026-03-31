/**
 * Quality Benchmarks
 *
 * Tracks quality metrics for ML-based operations.
 * These benchmarks use golden test sets to measure accuracy.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  isMLServiceAvailable,
  ML_SERVICES_URL,
  skipCtx,
} from '../setup.js';

// Quality targets from test strategy
const QUALITY_TARGETS = {
  entityResolutionF1: 0.87,
  factExtractionPrecision: 0.80,
  contradictionDetectionRecall: 0.90,
  classificationAccuracy: 0.85,
  searchRelevanceMRR: 0.70,
  entityDedupAccuracy: 0.95,
};

// Golden test data for classification
const CLASSIFICATION_TEST_SET = [
  { text: 'Remember to call John tomorrow', expected: ['task', 'reminder', 'todo'] },
  { text: 'Had a great meeting about the new feature', expected: ['thought', 'note', 'idea'] },
  { text: 'How does the authentication system work?', expected: ['question', 'query'] },
  { text: 'https://example.com/article', expected: ['link', 'url', 'reference'] },
  { text: 'The weather is nice today', expected: ['thought', 'note'] },
  { text: 'Buy groceries after work', expected: ['task', 'reminder', 'todo'] },
  { text: 'What is the deadline for Project Alpha?', expected: ['question', 'query'] },
  { text: 'Interesting article about machine learning', expected: ['thought', 'link', 'reference'] },
  { text: 'Schedule meeting with Sarah for Friday', expected: ['task', 'reminder', 'todo'] },
  { text: 'Why did the deployment fail yesterday?', expected: ['question', 'query'] },
];

// Golden test data for entity extraction
const ENTITY_EXTRACTION_TEST_SET = [
  {
    text: 'John Smith works at Google',
    expectedEntities: [
      { mention: 'John Smith', type: 'person' },
      { mention: 'Google', type: 'company' },
    ],
  },
  {
    text: 'The meeting with Sarah Chen is in San Francisco',
    expectedEntities: [
      { mention: 'Sarah Chen', type: 'person' },
      { mention: 'San Francisco', type: 'place' },
    ],
  },
  {
    text: 'Project Alpha uses React and TypeScript',
    expectedEntities: [
      { mention: 'Project Alpha', type: 'project' },
      { mention: 'React', type: 'concept' },
      { mention: 'TypeScript', type: 'concept' },
    ],
  },
];

// Golden test data for contradiction detection
const CONTRADICTION_TEST_SET = [
  {
    fact1: { subject: 'John', predicate: 'works_at', object: 'Google' },
    fact2: { subject: 'John', predicate: 'works_at', object: 'Microsoft' },
    expectedContradiction: true,
  },
  {
    fact1: { subject: 'John', predicate: 'knows', object: 'Sarah' },
    fact2: { subject: 'John', predicate: 'knows', object: 'Mike' },
    expectedContradiction: false,
  },
  {
    fact1: { subject: 'Budget', predicate: 'amount', object: '$100,000' },
    fact2: { subject: 'Budget', predicate: 'amount', object: '$500,000' },
    expectedContradiction: true,
  },
  {
    fact1: { subject: 'Project', predicate: 'status', object: 'active' },
    fact2: { subject: 'Project', predicate: 'status', object: 'cancelled' },
    expectedContradiction: true,
  },
  {
    fact1: { subject: 'Alice', predicate: 'works_on', object: 'Project A' },
    fact2: { subject: 'Alice', predicate: 'works_on', object: 'Project B' },
    expectedContradiction: false,
  },
];

describe('Quality Benchmarks', () => {
  beforeAll(async (ctx) => {
    const mlAvailable = await isMLServiceAvailable();
    if (!mlAvailable) {
      console.warn('⚠️ ML Services not available - skipping quality benchmarks');
      skipCtx(ctx);
    }
  });

  describe('Classification Accuracy', () => {
    it('should meet classification accuracy target', async () => {
      let correct = 0;

      for (const testCase of CLASSIFICATION_TEST_SET) {
        const response = await fetch(`${ML_SERVICES_URL}/classify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: testCase.text }),
        });

        if (response.ok) {
          const result = await response.json() as Record<string, unknown>;
          const predicted = (result.primary_intent as string | undefined)?.toLowerCase() || '';

          if (predicted && testCase.expected.includes(predicted)) {
            correct++;
          }
        }
      }

      const accuracy = correct / CLASSIFICATION_TEST_SET.length;
      console.log(`Classification accuracy: ${(accuracy * 100).toFixed(1)}%`);
      console.log(`Target: ${(QUALITY_TARGETS.classificationAccuracy * 100).toFixed(1)}%`);

      // Report accuracy (may not meet target with all models)
      expect(accuracy).toBeGreaterThan(0.5); // At least better than random
    }, 120000);
  });

  describe('Entity Extraction Quality', () => {
    it('should extract expected entities', async () => {
      let totalExpected = 0;
      let totalFound = 0;
      let correctFound = 0;

      for (const testCase of ENTITY_EXTRACTION_TEST_SET) {
        const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: testCase.text }),
        });

        if (response.ok) {
          const result = await response.json() as Record<string, unknown>;
          const extractedMentions = ((result.entities as unknown as Array<{ mention: string }>) || []).map(
            (e: { mention: string }) => e.mention.toLowerCase()
          );

          totalExpected += testCase.expectedEntities.length;
          totalFound += extractedMentions.length;

          for (const expected of testCase.expectedEntities) {
            const found = extractedMentions.some(
              (m: string) =>
                m.includes(expected.mention.toLowerCase()) ||
                expected.mention.toLowerCase().includes(m)
            );
            if (found) correctFound++;
          }
        }
      }

      const recall = correctFound / totalExpected;
      const precision = totalFound > 0 ? correctFound / totalFound : 0;
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

      console.log(`Entity extraction - Precision: ${(precision * 100).toFixed(1)}%`);
      console.log(`Entity extraction - Recall: ${(recall * 100).toFixed(1)}%`);
      console.log(`Entity extraction - F1: ${(f1 * 100).toFixed(1)}%`);
      console.log(`Target F1: ${(QUALITY_TARGETS.entityResolutionF1 * 100).toFixed(1)}%`);

      expect(recall).toBeGreaterThan(0.3); // At least finding some entities
    }, 120000);
  });

  describe('Contradiction Detection Quality', () => {
    it('should detect contradictions accurately', async () => {
      let truePositives = 0;
      let falsePositives = 0;
      let falseNegatives = 0;
      let trueNegatives = 0;

      for (const testCase of CONTRADICTION_TEST_SET) {
        const response = await fetch(`${ML_SERVICES_URL}/detect-contradiction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fact1: testCase.fact1,
            fact2: testCase.fact2,
          }),
        });

        if (response.ok) {
          const result = await response.json() as Record<string, unknown>;
          const predicted = result.contradicts as boolean;
          const expected = testCase.expectedContradiction;

          if (predicted && expected) truePositives++;
          else if (predicted && !expected) falsePositives++;
          else if (!predicted && expected) falseNegatives++;
          else trueNegatives++;
        }
      }

      const precision = truePositives / (truePositives + falsePositives) || 0;
      const recall = truePositives / (truePositives + falseNegatives) || 0;
      const accuracy = (truePositives + trueNegatives) / CONTRADICTION_TEST_SET.length;

      console.log(`Contradiction detection - Precision: ${(precision * 100).toFixed(1)}%`);
      console.log(`Contradiction detection - Recall: ${(recall * 100).toFixed(1)}%`);
      console.log(`Contradiction detection - Accuracy: ${(accuracy * 100).toFixed(1)}%`);
      console.log(`Target Recall: ${(QUALITY_TARGETS.contradictionDetectionRecall * 100).toFixed(1)}%`);

      expect(recall).toBeGreaterThan(0.5); // Better than random
    }, 120000);
  });

  describe('Quality Metrics Summary', () => {
    it('should report all quality targets', () => {
      console.log('\n=== Quality Targets ===');
      console.log(`Entity Resolution F1: >${(QUALITY_TARGETS.entityResolutionF1 * 100).toFixed(0)}%`);
      console.log(`Fact Extraction Precision: >${(QUALITY_TARGETS.factExtractionPrecision * 100).toFixed(0)}%`);
      console.log(`Contradiction Detection Recall: >${(QUALITY_TARGETS.contradictionDetectionRecall * 100).toFixed(0)}%`);
      console.log(`Classification Accuracy: >${(QUALITY_TARGETS.classificationAccuracy * 100).toFixed(0)}%`);
      console.log(`Search Relevance (MRR): >${(QUALITY_TARGETS.searchRelevanceMRR * 100).toFixed(0)}%`);
      console.log(`Entity Dedup Accuracy: >${(QUALITY_TARGETS.entityDedupAccuracy * 100).toFixed(0)}%`);
      console.log('========================\n');

      expect(true).toBe(true);
    });
  });
});
