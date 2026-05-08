/**
 * Gap-bias prompt augmentation tests (nmemo-7b3).
 *
 * When a `prioritisedGap` is set on the LearnerLessonContext, the outliner
 * and prose prompts must surface a "Prioritised gap" block instructing the
 * model to bias the outline / prose toward the root-cause concept.
 *
 * Cold-start callers (no prioritisedGap) must remain byte-identical to the
 * v0.3 baseline — covered by existing lesson-outliner-prompt.test.ts; here
 * we only assert the gap-bias path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test as outliner, type OutlinerInput } from '../lesson-outliner.js';
import { __test as prose } from '../lesson-prose.js';
import {
  withPrioritisedGap, makeColdStartContext,
  type LearnerLessonContext, type PrioritisedGap,
} from '../learner-lesson-context.js';

const gap: PrioritisedGap = {
  rootCauseEntityId: 'ent-scope-chain',
  rootCauseConceptName: 'scope chains',
  rootCauseReason: 'You skipped scope chains earlier in the course.',
  whyItMatters: 'Without scope chains, closures stay opaque.',
};

const baseOutlinerInput: OutlinerInput = {
  courseTitle: 'JavaScript Fundamentals',
  courseDescription: null,
  sectionTitle: 'Closures',
  sectionDescription: 'How closures capture variables.',
  learningObjectives: ['Define a closure'],
  orderIndex: 2,
  prevSectionTitle: 'Functions',
  nextSectionTitle: 'Async',
};

test('withPrioritisedGap: forces coldStart=false even when base is cold-start', () => {
  const cold = makeColdStartContext('2026-05-08T00:00:00Z');
  assert.equal(cold.coldStart, true);
  const biased = withPrioritisedGap(cold, gap);
  assert.equal(biased.coldStart, false);
  assert.equal(biased.prioritisedGap?.rootCauseConceptName, 'scope chains');
});

test('outliner prompt: prioritisedGap surfaces "Prioritised gap" block with concept + reason', () => {
  const ctx: LearnerLessonContext = withPrioritisedGap(
    makeColdStartContext('2026-05-08T00:00:00Z'),
    gap,
  );
  const prompt = outliner.buildUserPrompt({ ...baseOutlinerInput, learnerContext: ctx });
  assert.ok(prompt.includes('## Learner state'), 'should include Learner state section');
  assert.ok(prompt.includes('Prioritised gap'), 'should label the gap block');
  assert.ok(prompt.includes('scope chains'), 'should mention the root-cause concept');
  assert.ok(prompt.includes('skipped scope chains'), 'should include the root-cause reason');
  assert.ok(prompt.includes('Without scope chains'), 'should include the whyItMatters text');
  assert.ok(prompt.includes('remedial slant'), 'should instruct a remedial bias');
});

test('outliner prompt: no prioritisedGap → no "Prioritised gap" block', () => {
  const ctx: LearnerLessonContext = {
    coldStart: false,
    relevantFacts: [],
    forgottenConcepts: [],
    confusions: [{ entityId: null, concept: 'closures', misconception: 'capture by value', sourceText: null }],
    missingPrereqs: [],
    established: [],
    fetchedAt: '2026-05-08T00:00:00Z',
  };
  const prompt = outliner.buildUserPrompt({ ...baseOutlinerInput, learnerContext: ctx });
  assert.ok(!prompt.includes('Prioritised gap'), 'no gap → no Prioritised gap block');
});

test('prose context block: prioritisedGap surfaces unconditionally (any intent)', () => {
  const ctx: LearnerLessonContext = withPrioritisedGap(
    makeColdStartContext('2026-05-08T00:00:00Z'),
    gap,
  );
  // "intent" deliberately unrelated to the gap concept name — gap-bias is
  // unconditional so the model sees the remedial slant on every prose item.
  const block = prose.renderProseLearnerContextBlock(ctx, 'introduce variable scope');
  assert.ok(block.includes('prioritised gap'), 'prose block must surface the gap unconditionally');
  assert.ok(block.includes('scope chains'), 'prose block must include the concept name');
});
