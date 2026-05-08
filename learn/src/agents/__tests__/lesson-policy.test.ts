import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test as gen } from '../lesson-generator.js';

const ENV_KEYS = [
  'LEARN_LESSON_WEBSEARCH',
  'LEARN_OUTLINER_WEBSEARCH',
  'LEARN_PROSE_WEBSEARCH',
  'LEARN_ARTIFACT_WEBSEARCH',
  'LEARN_LESSON_WEBSEARCH_MAX_INGEST_URLS',
  'LEARN_LESSON_WEBSEARCH_MAX',
];

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const prior: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prior[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Clear any keys not specified in overrides too — we want a clean baseline.
    for (const k of ENV_KEYS) {
      if (!(k in overrides)) delete process.env[k];
    }
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

test('policy default: all stages enabled, ingest cap 3, maxStages 5', () => {
  const p = withEnv({}, () => gen.loadWebSearchPolicy());
  assert.equal(p.enabled, true);
  assert.equal(p.outliner, true);
  assert.equal(p.prose, true);
  assert.equal(p.artifact, true);
  assert.equal(p.maxIngestUrls, 3);
  assert.equal(p.maxStages, 5);
});

test('policy: LEARN_LESSON_WEBSEARCH_MAX overrides default cap', () => {
  const p = withEnv({ LEARN_LESSON_WEBSEARCH_MAX: '2' }, () => gen.loadWebSearchPolicy());
  assert.equal(p.maxStages, 2);
});

test('policy: LEARN_LESSON_WEBSEARCH=0 disables every stage', () => {
  const p = withEnv({ LEARN_LESSON_WEBSEARCH: '0' }, () => gen.loadWebSearchPolicy());
  assert.equal(p.enabled, false);
  assert.equal(p.outliner, false);
  assert.equal(p.prose, false);
  assert.equal(p.artifact, false);
});

test('policy: LEARN_PROSE_WEBSEARCH=0 leaves outliner/artifact enabled', () => {
  const p = withEnv({ LEARN_PROSE_WEBSEARCH: '0' }, () => gen.loadWebSearchPolicy());
  assert.equal(p.enabled, true);
  assert.equal(p.outliner, true);
  assert.equal(p.prose, false);
  assert.equal(p.artifact, true);
});

test('policy: maxIngestUrls overridable via env', () => {
  const p = withEnv({ LEARN_LESSON_WEBSEARCH_MAX_INGEST_URLS: '7' }, () => gen.loadWebSearchPolicy());
  assert.equal(p.maxIngestUrls, 7);
});

test('policy: invalid maxIngestUrls falls back to default', () => {
  const p = withEnv({ LEARN_LESSON_WEBSEARCH_MAX_INGEST_URLS: 'not-a-number' }, () => gen.loadWebSearchPolicy());
  assert.equal(p.maxIngestUrls, 3);
});
