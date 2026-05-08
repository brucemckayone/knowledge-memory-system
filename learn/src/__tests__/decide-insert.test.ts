/**
 * Pure unit tests for decideInsert (write_insight idempotency policy, nmemo-fv9).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideInsert } from '../services/insight-lifecycle.js';

const day = 24 * 60 * 60 * 1000;
const now = new Date('2026-05-08T00:00:00Z');

function dt(offsetDays: number): string {
  return new Date(now.getTime() + offsetDays * day).toISOString();
}

test('no existing row → insert', () => {
  assert.equal(decideInsert(null, now), 'insert');
  assert.equal(decideInsert(undefined, now), 'insert');
});

test('dismissed forever → block', () => {
  assert.equal(decideInsert({
    type: 'decay_warning',
    createdAt: dt(-2),
    dismissalKind: 'dismissed',
    snoozedUntil: null,
  }, now), 'block_dismissed');
});

test('snoozed and snooze still active → block_snoozed', () => {
  assert.equal(decideInsert({
    type: 'decay_warning',
    createdAt: dt(-1),
    dismissalKind: 'snoozed',
    snoozedUntil: dt(+5),
  }, now), 'block_snoozed');
});

test('snoozed and snooze expired → reinsert_after_snooze', () => {
  assert.equal(decideInsert({
    type: 'decay_warning',
    createdAt: dt(-10),
    dismissalKind: 'snoozed',
    snoozedUntil: dt(-1),
  }, now), 'reinsert_after_snooze');
});

test('auto_expired → reinsert_after_expired', () => {
  assert.equal(decideInsert({
    type: 'decay_warning',
    createdAt: dt(-30),
    dismissalKind: 'auto_expired',
    snoozedUntil: null,
  }, now), 'reinsert_after_expired');
});

test('active fresh row → block_duplicate (classic dedup)', () => {
  assert.equal(decideInsert({
    type: 'decay_warning',
    createdAt: dt(-1),
    dismissalKind: null,
    snoozedUntil: null,
  }, now), 'block_duplicate');
});

test('active row past per-type TTL → reinsert_after_ttl', () => {
  // decay_warning TTL is 14d
  assert.equal(decideInsert({
    type: 'decay_warning',
    createdAt: dt(-15),
    dismissalKind: null,
    snoozedUntil: null,
  }, now), 'reinsert_after_ttl');
});

test('cross_course_link past 22d (TTL=21d) → reinsert_after_ttl', () => {
  assert.equal(decideInsert({
    type: 'cross_course_link',
    createdAt: dt(-22),
    dismissalKind: null,
    snoozedUntil: null,
  }, now), 'reinsert_after_ttl');
});

test('cross_course_link at 20d (within TTL=21d) → block_duplicate', () => {
  assert.equal(decideInsert({
    type: 'cross_course_link',
    createdAt: dt(-20),
    dismissalKind: null,
    snoozedUntil: null,
  }, now), 'block_duplicate');
});
