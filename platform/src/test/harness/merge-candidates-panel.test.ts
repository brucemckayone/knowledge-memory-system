/**
 * Unit tests: unified merge-candidates panel helpers (bead nmemo-2yv.47).
 *
 * The panel (viz/js/panels/merge-candidates.js) subsumes the legacy cross-cluster
 * panel by surfacing every merge_candidates row regardless of candidate_source.
 * The bead's acceptance bullet:
 *
 *   "Test: panel renders rows with both candidate_source values; signal bars
 *    match underlying merge_candidates columns."
 *
 * The truly-correctness-bearing logic lives in merge-candidates-helpers.js:
 *   parseSignals(row)    — reads resolution_reasoning JSON + direct columns
 *   filterBySource(rows) — chip filter implementation
 *   filterUnresolved(...) — status filter implementation
 *
 * The DOM-coupled rendering (renderRow / renderSignalBars) is exercised in the
 * browser; here we verify the parsed signal shape and filters against fixture
 * rows whose JSON shape matches what upsertScoredCandidates writes
 * (merge-scorer.ts:740-805) for both candidate_source values.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — viz module is plain JS, no type declarations.
import { parseSignals, filterBySource, filterUnresolved, SIGNAL_LABELS } from '../../../viz/js/panels/merge-candidates-helpers.js';

// Fixture: a row as returned by getMergeCandidates() — fields mirror the
// public return type at graph-meta.ts. resolutionReasoning is the
// JSON-encoded blob upsertScoredCandidates writes (full SignalSet + score).
function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cand-1',
    entityA: { id: 'a', name: 'Entity A', type: 'person' },
    entityB: { id: 'b', name: 'Entity B', type: 'person' },
    centroidSimilarity: 0.7,
    memoryOverlap: 0.5,
    structuralSimilarity: 0.4,
    combinedScore: 0.6,
    status: 'candidate',
    detectionCount: 1,
    resolution: null,
    candidateSource: 'three_signal_scoring',
    resolutionReasoning: JSON.stringify({
      signals: {
        centroid_similarity:        0.7,
        memory_overlap:             0.5,
        structural_similarity:      0.4,
        cluster_match:              0.8,
        predicate_signature_cosine: 0.3,
        drift_recency_either:       null,
        centrality_match:           0.2,
        articulation_bonus:         0.5,
        component_match:            1.0,
      },
      combined_score: 0.6,
    }),
    ...overrides,
  };
}

describe('merge-candidates panel helpers (nmemo-2yv.47)', () => {
  describe('parseSignals — post-F1a unified shape', () => {
    it('returns all nine signal values from resolution_reasoning.signals', () => {
      const row = makeRow();
      const s = parseSignals(row);
      expect(s.centroid_similarity).toBe(0.7);
      expect(s.memory_overlap).toBe(0.5);
      expect(s.structural_similarity).toBe(0.4);
      expect(s.cluster_match).toBe(0.8);
      expect(s.predicate_signature_cosine).toBe(0.3);
      expect(s.drift_recency_either).toBeNull();
      expect(s.centrality_match).toBe(0.2);
      expect(s.articulation_bonus).toBe(0.5);
      expect(s.component_match).toBe(1.0);
    });

    it('parses signals from both candidate_source values identically', () => {
      const threeSignal = makeRow({ candidateSource: 'three_signal_scoring' });
      const crossCluster = makeRow({ candidateSource: 'cross_cluster_generator' });
      const s1 = parseSignals(threeSignal);
      const s2 = parseSignals(crossCluster);
      // Both sources now write the same SignalSet shape (post-F1a / .42 / .44),
      // so given identical resolution_reasoning blobs the parsed map is identical.
      for (const [key] of SIGNAL_LABELS) {
        expect(s1[key]).toBe(s2[key]);
      }
    });

    it('falls back to direct columns when resolution_reasoning is null', () => {
      const row = makeRow({
        resolutionReasoning: null,
        centroidSimilarity: 0.95,
        memoryOverlap: 0.85,
        structuralSimilarity: 0.75,
      });
      const s = parseSignals(row);
      // The three direct columns survive the missing JSON.
      expect(s.centroid_similarity).toBe(0.95);
      expect(s.memory_overlap).toBe(0.85);
      expect(s.structural_similarity).toBe(0.75);
      // The other six are null when no JSON is available.
      expect(s.cluster_match).toBeNull();
      expect(s.predicate_signature_cosine).toBeNull();
      expect(s.drift_recency_either).toBeNull();
      expect(s.centrality_match).toBeNull();
      expect(s.articulation_bonus).toBeNull();
      expect(s.component_match).toBeNull();
    });

    it('gracefully handles malformed JSON in resolution_reasoning', () => {
      const row = makeRow({ resolutionReasoning: 'not json {{{' });
      const s = parseSignals(row);
      // Direct-column fallback kicks in for the three core signals.
      expect(s.centroid_similarity).toBe(0.7);
      expect(s.memory_overlap).toBe(0.5);
      expect(s.structural_similarity).toBe(0.4);
      // The other six are null.
      expect(s.cluster_match).toBeNull();
    });

    it('maps legacy { contributions: ... } shape onto the unified vocabulary', () => {
      const row = makeRow({
        resolutionReasoning: JSON.stringify({
          contributions: {
            cluster:       0.7,
            drift_a:       0.4,
            drift_b:       0.6,
            role:          0.5,
            centrality:    0.3,
            articulation:  1.0,
          },
        }),
      });
      const s = parseSignals(row);
      expect(s.cluster_match).toBe(0.7);
      // drift_recency_either = max(drift_a, drift_b) per the legacy collapse.
      expect(s.drift_recency_either).toBe(0.6);
      // centrality_match = role || centrality.
      expect(s.centrality_match).toBe(0.5);
      expect(s.articulation_bonus).toBe(1.0);
      // The three direct columns still come from row.* (legacy blob didn't carry them).
      expect(s.centroid_similarity).toBe(0.7);
      expect(s.memory_overlap).toBe(0.5);
      expect(s.structural_similarity).toBe(0.4);
    });

    it('signal-bar values exactly match the underlying merge_candidates columns when JSON agrees', () => {
      // Acceptance bullet: "signal bars match underlying merge_candidates columns".
      // The three direct columns (centroid_similarity, memory_overlap,
      // structural_similarity) are the authoritative store. When JSON.signals
      // restate them, parseSignals must return those exact numbers — no
      // rounding, no rescaling.
      const row = makeRow({
        centroidSimilarity: 0.123,
        memoryOverlap: 0.456,
        structuralSimilarity: 0.789,
        resolutionReasoning: JSON.stringify({
          signals: {
            centroid_similarity: 0.123,
            memory_overlap: 0.456,
            structural_similarity: 0.789,
          },
        }),
      });
      const s = parseSignals(row);
      expect(s.centroid_similarity).toBe(0.123);
      expect(s.memory_overlap).toBe(0.456);
      expect(s.structural_similarity).toBe(0.789);
    });
  });

  describe('filterBySource — chip filter', () => {
    const rows = [
      { candidateSource: 'three_signal_scoring',    status: 'candidate' },
      { candidateSource: 'cross_cluster_generator', status: 'candidate' },
      { candidateSource: 'three_signal_scoring',    status: 'resolved'  },
    ];

    it('returns every row when sourceKey === "all"', () => {
      expect(filterBySource(rows, 'all').length).toBe(3);
    });
    it('filters to one source when chip is set', () => {
      const ts = filterBySource(rows, 'three_signal_scoring');
      expect(ts.length).toBe(2);
      expect(ts.every((r: { candidateSource: string }) => r.candidateSource === 'three_signal_scoring')).toBe(true);
      const cc = filterBySource(rows, 'cross_cluster_generator');
      expect(cc.length).toBe(1);
      expect(cc[0].candidateSource).toBe('cross_cluster_generator');
    });
  });

  describe('filterUnresolved — status filter', () => {
    it('drops resolved rows', () => {
      const rows = [
        { status: 'candidate' },
        { status: 'staging' },
        { status: 'provisional' },
        { status: 'resolved' },
        { status: 'resolved' },
      ];
      const out = filterUnresolved(rows);
      expect(out.length).toBe(3);
      expect(out.every((r: { status: string }) => r.status !== 'resolved')).toBe(true);
    });
  });
});
