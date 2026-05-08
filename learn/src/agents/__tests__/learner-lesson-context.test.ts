import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadLearnerLessonContext,
  __test,
} from '../learner-lesson-context.js';
import type { NmemoFact } from '../../services/nmemo-client.js';

const { deriveLearnerLessonContext, isColdStart } = __test;

const SECTION_CONCEPT_IDS = ['concept-A', 'concept-B'];

function fact(overrides: Partial<NmemoFact> & { createdAt?: string } = {}): NmemoFact {
  return {
    id: overrides.id ?? `f-${Math.random().toString(36).slice(2, 7)}`,
    subjectEntityId: overrides.subjectEntityId ?? 'learner',
    predicate: overrides.predicate ?? 'understands',
    objectEntityId: overrides.objectEntityId ?? null,
    objectValue: overrides.objectValue ?? null,
    confidence: overrides.confidence ?? null,
    sourceText: overrides.sourceText ?? null,
    ...(overrides.createdAt !== undefined ? ({ createdAt: overrides.createdAt } as Record<string, unknown>) : {}),
  } as NmemoFact;
}

// ── Cold-start path ──

test('isColdStart: true when no fact touches any section concept', () => {
  const facts = [fact({ predicate: 'understands', objectEntityId: 'concept-Z', confidence: 0.9 })];
  assert.equal(isColdStart(facts, SECTION_CONCEPT_IDS), true);
});

test('isColdStart: false when a fact touches a section concept', () => {
  const facts = [fact({ predicate: 'confused_by', objectEntityId: 'concept-A', objectValue: 'wrong belief' })];
  assert.equal(isColdStart(facts, SECTION_CONCEPT_IDS), false);
});

test('deriveLearnerLessonContext: cold-start returns canonical empty context', () => {
  const ctx = deriveLearnerLessonContext([], SECTION_CONCEPT_IDS);
  assert.equal(ctx.coldStart, true);
  assert.deepEqual(ctx.relevantFacts, []);
  assert.deepEqual(ctx.confusions, []);
  assert.deepEqual(ctx.forgottenConcepts, []);
  assert.deepEqual(ctx.missingPrereqs, []);
  assert.deepEqual(ctx.established, []);
});

// ── Confusion derivation ──

test('deriveLearnerLessonContext: confused_by fact lands in confusions[]', () => {
  const facts = [
    fact({
      predicate: 'confused_by',
      objectEntityId: 'concept-A',
      objectValue: 'closures capture by value',
      sourceText: 'I thought closures copy variables.',
    }),
  ];
  const ctx = deriveLearnerLessonContext(
    facts,
    SECTION_CONCEPT_IDS,
    new Map([['concept-A', 'closures']]),
  );
  assert.equal(ctx.coldStart, false);
  assert.equal(ctx.confusions.length, 1);
  assert.equal(ctx.confusions[0]!.concept, 'closures');
  assert.equal(ctx.confusions[0]!.misconception, 'closures capture by value');
  assert.equal(ctx.confusions[0]!.entityId, 'concept-A');
});

// ── Loader degrade-on-failure ──

test('loadLearnerLessonContext: degrades to cold-start when fetch throws', async () => {
  const ctx = await loadLearnerLessonContext(SECTION_CONCEPT_IDS, {
    fetchLearnerFacts: async () => { throw new Error('network down'); },
    timeoutMs: 1000,
  });
  assert.equal(ctx.coldStart, true);
  assert.deepEqual(ctx.relevantFacts, []);
  assert.deepEqual(ctx.confusions, []);
});

test('loadLearnerLessonContext: degrades to cold-start on timeout', async () => {
  const ctx = await loadLearnerLessonContext(SECTION_CONCEPT_IDS, {
    fetchLearnerFacts: () => new Promise((resolve) => setTimeout(() => resolve({ facts: [] }), 200)),
    timeoutMs: 20,
  });
  assert.equal(ctx.coldStart, true);
});

test('loadLearnerLessonContext: derives context on success', async () => {
  const ctx = await loadLearnerLessonContext(SECTION_CONCEPT_IDS, {
    fetchLearnerFacts: async () => ({
      facts: [
        fact({
          predicate: 'confused_by',
          objectEntityId: 'concept-A',
          objectValue: 'wrong mental model',
        }),
      ],
    }),
    entityNamesById: new Map([['concept-A', 'recursion']]),
    timeoutMs: 1000,
  });
  assert.equal(ctx.coldStart, false);
  assert.equal(ctx.confusions.length, 1);
  assert.equal(ctx.confusions[0]!.concept, 'recursion');
});

// ── Forgotten / established ──

test('deriveLearnerLessonContext: established understanding (>=0.7) flagged', () => {
  const facts = [
    fact({ predicate: 'understands', objectEntityId: 'concept-A', confidence: 0.85, createdAt: new Date().toISOString() }),
  ];
  const ctx = deriveLearnerLessonContext(
    facts,
    SECTION_CONCEPT_IDS,
    new Map([['concept-A', 'recursion']]),
  );
  assert.equal(ctx.established.length, 1);
  assert.equal(ctx.established[0]!.concept, 'recursion');
});

test('deriveLearnerLessonContext: forgotten concept (>=14 days, peak >=0.6) flagged', () => {
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const facts = [
    fact({ predicate: 'understands', objectEntityId: 'concept-A', confidence: 0.7, createdAt: old }),
  ];
  const ctx = deriveLearnerLessonContext(
    facts,
    SECTION_CONCEPT_IDS,
    new Map([['concept-A', 'recursion']]),
  );
  assert.equal(ctx.forgottenConcepts.length, 1);
  assert.equal(ctx.forgottenConcepts[0]!.name, 'recursion');
  assert.ok(ctx.forgottenConcepts[0]!.daysSince >= 14);
});

// ── Missing prereq ──

test('deriveLearnerLessonContext: lacks_prerequisite fact lands in missingPrereqs[]', () => {
  // For lacks_prerequisite, the section concept is the SUBJECT, so the
  // fact reads: "(learner_studying) concept-A lacks_prerequisite prereq-X".
  // We model the subject as the section concept here.
  const facts = [
    fact({
      subjectEntityId: 'concept-A',
      predicate: 'lacks_prerequisite',
      objectEntityId: 'prereq-X',
      objectValue: 'big-O notation',
    }),
  ];
  const ctx = deriveLearnerLessonContext(
    facts,
    SECTION_CONCEPT_IDS,
    new Map([['concept-A', 'binary search'], ['prereq-X', 'big-O notation']]),
  );
  assert.equal(ctx.missingPrereqs.length, 1);
  assert.equal(ctx.missingPrereqs[0]!.concept, 'big-O notation');
  assert.equal(ctx.missingPrereqs[0]!.neededFor, 'binary search');
});
