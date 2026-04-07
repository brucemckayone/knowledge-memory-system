/**
 * B09: Causal edge quality assertions
 *
 * Verifies that EVERY causal edge in the system meets quality standards:
 * - Non-empty reasoning
 * - Non-empty source_references array
 * - Each source_reference has type, id, and relevance
 */

import { describe, it, expect } from 'vitest';
import { testDb } from '../setup.js';

describe('B09: Causal edge quality', () => {
  it('no causal edge has NULL or empty reasoning', async () => {
    const bad = await testDb`
      SELECT id, reasoning FROM causal_edges
      WHERE reasoning IS NULL OR reasoning = '' OR LENGTH(TRIM(reasoning)) = 0
    `;
    expect(bad.length).toBe(0);
  });

  it('no causal edge has NULL, empty, or zero-length source_references', async () => {
    const bad = await testDb`
      SELECT id, source_references FROM causal_edges
      WHERE source_references IS NULL
         OR source_references::text = '[]'
         OR source_references::text = 'null'
         OR jsonb_array_length(source_references) = 0
    `;
    expect(bad.length).toBe(0);
  });

  it('every source_reference has non-empty type, id, and relevance', async () => {
    // Expand each edge's source_references array and check fields
    const bad = await testDb`
      SELECT e.id AS edge_id, ref.value
      FROM causal_edges e,
           jsonb_array_elements(e.source_references) AS ref(value)
      WHERE ref.value->>'type' IS NULL
         OR ref.value->>'type' = ''
         OR ref.value->>'id' IS NULL
         OR ref.value->>'id' = ''
         OR ref.value->>'relevance' IS NULL
         OR ref.value->>'relevance' = ''
    `;
    if (bad.length > 0) {
      console.log('Bad source_references:', bad.map(b => ({ edge: b.edge_id, ref: b.value })));
    }
    expect(bad.length).toBe(0);
  });
});
