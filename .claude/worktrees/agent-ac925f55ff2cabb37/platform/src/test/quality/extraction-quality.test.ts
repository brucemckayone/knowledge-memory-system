/**
 * Layer 2: ML Extraction Quality Tests
 *
 * Tests ML extraction against golden scenarios using property-based
 * verification with aggregate thresholds.
 *
 * Requires: PostgreSQL + ML service (ZAI_API_KEY)
 * Speed: ~2-3 min (ML calls)
 * Skips: when ML unavailable
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { isMLServiceAvailable, ML_SERVICES_URL } from '../setup.js';
import {
  EXTRACTION_SCENARIOS,
  CONTRADICTION_PAIRS,
  CLASSIFICATION_SCENARIOS,
  getTemporalScenarios,
} from './golden-scenarios.js';
import {
  matchEntities,
} from './helpers.js';

// --- Thresholds ---
// Starting thresholds are intentionally below aspirational targets
// to absorb model variance. Adjust upward when metrics improve.

const THRESHOLDS = {
  entityRecall: 0.75,           // Aspirational: 0.87
  entityTypeAccuracy: 0.70,     // Aspirational: 0.85
  relationshipRecall: 0.65,     // Aspirational: 0.80
  temporalPopulationRate: 0.60, // Aspirational: 0.80
  contradictionTP: 0.80,        // Aspirational: 0.90
  contradictionTN: 0.90,        // Aspirational: 0.95
  classificationAccuracy: 0.75, // Aspirational: 0.85
};

describe('Layer 2: ML Extraction Quality', () => {
  let mlAvailable = false;

  beforeAll(async () => {
    mlAvailable = await isMLServiceAvailable();
    if (!mlAvailable) {
      console.warn('⚠️  ML Services not available — skipping extraction quality tests');
    }
  });

  // E1: Entity recall
  it('E1: entity recall across golden scenarios', async (ctx) => {
    if (!mlAvailable) { ctx.skip(); return; }

    let totalExpected = 0;
    let totalFound = 0;

    for (const scenario of EXTRACTION_SCENARIOS) {
      if (scenario.expectedEntities.length === 0) continue;

      for (const message of scenario.messages) {
        const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
          signal: AbortSignal.timeout(120000),
        });

        if (!response.ok) continue;

        const data = await response.json() as {
          entities: Array<{ mention: string; type?: string }>;
        };

        const { found } = matchEntities(
          scenario.expectedEntities,
          data.entities || [],
        );

        totalExpected += scenario.expectedEntities.length;
        totalFound += found.length;
      }
    }

    const recall = totalExpected > 0 ? totalFound / totalExpected : 0;
    console.log(`E1: Entity recall = ${(recall * 100).toFixed(1)}% (threshold: ${(THRESHOLDS.entityRecall * 100).toFixed(0)}%)`);
    console.log(`    Found ${totalFound}/${totalExpected} expected entities`);

    expect(recall).toBeGreaterThanOrEqual(THRESHOLDS.entityRecall);
  }, 600000);

  // E2: Entity type accuracy
  it('E2: entity type accuracy', async (ctx) => {
    if (!mlAvailable) { ctx.skip(); return; }

    let totalMatched = 0;
    let totalTypeCorrect = 0;

    for (const scenario of EXTRACTION_SCENARIOS) {
      if (scenario.expectedEntities.length === 0) continue;

      for (const message of scenario.messages) {
        const response = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
          signal: AbortSignal.timeout(120000),
        });

        if (!response.ok) continue;

        const data = await response.json() as {
          entities: Array<{ mention: string; type?: string }>;
        };

        const { found, typeMatches } = matchEntities(
          scenario.expectedEntities,
          data.entities || [],
        );

        totalMatched += found.length;
        totalTypeCorrect += typeMatches;
      }
    }

    const typeAccuracy = totalMatched > 0 ? totalTypeCorrect / totalMatched : 0;
    console.log(`E2: Entity type accuracy = ${(typeAccuracy * 100).toFixed(1)}% (threshold: ${(THRESHOLDS.entityTypeAccuracy * 100).toFixed(0)}%)`);
    console.log(`    ${totalTypeCorrect}/${totalMatched} type-matched entities`);

    expect(typeAccuracy).toBeGreaterThanOrEqual(THRESHOLDS.entityTypeAccuracy);
  }, 600000);

  // E3: Relationship predicate recall
  it('E3: relationship predicate recall', async (ctx) => {
    if (!mlAvailable) { ctx.skip(); return; }

    let totalExpected = 0;
    let totalFound = 0;

    for (const scenario of EXTRACTION_SCENARIOS) {
      const expectedRels = scenario.expectedRelationships;
      if (!expectedRels || expectedRels.length === 0) continue;

      const fullText = scenario.messages.join('\n');

      const entityResponse = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: fullText }),
        signal: AbortSignal.timeout(120000),
      });

      if (!entityResponse.ok) continue;

      const entityData = await entityResponse.json() as {
        entities: Array<{ mention: string; type?: string }>;
      };

      const entities = (entityData.entities || []).map(e => ({
        name: e.mention,
        type: e.type,
      }));

      if (entities.length === 0) continue;

      const relResponse = await fetch(`${ML_SERVICES_URL}/extract-relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: fullText, entities }),
        signal: AbortSignal.timeout(120000),
      });

      if (!relResponse.ok) continue;

      const relData = await relResponse.json() as {
        relationships: Array<{
          subject: string;
          predicate: string;
          object: string;
          confidence: number;
          temporal_hint?: string;
        }>;
      };

      const extracted = relData.relationships || [];

      for (const exp of expectedRels) {
        totalExpected++;
        const found = extracted.some(ext => {
          const subjectMatch =
            ext.subject.toLowerCase().includes(exp.subject.toLowerCase()) ||
            exp.subject.toLowerCase().includes(ext.subject.toLowerCase());
          const objectMatch =
            ext.object.toLowerCase().includes(exp.object.toLowerCase()) ||
            exp.object.toLowerCase().includes(ext.object.toLowerCase());
          const predicateMatch =
            ext.predicate.toLowerCase().includes(exp.predicate.toLowerCase()) ||
            exp.predicate.toLowerCase().includes(ext.predicate.toLowerCase());

          return subjectMatch && objectMatch && predicateMatch;
        });
        if (found) totalFound++;
      }
    }

    const recall = totalExpected > 0 ? totalFound / totalExpected : 0;
    console.log(`E3: Relationship recall = ${(recall * 100).toFixed(1)}% (threshold: ${(THRESHOLDS.relationshipRecall * 100).toFixed(0)}%)`);
    console.log(`    Found ${totalFound}/${totalExpected} expected relationships`);

    expect(recall).toBeGreaterThanOrEqual(THRESHOLDS.relationshipRecall);
  }, 600000);

  // E4: Temporal language → temporal facts
  it('E4: temporal language produces temporal attributes', async (ctx) => {
    if (!mlAvailable) { ctx.skip(); return; }

    const temporalScenarios = getTemporalScenarios();
    let totalExpected = 0;
    let totalPopulated = 0;

    for (const scenario of temporalScenarios) {
      const fullText = scenario.messages.join('\n');

      const entityResponse = await fetch(`${ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: fullText }),
        signal: AbortSignal.timeout(120000),
      });

      if (!entityResponse.ok) continue;

      const entityData = await entityResponse.json() as {
        entities: Array<{ mention: string; type?: string }>;
      };

      const entities = (entityData.entities || []).map(e => ({
        name: e.mention,
        type: e.type,
      }));

      if (entities.length === 0) continue;

      const relResponse = await fetch(`${ML_SERVICES_URL}/extract-relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: fullText, entities }),
        signal: AbortSignal.timeout(120000),
      });

      if (!relResponse.ok) continue;

      const relData = await relResponse.json() as {
        relationships: Array<{
          subject: string;
          predicate: string;
          object: string;
          temporal_hint?: string;
        }>;
      };

      const extracted = relData.relationships || [];

      for (const _exp of scenario.temporalExpectations || []) {
        totalExpected++;
        const hasTemporalHint = extracted.some(
          r => r.temporal_hint && r.temporal_hint.trim().length > 0,
        );
        if (hasTemporalHint) totalPopulated++;
      }
    }

    const rate = totalExpected > 0 ? totalPopulated / totalExpected : 0;
    console.log(`E4: Temporal population rate = ${(rate * 100).toFixed(1)}% (threshold: ${(THRESHOLDS.temporalPopulationRate * 100).toFixed(0)}%)`);
    console.log(`    ${totalPopulated}/${totalExpected} temporal expectations had hints`);

    expect(rate).toBeGreaterThanOrEqual(THRESHOLDS.temporalPopulationRate);
  }, 600000);

  // E5: Contradiction detection (true positives)
  it('E5: contradiction detection true positive rate', async (ctx) => {
    if (!mlAvailable) { ctx.skip(); return; }

    const trueContradictions = CONTRADICTION_PAIRS.filter(p => p.expectContradicts);
    let detected = 0;

    for (const pair of trueContradictions) {
      const response = await fetch(`${ML_SERVICES_URL}/detect-contradiction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact1: pair.fact1, fact2: pair.fact2 }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) continue;

      const data = await response.json() as { contradicts: boolean };
      if (data.contradicts) detected++;
    }

    const tpRate = trueContradictions.length > 0 ? detected / trueContradictions.length : 0;
    console.log(`E5: Contradiction TP rate = ${(tpRate * 100).toFixed(1)}% (threshold: ${(THRESHOLDS.contradictionTP * 100).toFixed(0)}%)`);
    console.log(`    Detected ${detected}/${trueContradictions.length} true contradictions`);

    expect(tpRate).toBeGreaterThanOrEqual(THRESHOLDS.contradictionTP);
  }, 600000);

  // E6: Contradiction detection (true negatives)
  it('E6: contradiction detection true negative rate', async (ctx) => {
    if (!mlAvailable) { ctx.skip(); return; }

    const nonContradictions = CONTRADICTION_PAIRS.filter(p => !p.expectContradicts);
    let correctlyRejected = 0;

    for (const pair of nonContradictions) {
      const response = await fetch(`${ML_SERVICES_URL}/detect-contradiction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact1: pair.fact1, fact2: pair.fact2 }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) continue;

      const data = await response.json() as { contradicts: boolean };
      if (!data.contradicts) correctlyRejected++;
    }

    const tnRate = nonContradictions.length > 0 ? correctlyRejected / nonContradictions.length : 0;
    console.log(`E6: Contradiction TN rate = ${(tnRate * 100).toFixed(1)}% (threshold: ${(THRESHOLDS.contradictionTN * 100).toFixed(0)}%)`);
    console.log(`    Correctly rejected ${correctlyRejected}/${nonContradictions.length} non-contradictions`);

    expect(tnRate).toBeGreaterThanOrEqual(THRESHOLDS.contradictionTN);
  }, 600000);

  // E7: Classification accuracy
  it('E7: message classification accuracy', async (ctx) => {
    if (!mlAvailable) { ctx.skip(); return; }

    let correct = 0;

    for (const tc of CLASSIFICATION_SCENARIOS) {
      const response = await fetch(`${ML_SERVICES_URL}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: tc.text }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) continue;

      const data = await response.json() as { primary_intent?: string };
      const predicted = data.primary_intent?.toLowerCase() || '';

      if (tc.acceptableIntents.includes(predicted)) {
        correct++;
      }
    }

    const accuracy = correct / CLASSIFICATION_SCENARIOS.length;
    console.log(`E7: Classification accuracy = ${(accuracy * 100).toFixed(1)}% (threshold: ${(THRESHOLDS.classificationAccuracy * 100).toFixed(0)}%)`);
    console.log(`    ${correct}/${CLASSIFICATION_SCENARIOS.length} correctly classified`);

    expect(accuracy).toBeGreaterThanOrEqual(THRESHOLDS.classificationAccuracy);
  }, 600000);
});
