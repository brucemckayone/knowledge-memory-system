/**
 * Pure unit tests for gap-persistence helpers (nmemo-7b3).
 *
 * Covers:
 *  - gapIdempotencyKey: same root entity → same key, regardless of whether
 *    the targetConcept name changes.
 *  - gapIdempotencyKey: missing entity id → falls back to a name-based hash
 *    that stays stable across whitespace / case differences.
 *  - renderGapContentMd → projectGap round-trip preserves the structured
 *    fields the dashboard / section card consume.
 *  - isBelowGapColdStart honours the 10-fact threshold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __test, isBelowGapColdStart, GAP_COLD_START_FACT_THRESHOLD,
} from '../services/gap-persistence.js';
import type { GapAnalysisResult } from '../agents/gap-analyzer.js';

const { gapIdempotencyKey, renderGapContentMd, projectGap } = __test;

test('gapIdempotencyKey: same root entity id → same key', () => {
  const a = gapIdempotencyKey('ent-123', 'closures');
  const b = gapIdempotencyKey('ent-123', 'CLOSURES — re-explained');
  assert.equal(a, b);
});

test('gapIdempotencyKey: different root ids → different keys', () => {
  const a = gapIdempotencyKey('ent-123', 'closures');
  const b = gapIdempotencyKey('ent-456', 'closures');
  assert.notEqual(a, b);
});

test('gapIdempotencyKey: null entity id → falls back to normalised name', () => {
  const a = gapIdempotencyKey(null, '  Closures  ');
  const b = gapIdempotencyKey(null, 'closures');
  assert.equal(a, b);
});

test('gapIdempotencyKey: empty-string entity id treated as missing', () => {
  const a = gapIdempotencyKey('', 'closures');
  const b = gapIdempotencyKey(null, 'closures');
  assert.equal(a, b);
});

test('renderGapContentMd → projectGap preserves structured fields', () => {
  const result: GapAnalysisResult = {
    targetConcept: 'closures',
    rootCause: 'You skipped scope chains earlier in the course.',
    whyItMatters: 'Without closures, callback patterns become opaque.',
    lesson: '...',
    followUpQuestions: [],
    nextSteps: 'Read §3 of the closures section.',
  };
  const contentMd = renderGapContentMd(result);

  // Build a minimal `insights` row shape — we only need the fields projectGap reads.
  const row = {
    id: 'i1',
    type: 'gap_analysis',
    title: 'Gap: closures',
    contentMd,
    importance: 0.7,
    relatedEntityIds: JSON.stringify(['ent-123']),
    relatedCourseIds: '[]',
    relatedFactIds: '[]',
    relatedSectionIds: '[]',
    actionableUrl: null,
    idempotencyKey: 'k',
    deterministicImportance: 0.7,
    dismissalKind: null,
    snoozedUntil: null,
    createdAt: '2026-05-01T00:00:00Z',
    dismissedAt: null,
    viewedAt: null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const projected = projectGap(row);
  assert.equal(projected.rootCauseEntityId, 'ent-123');
  assert.equal(projected.rootCauseConceptName, 'closures');
  assert.equal(projected.rootCauseReason, result.rootCause);
  assert.equal(projected.whyItMatters, result.whyItMatters);
});

test('isBelowGapColdStart: threshold honoured', () => {
  assert.equal(isBelowGapColdStart(0), true);
  assert.equal(isBelowGapColdStart(GAP_COLD_START_FACT_THRESHOLD - 1), true);
  assert.equal(isBelowGapColdStart(GAP_COLD_START_FACT_THRESHOLD), false);
  assert.equal(isBelowGapColdStart(GAP_COLD_START_FACT_THRESHOLD + 5), false);
});
