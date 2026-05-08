/**
 * Pure unit tests for chat-tutor parseStructuredBlocks (nmemo-15o).
 * Exercises the happy path, the fallback wrapper, and nmemoUpdates extraction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../chat-tutor.js';

const { parseStructuredBlocks, fallbackBlocks, validateNmemoUpdate, extractNmemoUpdates } = __test;

test('parseStructuredBlocks: happy path with markdown blocks', () => {
  const raw = JSON.stringify({
    blocks: [
      { type: 'markdown', content: 'Hello, learner.' },
      { type: 'markdown', content: 'Second paragraph.' },
    ],
    nmemoUpdates: [],
  });
  const parsed = parseStructuredBlocks(raw);
  assert.ok(parsed, 'should parse');
  assert.equal(parsed!.blocks.length, 2);
  assert.equal(parsed!.blocks[0]!.type, 'markdown');
  assert.equal(parsed!.nmemoUpdates.length, 0);
});

test('parseStructuredBlocks: returns null on non-JSON garbage (fallback path)', () => {
  const parsed = parseStructuredBlocks('Just plain text, not JSON.');
  assert.equal(parsed, null);
});

test('parseStructuredBlocks: returns null when blocks is missing', () => {
  const parsed = parseStructuredBlocks(JSON.stringify({ nmemoUpdates: [] }));
  assert.equal(parsed, null);
});

test('parseStructuredBlocks: extracts and validates nmemoUpdates', () => {
  const raw = JSON.stringify({
    blocks: [{ type: 'markdown', content: 'ok' }],
    nmemoUpdates: [
      { tool: 'record_understanding', concept: 'closures', confidence: 0.8 },
      { tool: 'get_entity_by_name', concept: 'should be dropped (read tool)' },
      { /* no tool field — should be dropped */ concept: 'orphan' },
    ],
  });
  const parsed = parseStructuredBlocks(raw);
  assert.ok(parsed);
  assert.equal(parsed!.nmemoUpdates.length, 1, 'only valid write tool entries survive');
  assert.equal(parsed!.nmemoUpdates[0]!.tool, 'record_understanding');
  assert.equal(parsed!.nmemoUpdates[0]!.confidence, 0.8);
});

test('fallbackBlocks: wraps raw text as a single markdown block', () => {
  const blocks = fallbackBlocks('Plain answer with no JSON.');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, 'markdown');
  if (blocks[0]!.type === 'markdown') {
    assert.equal(blocks[0]!.content, 'Plain answer with no JSON.');
  }
});

test('fallbackBlocks: strips surrounding code-fence so braces do not leak', () => {
  const blocks = fallbackBlocks('```json\n{"oops": true}\n```');
  assert.equal(blocks.length, 1);
  if (blocks[0]!.type === 'markdown') {
    assert.equal(blocks[0]!.content.includes('```'), false, 'fences stripped');
  }
});

test('fallbackBlocks: empty input becomes a placeholder block', () => {
  const blocks = fallbackBlocks('   ');
  assert.equal(blocks.length, 1);
  if (blocks[0]!.type === 'markdown') {
    assert.equal(blocks[0]!.content, '(empty response)');
  }
});

test('validateNmemoUpdate: drops non-write tools and missing tool', () => {
  assert.equal(validateNmemoUpdate({ tool: 'get_entity_by_name' }), null);
  assert.equal(validateNmemoUpdate({ concept: 'no tool' }), null);
  assert.equal(validateNmemoUpdate(null), null);
});

test('extractNmemoUpdates: returns [] when nmemoUpdates is missing or wrong type', () => {
  assert.deepEqual(extractNmemoUpdates({}), []);
  assert.deepEqual(extractNmemoUpdates({ nmemoUpdates: 'not an array' }), []);
});
