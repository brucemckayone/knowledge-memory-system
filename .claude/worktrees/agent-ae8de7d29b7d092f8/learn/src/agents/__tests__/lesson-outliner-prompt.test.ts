import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test as outliner, type OutlinerInput } from '../lesson-outliner.js';
import {
  makeColdStartContext,
  type LearnerLessonContext,
} from '../learner-lesson-context.js';

const baseInput: OutlinerInput = {
  courseTitle: 'JavaScript Fundamentals',
  courseDescription: null,
  sectionTitle: 'Closures',
  sectionDescription: 'How closures capture variables.',
  learningObjectives: ['Define a closure', 'Identify capture by reference'],
  orderIndex: 2,
  prevSectionTitle: 'Functions',
  nextSectionTitle: 'Async',
};

// ── Cold-start byte-identity ──

test('outliner.buildUserPrompt: undefined learnerContext == cold-start coldStart=true (byte-identical)', () => {
  const baseline = outliner.buildUserPrompt(baseInput);
  const coldStart = outliner.buildUserPrompt({
    ...baseInput,
    learnerContext: makeColdStartContext('2026-05-08T00:00:00Z'),
  });
  assert.equal(coldStart, baseline, 'cold-start prompt must be byte-identical to no-context prompt');
  assert.ok(!baseline.includes('## Learner state'), 'baseline must not contain Learner state header');
});

// ── Personalised path ──

test('outliner.buildUserPrompt: confusion concept name appears in user prompt', () => {
  const ctx: LearnerLessonContext = {
    coldStart: false,
    relevantFacts: [],
    forgottenConcepts: [],
    confusions: [{
      entityId: 'concept-A',
      concept: 'closures',
      misconception: 'closures capture by value, not reference',
      sourceText: 'I thought closures copy variables.',
    }],
    missingPrereqs: [],
    established: [],
    fetchedAt: '2026-05-08T00:00:00Z',
  };
  const prompt = outliner.buildUserPrompt({ ...baseInput, learnerContext: ctx });
  assert.ok(prompt.includes('## Learner state'), 'should contain Learner state section');
  assert.ok(prompt.includes('closures'), 'should mention concept name');
  assert.ok(prompt.includes('closures capture by value'), 'should quote misconception text');
});

test('outliner.buildUserPrompt: missingPrereqs surface neededFor relationship', () => {
  const ctx: LearnerLessonContext = {
    coldStart: false,
    relevantFacts: [],
    forgottenConcepts: [],
    confusions: [],
    missingPrereqs: [{ concept: 'big-O notation', neededFor: 'binary search' }],
    established: [],
    fetchedAt: '2026-05-08T00:00:00Z',
  };
  const prompt = outliner.buildUserPrompt({ ...baseInput, learnerContext: ctx });
  assert.ok(prompt.includes('Missing prerequisites'), 'should list missing prereqs');
  assert.ok(prompt.includes('big-O notation'), 'should name the prereq');
  assert.ok(prompt.includes('binary search'), 'should name the section concept it gates');
});

test('outliner.renderLearnerStateBlock: empty arrays yield empty string (no spurious section)', () => {
  const ctx: LearnerLessonContext = {
    coldStart: false,
    relevantFacts: [],
    forgottenConcepts: [],
    confusions: [],
    missingPrereqs: [],
    established: [],
    fetchedAt: '2026-05-08T00:00:00Z',
  };
  const block = outliner.renderLearnerStateBlock(ctx);
  assert.equal(block, '', 'a coldStart=false context with no actionable state should yield no block');
});
