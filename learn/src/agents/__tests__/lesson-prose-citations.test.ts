import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test as prose } from '../lesson-prose.js';

const { parseCitationsBlock, stripCitationsBlock } = prose;

test('parseCitationsBlock: returns [] when no [CITATIONS] marker present', () => {
  const raw = '{"markdown":"hello"}';
  assert.deepEqual(parseCitationsBlock(raw), []);
});

test('parseCitationsBlock: extracts a single citation entry', () => {
  const raw = `{"markdown":"hi"}\n\n[CITATIONS]\n{"citations":[{"url":"https://example.com/a","title":"A doc"}]}`;
  const cites = parseCitationsBlock(raw);
  assert.equal(cites.length, 1);
  assert.equal(cites[0]!.url, 'https://example.com/a');
  assert.equal(cites[0]!.title, 'A doc');
});

test('parseCitationsBlock: deduplicates entries by URL', () => {
  const raw = `[CITATIONS]\n{"citations":[
    {"url":"https://example.com/a","title":"A"},
    {"url":"https://example.com/a","title":"A again"},
    {"url":"https://example.com/b","title":"B"}
  ]}`;
  const cites = parseCitationsBlock(raw);
  assert.equal(cites.length, 2);
  assert.equal(cites[0]!.url, 'https://example.com/a');
  assert.equal(cites[1]!.url, 'https://example.com/b');
});

test('parseCitationsBlock: rejects non-http URLs', () => {
  const raw = `[CITATIONS]\n{"citations":[{"url":"javascript:alert(1)"}]}`;
  assert.deepEqual(parseCitationsBlock(raw), []);
});

test('parseCitationsBlock: malformed JSON yields []', () => {
  const raw = `[CITATIONS]\n{this is not json`;
  assert.deepEqual(parseCitationsBlock(raw), []);
});

test('parseCitationsBlock: tolerates citations after markdown JSON wrapper', () => {
  const raw = `{"markdown":"prose body"}\n[CITATIONS]{"citations":[{"url":"https://x.dev"}]}`;
  const cites = parseCitationsBlock(raw);
  assert.equal(cites.length, 1);
  assert.equal(cites[0]!.url, 'https://x.dev');
  assert.equal(cites[0]!.title, undefined);
});

test('stripCitationsBlock: removes the metadata footer leaving JSON wrapper intact', () => {
  const raw = `{"markdown":"hi"}\n\n[CITATIONS]\n{"citations":[{"url":"https://x.dev"}]}`;
  const stripped = stripCitationsBlock(raw);
  assert.equal(stripped, '{"markdown":"hi"}');
});

test('stripCitationsBlock: passes through unchanged when no marker', () => {
  const raw = '{"markdown":"hi"}';
  assert.equal(stripCitationsBlock(raw), '{"markdown":"hi"}');
});
