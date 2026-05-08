/**
 * Pure unit tests for gap-analyzer's ROOT_CAUSE: trailer parser (nmemo-eh1).
 *
 * Verifies the parser:
 *  - Extracts entityId + conceptName from a well-formed trailer.
 *  - Tolerates explicit null entityId (cold-start case).
 *  - Returns nulls when the trailer is missing entirely (back-compat with
 *    older agents that only emit prose JSON).
 *  - Returns nulls when the trailer JSON is malformed.
 *  - Picks the LAST occurrence when the marker appears mid-prose followed by
 *    a real trailer at the end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../gap-analyzer.js';

const { parseRootCauseTrailer } = __test;

test('parseRootCauseTrailer: well-formed trailer extracts entityId + conceptName', () => {
  const raw = `{ "targetConcept": "BST traversal", ... }

ROOT_CAUSE: { "entityId": "ent_abc123", "conceptName": "binary search trees" }`;
  const parsed = parseRootCauseTrailer(raw);
  assert.equal(parsed.entityId, 'ent_abc123');
  assert.equal(parsed.conceptName, 'binary search trees');
});

test('parseRootCauseTrailer: explicit null entityId surfaces as null', () => {
  const raw = `ROOT_CAUSE: { "entityId": null, "conceptName": "general review" }`;
  const parsed = parseRootCauseTrailer(raw);
  assert.equal(parsed.entityId, null);
  assert.equal(parsed.conceptName, 'general review');
});

test('parseRootCauseTrailer: missing trailer → both null (back-compat)', () => {
  // Older runs / LLM forgetfulness — must not crash and must let the caller
  // fall back to name-based lookup.
  const raw = `{ "targetConcept": "closures", "rootCause": "..." }`;
  const parsed = parseRootCauseTrailer(raw);
  assert.equal(parsed.entityId, null);
  assert.equal(parsed.conceptName, null);
});

test('parseRootCauseTrailer: malformed JSON in trailer → both null', () => {
  const raw = `ROOT_CAUSE: { entityId: ent_xxx, conceptName: missing-quotes }`;
  const parsed = parseRootCauseTrailer(raw);
  assert.equal(parsed.entityId, null);
  assert.equal(parsed.conceptName, null);
});

test('parseRootCauseTrailer: empty input → both null', () => {
  const parsed = parseRootCauseTrailer('');
  assert.equal(parsed.entityId, null);
  assert.equal(parsed.conceptName, null);
});

test('parseRootCauseTrailer: picks the LAST occurrence when marker appears mid-prose', () => {
  const raw = `Earlier I considered emitting ROOT_CAUSE: { "entityId": "ent_wrong", "conceptName": "wrong" } but reconsidered.

Final trailer:
ROOT_CAUSE: { "entityId": "ent_right", "conceptName": "right concept" }`;
  const parsed = parseRootCauseTrailer(raw);
  assert.equal(parsed.entityId, 'ent_right');
  assert.equal(parsed.conceptName, 'right concept');
});

test('parseRootCauseTrailer: empty-string entityId treated as null', () => {
  // The schema says entityId can be null; an empty string is equivalent.
  const raw = `ROOT_CAUSE: { "entityId": "", "conceptName": "vague" }`;
  const parsed = parseRootCauseTrailer(raw);
  assert.equal(parsed.entityId, null);
  assert.equal(parsed.conceptName, 'vague');
});
