/**
 * nmemo-1cp — nomic-embed task prefixes (search_query / search_document)
 *
 * nomic-embed-text is asymmetric: stored memory passages must embed behind the
 * `search_document: ` prefix and memories queries behind `search_query: `. A
 * verify side-test (yxj.1) showed adopting these lifts recall@1 0.38 -> 0.75, so
 * this bead adopts them PLATFORM-SIDE (prepend before /embed; no ml-services
 * change).
 *
 * Scope: MEMORIES retrieval only —
 *   - store()'s window + unit embeds  -> search_document:
 *   - search_memories query embed     -> search_query:
 * Entity-name and fact embeds are a SYMMETRIC similarity and stay on ml.embed()
 * raw (no prefix). These tests assert exactly that scope.
 *
 * Fully isolated: ml.embed is spied (no real Ollama), and the Qdrant write/read
 * functions are mocked (no real Qdrant). No production data, no restart.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ml,
  SEARCH_DOCUMENT_PREFIX,
  SEARCH_QUERY_PREFIX,
} from '../../services/ml-client.js';
import * as qdrant from '../../services/qdrant.js';
import { store } from '../../pipeline.js';
import { handleToolCall } from '../../services/causal-agent.js';

const FAKE_VECTOR = Array.from({ length: 768 }, () => 0);

function spyEmbed() {
  // Spy on the underlying embed method. embedDocument/embedQuery delegate to it
  // with the prefix already prepended, so every recorded arg shows exactly the
  // text that would hit /embed — no real network call.
  return vi.spyOn(ml, 'embed').mockResolvedValue({
    vector: FAKE_VECTOR,
    model: 'nomic-embed-text',
    dimensions: 768,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('nmemo-1cp: ml client prefix helpers', () => {
  it('exposes the canonical nomic task prefixes', () => {
    expect(SEARCH_DOCUMENT_PREFIX).toBe('search_document: ');
    expect(SEARCH_QUERY_PREFIX).toBe('search_query: ');
  });

  it('embedDocument prepends search_document:', async () => {
    const embed = spyEmbed();
    await ml.embedDocument('the user graduated with a marine biology degree');
    expect(embed).toHaveBeenCalledWith(
      'search_document: the user graduated with a marine biology degree',
      expect.any(String),
    );
  });

  it('embedQuery prepends search_query:', async () => {
    const embed = spyEmbed();
    await ml.embedQuery('what degree did the user earn');
    expect(embed).toHaveBeenCalledWith(
      'search_query: what degree did the user earn',
      expect.any(String),
    );
  });

  it('embed (raw) does NOT prepend any task prefix — entity/fact embeds use this', async () => {
    const embed = spyEmbed();
    // entities.ts and facts.ts generateEmbedding call ml.embed(text) directly;
    // this is the scope guard that those embeds stay unprefixed.
    await ml.embed('Marie Curie');
    const [[arg]] = embed.mock.calls;
    expect(arg).toBe('Marie Curie');
    expect(arg).not.toContain(SEARCH_DOCUMENT_PREFIX);
    expect(arg).not.toContain(SEARCH_QUERY_PREFIX);
  });

  it('no double-prefixing: embedDocument output is a single prefix', async () => {
    const embed = spyEmbed();
    await ml.embedDocument('hello');
    const [[arg]] = embed.mock.calls;
    expect(arg.startsWith(SEARCH_DOCUMENT_PREFIX)).toBe(true);
    expect(arg.indexOf(SEARCH_DOCUMENT_PREFIX)).toBe(
      arg.lastIndexOf(SEARCH_DOCUMENT_PREFIX),
    );
    expect(arg).not.toContain(SEARCH_QUERY_PREFIX);
  });
});

describe('nmemo-1cp: store() path embeds documents with search_document:', () => {
  it('prefixes BOTH the window and every unit embed with search_document:', async () => {
    const embed = spyEmbed();
    const upsert = vi
      .spyOn(qdrant, 'storeMemoryWithUnits')
      .mockResolvedValue(undefined);

    // Long enough to split into multiple units so we exercise the unit path too.
    const text =
      'I graduated from university with a degree in marine biology. ' +
      'My favourite ocean animal is the octopus. ' +
      'Later I moved to the coast to study coral reefs full time.';

    await store(text, { source: 'test' });

    expect(upsert).toHaveBeenCalledTimes(1);
    // Every text that reached the embed boundary during store() must carry the
    // document prefix — window AND units. None may carry the query prefix.
    expect(embed.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [arg] of embed.mock.calls) {
      expect(arg.startsWith(SEARCH_DOCUMENT_PREFIX)).toBe(true);
      expect(arg).not.toContain(SEARCH_QUERY_PREFIX);
    }
    // The window embed is the raw text behind the document prefix.
    expect(embed).toHaveBeenCalledWith(
      SEARCH_DOCUMENT_PREFIX + text,
      expect.any(String),
    );
  });
});

describe('nmemo-1cp: search_memories query embeds with search_query:', () => {
  it('prefixes the memories query embed with search_query:', async () => {
    const embed = spyEmbed();
    // Mock the read path so the handler never touches Qdrant.
    vi.spyOn(qdrant, 'searchMemoriesByUnit').mockResolvedValue([]);

    await handleToolCall('search_memories', { query: 'where did I study', limit: 5 });

    expect(embed).toHaveBeenCalledWith(
      'search_query: where did I study',
      expect.any(String),
    );
    const [[arg]] = embed.mock.calls;
    expect(arg).not.toContain(SEARCH_DOCUMENT_PREFIX);
  });

  it('scope guard: search_similar_entities (entity search) is NOT prefixed', async () => {
    const embed = spyEmbed();
    // findSimilarEntities hits pgvector; we only care that the embed arg is raw.
    // Mock searchMemoriesByUnit defensively (unused on this branch).
    vi.spyOn(qdrant, 'searchMemoriesByUnit').mockResolvedValue([]);

    // findSimilarEntities will run against the (isolated) test DB; the embed
    // assertion fires before any DB result matters. If the DB call throws we
    // still captured the embed arg, so guard the await.
    await handleToolCall('search_similar_entities', { query: 'Marie Curie' }).catch(
      () => undefined,
    );

    const [[arg]] = embed.mock.calls;
    expect(arg).toBe('Marie Curie');
    expect(arg).not.toContain(SEARCH_DOCUMENT_PREFIX);
    expect(arg).not.toContain(SEARCH_QUERY_PREFIX);
  });
});
