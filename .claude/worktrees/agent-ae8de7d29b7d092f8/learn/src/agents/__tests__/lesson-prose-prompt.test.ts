import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test as prose, type ProseWriterInput } from '../lesson-prose.js';
import {
  makeColdStartContext,
  type LearnerLessonContext,
} from '../learner-lesson-context.js';
import type { LessonOutline } from '../lesson-outliner.js';

const outline: LessonOutline = {
  title: 'Closures',
  intro: 'Closures wrap a function with the variables it sees.',
  items: [
    { kind: 'prose', id: 'p1', intent: 'Define a closure and contrast with a plain function — name the wrong belief about value capture, then correct it.', wordTarget: 300 },
    { kind: 'prose', id: 'p2', intent: 'Show how closures interact with loops.', wordTarget: 250 },
  ],
  outro: 'Up next: async functions.',
};

const baseInput: ProseWriterInput = {
  outline,
  item: outline.items[0] as { kind: 'prose'; id: string; intent: string; wordTarget: number },
  courseTitle: 'JavaScript Fundamentals',
  sectionTitle: 'Closures',
  sectionDescription: 'How closures capture variables.',
  learningObjectives: ['Define a closure'],
};

test('prose.buildUserPrompt: cold-start coldStart=true is byte-identical to no-context prompt', () => {
  const baseline = prose.buildUserPrompt(baseInput);
  const coldStart = prose.buildUserPrompt({
    ...baseInput,
    learnerContext: makeColdStartContext('2026-05-08T00:00:00Z'),
  });
  assert.equal(coldStart, baseline);
  assert.ok(!baseline.includes('## Learner context'), 'baseline must not contain Learner context header');
});

test('prose.buildUserPrompt: confusion that matches intent surfaces in prompt', () => {
  const ctx: LearnerLessonContext = {
    coldStart: false,
    relevantFacts: [],
    forgottenConcepts: [],
    confusions: [{
      entityId: 'concept-A',
      // The intent for p1 mentions "closure" — substring match should pull this in.
      concept: 'closure',
      misconception: 'closures capture variables by value',
      sourceText: null,
    }],
    missingPrereqs: [],
    established: [],
    fetchedAt: '2026-05-08T00:00:00Z',
  };
  const prompt = prose.buildUserPrompt({ ...baseInput, learnerContext: ctx });
  assert.ok(prompt.includes('## Learner context'), 'should contain Learner context section');
  assert.ok(prompt.includes('closures capture variables by value'), 'misconception text appears');
});

test('prose.buildUserPrompt: confusion whose concept does not match intent is filtered out', () => {
  const unrelatedItem = outline.items[1]!; // intent is about loops
  const ctx: LearnerLessonContext = {
    coldStart: false,
    relevantFacts: [],
    forgottenConcepts: [],
    confusions: [{
      entityId: 'concept-Z',
      concept: 'monad', // does not appear in the loop-focused intent
      misconception: 'monads are like burritos',
      sourceText: null,
    }],
    missingPrereqs: [],
    established: [],
    fetchedAt: '2026-05-08T00:00:00Z',
  };
  const prompt = prose.buildUserPrompt({
    ...baseInput,
    item: unrelatedItem as { kind: 'prose'; id: string; intent: string; wordTarget: number },
    learnerContext: ctx,
  });
  // No relevant entries → no Learner context section emitted.
  assert.ok(!prompt.includes('## Learner context'), 'irrelevant confusion should not surface');
  assert.ok(!prompt.includes('monad'), 'unrelated concept name absent');
});
