/**
 * embed.ts write-vs-query failure contract (bead nmemo-avd / PC8-1). Proves the
 * write path fails LOUD — it can never hand a caller an empty vector to silently
 * persist as a NULL embedding — while the query path stays lenient.
 *
 * Pure unit: the ML client is mocked, so no DB / no ML service. Every case pins one
 * ml.embed outcome (reject, empty vector, populated vector) and asserts the helper's
 * response to it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked before the module-under-test is imported (vi.mock is hoisted).
const embedMock = vi.fn();
vi.mock('../../services/ml-client.js', () => ({
  ml: { embed: (text: string) => embedMock(text) },
}));

import { embedForWrite, embedForQuery, EmbeddingUnavailableError } from '../../services/embed.js';

const VEC = Array.from({ length: 768 }, (_, i) => (i % 7) / 10);

beforeEach(() => {
  embedMock.mockReset();
});

describe('embedForWrite — fails loud (nmemo-avd)', () => {
  it('returns the vector on success', async () => {
    embedMock.mockResolvedValue({ vector: VEC, model: 'x', dimensions: 768 });
    await expect(embedForWrite('hello')).resolves.toEqual(VEC);
    expect(embedMock).toHaveBeenCalledWith('hello');
  });

  it('THROWS when the ML service errors (never returns [] to be persisted as NULL)', async () => {
    embedMock.mockRejectedValue(new Error('503 Service Unavailable'));
    await expect(embedForWrite('hello')).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it('preserves the underlying failure as the error cause', async () => {
    const boom = new Error('ollama down');
    embedMock.mockRejectedValue(boom);
    await expect(embedForWrite('hello')).rejects.toMatchObject({ cause: boom });
  });

  it('THROWS when the ML service returns an empty vector', async () => {
    embedMock.mockResolvedValue({ vector: [], model: 'x', dimensions: 0 });
    await expect(embedForWrite('hello')).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it('THROWS when the vector field is missing', async () => {
    embedMock.mockResolvedValue({ model: 'x', dimensions: 0 } as unknown as { vector: number[] });
    await expect(embedForWrite('hello')).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });
});

describe('embedForQuery — degrades gracefully', () => {
  it('returns the vector on success', async () => {
    embedMock.mockResolvedValue({ vector: VEC, model: 'x', dimensions: 768 });
    await expect(embedForQuery('q')).resolves.toEqual(VEC);
  });

  it('returns [] when the ML service errors (no throw — caller degrades)', async () => {
    embedMock.mockRejectedValue(new Error('503'));
    await expect(embedForQuery('q')).resolves.toEqual([]);
  });

  it('returns [] when the ML service returns an empty vector', async () => {
    embedMock.mockResolvedValue({ vector: [], model: 'x', dimensions: 0 });
    await expect(embedForQuery('q')).resolves.toEqual([]);
  });
});
