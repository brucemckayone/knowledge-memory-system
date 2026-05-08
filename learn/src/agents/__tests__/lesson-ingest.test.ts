import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectCitationUrls,
  ingestLessonSources,
  type LessonBlock,
} from '../lesson-generator.js';
import { __test as gen } from '../lesson-generator.js';

const policy = {
  enabled: true,
  outliner: true,
  prose: true,
  artifact: true,
  maxIngestUrls: 10,
};

// ── collectCitationUrls ────────────────────────────────────────────────────

test('collectCitationUrls: returns [] when no blocks have citations', () => {
  const blocks: LessonBlock[] = [
    { type: 'markdown', content: 'hello' },
    { type: 'component', kind: 'Mermaid', props: {} },
  ];
  assert.deepEqual(collectCitationUrls(blocks), []);
});

test('collectCitationUrls: deduplicates URLs across blocks, preserving order', () => {
  const blocks: LessonBlock[] = [
    { type: 'markdown', content: 'a', citations: [{ url: 'https://x/a' }, { url: 'https://x/b' }] },
    { type: 'markdown', content: 'b', citations: [{ url: 'https://x/a' }, { url: 'https://x/c' }] },
  ];
  assert.deepEqual(collectCitationUrls(blocks), ['https://x/a', 'https://x/b', 'https://x/c']);
});

test('collectCitationUrls: skips empty / malformed entries', () => {
  const blocks: LessonBlock[] = [
    { type: 'markdown', content: 'a', citations: [{ url: '' }, { url: '   ' }] },
    { type: 'markdown', content: 'b', citations: [{ url: 'https://x/ok' }] },
  ];
  assert.deepEqual(collectCitationUrls(blocks), ['https://x/ok']);
});

// ── ingestLessonSources ────────────────────────────────────────────────────

test('ingestLessonSources: calls ingest exactly once per unique URL', async () => {
  const ingestCalls: Array<{ text: string; source: string }> = [];
  const blocks: LessonBlock[] = [
    { type: 'markdown', content: 'a', citations: [{ url: 'https://x/a' }, { url: 'https://x/b' }] },
    { type: 'markdown', content: 'b', citations: [{ url: 'https://x/a' }] },
  ];
  const r = await ingestLessonSources('section-1', blocks, policy, {
    fetchUrl: async (u) => `<doc for ${u}>`,
    ingest: async (text, source) => {
      ingestCalls.push({ text, source });
      return { memoryId: `mem-${ingestCalls.length}` };
    },
  });
  assert.equal(ingestCalls.length, 2, 'ingest called once per unique URL');
  assert.deepEqual(r.ingested, ['https://x/a', 'https://x/b']);
  assert.equal(r.failed.length, 0);
});

test('ingestLessonSources: source string follows learn:lesson:<sectionId>:websearch:<hash> convention', async () => {
  const ingestCalls: Array<{ text: string; source: string }> = [];
  const blocks: LessonBlock[] = [
    { type: 'markdown', content: 'a', citations: [{ url: 'https://x/a' }] },
  ];
  await ingestLessonSources('sec-42', blocks, policy, {
    fetchUrl: async () => 'doc text',
    ingest: async (text, source) => {
      ingestCalls.push({ text, source });
      return { memoryId: 'mem' };
    },
  });
  assert.equal(ingestCalls.length, 1);
  const src = ingestCalls[0]!.source;
  assert.match(src, /^learn:lesson:sec-42:websearch:[a-f0-9]{12}$/);
});

test('ingestLessonSources: ingest failure does not block — logs and continues', async () => {
  const blocks: LessonBlock[] = [
    { type: 'markdown', content: 'a', citations: [{ url: 'https://x/a' }, { url: 'https://x/b' }] },
  ];
  const aHash = gen.shortUrlHash('https://x/a');
  const r = await ingestLessonSources('section-1', blocks, policy, {
    fetchUrl: async (u) => `doc for ${u}`,
    ingest: async (_text, source) => {
      // Fail the first URL by matching its short hash in the source string;
      // succeed on the second.
      if (source.includes(aHash)) throw new Error('synthetic 500');
      return { memoryId: 'mem-ok' };
    },
  });
  assert.equal(r.ingested.length, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0]!.url, 'https://x/a');
});

test('ingestLessonSources: fetch failure on a URL skips ingest for that URL', async () => {
  const blocks: LessonBlock[] = [
    { type: 'markdown', content: 'a', citations: [{ url: 'https://x/a' }, { url: 'https://x/b' }] },
  ];
  const ingested: string[] = [];
  const r = await ingestLessonSources('section-1', blocks, policy, {
    fetchUrl: async (u) => {
      if (u === 'https://x/a') throw new Error('connection refused');
      return `doc for ${u}`;
    },
    ingest: async (_text, source) => {
      ingested.push(source);
      return { memoryId: 'mem' };
    },
  });
  assert.equal(ingested.length, 1, 'only the successful URL was ingested');
  assert.equal(r.ingested.length, 1);
  assert.equal(r.failed.length, 1);
});

test('ingestLessonSources: caps at policy.maxIngestUrls', async () => {
  const ingested: string[] = [];
  const blocks: LessonBlock[] = [
    { type: 'markdown', content: 'a', citations: [
      { url: 'https://x/a' },
      { url: 'https://x/b' },
      { url: 'https://x/c' },
      { url: 'https://x/d' },
    ] },
  ];
  await ingestLessonSources('section-1', blocks, { ...policy, maxIngestUrls: 2 }, {
    fetchUrl: async () => 'doc',
    ingest: async (_text, source) => {
      ingested.push(source);
      return { memoryId: 'mem' };
    },
  });
  assert.equal(ingested.length, 2, 'only first 2 unique URLs ingested when cap is 2');
});

test('ingestLessonSources: zero-citation lesson is a no-op', async () => {
  let called = false;
  const blocks: LessonBlock[] = [{ type: 'markdown', content: 'plain' }];
  const r = await ingestLessonSources('section-1', blocks, policy, {
    fetchUrl: async () => { called = true; return ''; },
    ingest: async () => { called = true; return { memoryId: 'm' }; },
  });
  assert.equal(called, false);
  assert.deepEqual(r.ingested, []);
});
