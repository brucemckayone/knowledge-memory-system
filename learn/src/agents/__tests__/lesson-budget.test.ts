import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test as gen } from '../lesson-generator.js';
import type { WebSearchStageRequest } from '../lesson-generator.js';

const { allocateWebSearchBudget } = gen;

test('budget: empty stage list yields no grants', () => {
  const a = allocateWebSearchBudget([], 5);
  assert.equal(a.used, 0);
  assert.equal(a.granted.size, 0);
  assert.equal(a.max, 5);
  assert.deepEqual(a.byKind, { outliner: 0, prose: 0, freeform_artifact: 0 });
});

test('budget: max=0 grants nothing even when stages want web', () => {
  const stages: WebSearchStageRequest[] = [
    { id: 'outliner', kind: 'outliner', wantsWeb: true },
    { id: 'p1', kind: 'prose', wantsWeb: true },
  ];
  const a = allocateWebSearchBudget(stages, 0);
  assert.equal(a.used, 0);
  assert.equal(a.granted.size, 0);
});

test('budget: stages that do not want web are skipped, not charged', () => {
  const stages: WebSearchStageRequest[] = [
    { id: 'outliner', kind: 'outliner', wantsWeb: false },
    { id: 'p1', kind: 'prose', wantsWeb: true },
    { id: 'p2', kind: 'prose', wantsWeb: false },
    { id: 'a1', kind: 'freeform_artifact', wantsWeb: true },
  ];
  const a = allocateWebSearchBudget(stages, 5);
  assert.equal(a.used, 2);
  assert.equal(a.granted.has('outliner'), false);
  assert.equal(a.granted.has('p1'), true);
  assert.equal(a.granted.has('p2'), false);
  assert.equal(a.granted.has('a1'), true);
  assert.deepEqual(a.byKind, { outliner: 0, prose: 1, freeform_artifact: 1 });
});

test('budget: cap exhausts in order — later stages denied even if they want web', () => {
  const stages: WebSearchStageRequest[] = [
    { id: 'outliner', kind: 'outliner', wantsWeb: true },
    { id: 'p1', kind: 'prose', wantsWeb: true },
    { id: 'p2', kind: 'prose', wantsWeb: true },
    { id: 'p3', kind: 'prose', wantsWeb: true },
    { id: 'a1', kind: 'freeform_artifact', wantsWeb: true },
  ];
  const a = allocateWebSearchBudget(stages, 3);
  assert.equal(a.used, 3);
  assert.equal(a.granted.has('outliner'), true);
  assert.equal(a.granted.has('p1'), true);
  assert.equal(a.granted.has('p2'), true);
  assert.equal(a.granted.has('p3'), false);
  assert.equal(a.granted.has('a1'), false);
});

test('budget: order matters — outliner first consumes the only slot', () => {
  const stages: WebSearchStageRequest[] = [
    { id: 'outliner', kind: 'outliner', wantsWeb: true },
    { id: 'p1', kind: 'prose', wantsWeb: true },
  ];
  const a = allocateWebSearchBudget(stages, 1);
  assert.equal(a.used, 1);
  assert.equal(a.granted.has('outliner'), true);
  assert.equal(a.granted.has('p1'), false);
  assert.deepEqual(a.byKind, { outliner: 1, prose: 0, freeform_artifact: 0 });
});

test('budget: when more wanters than slots, byKind reflects what got through', () => {
  const stages: WebSearchStageRequest[] = [
    { id: 'p1', kind: 'prose', wantsWeb: true },
    { id: 'p2', kind: 'prose', wantsWeb: true },
    { id: 'a1', kind: 'freeform_artifact', wantsWeb: true },
    { id: 'a2', kind: 'freeform_artifact', wantsWeb: true },
  ];
  const a = allocateWebSearchBudget(stages, 3);
  assert.equal(a.used, 3);
  assert.deepEqual(a.byKind, { outliner: 0, prose: 2, freeform_artifact: 1 });
  assert.equal(a.granted.has('a2'), false);
});

test('budget: negative max is clamped to zero', () => {
  const stages: WebSearchStageRequest[] = [
    { id: 'p1', kind: 'prose', wantsWeb: true },
  ];
  const a = allocateWebSearchBudget(stages, -3);
  assert.equal(a.used, 0);
  assert.equal(a.granted.size, 0);
});
