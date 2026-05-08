/**
 * Pure unit tests for patrol-agent parseReport (nmemo-15o).
 * Verifies the SUMMARY:/WROTE: trailer parser handles malformed agent output
 * gracefully — missing trailer, missing types list, mixed dash variants.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../patrol-agent.js';

const { parseReport } = __test;

test('parseReport: well-formed trailer extracts summary, count, types', () => {
  const raw = `Some agent prose about what it scanned.

SUMMARY: Decay surfaced one warning; cross-course found a same_as overlap.
WROTE: 2 insights — types: decay_warning, cross_course_link
`;
  const parsed = parseReport(raw);
  assert.equal(parsed.wroteCount, 2);
  assert.deepEqual(parsed.types, ['decay_warning', 'cross_course_link']);
  assert.ok(parsed.summary.includes('Decay surfaced'));
});

test('parseReport: zero-insight outcome with "none" types', () => {
  const raw = `Looked at everything; nothing pedagogically valuable.

SUMMARY: All five passes ran clean; nothing worth surfacing today.
WROTE: 0 insights — types: none
`;
  const parsed = parseReport(raw);
  assert.equal(parsed.wroteCount, 0);
  assert.deepEqual(parsed.types, []);
  assert.ok(parsed.summary.includes('All five passes'));
});

test('parseReport: missing trailer falls back to tail-of-text summary', () => {
  // No SUMMARY: / WROTE: lines at all — the parser must not crash and must
  // produce a non-empty summary so the patrol_runs row has something to log.
  const raw = `The agent forgot the trailer. It just stopped talking after listing observations:
- decay candidate: hashing
- decay candidate: closures
- did not call write_insight (cap reached upstream)`;
  const parsed = parseReport(raw);
  assert.equal(parsed.wroteCount, 0);
  assert.deepEqual(parsed.types, []);
  assert.ok(parsed.summary.length > 0, 'summary must be non-empty even without a trailer');
});

test('parseReport: tolerates ASCII hyphen instead of em dash', () => {
  const raw = `SUMMARY: minimal.
WROTE: 1 insights - types: synthesis_candidate
`;
  const parsed = parseReport(raw);
  assert.equal(parsed.wroteCount, 1);
  assert.deepEqual(parsed.types, ['synthesis_candidate']);
});

test('parseReport: handles trailing whitespace around types', () => {
  const raw = `SUMMARY: ok
WROTE: 3 insights — types:   decay_warning ,  cross_course_link , pattern_emerging
`;
  const parsed = parseReport(raw);
  assert.equal(parsed.wroteCount, 3);
  assert.deepEqual(parsed.types, ['decay_warning', 'cross_course_link', 'pattern_emerging']);
});
