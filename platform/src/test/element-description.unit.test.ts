/**
 * Unit tests for the code-element description authoring convention (bead
 * nmemo-uhp.17.1, doc 13). composeFacetedDescription is PURE (no DB/ML/config), so
 * this suite is fast + deterministic. It pins the load-bearing invariants: the
 * canonical byte-shape matches the doc-11/12 bake-off `facets` formula that was
 * actually measured, the label order is fixed, blank facets are skipped (no empty-
 * label noise), and an all-blank facet set degrades to '' (name-only embedding via
 * entityEmbedTextFor) rather than throwing.
 */

import { describe, it, expect } from 'vitest';
import {
  composeFacetedDescription,
  FACET_LABELS,
  type ElementFacets,
} from '../services/element-description.js';
import { entityEmbedTextFor } from '../services/embed-text.js';

describe('composeFacetedDescription', () => {
  it('renders the full facet set in the canonical bake-off byte-shape', () => {
    const facets: ElementFacets = {
      operation: 'reinterprets a sockaddr_in pointer as a generic sockaddr pointer',
      dataTypes: 'sockaddr_in*, sockaddr*, std::string address, uint16_t port',
      memoryPointers: 'reinterpret_cast type-puns between the two socket-address structs',
      ownershipLifetime: 'the returned pointer aliases the caller-owned addr object',
      sideEffects: 'none in the cast helper (noexcept)',
      errorHandling: 'none; the helper is noexcept',
      concepts: ['reinterpret_cast', 'sockaddr aliasing', 'noexcept'],
    };
    expect(composeFacetedDescription(facets)).toBe(
      'operation: reinterprets a sockaddr_in pointer as a generic sockaddr pointer; ' +
        'data/types: sockaddr_in*, sockaddr*, std::string address, uint16_t port; ' +
        'memory/pointers: reinterpret_cast type-puns between the two socket-address structs; ' +
        'ownership/lifetime: the returned pointer aliases the caller-owned addr object; ' +
        'side-effects: none in the cast helper (noexcept); ' +
        'error-handling: none; the helper is noexcept; ' +
        'concepts: reinterpret_cast, sockaddr aliasing, noexcept',
    );
  });

  it('exposes a fixed, canonical facet order that the renderer honours', () => {
    expect(FACET_LABELS.map(([, label]) => label)).toEqual([
      'operation',
      'data/types',
      'memory/pointers',
      'ownership/lifetime',
      'side-effects',
      'error-handling',
    ]);
    // Render order follows FACET_LABELS regardless of object key insertion order.
    const scrambled: ElementFacets = {
      errorHandling: 'checks errc',
      operation: 'parses a number',
      memoryPointers: 'no allocation',
    };
    expect(composeFacetedDescription(scrambled)).toBe(
      'operation: parses a number; memory/pointers: no allocation; error-handling: checks errc',
    );
  });

  it('skips blank/absent facets (no empty-label noise) — a pure getter has few facets', () => {
    const getter: ElementFacets = {
      operation: 'returns the stored port',
      dataTypes: '  ',
      memoryPointers: '',
      concepts: [],
    };
    expect(composeFacetedDescription(getter)).toBe('operation: returns the stored port');
  });

  it('trims, blank-filters, and case-insensitively de-dupes the concepts tail', () => {
    const facets: ElementFacets = {
      operation: 'copies a buffer',
      concepts: [' RAII ', 'raii', 'memcpy', '', '  ', 'MEMCPY', 'bounds check'],
    };
    expect(composeFacetedDescription(facets)).toBe(
      'operation: copies a buffer; concepts: RAII, memcpy, bounds check',
    );
  });

  it('returns "" when no facet carries content (safe degradation to name-only embed)', () => {
    const empty: ElementFacets = { operation: '   ', concepts: ['', '  '] };
    const description = composeFacetedDescription(empty);
    expect(description).toBe('');
    // A blank description means entityEmbedTextFor falls back to the bare name —
    // i.e. pre-.14 single-corpus behaviour, never an error.
    expect(entityEmbedTextFor('TcpClient::port', description, 'name_description')).toBe(
      'TcpClient::port',
    );
  });

  it('composes end-to-end with entityEmbedTextFor for the stored embed text', () => {
    const facets: ElementFacets = {
      operation: 'parses an entire text buffer into an arithmetic value',
      dataTypes: 'std::string_view, std::from_chars_result, out-parameter value',
      concepts: ['std::from_chars', 'full-input consumption'],
    };
    const description = composeFacetedDescription(facets);
    expect(entityEmbedTextFor('parseNumber', description, 'name_description')).toBe(
      `parseNumber\n${description}`,
    );
  });
});
