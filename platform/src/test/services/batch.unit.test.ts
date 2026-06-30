/**
 * Unit tests for batch chunk-ordering (doc 38 S1). Pure — no DB / infra.
 */

import { describe, it, expect } from 'vitest';
import { prepareBatch } from '../../services/batch.js';

describe('prepareBatch', () => {
  it('assigns chunk_index 0..N-1 in array order', () => {
    const items = prepareBatch(['a', 'b', 'c'], { sourceId: 's1' });
    expect(items.map((i) => i.chunkIndex)).toEqual([0, 1, 2]);
    expect(items.map((i) => i.text)).toEqual(['a', 'b', 'c']);
  });

  it('shares one sourceId across all items', () => {
    const items = prepareBatch(['a', 'b'], { sourceId: 'src-xyz' });
    expect(items.every((i) => i.sourceId === 'src-xyz')).toBe(true);
  });

  it('passes through source and contentType', () => {
    const items = prepareBatch(['a'], { sourceId: 's1', source: 'doc.txt', contentType: 'code-ts' });
    expect(items[0]).toMatchObject({ source: 'doc.txt', contentType: 'code-ts', chunkIndex: 0 });
  });

  it('returns an empty list for no chunks', () => {
    expect(prepareBatch([], { sourceId: 's1' })).toEqual([]);
  });
});
