/**
 * Pure unit tests for insight-lifecycle helpers (nmemo-fv9).
 * No DB, no network — runs under `node --import tsx --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hybridImportance, isExpired, isCurrentlySnoozed, isVisible,
  ttlForType, INSIGHT_TTL_DAYS, clamp,
} from '../services/insight-lifecycle.js';

const day = 24 * 60 * 60 * 1000;

function isoMinusDays(now: Date, days: number): string {
  return new Date(now.getTime() - days * day).toISOString();
}
function isoPlusDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * day).toISOString();
}

test('clamp basic', () => {
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(clamp(-0.1, 0, 1), 0);
  assert.equal(clamp(1.5, 0, 1), 1);
  assert.equal(clamp(NaN, 0, 1), 0);
});

test('hybridImportance: clamps deterministic and multiplier; final clamped to [0,1]', () => {
  // det 0.57 * judged 1.2 = 0.684
  assert.ok(Math.abs(hybridImportance(0.57, 1.2) - 0.684) < 1e-9);
  // det 0.9 * judged 1.5 = 1.35 → clamp to 1.0
  assert.equal(hybridImportance(0.9, 1.5), 1.0);
  // judged 2.5 clamped to 1.5; det 0.4 * 1.5 = 0.6
  assert.ok(Math.abs(hybridImportance(0.4, 2.5) - 0.6) < 1e-9);
  // judged 0.1 clamped to 0.5; det 0.4 * 0.5 = 0.2
  assert.ok(Math.abs(hybridImportance(0.4, 0.1) - 0.2) < 1e-9);
  // det -0.5 → 0
  assert.equal(hybridImportance(-0.5, 1.0), 0);
  // det 1.5 → 1
  assert.equal(hybridImportance(1.5, 1.0), 1);
});

test('hybridImportance default multiplier = 1.0', () => {
  assert.equal(hybridImportance(0.5), 0.5);
});

test('ttlForType: known + unknown', () => {
  assert.equal(ttlForType('decay_warning'), 14);
  assert.equal(ttlForType('cross_course_link'), 21);
  assert.equal(ttlForType('synthesis_candidate'), 21);
  assert.equal(ttlForType('prerequisite_gap'), 14);
  assert.equal(ttlForType('contradiction_detected'), 14);
  assert.equal(ttlForType('pattern_emerging'), 21);
  assert.equal(ttlForType('totally_unknown_type'), 14); // default
});

test('isExpired: per-type TTL', () => {
  const now = new Date('2026-05-08T00:00:00Z');
  // decay_warning created 13d ago → not expired (TTL 14)
  assert.equal(isExpired({
    type: 'decay_warning',
    createdAt: isoMinusDays(now, 13),
    dismissalKind: null, snoozedUntil: null,
  }, now), false);
  // decay_warning created 15d ago → expired
  assert.equal(isExpired({
    type: 'decay_warning',
    createdAt: isoMinusDays(now, 15),
    dismissalKind: null, snoozedUntil: null,
  }, now), true);
  // cross_course_link created 20d ago → not expired (TTL 21)
  assert.equal(isExpired({
    type: 'cross_course_link',
    createdAt: isoMinusDays(now, 20),
    dismissalKind: null, snoozedUntil: null,
  }, now), false);
  // synthesis_candidate created 22d ago → expired
  assert.equal(isExpired({
    type: 'synthesis_candidate',
    createdAt: isoMinusDays(now, 22),
    dismissalKind: null, snoozedUntil: null,
  }, now), true);
});

test('isCurrentlySnoozed', () => {
  const now = new Date('2026-05-08T00:00:00Z');
  // snoozed, until in future → currently snoozed
  assert.equal(isCurrentlySnoozed({
    type: 'decay_warning',
    createdAt: isoMinusDays(now, 1),
    dismissalKind: 'snoozed',
    snoozedUntil: isoPlusDays(now, 5),
  }, now), true);
  // snoozed, until in past → not currently snoozed
  assert.equal(isCurrentlySnoozed({
    type: 'decay_warning',
    createdAt: isoMinusDays(now, 10),
    dismissalKind: 'snoozed',
    snoozedUntil: isoMinusDays(now, 1),
  }, now), false);
  // not snoozed at all
  assert.equal(isCurrentlySnoozed({
    type: 'decay_warning',
    createdAt: isoMinusDays(now, 1),
    dismissalKind: null,
    snoozedUntil: null,
  }, now), false);
});

test('isVisible composite', () => {
  const now = new Date('2026-05-08T00:00:00Z');
  // Active, fresh → visible
  assert.equal(isVisible({
    type: 'decay_warning',
    createdAt: isoMinusDays(now, 1),
    dismissalKind: null, snoozedUntil: null,
  }, now), true);
  // Dismissed forever → not visible
  assert.equal(isVisible({
    type: 'decay_warning',
    createdAt: isoMinusDays(now, 1),
    dismissalKind: 'dismissed', snoozedUntil: null,
  }, now), false);
  // Snoozed and still snoozed → not visible
  assert.equal(isVisible({
    type: 'decay_warning',
    createdAt: isoMinusDays(now, 1),
    dismissalKind: 'snoozed', snoozedUntil: isoPlusDays(now, 5),
  }, now), false);
  // Past TTL → not visible
  assert.equal(isVisible({
    type: 'decay_warning',
    createdAt: isoMinusDays(now, 20),
    dismissalKind: null, snoozedUntil: null,
  }, now), false);
  // auto_expired → not visible
  assert.equal(isVisible({
    type: 'decay_warning',
    createdAt: isoMinusDays(now, 1),
    dismissalKind: 'auto_expired', snoozedUntil: null,
  }, now), false);
});

test('per-type TTL: cross_course_link survives 20d, decay_warning does not', () => {
  const now = new Date('2026-05-08T00:00:00Z');
  const created20dAgo = isoMinusDays(now, 20);
  assert.equal(isVisible({
    type: 'cross_course_link',
    createdAt: created20dAgo,
    dismissalKind: null, snoozedUntil: null,
  }, now), true);
  assert.equal(isVisible({
    type: 'decay_warning',
    createdAt: created20dAgo,
    dismissalKind: null, snoozedUntil: null,
  }, now), false);
});

test('TTL constants match design spec', () => {
  assert.equal(INSIGHT_TTL_DAYS.decay_warning, 14);
  assert.equal(INSIGHT_TTL_DAYS.cross_course_link, 21);
  assert.equal(INSIGHT_TTL_DAYS.synthesis_candidate, 21);
  assert.equal(INSIGHT_TTL_DAYS.prerequisite_gap, 14);
  assert.equal(INSIGHT_TTL_DAYS.contradiction_detected, 14);
  assert.equal(INSIGHT_TTL_DAYS.pattern_emerging, 21);
});
